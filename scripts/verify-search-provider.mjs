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
// 이번 커밋에서 코어 구현을 `generate_ai_with_fallback_with_query`(3-튜플)로 옮기고
// `generate_ai_with_fallback` 은 위임 래퍼가 되었다. 검사 이름을 실제 구현으로 맞춘다
// (이름이 어긋나면 fnBody 가 "" 를 반환해 항상 FAIL 하는 오탐이 난다 — 이번 실행에서 실제로 발생).
check("네트워크 시도 함수(generate_ai_with_fallback_query)가 Search 분기를 명시한다", () => {
  const body = fnBody(scenario, "generate_ai_with_fallback_query");
  return /ImageProvider::Search =>/.test(body);
});

check("2-튜플 generate_ai_with_fallback 은 3-튜플 _query 판에 위임한다(질의문 재계산 금지)", () => {
  const body = fnBody(scenario, "generate_ai_with_fallback");
  return /generate_ai_with_fallback_query\s*\(/.test(body);
});

check("search_query_for 는 검색어 단독 소스이고 프롬프트 인자를 받지 않는다", () => {
  const body = fnBody(scenario, "search_query_for");
  if (!body) return false;
  // 시그니처: (settings, seed) — 프롬프트 파라미터가 없어야 한다.
  const sig = /pub fn search_query_for\(([^)]*)\)/.exec(scenario);
  if (!sig) return false;
  const hasPromptParam = /\bprompt\b/.test(sig[1]);
  // 본문은 검색어 목록만 보고, 프롬프트 폴백 분기가 없어야 한다.
  return (
    !hasPromptParam &&
    /valid_search_queries/.test(body) &&
    !/prompt/.test(body.replace(/\/\/[^\n]*/g, ""))
  );
});

check("provider_is_configured 의 Search 는 프롬프트를 보지 않고 검색어만 검사한다", () => {
  const body = fnBody(scenario, "provider_is_configured");
  // Search arm 은 블록이 아니라 식(expression) 형태다.
  const arm = /ImageProvider::Search =>([\s\S]*?)\n\s*(\/\/|ImageProvider::Puter)/.exec(body);
  if (!arm) return false;
  const code = arm[1].replace(/\/\/[^\n]*/g, "");
  return /search_queries/.test(code) && !/settings\.prompt/.test(code);
});

check("generate_ai_with_fallback_with_query 가 Search 에 키워드 기반 질의를 전달하고 실제 사용 질의문을 반환한다", () => {
  const body = fnBody(scenario, "generate_ai_with_fallback_with_query");
  return (
    /search_query_for/.test(body) &&
    /attempt\(provider, &query/.test(body) &&
    /Ok\(p\)\s*=>\s*return\s+Ok\(\(\s*provider,\s*p,\s*query\s*\)\)/.test(body)
  );
});

check("generate_ai_with_fallback_with_query 가 Search 자격을 공급자 단일 판정 헬퍼로만 결정한다", () => {
  const body = fnBody(scenario, "generate_ai_with_fallback_with_query");
  // Search 전용 자격 분기(|| !trimmed.is_empty())가 남아 있으면 프롬프트가 자격에 관여한다.
  return (
    /provider_is_configured\(settings,\s*provider\)/.test(body) &&
    !/\|\|\s*!trimmed\.is_empty\(\)/.test(body)
  );
});

check("tick_scenario 상단 AI 분기가 Search 채택 시 실제 검색어(used_query)를 기록하고 next_index 를 모듈로 순환한다", () => {
  const body = fnBody(scenario, "tick_scenario");
  const topBranch = body.split("if settings.prompt.trim().is_empty()")[0] || "";
  return (
    /used\s*==\s*ImageProvider::Search/.test(topBranch) &&
    /query:\s*\{used_query\}/.test(topBranch) &&
    /wrapping_add\(1\)\s*%\s*query_count/.test(topBranch)
  );
});

check("generate_wallpaper_priority_impl 이 Search 채택 시 실제 검색어(used_query)를 기록하고 next_index 를 모듈로 순환·저장한다", () => {
  const body = fnBody(lib, "generate_wallpaper_priority_impl");
  return (
    /used\s*==\s*wallmagic_core::ImageProvider::Search/.test(body) &&
    /query:\s*\{used_query\}/.test(body) &&
    /wrapping_add\(1\)\s*%\s*query_count/.test(body) &&
    /save_scenario\(&settings\)/.test(body)
  );
});

check("검색어가 비면 프롬프트가 있어도 Search 를 시도하지 않는 회귀 테스트가 있다(프롬프트 폴백 금지)", () => {
  const body = fnBody(scenario, "test_search_never_falls_back_to_prompt");
  return (
    /assert!\(s\.source\.search_queries\.is_empty\(\)\)/.test(body) &&
    /generate_ai_with_fallback_with\(&s,\s*"manual keyword"/.test(body) &&
    /expect_err/.test(body)
  );
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

check("② 생성·적용(handleGenerateAi) 검색 분기가 백엔드가 실제 사용한 검색어를 표기한다", () => {
  // 백엔드(generate_wallpaper_priority_impl)는 search_query_for 로 키워드를 순환하므로
  // UI 가 넘긴 prompt 를 그대로 표기하면 실제 검색어와 어긋난다.
  // 적용 기록(state.source)의 "· query: <실제 검색어>" 를 읽어 표기해야 한다.
  const body = fnBody(app, "handleGenerateAi");
  const module = readRepoFile("src-ui/appliedQuery.ts");
  return (
    /import\s*\{\s*parseAppliedSearchQuery\s*\}\s*from\s*"\.\/appliedQuery"/.test(app) &&
    /parseAppliedSearchQuery\(\s*state\.source\s*\)/.test(body) &&
    /appliedQuery/.test(body) &&
    /QUERY_MARKER\s*=\s*"· query:"/.test(module) &&
    /TRAILING_PRIORITY_SUFFIX/.test(module)
  );
});

check("② 생성은 검색 공급자를 실행하지 않는다(검색 실행 지점은 ① 검색 하나)", () => {
  // 사용자 지시("검색은 검색 창에서 설정, 생성은 생성 창에서 설정")에 따라 ② 생성 영역의
  // 검색 실행 분기를 제거했다. ② 가 provider:"search" 로 백엔드 검색을 호출하면 검색
  // 액션이 두 곳에 중복되고, 그 버튼이 이미지 검색어에 반응해 혼동을 만든다.
  const body = fnBody(app, "handleGenerate");
  return (
    /scProvider === "search"/.test(body) &&
    /① 검색/.test(body) &&
    !/provider:\s*"search"/.test(body)
  );
});

check("① 검색 [검색] 은 키워드를 회전 없이 그대로 넘겨 표기=실제가 된다", () => {
  const body = fnBody(app, "handleSearch");
  const backend = fnBody(lib, "generate_library_wallpaper_with_provider_impl");
  const searchArm = /"search"\s*=>\s*\{[\s\S]*?\n        \}/.exec(backend);
  return (
    /invoke<SearchResult>\("search_wallpapers"/.test(body) &&
    /\bquery,/.test(body) &&
    Boolean(searchArm) &&
    /generate_search_wallpaper\(trimmed_prompt/.test(searchArm[0]) &&
    !/search_query_for/.test(searchArm[0])
  );
});

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
