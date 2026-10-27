#!/usr/bin/env node
// ② 생성 버튼의 검색(Search) 분기 계약 검증 — 공급자="search" 일 때 ② 버튼의 기대 동작을 고정한다.
//
// 배경(결함): handleGenerate 에 provider="search" 분기가 없어
//   ① 검색 공급자를 선택해도 ② 버튼이 "생성 (검색 …)" 으로 남아 무엇을 하는지 불명확했고
//   ② 시나리오 ⑤에 저장한 검색 키워드 목록이 무시된 채 프롬프트만 검색어로 쓰였으며
//   ③ 프롬프트가 비면 키워드가 있어도 "프롬프트를 입력하세요" 로 막혔다.
//
// 계약: 검색 공급자 선택 시 ② 버튼은 "검색 실행 (Search)" 로 분기하고,
//       검색어는 ⑤ 키워드(첫 항목) → 프롬프트 순으로 해석하며, 배경 적용은 하지 않는다(후보만).
//
// 사용: node scripts/verify-search-generate-button.mjs [--git=<rev>]
//   --git 지정 시 `git show <rev>:<path>` 로 과거 소스를 검사한다(Red 재현용).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "src-ui/App.tsx";
const gitArg = process.argv.find((a) => a.startsWith("--git="));
const gitRev = gitArg ? gitArg.slice("--git=".length) : null;
const app = gitRev
  ? execFileSync("git", ["show", `${gitRev}:${APP}`], { encoding: "utf8" })
  : fs.readFileSync(APP, "utf8");

console.log(`검사 대상: ${gitRev ? `${gitRev}:` : ""}${APP}`);

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

check("검색 공급자는 ② 생성 핸들러에서 전용 분기로 처리한다", () =>
  /scProvider\s*===\s*"search"/.test(gen));

check('검색 분기는 백엔드 검색 커맨드를 provider "search" 로 호출한다', () =>
  /"generate_library_wallpaper_with_provider"[\s\S]{0,320}?provider:\s*"search"/.test(gen));

check("검색어는 ① 검색 영역의 검색어만 쓴다(프롬프트 대체 없음)", () =>
  /const keyword = searchKeywords\[0\];/.test(gen) &&
  !/searchKeywords\[0\] : aiPrompt/.test(gen));

check("검색 공급자는 프롬프트가 아니라 검색어 유무로 입력을 판정한다", () =>
  /if \(scProvider === "search"\) \{\s*if \(searchKeywords\.length === 0\)/.test(gen));

check("검색 분기는 배경을 적용하지 않고 후보만 추가한다", () => {
  const i = gen.indexOf('if (scProvider === "search")');
  if (i === -1) return false;
  const body = gen.slice(i, i + 1400);
  return (
    /setSelected\(candidate\)/.test(body) &&
    !/apply_generated_image|generate_wallpaper_priority/.test(body)
  );
});

check("검색 분기는 검색어 출처를 사용자에게 알린다", () =>
  /검색 완료 \(Search\)/.test(gen));

// ── ② 버튼 렌더링 ──
check("② 버튼 라벨이 검색일 때 '검색 실행 (Search)' 로 바뀐다", () =>
  /"검색 실행 \(Search\)"/.test(app));

check("② 버튼 라벨은 다른 공급자에서 생성(공급자) 표기를 유지한다", () => {
  const m = app.match(/onClick=\{\(\) => void handleGenerate\(\)\}[\s\S]{0,200}?<\/button>/);
  return Boolean(m) && /providerLabel\(scProvider\)/.test(m[0]);
});

check("② 버튼은 검색 입력(키워드·프롬프트)이 모두 없으면 비활성화된다", () => {
  const m = app.match(/onClick=\{\(\) => void handleGenerate\(\)\}[\s\S]{0,200}?<\/button>/);
  return Boolean(m) && /disabled=\{[^}]*searchNeedsInput[^}]*\}/.test(m[0]);
});

check("searchNeedsInput 은 검색 공급자 + 검색어 공백 조건으로 정의된다(프롬프트 미관여)", () => {
  const i = app.indexOf("const searchNeedsInput");
  if (i === -1) return false;
  const decl = app.slice(i, i + 200).split(";")[0];
  return (
    /scProvider === "search"/.test(decl) &&
    /searchKeywords\.length === 0/.test(decl) &&
    !/prompt\.trim\(\)/.test(decl)
  );
});

// ── 다른 공급자 회귀 없음 ──
check("Puter 분기(puterGenerateWithAuth)는 그대로 유지된다", () =>
  /scProvider\s*===\s*"puter"/.test(gen) && /puterGenerateWithAuth/.test(gen));

check("비-Puter 공급자는 백엔드로 선택 공급자를 전달한다(provider: scProvider)", () =>
  /provider:\s*scProvider/.test(gen));

check("OpenAI/Cloudflare 자격증명 분기가 그대로 유지된다", () =>
  /scOpenaiKey\.trim\(\)/.test(gen) && /scCfToken\.trim\(\)/.test(gen));

const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `${results.length}항목 전부 ok — 검색 공급자 ② 버튼 계약 통과`
    : `${failed} FAIL / ${results.length - failed} ok — 검색 공급자 ② 버튼 계약 미충족`,
);
process.exit(failed === 0 ? 0 : 1);
