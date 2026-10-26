#!/usr/bin/env node
// 공급자 라우팅 계약 검증 — ② 생성 버튼이 "선택한 공급자"로 이미지를 생성하는지 검사한다.
//
// 배경(결함): `handleGenerate` 가 `generate_library_wallpaper`(코어 하드코딩 Pollinations)만
// 호출해, 이미지 공급자를 Puter/Cloudflare/OpenAI 로 설정해도 ② 생성은 항상 Pollinations
// 결과를 만들었다. 사용자는 "설정된 공급자로 생성되지 않는다"고 신고했다.
//
// 검사 대상:
//   - src-ui/App.tsx  handleGenerate 본문 / ② 생성 버튼 라벨
//   - src-tauri/src/lib.rs  generate_library_wallpaper_with_provider / save_generated_image 커맨드
//
// 사용: node scripts/verify-provider-routing.mjs [--git=<rev>]
//   --git 지정 시 `git show <rev>:<path>` 로 과거 소스를 검사한다(Red 재현용).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "src-ui/App.tsx";
const LIB = "src-tauri/src/lib.rs";

const gitArg = process.argv.find((a) => a.startsWith("--git="));
const gitRev = gitArg ? gitArg.slice("--git=".length) : null;

function readSource(path) {
  if (!gitRev) return fs.readFileSync(path, "utf8");
  return execFileSync("git", ["show", `${gitRev}:${path}`], { encoding: "utf8" });
}

const app = readSource(APP);
const lib = readSource(LIB);

console.log(`검사 대상: ${gitRev ? `${gitRev}:` : ""}${APP} , ${gitRev ? `${gitRev}:` : ""}${LIB}`);

/** `const name = async () => { ... }` 본문을 중괄호 균형으로 추출한다. */
function sliceAsyncFn(src, name) {
  const marker = `const ${name} = async () => {`;
  const start = src.indexOf(marker);
  if (start === -1) return "";
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const results = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    ok = Boolean(fn());
  } catch (e) {
    detail = e.message;
  }
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const gen = sliceAsyncFn(app, "handleGenerate");

check("handleGenerate 본문을 추출한다", () => gen.length > 0);

check("② 생성은 선택 공급자(puter)를 Puter SDK 경로로 분기한다", () => {
  return /scProvider\s*===\s*"puter"/.test(gen) && /puterGenerateWithAuth/.test(gen);
});

check("② 생성은 Puter 결과를 라이브러리 후보로 저장한다(save_generated_image)", () => {
  return /"save_generated_image"/.test(gen);
});

check("② 생성은 비-Puter 공급자를 백엔드로 넘긴다(generate_library_wallpaper_with_provider)", () => {
  return /"generate_library_wallpaper_with_provider"/.test(gen) && /provider:\s*scProvider/.test(gen);
});

check("② 생성이 무조건 Pollinations 하드코딩 호출만 하지 않는다", () => {
  // 분기 없이 generate_library_wallpaper 만 호출하는 형태(결함)를 배제한다.
  const hardcodedOnly =
    /"generate_library_wallpaper"/.test(gen) &&
    !/"generate_library_wallpaper_with_provider"/.test(gen);
  return !hardcodedOnly;
});

check("생성 완료 메시지가 실제 사용 공급자를 표시한다", () => {
  return /providerLabel\(scProvider\)/.test(gen);
});

check("② 생성 버튼 라벨이 선택 공급자를 보여준다", () => {
  const m = app.match(/onClick=\{\(\) => void handleGenerate\(\)\}[\s\S]{0,200}?<\/button>/);
  if (!m) return false;
  return /providerLabel\(scProvider\)/.test(m[0]);
});

check("백엔드에 generate_library_wallpaper_with_provider 커맨드가 있다", () => {
  return /fn generate_library_wallpaper_with_provider\s*\(/.test(lib);
});

check("백엔드에 save_generated_image 커맨드가 있다", () => {
  return /fn save_generated_image\s*\(/.test(lib);
});

check("두 커맨드가 generate_handler 에 등록되어 있다", () => {
  return (
    /generate_library_wallpaper_with_provider,/.test(lib) &&
    /save_generated_image,/.test(lib)
  );
});

check("미지원 공급자는 명시적 오류로 실패한다(조용한 폴스루 금지)", () => {
  return /unknown provider/.test(lib) && /Puter는 WebView/.test(lib);
});

check("Cloudflare/OpenAI 생성 후 사이드카에 공급자를 기록한다", () => {
  return /write_generation_sidecar\(&dest,\s*Some\(provider\)/.test(lib);
});

check("② 생성의 save_generated_image 호출은 label(공급자 id)을 전달한다", () => {
  // 계약: label 을 **생략하지 않고 명시 전달**한다(무라벨 → 백엔드가 오귀속).
  // 리터럴 "puter" 뿐 아니라, `scProvider === "puter"` 분기에서 타입이 좁혀진
  // `label: scProvider` 도 같은 계약을 만족한다 (선택값을 그대로 전달).
  return /"save_generated_image"[\s\S]{0,300}?label:\s*(?:"[^"]+"|scProvider)/.test(gen);
});

check("save_generated_image 는 무라벨 호출을 명시적 오류로 거부한다", () => {
  return /save_generated_image: label\(공급자 id\)이 필요합니다/.test(lib);
});

check("save_generated_image 파일명 접두어가 라벨에서 파생된다(puter_ 고정 아님)", () => {
  // 파일 경로만 보고 공급자를 오판하지 않도록 접두어를 라벨에서 만든다.
  return /format!\("generated_\{safe\}_\{hash:08x\}\.png"\)/.test(lib);
});

// --- 자격증명 분리 계약 (검수 지적 [high]) -------------------------------------
// 결함: handleGenerate 가 비-Puter 분기에서 `apiToken` 에 **항상 scCfToken** 을 전달했다.
//  → (1) OpenAI 키(scOpenaiKey)를 입력해도 전달되지 않아 실패.
//  → (2) Cloudflare 토큰 입력란이 비어 있지 않으면 OpenAI 인증에 그 토큰이 전달되어 인증 오류.
check("OpenAI 선택 시 자격증명은 scOpenaiKey 에서 온다(Cloudflare 토큰 오전달 금지)", () => {
  return /scProvider\s*===\s*"openai"\s*\?\s*scOpenaiKey\.trim\(\)/.test(gen);
});

check("Cloudflare 선택 시 자격증명은 scCfToken 에서 온다", () => {
  return /scProvider\s*===\s*"cloudflare-workers-ai"\s*\?\s*scCfToken\.trim\(\)/.test(gen);
});

check("apiToken 에 scCfToken 을 무조건 전달하지 않는다(공급자 무관 고정 전달 금지)", () => {
  return !/apiToken:\s*scCfToken\.trim\(\)/.test(gen);
});

check("자격증명이 비면 null 을 보내 백엔드 저장값 폴백 계약을 유지한다", () => {
  return /apiToken:\s*credential\s*\?\s*credential\s*:\s*null/.test(gen);
});

// 백엔드 교차 누수 금지: openai 분기는 openai.api_key 만, cloudflare 분기는
// cloudflare.api_token 만 읽는다(서로의 자격증명을 대신 쓰지 않는다).
check("백엔드 openai 분기는 openai.api_key 만 폴백으로 읽는다", () => {
  const i = lib.indexOf('"openai" => {');
  if (i === -1) return false;
  const body = lib.slice(i, i + 900);
  return /s\.openai\.api_key/.test(body) && !/s\.cloudflare\.api_token/.test(body);
});

check("백엔드 cloudflare 분기는 cloudflare.api_token 만 폴백으로 읽는다", () => {
  const i = lib.indexOf('"cloudflare-workers-ai" => {');
  if (i === -1) return false;
  const body = lib.slice(i, i + 900);
  return /s\.cloudflare\.api_token/.test(body) && !/s\.openai\.api_key/.test(body);
});

const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `${results.length}항목 전부 ok — 공급자 라우팅 계약 통과`
    : `${failed} FAIL / ${results.length - failed} ok — 공급자 라우팅 계약 미충족`,
);
process.exit(failed === 0 ? 0 : 1);
