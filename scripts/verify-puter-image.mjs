#!/usr/bin/env node
/**
 * Puter 이미지 생성 경로 계약 검증 (Red→Green).
 *
 * 두 결함을 검사한다.
 *  (1) 생성 실패: `puterResultToBase64`가 HTMLImageElement를 canvas.toDataURL()로 먼저
 *      변환하면 원격(https) 이미지에서 canvas taint → SecurityError로 항상 실패한다.
 *      → src를 fetch → Blob → base64로 먼저 처리해야 한다.
 *  (2) 모델 선택 메뉴 부재: `txt2img(prompt)`가 model 옵션 없이 호출되고
 *      Puter 블록에 모델 선택 UI가 없다.
 *      → 모델 목록 상수 + state + select + txt2img options 전달이 있어야 한다.
 *
 * 정적 계약 검사(문자열/구조)이며, 실제 Puter 네트워크 호출은 검증하지 않는다.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "src-ui/App.tsx";
const src = readFileSync(file, "utf8");

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
    detail = String(err);
  }
  results.push({ name, ok, detail });
}

/** 함수 본문을 중괄호 깊이 기반으로 추출한다(다음 함수 포함 오탐 방지). */
function bodyOf(signature) {
  const at = src.indexOf(signature);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

const toBase64Body = bodyOf("function puterResultToBase64");
const genBody = bodyOf("async function puterGenerateWithAuth");

// ── (1) 원격 이미지 처리 ──
check("puterResultToBase64 함수 본문 추출", () => {
  if (!toBase64Body.trim()) return "본문을 찾지 못함";
  return true;
});

check("HTMLImageElement 처리에서 src fetch → Blob 경로가 canvas.toDataURL보다 먼저", () => {
  if (!toBase64Body) return "본문 없음";
  const imgIdx = toBase64Body.indexOf("instanceof HTMLImageElement");
  if (imgIdx < 0) return "HTMLImageElement 분기 없음";
  const rest = toBase64Body.slice(imgIdx);
  const fetchIdx = rest.indexOf("fetch(src");
  const canvasIdx = rest.indexOf("toDataURL");
  if (fetchIdx < 0) return "원격 src를 fetch하는 경로 없음 (canvas.toDataURL 단독 → cross-origin taint)";
  if (canvasIdx >= 0 && canvasIdx < fetchIdx) return "canvas.toDataURL이 fetch보다 먼저 호출됨 (taint 재발)";
  return true;
});

check("cross-origin taint 원인이 주석으로 기록됨", () => {
  if (!/cross-origin|taint|SecurityError/i.test(src)) return "원인 주석 없음";
  return true;
});

// ── (2) 모델 선택 ──
check("Puter 이미지 모델 목록 상수 존재 (PUTER_IMAGE_MODELS)", () => {
  if (!/const PUTER_IMAGE_MODELS\b/.test(src)) return "PUTER_IMAGE_MODELS 상수 미정의";
  return true;
});

check("모델 목록 상수에 문자열 모델 ID가 2개 이상 포함", () => {
  const at = src.indexOf("const PUTER_IMAGE_MODELS");
  if (at < 0) return "상수 없음";
  const end = src.indexOf("];", at);
  if (end < 0) return "배열 종료를 찾지 못함";
  const block = src.slice(at, end);
  const ids = block.match(/"[^"]*[a-z0-9][^"]*"/g) ?? [];
  const modelLike = ids.filter((v) => /-/.test(v) || /\//.test(v));
  if (modelLike.length < 2) return `모델 ID 부족 (${modelLike.length}건)`;
  return true;
});

check("Puter 모델 state(scPuterModel) 정의", () => {
  if (!/const \[scPuterModel, setScPuterModel\] = useState<string>/.test(src)) {
    return "scPuterModel state 없음";
  }
  return true;
});

check("Puter 블록에 모델 선택 select(id=\"scPuterModel\") 존재", () => {
  const at = src.indexOf('id="scPuterModel"');
  if (at < 0) return 'id="scPuterModel" 엘리먼트 없음';
  const back = src.lastIndexOf("<select", at);
  if (back < 0) return "select 엘리먼트가 아님";
  const between = src.slice(back, at);
  if (between.includes("/>") || between.includes("</select>")) return "select 범위 밖";
  return true;
});

check("select 옵션이 PUTER_IMAGE_MODELS에서 파생 (하드코딩 금지)", () => {
  const at = src.indexOf('id="scPuterModel"');
  if (at < 0) return "select 없음";
  const close = src.indexOf("</select>", at);
  const block = close > at ? src.slice(at, close) : "";
  if (!block.includes("PUTER_IMAGE_MODELS.map")) return "PUTER_IMAGE_MODELS.map 미사용";
  return true;
});

check("txt2img 호출에 model 옵션이 전달됨", () => {
  if (!genBody) return "puterGenerateWithAuth 본문 없음";
  if (/\{ model:/.test(genBody)) return true;
  return "txt2img 호출에 model 옵션 전달 없음";
});

check("모델 옵션이 빈 값일 때 옵션 미전달(undefined)로 기본 모델 사용", () => {
  if (!genBody) return "본문 없음";
  if (!/undefined/.test(genBody)) return "빈 모델 처리(undefined) 없음";
  return true;
});

check("Puter 생성 호출부 2곳이 모델을 전달 (단일 생성 + 우선순위)", () => {
  const calls = src.match(/puterGenerateWithAuth\(aiPrompt\)/g) ?? [];
  if (calls.length === 0) {
    const withModel = src.match(/puterGenerateWithAuth\(aiPrompt, scPuterModel\)/g) ?? [];
    if (withModel.length >= 2) return true;
    return `모델 미전달 호출 잔존: ${calls.length}건 / 모델 전달: ${withModel.length}건`;
  }
  return `모델 없이 호출되는 지점 ${calls.length}건 (생성 실패 시 모델 선택 무효)`;
});

check("Puter 블록에 모델 미지정 시 기본 모델 안내 문구 존재", () => {
  if (!/모델을 선택하지 않으면 Puter 기본 모델/.test(src)) return "안내 문구 없음";
  return true;
});

// ── 출력 ──
let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`ok   ${r.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
}
if (failed > 0) {
  console.log(`\n${failed}/${results.length} 항목 실패 (Puter 이미지 계약 미충족)`);
  process.exit(1);
}
console.log(`\n(${results.length}/${results.length} ok) Puter 이미지 생성·모델 선택 계약 통과`);
