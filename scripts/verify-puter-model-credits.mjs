#!/usr/bin/env node
// 검증: "Puter 이미지 모델별 1회당 크레딧 표시" 계약 (실행 검증).
//
// 이 스크립트는 소스 문자열을 정규식으로 훑지 않고 **모듈 함수를 실제로 실행**해
// 기대값과 대조한다 (src-ui/puterModelCredits.ts 는 React·DOM·Tauri 비의존 순수 모듈).
//
// 사용:
//   node --experimental-strip-types scripts/verify-puter-model-credits.mjs
import { readFileSync } from "node:fs";

const APP = "src-ui/App.tsx";
const results = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    if (typeof r === "string") {
      ok = false;
      detail = r;
    } else {
      ok = !!r;
    }
  } catch (err) {
    ok = false;
    detail = String(err && err.message ? err.message : err);
  }
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const modUrl = new URL("../src-ui/puterModelCredits.ts", import.meta.url).href;
let m = null;
try {
  m = await import(modUrl);
} catch (err) {
  console.log(`FAIL 모듈 로드(src-ui/puterModelCredits.ts) — ${err.message}`);
  console.log("\n0/1 통과 — 단가 표시 모듈이 없습니다 (Red)");
  process.exit(1);
}

// ── App.tsx 의 모델 목록과 상수 표의 정합성 ──
function appModelIds() {
  const src = readFileSync(APP, "utf8");
  const at = src.indexOf("const PUTER_IMAGE_MODELS");
  if (at < 0) return [];
  const end = src.indexOf("];", at);
  const block = end > at ? src.slice(at, end) : "";
  return [...block.matchAll(/id:\s*"([^"]+)"/g)].map((x) => x[1]);
}

check("단가 상수 배열(PUTER_MODEL_CREDITS)이 존재한다", () =>
  Array.isArray(m.PUTER_MODEL_CREDITS) && m.PUTER_MODEL_CREDITS.length > 1);

check("단가 표가 App 의 모든 이미지 모델 id 를 덮는다", () => {
  const ids = appModelIds();
  if (ids.length === 0) return "App.tsx 에서 모델 목록을 찾지 못함";
  const have = new Set(m.PUTER_MODEL_CREDITS.map((c) => c.id));
  const missing = ids.filter((id) => !have.has(id));
  return missing.length === 0 ? true : `단가 표에 없는 모델: ${missing.join(", ")}`;
});

check("기본 모델 id 상수가 App 기본값(openai/gpt-image-2)과 일치한다", () =>
  m.PUTER_DEFAULT_MODEL_ID === "openai/gpt-image-2");

// ── 실측 근거 값 ──
check("gpt-image-2 1회당 크레딧 = 실측 19.02 (output 188.16 + input 2.048 / 10회)", () => {
  const c = m.creditForModel("openai/gpt-image-2");
  if (!c) return "모델 항목 없음";
  if (typeof c.creditsPerImage !== "number") return "creditsPerImage 가 숫자가 아님";
  return Math.abs(c.creditsPerImage - 19.0208) < 0.01 ? true : `값 불일치: ${c.creditsPerImage}`;
});

check("단가 미확인 모델은 null 로 두고 사유(basis)를 남긴다(추정치 위장 금지)", () => {
  const unknown = m.PUTER_MODEL_CREDITS.filter((c) => c.creditsPerImage === null);
  if (unknown.length === 0) return "null 모델이 없음 — 단가를 모두 아는 것은 실측 근거와 불일치";
  const noBasis = unknown.filter((c) => typeof c.basis !== "string" || c.basis.trim() === "");
  return noBasis.length === 0 ? true : `사유 없는 항목: ${noBasis.map((c) => c.id).join(", ")}`;
});

// ── 표시 함수 ──
check("formatCreditsPerImage(null) 은 '정보 없음' 이다", () =>
  m.formatCreditsPerImage(null) === "정보 없음");

check("formatCreditsPerImage(실측값) 은 '약 19.02 credits/회' 형식이다", () =>
  m.formatCreditsPerImage(m.creditForModel("openai/gpt-image-2")) === "약 19.02 credits/회");

check("creditForModel(모르는 id) 은 null 이다", () => m.creditForModel("nope/none") === null);

// ── 예상 생성 가능 횟수 ──
check("estimateImagesForCredits(578.6956, 19.0208) = 30", () =>
  m.estimateImagesForCredits(578.6956796329976, 19.0208) === 30);

check("estimateImagesForCredits 는 미확인(null)·0 나눗셈에서 null 을 돌려준다", () =>
  m.estimateImagesForCredits(null, 19.02) === null &&
  m.estimateImagesForCredits(100, null) === null &&
  m.estimateImagesForCredits(100, 0) === null);

// ── 카탈로그 정규화 ──
check("카탈로그(result 래핑 + pricing.unit=credits)에서 단가를 읽는다", () => {
  const parsed = m.parseModelCatalogCredits({
    result: [{ id: "openai/gpt-image-2", pricing: { unit: "credits", cost: 19.02 } }],
  });
  return parsed.length === 1 && Math.abs(parsed[0].creditsPerImage - 19.02) < 0.001
    ? true
    : `결과: ${JSON.stringify(parsed)}`;
});

check("달러(unit=usd) 단가를 credit 으로 오인하지 않는다", () => {
  const parsed = m.parseModelCatalogCredits({
    result: [{ id: "x/y", pricing: { unit: "usd", cost: 0.04 } }],
  });
  return parsed.length === 0 ? true : `오인: ${JSON.stringify(parsed)}`;
});

check("키 이름이 credit 인 숫자 필드를 읽는다 (credits_per_image)", () => {
  const parsed = m.parseModelCatalogCredits([{ id: "a/b", credits_per_image: "5" }]);
  return parsed.length === 1 && parsed[0].creditsPerImage === 5
    ? true
    : `결과: ${JSON.stringify(parsed)}`;
});

check("카탈로그가 배열/예상 밖 형태여도 예외 없이 빈 배열을 돌려준다", () => {
  const a = m.parseModelCatalogCredits("garbage");
  const b = m.parseModelCatalogCredits(null);
  const c = m.parseModelCatalogCredits({ result: {} });
  return Array.isArray(a) && a.length === 0 && b.length === 0 && c.length === 0;
});

// ── App.tsx 배선 (모듈이 UI 에 실제로 연결되었는가) ──
const appSrc = readFileSync(APP, "utf8");

check("App 이 단가 모듈(./puterModelCredits)을 import 한다", () =>
  /from "\.\/puterModelCredits"/.test(appSrc) && /formatCreditsPerImage/.test(appSrc));

check("모델 select 옵션 라벨에 1회당 크레딧이 붙는다", () => {
  const at = appSrc.indexOf('id="scPuterModel"');
  const close = at >= 0 ? appSrc.indexOf("</select>", at) : -1;
  const block = at >= 0 && close > at ? appSrc.slice(at, close) : "";
  return (
    /PUTER_IMAGE_MODELS\.map/.test(block) &&
    /formatCreditsPerImage\(creditForModel\(m\.id\)\)/.test(block)
  );
});

check("선택 모델 1회당 크레딧 + 남은 크레딧 기준 생성 가능 횟수를 표시한다", () =>
  /id="puterModelCredits"/.test(appSrc) &&
  /formatCreditsPerImage\(selectedPuterCredit\)/.test(appSrc) &&
  /estimateImagesForCredits\(/.test(appSrc) &&
  /puterImagesPossible/.test(appSrc));

check("모델 전체 단가 표(PUTER_MODEL_CREDITS)를 UI 에서 렌더한다", () =>
  /PUTER_MODEL_CREDITS\.map/.test(appSrc));

check("모델 미선택 시 기본 모델(PUTER_DEFAULT_MODEL_ID) 단가로 폴백한다", () =>
  /scPuterModel\.trim\(\)\s*\?\s*scPuterModel\.trim\(\)\s*:\s*PUTER_DEFAULT_MODEL_ID/.test(appSrc));

const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `\n(${results.length}/${results.length} ok) 모델별 크레딧 표시 계약 통과`
    : `\n${failed}/${results.length} 항목 실패 (모델별 크레딧 계약 미충족)`,
);
process.exit(failed === 0 ? 0 : 1);
