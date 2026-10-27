#!/usr/bin/env node
// 정적 검사: 창 생성(`WebviewWindowBuilder::new … .build()`)에 **도달하는**
// `#[tauri::command]` 는 반드시 `async fn` 이어야 한다.
//
// 배경 (추정 원인 — 런타임 미확정. src-tauri/src/lib.rs 의 open_history_window 주석 참조):
// Tauri v2 에서 `async` 가 아닌 `#[tauri::command]` 는 메인 스레드에서 실행된다.
// 그 상태에서 `WebviewWindowBuilder::build()` 로 웹뷰 창을 만들면 Windows(wry)의
// WebView2 생성이 메시지 펌프를 중첩 재진입시켜 흰 창 · `X`(WM_CLOSE) 무반응 ·
// 프로세스 잔존이 생길 수 있다. 실제로 히스토리 창에서 이 증상이 보고됐고,
// `open_history_window` 를 async 로 바꿔 회피했다.
//
// 회귀 방지선이 없으면, 나중에 새 sync 커맨드에서 창을 만들면 같은 증상이 되살아난다.
// 그래서 "창 생성을 직접 하거나, 창 생성을 하는 함수를 호출하는 커맨드는 async" 를
// 정적으로 강제한다.
//
// 검사 방식 (간접 호출 우회 차단):
//   1) lib.rs 의 모든 `fn` 선언과 본문을 수집한다(주석 제거, 문자열 인식).
//   2) 본문에 WebviewWindowBuilder + .build() 가 있는 fn 을 "창 생성 fn" 으로 표시.
//   3) fn → fn 호출 그래프를 만들어 도달 가능성을 전파한다
//      (커맨드 → 래퍼 함수 → 실제 build  같은 우회를 잡기 위함).
//   4) 창 생성에 도달하는 커맨드가 async 가 아니면 FAIL.
//   5) setup() 처럼 커맨드가 아닌 클로저에서의 생성은 대상이 아니다
//      (이벤트 루프 시작 전이므로 교착 조건이 아님 — 메인 창이 그 경로다).
//
// 사용: node scripts/verify-window-builder-async.mjs [lib.rs 경로]
//   경로 인자는 위반 검출(Red) 확인용이다. 기본값은 실제 소스.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "src-tauri/src/lib.rs");
const raw = readFileSync(libPath, "utf8");

/** 주석 제거(문자열 리터럴 내부는 보존). 주석 안의 `{`·`}`·`fn` 이 파싱을 깨뜨리지 않게 한다. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `openIndex` 의 괄호 짝을 찾는다(문자열 리터럴 내부는 건너뛴다). */
function findClosing(src, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j++;
      }
      i = j - 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const code = stripComments(raw);

// `(pub)? (async)? fn NAME` — 선언 위치와 async 여부를 함께 수집
const fnRe = /(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+([A-Za-z_][\w]*)/g;
const fns = [];
let m;
while ((m = fnRe.exec(code))) {
  const isAsync = Boolean(m[1]);
  const name = m[2];
  const declStart = m.index;
  const parenOpen = code.indexOf("(", m.index + m[0].length - 1);
  if (parenOpen < 0) continue;
  const parenClose = findClosing(code, parenOpen, "(", ")");
  if (parenClose < 0) continue;
  const braceOpen = code.indexOf("{", parenClose);
  if (braceOpen < 0) continue;
  const braceClose = findClosing(code, braceOpen, "{", "}");
  if (braceClose < 0) continue;
  const body = code.slice(braceOpen + 1, braceClose);
  // 커맨드 판정: 선언 앞(최대 300자)에 #[tauri::command] 가 있고,
  // 그 속성과 `fn` 사이에 **다른 코드가 없어야** 한다.
  //
  // "앞 300자 안에 속성이 있는가" 로만 판정하면 커맨드 바로 뒤에 선언된 일반 함수까지
  // 커맨드로 오판한다. 실측: `run`(setup 클로저를 품은 앱 진입점)이 커맨드로 잡혀
  // "sync 커맨드가 창 생성에 도달한다" 는 거짓 FAIL 이 났다. `run` 의 창 생성은
  // 이벤트 루프 시작 전이므로 교착 조건이 아니고, 검사 대상도 아니다.
  const before = code.slice(Math.max(0, declStart - 300), declStart);
  const marker = "#[tauri::command]";
  const markerAt = before.lastIndexOf(marker);
  const between = markerAt < 0 ? null : before.slice(markerAt + marker.length);
  // 주석은 이미 제거됐으므로 사이에 남을 수 있는 것은 공백과 다른 속성뿐이다.
  const isCommand = between !== null && /^\s*(#\[[^\]]*\]\s*)*$/.test(between);
  fns.push({ name, isAsync, isCommand, body });
}

const fnNames = new Set(fns.map((f) => f.name));

/** 본문에서 WebviewWindowBuilder + .build() 를 모두 포함하면 창 생성 fn. */
const buildsWindow = (body) =>
  /WebviewWindowBuilder::(?:new|builder)/.test(body) && /\.build\s*\(/.test(body);

const builderFns = fns.filter((f) => buildsWindow(f.body)).map((f) => f.name);

/** 본문이 호출하는(텍스트상 등장하는) 다른 fn 이름들. */
function calledFns(body) {
  const out = new Set();
  const re = /\b([A-Za-z_][\w]*)\s*\(/g;
  let call;
  while ((call = re.exec(body))) {
    const name = call[1];
    if (fnNames.has(name)) out.add(name);
  }
  return out;
}

const byName = new Map(fns.map((f) => [f.name, f]));
const reachesBuildCache = new Map();
/** name 이 (직접 또는 간접으로) 창 생성에 도달하는가. */
function reachesBuild(name, seen = new Set()) {
  if (reachesBuildCache.has(name)) return reachesBuildCache.get(name);
  if (builderFns.includes(name)) {
    reachesBuildCache.set(name, true);
    return true;
  }
  if (seen.has(name)) return false;
  seen.add(name);
  const fn = byName.get(name);
  if (!fn) return false;
  for (const callee of calledFns(fn.body)) {
    if (reachesBuild(callee, seen)) {
      reachesBuildCache.set(name, true);
      return true;
    }
  }
  reachesBuildCache.set(name, false);
  return false;
}

const commandFns = fns.filter((f) => f.isCommand);
const failures = [];
const oks = [];

for (const cmd of commandFns) {
  if (!reachesBuild(cmd.name)) continue;
  if (cmd.isAsync) {
    oks.push(`ok   ${cmd.name} — 창 생성에 도달하며 async fn 이다`);
  } else {
    failures.push(
      `${cmd.name} — sync 커맨드가 창 생성(WebviewWindowBuilder::build)에 도달한다. ` +
        `async fn 으로 선언해야 한다(메인 스레드 재진입 회피)`
    );
  }
}

// 검사 무효 방지: 창 생성 지점을 하나도 못 찾으면 "통과"가 아니라 실패로 본다.
// (패턴이 바뀌어 검사가 조용히 아무것도 잡지 못하는 상황을 막는다)
if (builderFns.length === 0) {
  failures.push(
    "창 생성 지점을 찾지 못했다 — 검사 패턴이 소스와 어긋났을 수 있으므로 결과를 신뢰할 수 없다"
  );
}

// 커맨드가 아닌 위치(setup() 클로저 등)의 생성은 대상 아님 — 개수만 보고한다.
const nonCommandBuilders = builderFns.filter(
  (n) => !commandFns.some((c) => c.name === n) && !commandFns.some((c) => reachesBuild(c.name) && calledFns(c.body).has(n))
);

for (const line of oks) console.log(line);
console.log(
  `     창 생성 fn=[${builderFns.join(", ")}] / 커맨드 ${commandFns.length}개 중 ` +
    `${oks.length}개가 창 생성 경로, 비커맨드 클로저 ${nonCommandBuilders.length}개(setup 등 — 대상 아님)`
);

if (failures.length > 0) {
  for (const f of failures) console.error("FAIL " + f);
  console.error(`FAIL: 창 생성 커맨드 async 계약 위반 ${failures.length}건`);
  process.exit(1);
}
console.log("ok   창 생성을 하는 모든 커맨드가 async fn 이다 (메인 스레드 재진입 회귀 방지)");
