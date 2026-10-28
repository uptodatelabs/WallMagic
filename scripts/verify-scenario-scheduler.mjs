#!/usr/bin/env node
// 검증: 시나리오 자동 전환의 **주기 실행 주체는 Rust 백그라운드 스레드**이고,
// UI 는 그 결과 이벤트만 구독한다는 계약.
//
// 배경(검수 지적 [high]): 이전 구현은 `src-ui/App.tsx` 의 `setInterval(60_000)` 이
// `tick_scenario_now` 를 직접 invoke 했다. 창을 닫아 트레이에 상주시키면 WebView2 가
// 숨김 창의 타이머를 스로틀링하므로 "60초마다 전환"이 수 분으로 늘거나 정지할 수 있고,
// 히스토리 창이 함께 떠 있으면 WebView 가 2개라 틱이 2배로 돌았다.
// 그래서 전환의 주체를 Rust 로 옮겼다. 이 계약이 되돌아가지 않도록 코드로 고정한다.
//
// 검사 항목
//  (1) Rust: 주기 상수 · std::thread::spawn · loop · sleep 이 한 함수 안에 있다
//  (2) Rust: 성공/실패 이벤트 2종을 emit 한다(무음 실패 금지)
//  (3) Rust: setup 에서 스케줄러를 시작한다(시작하지 않으면 죽은 코드다)
//  (4) UI: setInterval 콜백 안에서 tick_scenario_now 를 호출하지 않는다(이중 틱·스로틀링 금지)
//  (5) UI: 두 이벤트를 구독하고 언마운트 시 해제한다(리스너 누수 방지)
//
// 사용: node scripts/verify-scenario-scheduler.mjs [lib.rs 경로] [App.tsx 경로]
//   경로 인자는 과거 스냅샷에 대한 Red(실패) 재현용이다. 기본값은 실제 소스.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "src-tauri/src/lib.rs");
const appPath = process.argv[3] ? resolve(process.argv[3]) : resolve(root, "src-ui/App.tsx");

const lib = readFileSync(libPath, "utf8");
const app = readFileSync(appPath, "utf8");

const fails = [];
const oks = [];
function check(ok, okMsg, failMsg) {
  if (ok) oks.push("ok   " + okMsg);
  else fails.push(failMsg);
}

/** `fn NAME(` 부터 짝이 맞는 `}` 까지의 본문(문자열 리터럴 내부 중괄호는 무시). */
function fnBody(src, name) {
  const decl = new RegExp(`fn\\s+${name}\\s*\\(`).exec(src);
  if (!decl) return null;
  const braceOpen = src.indexOf("{", decl.index + decl[0].length);
  if (braceOpen < 0) return null;
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j++;
      }
      i = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(braceOpen + 1, i);
    }
  }
  return null;
}

/**
 * 주석을 제거한다(문자열 리터럴 내부는 보존).
 *
 * 이 검사기는 "코드가 무엇을 하는가" 를 보는데, 주석은 코드가 아니다. 그런데
 * `App.tsx` 상단의 해소 주석이 **이전 구현의 이력**을 설명하며 `setInterval(60_000)` 과
 * `tick_scenario_now` 를 나란히 적어 두었다. 주석을 그대로 스캔하면 이미 Rust 스레드로
 * 옮긴 코드를 "아직 UI 타이머가 틱을 돌린다" 로 오판한다(실측: 13/14 거짓 FAIL).
 *
 * 이때 **주석을 지워서 통과시키면 계약을 푸는 것**이므로, 검사기 쪽을 고친다.
 * 과거 이력은 남겨야 하고(왜 Rust 로 옮겼는지가 코드보다 중요한 맥락이다) 검사는
 * 실제 실행 코드만 봐야 한다.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
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

// ── (1) Rust 스케줄러 본체 ──
const hasIntervalConst = /const\s+SCENARIO_TICK_INTERVAL_SECS\s*:\s*u64\s*=\s*\d+\s*;/.test(lib);
check(
  hasIntervalConst,
  "주기 상수 SCENARIO_TICK_INTERVAL_SECS 가 선언돼 있다(매직 넘버 금지)",
  "주기 상수 SCENARIO_TICK_INTERVAL_SECS 가 없다 — 스케줄러가 매직 넘버를 쓰거나 사라졌다"
);

const scheduler = fnBody(lib, "spawn_scenario_timer");
check(
  scheduler !== null,
  "spawn_scenario_timer 함수가 존재한다",
  "spawn_scenario_timer 함수가 없다 — 주기 실행 주체가 Rust 에 없다(스로틀링에 노출)"
);

if (scheduler !== null) {
  check(
    /std::thread::spawn|thread::spawn/.test(scheduler),
    "스케줄러가 별도 스레드에서 돈다(std::thread::spawn)",
    "스케줄러가 별도 스레드에서 돌지 않는다 — UI 스레드/WebView 타이머에 의존하면 숨김 창에서 스로틀링된다"
  );
  check(
    /\bloop\s*\{/.test(scheduler),
    "스케줄러가 주기 루프를 갖는다(loop)",
    "스케줄러에 주기 루프(loop)가 없다 — 1회 실행이면 자동 전환이 반복되지 않는다"
  );
  check(
    /std::thread::sleep|thread::sleep/.test(scheduler),
    "스케줄러가 주기마다 sleep 한다",
    "스케줄러에 sleep 이 없다 — 무한 즉시 루프로 CPU 를 점유한다"
  );
  check(
    /SCENARIO_TICK_INTERVAL_SECS/.test(scheduler),
    "sleep 간격이 주기 상수를 참조한다(상수와 실제 주기 일치)",
    "sleep 간격이 주기 상수를 참조하지 않는다 — 상수와 실제 주기가 어긋날 수 있다"
  );

  // ── (2) 이벤트 2종 ──
  check(
    /"scenario:\/\/auto-applied"/.test(scheduler),
    "성공 이벤트 scenario://auto-applied 를 emit 한다",
    "성공 이벤트 scenario://auto-applied 가 없다 — UI 가 전환 결과를 표시할 수 없다"
  );
  check(
    /"scenario:\/\/auto-tick-failed"/.test(scheduler),
    "실패 이벤트 scenario://auto-tick-failed 를 emit 한다",
    "실패 이벤트 scenario://auto-tick-failed 가 없다 — 무음 실패가 된다"
  );
  check(
    /evaluate_auto_switch_impl/.test(scheduler),
    "스케줄러가 매 주기 자동 전환 규칙을 평가한다",
    "스케줄러가 자동 전환 규칙(evaluate_auto_switch_impl)을 평가하지 않는다 — 시간대 규칙이 발동하지 않는다"
  );
}

// ── (3) setup 에서 시작 ──
const started = /spawn_scenario_timer\s*\(\s*app\.handle\(\)\.clone\(\)\s*\)/.test(lib);
check(
  started,
  "setup 에서 spawn_scenario_timer(app.handle().clone()) 를 호출한다",
  "setup 에서 스케줄러를 시작하지 않는다 — 함수만 있고 실행되지 않으면 자동 전환이 동작하지 않는다"
);

// ── (4) UI 가 tick 을 직접 돌리지 않는다 ──
//
// 주석을 먼저 제거하고 검사한다. 제거하지 않으면 "이전 구현은 setInterval 로
// tick_scenario_now 를 호출했다"는 **설명 주석**이 위반으로 잡힌다(실측: line 1051
// 주석에서 setInterval 과 tick_scenario_now 가 24자 거리로 오탐).
// 계약은 "실행되는 코드가 tick 을 돌리지 않는다"이므로 주석·문자열은 대상이 아니다.
// `stripComments` 는 위(§헬퍼, `fnBody` 아래)에 정의된 것을 그대로 쓴다.
// 여기서 다시 선언하면 모듈 스코프 중복 선언(SyntaxError: Identifier 'stripComments'
// has already been declared)으로 **검사기 자체가 실행되지 않는다**(실측).
// 검사기가 죽으면 exit=1 이지만 그 실패는 계약 위반이 아니라 문법 오류이므로,
// "계약을 지켰는가"를 판정할 수 없게 된다 — 통과를 위해 계약을 푸는 것과 같은 결과다.
const appCode = stripComments(app);
const intervalWindows = [];
const intervalRe = /setInterval\s*\(/g;
let m;
while ((m = intervalRe.exec(appCode))) {
  intervalWindows.push(appCode.slice(m.index, m.index + 2000));
}
const tickingIntervals = intervalWindows.filter((w) => w.includes("tick_scenario_now"));
check(
  tickingIntervals.length === 0,
  `setInterval 콜백에서 tick_scenario_now 를 호출하지 않는다(주석 제외 실코드 setInterval ${intervalWindows.length}곳)`,
  "setInterval 콜백이 tick_scenario_now 를 호출한다 — 숨김 창 스로틀링·이중 틱(WebView 2개) 위험"
);

// ── (5) UI 이벤트 구독 + 정리 ──
check(
  /listen<\s*WallpaperState\s*>\s*\(\s*"scenario:\/\/auto-applied"/.test(app),
  "UI 가 scenario://auto-applied 를 WallpaperState 타입으로 구독한다",
  "UI 가 scenario://auto-applied 를 구독하지 않는다 — Rust 가 전환해도 화면이 갱신되지 않는다"
);
check(
  /listen<\s*string\s*>\s*\(\s*"scenario:\/\/auto-tick-failed"/.test(app),
  "UI 가 scenario://auto-tick-failed 를 구독한다",
  "UI 가 scenario://auto-tick-failed 를 구독하지 않는다 — 자동 틱 실패가 사용자에게 보이지 않는다"
);
check(
  /disposed\s*=\s*true/.test(app) && /unlistenApplied\?\.\(\)/.test(app) && /unlistenFailed\?\.\(\)/.test(app),
  "구독 해제를 언마운트 시 수행한다(disposed 플래그 + unlisten 2종)",
  "구독 해제 경로가 없다 — 비동기 listen 이 늦게 도착하면 리스너가 누수된다"
);

for (const line of oks) console.log(line);
if (fails.length > 0) {
  for (const f of fails) console.error("FAIL " + f);
  console.error(`${fails.length}/${oks.length + fails.length} FAIL — 시나리오 스케줄러 계약 위반`);
  process.exit(1);
}
console.log(`ok   ${oks.length}/${oks.length} — 자동 전환은 Rust 스레드가 소유하고 UI 는 이벤트만 구독한다`);
