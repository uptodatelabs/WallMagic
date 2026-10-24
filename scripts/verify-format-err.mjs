// formatErr 동작 재현 스크립트 (검수 지적 #1 대응)
// - Red: 구 `String(err)` 경로는 {error:{message:'x'}}를 '[object Object]'로 만든다 (FAIL)
// - Green: 현 formatErr는 같은 입력에서 'x'를 반환한다 (PASS)
// 실행: node scripts/verify-format-err.mjs (exit 0 = Red 확인 + Green 통과)

function formatErr(err) {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object" && err !== null) {
    const e = err;
    if (typeof e.message === "string" && e.message) return e.message;
    const inner = e.error;
    if (typeof inner === "object" && inner !== null) {
      const m = inner.message;
      if (typeof m === "string" && m) return m;
    }
    if (typeof e.error === "string" && e.error) return e.error;
    try {
      return JSON.stringify(e);
    } catch {
      const keys = Object.keys(e);
      const fallback = e.code ?? e.name;
      if (typeof fallback === "string" && fallback) {
        return keys.length > 0 ? `${fallback} (keys: ${keys.join(", ")})` : fallback;
      }
      if (keys.length > 0) return `알 수 없는 오류 (keys: ${keys.join(", ")})`;
      return "알 수 없는 오류";
    }
  }
  return String(err);
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} — got: ${JSON.stringify(actual)} / want: ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

function checkNot(name, actual, forbidden) {
  const ok = actual !== forbidden;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} — got: ${JSON.stringify(actual)} (must not be ${JSON.stringify(forbidden)})`);
  if (!ok) failures++;
}

// ── Red: 구 경로 재현 ──
const sdkErr = { error: { message: "x" } };
const oldResult = String(sdkErr);
console.log(`Red  구 String(err) 경로: ${JSON.stringify(oldResult)} (버그 재현: '[object Object]'가 되면 Red 증빙 성립)`);
if (oldResult !== "[object Object]") {
  console.log("FAIL Red 재현 실패 — 구 경로가 [object Object]를 만들지 않음");
  failures++;
} else {
  console.log("ok   Red 재현 확인 — 구 경로는 [object Object] (사용자 신고와 일치)");
}

// ── Green: 현 formatErr ──
check("formatErr({error:{message:'x'}}) → 'x'", formatErr({ error: { message: "x" } }), "x");
check("formatErr({message:'boom'}) → 'boom'", formatErr({ message: "boom" }), "boom");
check("formatErr({error:'plain'}) → 'plain'", formatErr({ error: "plain" }), "plain");
check("formatErr(new Error('e')) → 'e'", formatErr(new Error("e")), "e");
check("formatErr('raw') → 'raw'", formatErr("raw"), "raw");

// ── 지적 #2: 순환 참조 안전장치 ──
const cyclic = { code: "E_CYCLE" };
cyclic.self = cyclic;
const cyclicOut = formatErr(cyclic);
console.log(`Green 순환 참조 입력 → ${JSON.stringify(cyclicOut)}`);
checkNot("순환 참조 입력이 '[object Object]'로 떨어지지 않음", cyclicOut, "[object Object]");
if (!/E_CYCLE|알 수 없는 오류/.test(cyclicOut)) {
  console.log("FAIL 순환 참조 대체 요약에 식별자/키 정보 없음");
  failures++;
} else {
  console.log("ok   순환 참조 대체 요약에 식별자 포함");
}

if (failures > 0) {
  console.log(`formatErr 재현 스크립트: ${failures}건 FAIL`);
  process.exit(1);
}
console.log("formatErr 재현 스크립트 통과 (Red 확인 + Green PASS)");
