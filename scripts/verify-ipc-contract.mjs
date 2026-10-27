#!/usr/bin/env node
// IPC 계약 검증:
//  (1) src-ui의 invoke("...") 이름 집합 ↔ src-tauri의 #[tauri::command] 함수 이름 집합 일치.
//      Tauri v2는 Rust 함수명 그대로 등록하므로 이름이 어긋나면 UI 버튼이 런타임에
//      "command not found" 로 실패한다.
//  (2) invoke 인자 객체의 **최상위 키** ↔ Rust 파라미터의 camelCase 이름 일치.
//      Tauri v2는 Rust 파라미터(snake_case)를 JS에서 camelCase 키로 받으므로,
//      키가 어긋나면 invoke 는 런타임에 "invalid args `monitorId` ..." 로 실패한다.
//      이름만 검사하던 이전 버전은 이 실패를 잡지 못했다(검수 지적: apply_wallpaper 인자 키 미확인).
//
// 파싱은 문자열 리터럴·주석을 인식한다. 주석을 인식하지 않으면
//   · `// comment` 로 시작하는 세그먼트에서 키 추출이 실패해 키가 조용히 누락되고(거짓 통과),
//   · 주석 안의 `{` `}` 가 깊이 계산을 깨뜨린다.
// (실측: save_generated_image 호출부의 `label` 이 주석에 가려 누락된 채 'ok' 로 통과했다)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = readFileSync(resolve(root, "src-ui/App.tsx"), "utf8");
const rs = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");

const invocations = [...ui.matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
// Tauri v2 제한: lib.rs의 command 함수는 pub 불가(E0255) — pub 유무와 무관하게 매칭
const commands = [...rs.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?fn ([a-z_]+)/g)].map((m) => m[1]);

console.log("UI invokes   : " + invocations.join(", "));
console.log("Rust commands: " + commands.join(", "));

const missingInRust = invocations.filter((name) => !commands.includes(name));
const unusedInRust = commands.filter((name) => !invocations.includes(name));

// ---------------------------------------------------------------------------
// 저수준 스캐너 — 문자열 / 주석 구간을 안전하게 건너뛴다
// ---------------------------------------------------------------------------

/** 문자열 리터럴 시작 위치 i 에서 **닫는 인용부호 다음 인덱스**를 돌려준다. */
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    j++;
  }
  return j;
}

/** `//` 시작 위치 i 에서 **개행 위치**(또는 끝)를 돌려준다. */
function skipLineComment(src, i) {
  let j = i + 2;
  while (j < src.length && src[j] !== "\n") j++;
  return j;
}

/** `/*` 시작 위치 i 에서 **`*\/` 다음 인덱스**를 돌려준다. */
function skipBlockComment(src, i) {
  let j = i + 2;
  while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
  return Math.min(j + 2, src.length);
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/** `openIndex` 의 괄호와 짝이 맞는 닫는 괄호 위치를 찾는다. */
function findMatching(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i) - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i) - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i) - 1;
      continue;
    }
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `a, b, c` → ["a","b","c"] (괄호·꺾쇠·대괄호·중괄호 안의 쉼표는 무시) */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const c of text) {
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

// ---------------------------------------------------------------------------
// Rust 명령 파라미터
// ---------------------------------------------------------------------------

/** Rust 명령의 파라미터 목록 `( … )` 본문을 뽑는다 (여러 줄 허용). */
function rustCommandParams(src, fnName) {
  const idx = src.search(
    new RegExp(`#\\[tauri::command\\]\\s*(?:pub\\s+)?fn\\s+${fnName}\\s*\\(`)
  );
  if (idx < 0) return [];
  const open = src.indexOf("(", idx);
  if (open < 0) return [];
  const end = findMatching(src, open);
  if (end < 0) return [];
  return splitTopLevel(src.slice(open + 1, end))
    .map((p) => {
      const m = /^([A-Za-z_][\w]*)\s*:\s*([\s\S]+)$/.exec(p);
      if (!m) return null;
      return { name: m[1], type: m[2].trim() };
    })
    .filter(Boolean);
}

/** JS가 보내지 않는 주입 인자(State<T>, AppHandle). */
function isInjected(type) {
  return /(^|::)State\s*</.test(type) || /(^|::)AppHandle\b/.test(type);
}

// ---------------------------------------------------------------------------
// UI invoke 인자 키
// ---------------------------------------------------------------------------

const SEG_KEY = /^([A-Za-z_$][\w$]*)\s*(?::|$)/;
const SPREAD = /^\.\.\./;

/**
 * 인자 객체 리터럴 본문을 최상위 쉼표로 나눈 뒤, 각 세그먼트 **선두 토큰**만 키로 취한다.
 *
 * 문자 단위로 `키:` 패턴을 스캔하면 식별자 내부 접미사까지 매칭돼
 * `path:` 가 path/ath/th/h 로 부풀려지는 오탐이 발생한다(실측). 그래서
 * ① 최상위 쉼표로 세그먼트를 자르고 ② 세그먼트 선두만 본다.
 */
function objectLiteralKeys(body) {
  const segments = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(body, i);
      current += body.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "/" && body[i + 1] === "/") {
      i = skipLineComment(body, i) - 1;
      current += " "; // 주석을 지워도 토큰이 붙어버리지 않게 구분자 유지
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      i = skipBlockComment(body, i) - 1;
      current += " ";
      continue;
    }
    if (OPENERS.includes(c)) {
      depth++;
      current += c;
      continue;
    }
    if (CLOSERS.includes(c)) {
      depth--;
      current += c;
      continue;
    }
    if (c === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") segments.push(current);

  const keys = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === "" || SPREAD.test(trimmed)) continue;
    const m = SEG_KEY.exec(trimmed);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** 같은 명령의 **호출부별** 인자 키 목록. */
function uiArgKeys(src, cmdName) {
  const re = new RegExp(`invoke(?:<[^>]*>)?\\(\\s*["']${cmdName}["']\\s*,\\s*\\{`, "g");
  const keysPerCall = [];
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const end = findMatching(src, open);
    if (end < 0) continue;
    keysPerCall.push(objectLiteralKeys(src.slice(open + 1, end)));
  }
  return keysPerCall;
}

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// 대조
// ---------------------------------------------------------------------------

const argFailures = [];
const argChecks = [];
for (const cmdName of [...new Set(invocations)]) {
  const params = rustCommandParams(rs, cmdName);
  const fromJs = params.filter((p) => !isInjected(p.type));
  const expectedCamel = fromJs.map((p) => snakeToCamel(p.name));
  const optionalCamel = fromJs
    .filter((p) => /^Option\s*</.test(p.type))
    .map((p) => snakeToCamel(p.name));
  const requiredCamel = expectedCamel.filter((n) => !optionalCamel.includes(n));

  const calls = uiArgKeys(ui, cmdName);
  if (calls.length === 0) {
    // 인자 없는 명령은 객체 리터럴도 없다 — 정상.
    if (requiredCamel.length > 0) {
      argFailures.push(
        `${cmdName} — 호출부 인자 객체를 찾지 못했는데 Rust 필수 인자가 있다 ` +
          `rust=[${expectedCamel.join(",")}]`
      );
    } else {
      argChecks.push(`ok   ${cmdName} — 인자 없음 ↔ Rust {${expectedCamel.join(", ")}}`);
    }
    continue;
  }
  calls.forEach((keys, i) => {
    const extra = keys.filter((k) => !expectedCamel.includes(k));
    const missingRequired = requiredCamel.filter((k) => !keys.includes(k));
    const label = `${cmdName}[${i}]`;
    if (extra.length === 0 && missingRequired.length === 0) {
      argChecks.push(`ok   ${label} 키 {${keys.join(", ")}} ↔ Rust {${expectedCamel.join(", ")}}`);
    } else {
      argFailures.push(
        `${label} extra=[${extra.join(",")}] missing_required=[${missingRequired.join(",")}] ` +
          `ui=[${keys.join(",")}] rust=[${expectedCamel.join(",")}]`
      );
    }
  });
}

for (const line of argChecks) console.log(line);
if (argFailures.length > 0) {
  console.error("ARG_MISMATCH " + argFailures.join(" | "));
}

if (missingInRust.length > 0 || unusedInRust.length > 0 || argFailures.length > 0) {
  console.error(
    "MISMATCH missing_in_rust=[" +
      missingInRust.join(",") +
      "] unused_in_rust=[" +
      unusedInRust.join(",") +
      "] arg_mismatch=" +
      argFailures.length
  );
  process.exit(1);
}
console.log(
  "MATCH: IPC 명령 이름 + 인자 키 계약 일치 (" +
    commands.length +
    " commands, " +
    argChecks.filter((l) => l.startsWith("ok")).length +
    " 호출부)"
);
