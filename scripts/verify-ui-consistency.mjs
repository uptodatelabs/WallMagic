#!/usr/bin/env node
// scripts/verify-ui-consistency.mjs — UI 일관성 계약 검증 (정적 구조)
// 계약:
//   1) 프롬프트 입력 엘리먼트는 정확히 1곳(#prompt) — #scPrompt 등 중복 입력 금지 (공용 프롬프트 단일화)
//   2) 이미지 공급자 목록은 단일 상수 PROVIDERS에서 파생 — select 옵션과 우선순위 목록이 같은 소스를 참조
//   3) PROVIDERS는 4개 공급자(pollinations/puter/cloudflare-workers-ai/openai)를 포함 — 선택지 집합 == 우선순위 집합
//   4) 우선순위 기본값(FREE_FIRST_ORDER)도 같은 소스에서 파생 — puter 누락 금지
//   5) 우선순위 목록 라벨은 providerLabel(PROVIDERS)에서 파생 — 하드코딩 라벨 3항 연산자 금지(puter 라벨 누락 방지)
//   6) 우선순위 생성(handleGeneratePriority)은 화면 순서대로 실제 시도 — puter(브라우저 SDK) 분기 포함
// 실행: node scripts/verify-ui-consistency.mjs  (불일치 시 exit 1)
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src-ui/App.tsx", import.meta.url), "utf8");
const failures = [];
const check = (name, ok, detail) => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL ${name} — ${detail}`);
  }
};

// 1. 프롬프트 입력 단일화
const promptIds = [...src.matchAll(/id="([A-Za-z]*[Pp]rompt[A-Za-z]*)"/g)].map((m) => m[1]);
check(
  '프롬프트 입력 엘리먼트 단일화 (id="prompt" 1곳, 중복 입력·상태 없음)',
  promptIds.filter((v) => v === "prompt").length === 1 &&
    !src.includes("scPrompt") &&
    !src.includes('htmlFor="prompt"') === false ? true : promptIds.filter((v) => v === "prompt").length === 1 && !src.includes("scPrompt"),
  `발견된 prompt id: ${JSON.stringify(promptIds)}`
);

// 2. PROVIDERS 단일 상수 정의
const providersDefs = src.match(/const PROVIDERS\s*[:=]/g) ?? [];
check("PROVIDERS 단일 상수 정의(1회)", providersDefs.length === 1, `정의 ${providersDefs.length}회`);

// 3. PROVIDERS가 4개 공급자를 모두 포함
const providersBlock = src.split("const PROVIDERS")[1]?.split("];")[0] ?? "";
for (const id of ["pollinations", "puter", "cloudflare-workers-ai", "openai"]) {
  check(`PROVIDERS에 "${id}" 포함`, providersBlock.includes(`"${id}"`), `PROVIDERS 블록: ${providersBlock.slice(0, 120)}`);
}

// 4. select 옵션·우선순위 목록이 PROVIDERS를 참조 (공급자 option 하드코딩 금지)
const hardcoded = [...src.matchAll(/<option value="(pollinations|puter|cloudflare-workers-ai|openai)">/g)];
check(
  "공급자 select 하드코딩 option 제거(PROVIDERS.map 참조)",
  hardcoded.length === 0 && (src.match(/PROVIDERS\.map/g) ?? []).length >= 2,
  `하드코딩 option ${hardcoded.length}건 / PROVIDERS.map ${(src.match(/PROVIDERS\.map/g) ?? []).length}회 (select+기본값 각 1회 이상 필요)`
);

// 5. 우선순위 기본값이 puter를 포함한 동일 집합에서 파생
const ff = src.split("FREE_FIRST_ORDER")[1]?.split(";")[0] ?? "";
check(
  "FREE_FIRST_ORDER가 puter 포함 집합에서 파생",
  /PROVIDERS\.map/.test(ff) || ff.includes('"puter"'),
  `FREE_FIRST_ORDER 정의부: ${ff.trim().slice(0, 100)}`
);

// 6. 우선순위 목록 라벨이 PROVIDERS에서 파생 (하드코딩 3항 연산자 금지 — puter가 "OpenAI"로 오라벨링되는 현상 방지)
check(
  "우선순위 목록 라벨이 providerLabel(PROVIDERS)에서 파생",
  src.includes("{providerLabel(p)}") && !src.includes('p === "pollinations" ?'),
  "우선순위 행에 하드코딩 라벨 3항 연산자가 남아 있음 (providerLabel 미사용)"
);

// 7. 우선순위 생성 체인에 puter 분기 포함 (화면 순서 = 실제 시도 순서 보장)
const prBody = src.split("const handleGeneratePriority")[1]?.split("const handleTickScenario")[0] ?? "";
check(
  "handleGeneratePriority가 puter를 실제 시도 순서에 포함(브라우저 SDK 분기)",
  prBody.includes('id === "puter"'),
  `handleGeneratePriority 본문에 puter 분기 없음: ${prBody.slice(0, 120)}`
);

// 8. Puter 세션 연결 헬퍼: 생성 전 미인증이면 puter.auth.signIn() 로그인 팝업
check(
  "ensurePuterSession이 puter.auth.isSignedIn 체크 + signIn 로그인 팝업 호출",
  /async function ensurePuterSession/.test(src) &&
    src.includes("auth.isSignedIn") &&
    src.includes("auth.signIn"),
  "ensurePuterSession 헬퍼 미정의 또는 auth.isSignedIn/auth.signIn 호출 누락"
);

// 8-2. isSignedIn 안전 래퍼 — SDK가 동기 boolean을 반환해도 동작해야 한다.
//      `auth.isSignedIn().catch(...)` 직접 체이닝은
//      `TypeError: auth.isSignedIn(...).catch is not a function`을 유발하므로 금지.
//      puterIsSignedIn() 래퍼(Promise.resolve 정규화 + try/catch)를 경유할 것.
check(
  "ensurePuterSession이 동기·비동기 안전 래퍼 puterIsSignedIn 사용 (.catch 직접 체이닝 금지)",
  /async function puterIsSignedIn/.test(src) &&
    src.includes("Promise.resolve") &&
    !/isSignedIn\(\)\.catch\(/.test(src),
  "puterIsSignedIn 래퍼 미정의 또는 isSignedIn().catch 직접 체이닝 잔존"
);

// 9. 생성 헬퍼가 세션 보장 → txt2img → 인증 오류 시 signIn 후 재시도
//    구현 설계상 signIn 호출은 ensurePuterSession에 위임되므로 본문 리터럴 "signIn"이 아니라
//    (a) ensurePuterSession 호출(사전 세션 보장) + (b) txt2img 생성 + (c) catch 재시도 분기
//    (ensurePuterSession 재호출 2회 = 사전 1회 + 재시도 1회)를 요구한다.
const genHelper = src.split("async function puterGenerateWithAuth")[1]?.split("\nfunction ")[0] ?? "";
check(
  "puterGenerateWithAuth가 세션 보장 후 생성하고 인증 오류 시 재시도",
  genHelper.includes("ensurePuterSession") &&
    genHelper.includes("txt2img") &&
    /catch/.test(genHelper) &&
    (genHelper.match(/ensurePuterSession\(\)/g) ?? []).length >= 2,
  `puterGenerateWithAuth 본문: ${genHelper.slice(0, 120)}`
);

// 10. 실제 생성 지점은 헬퍼 경유 — 핸들러 내 직접 txt2img 호출 금지(로그인 미연결로 생성이 안 되던 현상 방지)
//     헬퍼는 이제 모델 옵션 유무를 `call` 클로저로 분기하므로 `await txt2img(` 형태가 아니라
//     `txt2img(...)` 두 형태(모델 지정/기본)로 나타난다. 따라서 "await txt2img(" 개수가 아니라
//     "전체 파일의 txt2img( 호출이 모두 헬퍼 본문 안에 있는가"로 검사한다.
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
const genCallCount = (src.match(/puterGenerateWithAuth\(/g) ?? []).length;
const helperTxt2imgBody = bodyOf("async function puterGenerateWithAuth");
const allTxt2img = (src.match(/\btxt2img\(/g) ?? []).length;
const helperTxt2img = (helperTxt2imgBody.match(/\btxt2img\(/g) ?? []).length;
check(
  "생성 지점이 puterGenerateWithAuth 경유 (핸들러 내 직접 txt2img 호출 금지)",
  genCallCount >= 3 && helperTxt2img >= 2 && allTxt2img === helperTxt2img,
  `helper 참조 ${genCallCount}회(정의+생성지점 2) / 전체 txt2img 호출 ${allTxt2img}회 중 헬퍼 내부 ${helperTxt2img}회 (전체 == 헬퍼 내부여야 함)`
);

// 11. 수동 로그인 버튼 노출 (생성 전 세션 연결 가능)
check(
  "Puter 블록에 수동 로그인 버튼(세션 연결) 존재",
  src.includes("Puter 로그인") && src.includes("handlePuterSignIn"),
  "Puter 블록에 로그인 버튼/handlePuterSignIn 없음"
);

if (failures.length > 0) {
  console.error(`\n${failures.length}건 불일치 — UI 일관성 계약 위반`);
  process.exit(1);
}
console.log("\nUI 일관성 계약 통과");
