#!/usr/bin/env node
// 검증: 이미지 공급자 "검색(Search)" 이 백엔드(코어·IPC)와 프론트(공급자 선택·시나리오 작성)에
// 일관되게 배선되어 있는지 확인한다.
//
// 사용:
//   node scripts/verify-search-provider.mjs              # 현재 작업 트리
//   node scripts/verify-search-provider.mjs --git=HEAD   # 특정 커밋(수정 전 Red 재현)
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const arg = process.argv.find((a) => a.startsWith("--git="));
const rev = arg ? arg.slice("--git=".length) : null;

function readRepoFile(path) {
  if (!rev) return fs.readFileSync(path, "utf8");
  return execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8" });
}

const scenario = readRepoFile("crates/core/src/scenario.rs");
const search = readRepoFile("crates/core/src/search.rs");
const lib = readRepoFile("src-tauri/src/lib.rs");
const app = readRepoFile("src-ui/App.tsx");

/** 이름이 정확히 name 인 함수 본문(중괄호 균형)을 잘라낸다.
 *
 * 접두사가 같은 함수(`generate_ai_with_fallback` vs `_with`,
 * `generate_library_wallpaper_with_provider` vs `_impl`)를 잘못 잡으면
 * 검사 대상 본문이 바뀌어 오탐/누락이 생긴다 — 이름 경계를 강제한다. */
function fnBody(src, name) {
  // Rust(`fn name(`)와 JS(`const name = async () => {` / `useCallback(async () => {`)를
  // 모두 지원한다. 이전 구현은 Rust 시그니처만 찾아 JS 함수 2건을 항상 "" 로 판정했다
  // (오탐 FAIL: body 가 비어 정규식이 절대 매칭되지 않음).
  const re = new RegExp(`fn\\s+${name}\\s*[(<]`);
  let m = re.exec(src);
  let start;
  if (m) {
    start = m.index;
  } else {
    const jsRe = new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`);
    m = jsRe.exec(src);
    start = m ? m.index : -1;
  }
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const checks = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    ok = Boolean(fn());
  } catch (e) {
    detail = String(e && e.message ? e.message : e);
  }
  checks.push({ name, ok, detail });
}

// ── 코어: ImageProvider::Search ──
check("코어 ImageProvider 에 Search variant 가 있다", () => {
  const body = fnBody(scenario, "ImageProvider") || scenario;
  const m = /pub enum ImageProvider \{[\s\S]*?\n\}/.exec(body);
  return m && /\bSearch,/.test(m[0]);
});

check("Search 의 식별자는 'search' 다 (as_id / kebab-case)", () =>
  /ImageProvider::Search => "search"/.test(scenario));

check("generation_source_detail 이 Search 경로를 설명한다", () =>
  /ImageProvider::Search =>/.test(fnBody(scenario, "generation_source_detail")));

// ── 코어: 시나리오 소스에 검색 키워드 ──
check("ScenarioSource 에 search_queries 필드가 있다", () => {
  const m = /pub struct ScenarioSource \{[\s\S]*?\n\}/.exec(scenario);
  return m && /pub search_queries: Vec<String>/.test(m[0]);
});

check("search_queries 는 serde default 로 구버전 JSON 과 호환된다", () => {
  const m = /pub struct ScenarioSource \{[\s\S]*?\n\}/.exec(scenario);
  if (!m) return false;
  const idx = m[0].indexOf("pub search_queries");
  if (idx < 0) return false;
  const before = m[0].slice(0, idx);
  // 필드 직전(문서 주석 포함) 200자 안에 #[serde(default)] 가 있어야 한다.
  return /#\[serde\(default\)\][^;]{0,200}$/s.test(before.slice(-220));
});

// ── 코어: 자격 판정 · 실행 게이트 ──
check("provider_is_configured 가 Search 자격을 판정한다", () => {
  const body = fnBody(scenario, "provider_is_configured");
  return /ImageProvider::Search =>/.test(body);
});

check("should_run 이 search_queries 만으로도 실행 조건을 만족시킨다", () => {
  const body = fnBody(scenario, "should_run");
  return /search_queries/.test(body);
});

// ── 코어: 실행 경로(폴백 · tick) ──
check("generate_ai_with_fallback 이 Search 분기를 명시한다", () => {
  const body = fnBody(scenario, "generate_ai_with_fallback");
  return /ImageProvider::Search =>/.test(body);
});

check("search_query_for 가 저장 키워드를 공용 프롬프트보다 우선한다", () => {
  const body = fnBody(scenario, "search_query_for");
  if (!body) return false;
  const keywordIdx = body.indexOf("valid_search_queries");
  const promptIdx = body.indexOf("prompt.trim()");
  // 키워드 목록 검사를 먼저 하고, 프롬프트는 폴백으로만 쓰여야 한다.
  return keywordIdx >= 0 && promptIdx > keywordIdx;
});

check("provider_is_configured 의 Search 가 프롬프트만으로도 자격을 인정한다", () => {
  const body = fnBody(scenario, "provider_is_configured");
  const arm = /ImageProvider::Search => \{[\s\S]*?\n        \}/.exec(body);
  return Boolean(arm) && /search_queries/.test(arm[0]) && /settings\.prompt/.test(arm[0]);
});

check("generate_ai_with_fallback_with 가 Search 에 키워드 기반 질의를 전달한다", () => {
  const body = fnBody(scenario, "generate_ai_with_fallback_with");
  return /search_query_for/.test(body) && /attempt\(provider, &query/.test(body);
});

check("tick_scenario 가 검색 소스 분기를 갖는다", () => {
  const body = fnBody(scenario, "tick_scenario");
  return /search_queries/.test(body) && /generate_search_wallpaper/.test(body);
});

// ── search 모듈: 검색 결과를 파일로 확정 ──
check("search.rs 가 generate_search_wallpaper 를 공개한다", () =>
  /pub fn generate_search_wallpaper/.test(search));

check("generate_search_wallpaper 는 온라인 검색을 사용한다", () => {
  const body = fnBody(search, "generate_search_wallpaper");
  return /search_online_wallpapers/.test(body);
});

check("코어 facade(lib.rs)가 generate_search_wallpaper 를 재export 한다", () => {
  const coreLib = readRepoFile("crates/core/src/lib.rs");
  return /generate_search_wallpaper/.test(coreLib);
});

// ── IPC: ② 생성이 검색 공급자를 분기한다 ──
check("generate_library_wallpaper_with_provider 가 'search' 를 분기한다", () => {
  const body = fnBody(lib, "generate_library_wallpaper_with_provider_impl");
  return /"search"\s*=>/.test(body);
});

// ── 프론트: 공급자 선택 ──
check("ProviderId 유니온에 \"search\" 가 있다", () =>
  /type ProviderId =[^;]*"search"/.test(app));

check("PROVIDERS 목록에 search 항목이 있다", () =>
  /\{\s*id:\s*"search"/.test(app));

// ── 프론트: 시나리오 작성 UI ──
check("ScenarioSettings(source) 타입에 search_queries 가 있다", () => {
  const m = /source:\s*\{[^}]*\}/.exec(app);
  return m && /search_queries/.test(m[0]);
});

check("검색 키워드 입력(textarea #scSearchQueries)이 있다", () =>
  /id="scSearchQueries"/.test(app));

check("저장 payload 가 search_queries 를 전달한다", () => {
  const body = fnBody(app, "handleSaveScenario");
  return /search_queries/.test(body);
});

check("시나리오 조회가 search_queries 를 복원한다", () => {
  const body = fnBody(app, "refreshScenario");
  return /search_queries/.test(body);
});

// ── Rust 단위 테스트(구버전 JSON 호환) ──
check("구버전 scenario.json(search_queries 없음) 호환 테스트가 있다", () =>
  /search_queries[\s\S]{0,400}legacy|legacy[\s\S]{0,400}search_queries/.test(scenario) &&
  /fn test_search_queries_/.test(scenario));

let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`  ok   ${c.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} 통과${rev ? ` (rev=${rev})` : ""}`);
process.exit(failed === 0 ? 0 : 1);
