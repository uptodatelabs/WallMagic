#!/usr/bin/env node
/// 검증: (1) 시나리오 공급자 개별 On/Off (disabled_providers) 배선
///       (2) Puter 남은 크레딧(getMonthlyUsage) 조회·표시
///
/// 계약 (Red → Green 대상):
///  1. 코어 ScenarioSettings 에 `disabled_providers` 필드가 있고 serde default 로 하위호환된다
///  2. provider_is_configured 가 Off 공급자를 자격 없음으로 판정한다
///  3. effective_provider_order 가 Off 공급자를 후보에서 제외한다
///  4. UI 저장 payload 가 disabled_providers 를 백엔드에 전달한다 (puter 제외)
///  5. UI 가 우선순위 목록의 각 공급자에 On/Off 토글을 렌더한다
///  6. 우선순위 생성이 Off 공급자를 시도하지 않는다
///  7. Puter 크레딧: getMonthlyUsage 정규화 + 남은 allowance 표시 (null 은 '알 수 없음')
///  8. 크레딧 미조회(0)와 모름(null)을 구분한다
import { readFileSync } from "node:fs";

const core = readFileSync("crates/core/src/scenario.rs", "utf8");
const app = readFileSync("src-ui/App.tsx", "utf8");
// 크레딧 정규화·표시 로직은 React 비의존 순수 모듈로 분리되었다.
// (이전에는 App.tsx 안에 있어 문자열 검사만 가능했고, "모두 0 표시" 결함을 놓쳤다)
// 이 스크립트는 배선(호출·UI)을 app 에서, 계산 규칙을 usage 모듈에서 확인한다.
const usage = readFileSync("src-ui/puterUsage.ts", "utf8");

const results = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === "object" && r.detail) detail = r.detail;
  } catch (err) {
    detail = String(err && err.message ? err.message : err);
  }
  results.push({ name, ok, detail });
}

// ── 1. 코어 설정 필드 ────────────────────────────────────────────────
check("코어 ScenarioSettings 에 disabled_providers 필드가 있다", () => {
  const block = core.slice(core.indexOf("pub struct ScenarioSettings"));
  const body = block.slice(0, block.indexOf("\n}"));
  return { ok: /pub\s+disabled_providers\s*:\s*Vec<ImageProvider>/.test(body), detail: body.slice(0, 80) };
});

check("disabled_providers 는 serde default 로 구버전 JSON 과 호환된다", () => {
  const idx = core.indexOf("pub disabled_providers");
  if (idx < 0) return false;
  const before = core.slice(Math.max(0, idx - 200), idx);
  return /#\[serde\(default\)\]\s*$/.test(before.trimEnd() + "\n") || before.includes("#[serde(default)]");
});

// ── 2. 자격 판정 ────────────────────────────────────────────────────
check("provider_is_configured 가 Off 공급자를 자격 없음으로 판정한다", () => {
  const start = core.indexOf("pub fn provider_is_configured");
  const body = core.slice(start, start + 900);
  return /disabled_providers[\s\S]{0,120}contains\(&?provider\)[\s\S]{0,80}false/.test(body);
});

// ── 3. 순서 해석 ────────────────────────────────────────────────────
check("effective_provider_order 가 Off 공급자를 제외한다", () => {
  const start = core.indexOf("pub fn effective_provider_order");
  const body = core.slice(start, start + 900);
  return /disabled_providers/.test(body);
});

// ── 4. 저장 payload ────────────────────────────────────────────────
check("저장 payload 가 disabled_providers 를 전달한다", () => {
  const start = app.indexOf('invoke<ScenarioSettings>("save_scenario"');
  const body = app.slice(start, start + 1400);
  return /disabled_providers\s*:/.test(body);
});

// 화면에서 Off 로 둔 상태는 재조회 후에도 유지되어야 한다("껐는데 다시 켜져 있다" 혼동 방지).
// 따라서 disabled_providers 는 4종 전체(FREE_FIRST_ORDER)에서 Off 인 것을 담는다.
// Puter 는 백엔드가 후보로 쓰지 않으므로(provider_is_configured → false) 이 값이
// 시나리오 실행에 부작용을 주지 않는다 — 그 사실도 아래 2번 항목이 함께 고정한다.
check("저장 payload 의 disabled_providers 는 Off 공급자 전체를 담는다 (Puter Off 상태도 유지)", () => {
  const start = app.indexOf('invoke<ScenarioSettings>("save_scenario"');
  const body = app.slice(start, start + 1600);
  const m = body.match(/disabled_providers\s*:\s*([\s\S]{0,220})/);
  if (!m) return false;
  return /FREE_FIRST_ORDER\.filter/.test(m[1]) && /scProviderEnabled/.test(m[1]);
});

check("복원 시 Puter Off 상태도 되살린다 (puter: !offList.includes)", () => {
  // 앵커 주의: `"disabled_providers?"` 는 ScenarioSettings 인터페이스(타입 선언)에도 등장한다.
  // 그 위치에서 자르면 복원 블록이 아닌 타입 선언만 검사해 오탐 FAIL 이 난다.
  // → 복원 블록 고유 문자열(rawOff 추출)을 앵커로 쓴다.
  const start = app.indexOf("const rawOff = (sc as unknown as { disabled_providers");
  if (start < 0) return false;
  const body = app.slice(start, start + 900);
  return /puter:\s*!offList\.includes\("puter"\)/.test(body);
});

// ── 5. On/Off UI ────────────────────────────────────────────────────
check("우선순위 목록 각 항목에 On/Off 토글이 있다", () => {
  const start = app.indexOf("이미지 생성 우선순위");
  const body = app.slice(start, start + 1600);
  return /scProviderEnabled\[p\]/.test(body) && /type="checkbox"/.test(body);
});

check("On/Off 토글은 상태를 갱신한다 (읽기 전용 아님)", () => {
  const start = app.indexOf("이미지 생성 우선순위");
  const body = app.slice(start, start + 1600);
  return /setScProviderEnabled/.test(body);
});

// ── 6. 생성 경로 ────────────────────────────────────────────────────
check("우선순위 생성이 Off 공급자를 시도하지 않는다", () => {
  const start = app.indexOf("const handleGeneratePriority");
  const body = app.slice(start, start + 2200);
  return /scProviderEnabled\[id\]/.test(body) || /enabledOrder/.test(body);
});

check("선택 공급자가 Off 면 명시적 오류로 알린다", () => {
  const start = app.indexOf("const handleGeneratePriority");
  const body = app.slice(start, start + 2200);
  return /scProviderEnabled\[scProvider\][\s\S]{0,200}(Off|비활성)/.test(body);
});

// ── 7. 크레딧 조회 ──────────────────────────────────────────────────
check("Puter 크레딧은 auth.getMonthlyUsage 로 조회한다", () => {
  return /getMonthlyUsage/.test(app);
});

check("남은 크레딧(microcents)을 표시 문자열로 변환한다", () => {
  // 계산은 순수 모듈(usage)이 담당한다. 1센트 미만은 4자리로 보여 실제 값을 가리지 않는다.
  return (
    /PUTER_MICROCENTS_PER_CENT\s*=\s*1_000_000/.test(usage) &&
    /toFixed\(/.test(usage) &&
    /formatMicrocents/.test(app)
  );
});

check("크레딧 응답은 allowanceInfo.remaining 과 monthUsageAllowance 를 정규화한다", () => {
  // 고정 경로만 보지 않고 후보 키를 트리에서 탐색한다(래핑·snake_case·문자열 숫자 대응).
  return (
    /"remaining"/.test(usage) &&
    /monthUsageAllowance/.test(usage) &&
    /"month_usage_allowance"/.test(usage) &&
    /remaining_allowance/.test(usage)
  );
});

// ── 8. 0 과 모름 구분 ───────────────────────────────────────────────
check("크레딧 미확인(null)과 0 을 구분해 표시한다", () => {
  // 표시 문자열 규칙은 순수 모듈(usage)에 있다: null → "알 수 없음", 0 → "$0.00".
  // (이전에는 App.tsx 안에 있어 app 만 검사했으나, 모듈 분리 후에는 usage 가 대상이다.
  //  app 쪽은 조회 결과를 그대로 formatMicrocents 에 넘기는지(중간 0 변환 없음)만 본다.)
  const nullIsUnknown = /value === null\) return "알 수 없음"/.test(usage);
  const zeroIsZero = /value === 0\) return "\$0\.00"/.test(usage);
  const appPassesThrough = /formatMicrocents\(puterUsage\.summary\.remaining\)/.test(app);
  return nullIsUnknown && zeroIsZero && appPassesThrough;
});

check("크레딧 조회 실패는 0 으로 위장하지 않고 명시적 오류로 표시한다", () => {
  const start = app.indexOf("export async function fetchPuterUsage");
  const body = app.slice(start, start + 1200);
  return /throw new Error/.test(body);
});

check("Puter 섹션에 잔여 크레딧 UI(조회 버튼 + 표시)가 있다", () => {
  const start = app.indexOf('{scProvider === "puter" &&');
  const body = app.slice(start, start + 2600);
  return /puterUsage/.test(body) && /잔여 크레딧|남은 크레딧/.test(body);
});

let fail = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
}
console.log(`\n${results.length - fail}/${results.length} 통과`);
if (fail > 0) {
  console.log(`[FAIL] 공급자 On/Off + Puter 크레딧 계약 ${fail}건 미충족`);
  process.exit(1);
}
console.log("[PASS] 공급자 On/Off + Puter 크레딧 계약 통과");
