#!/usr/bin/env node
// seed 정책 계약 검증.
//
// 배경: Pollinations 는 **같은 URL(프롬프트+파라미터)** 에 대해 캐시된 동일 이미지를 돌려준다.
// 이 앱은 요청 URL 에 `seed` 를 전혀 붙이지 않았으므로(수정 전 실측: `?width=1920&height=1080&nologo=true`
// 만 존재) 같은 프롬프트로 생성하면 매번 똑같은 이미지가 나왔다. 이 스크립트는
// (1) seed 가 요청 파라미터로 실제 전달되는지, (2) seed 미지원 공급자에 보내지 않는지,
// (3) 기본값이 random 인지, (4) UI 에서 고정/순차/랜덤을 고를 수 있는지를 소스 계약으로 고정한다.
//
// 사용: node scripts/verify-seed.mjs
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const results = [];
const check = (name, cond, detail = "") => results.push({ name, ok: !!cond, detail });

const wallpaper = read("crates/core/src/wallpaper.rs");
const scenario = read("crates/core/src/scenario.rs");
const coreLib = read("crates/core/src/lib.rs");
const appLib = read("src-tauri/src/lib.rs");
const app = read("src-ui/App.tsx");

// ── 1) Pollinations: seed 가 URL 쿼리로 전달된다 ──────────────────────────────
check(
  "pollinations_image_url(prompt, seed) 순수 함수가 있다",
  /pub fn pollinations_image_url\s*\(\s*prompt:\s*&str\s*,\s*seed:\s*Option<u64>\s*\)\s*->\s*String/.test(
    wallpaper,
  ),
);
check(
  "pollinations URL 은 seed 가 있을 때 &seed={s} 를 붙인다",
  /url\.push_str\(\s*&format!\("&seed=\{s\}"\)\s*\)/.test(wallpaper),
);
// 402 재시도 정책 도입으로 URL 조립이 `_with_policy` 로 이동하고 `_with_seed` 는
// 기본 정책을 넘기는 얇은 래퍼가 되었다. 검사 대상도 "seed 가 URL 조립 지점까지
// 전달되는가"로 바꾼다 — 위임 함수를 계속 검사하면 본문이 비어 항상 FAIL 하는 오탐이 난다.
check(
  "generate_online_wallpaper_with_seed 가 seed 를 URL 생성에 넘긴다",
  /pub fn generate_online_wallpaper_with_seed\s*\([\s\S]{0,700}?generate_online_wallpaper_with_policy\s*\(/.test(
    wallpaper,
  ) &&
    /pub fn generate_online_wallpaper_with_policy\s*\([\s\S]{0,900}?pollinations_image_url\(\s*trimmed\s*,\s*seed\s*\)/.test(
      wallpaper,
    ),
);
check(
  "기존 generate_online_wallpaper 는 seed=None 위임 래퍼다(하위호환)",
  /pub fn generate_online_wallpaper\s*\([\s\S]{0,300}?generate_online_wallpaper_with_seed\(\s*prompt\s*,\s*None\s*,/.test(
    wallpaper,
  ),
);

// ── 2) SeedMode: 기본값 random + 구 JSON 호환 ────────────────────────────────
check(
  "SeedMode enum 에 Fixed/Incremental/Random 이 있다",
  /pub enum SeedMode\s*\{[\s\S]{0,200}?Fixed[\s\S]{0,80}?Incremental[\s\S]{0,80}?Random/.test(scenario),
);
check(
  "SeedMode 기본값은 Random 이다(같은 프롬프트 = 같은 이미지 제거)",
  /#\[default\]\s*\n\s*Random,/.test(scenario),
);
check(
  "ScenarioSettings 에 seed_mode/seed_fixed/seed_next 가 serde default 로 있다",
  /#\[serde\(default\)\]\s*\n\s*pub seed_mode:\s*SeedMode/.test(scenario) &&
    /#\[serde\(default\)\]\s*\n\s*pub seed_fixed:\s*u64/.test(scenario) &&
    /#\[serde\(default\)\]\s*\n\s*pub seed_next:\s*u64/.test(scenario),
);
check(
  "Default 구현이 seed_mode: SeedMode::Random 을 넣는다",
  /seed_mode:\s*SeedMode::Random/.test(scenario),
);

// ── 3) seed 결정·전진 순수 함수 ───────────────────────────────────────────────
check(
  "next_seed_value(mode, fixed, counter, now) 순수 함수가 있다",
  /pub fn next_seed_value\s*\(\s*mode:\s*SeedMode\s*,\s*fixed:\s*u64\s*,\s*counter:\s*u64\s*,\s*now_secs:\s*u64\s*\)\s*->\s*u64/.test(
    scenario,
  ),
);
// Random 값은 API 지원 범위(1..=SEED_MAX)로 정규화된다 — `normalize_seed(mix_seed(..))`.
// Fixed/Incremental 은 사용자가 지정한 값 그대로(항등)여야 "고정 seed"·"카운터 순차" 약속이 지켜진다.
check(
  "Fixed 는 고정값, Incremental 은 카운터, Random 은 시각+카운터 혼합",
  /SeedMode::Fixed\s*=>\s*fixed/.test(scenario) &&
    /SeedMode::Incremental\s*=>\s*counter/.test(scenario) &&
    /SeedMode::Random\s*=>\s*normalize_seed\(\s*mix_seed\(\s*now_secs\s*,\s*counter\s*\)\s*,?\s*\)/.test(
      scenario,
    ),
);
check(
  "advance_seed 는 Fixed 가 아닐 때만 카운터를 전진시킨다",
  /pub fn advance_seed\s*\(\s*settings:\s*&mut ScenarioSettings\s*\)[\s\S]{0,400}?SeedMode::Fixed\s*=>\s*\{\s*\}[\s\S]{0,200}?seed_next\s*=\s*settings\.seed_next\.wrapping_add\(1\)/.test(
    scenario,
  ),
);
check(
  "생성 1회용 seed 를 결정·전진·저장하는 take_generation_seed 가 있다",
  /pub fn take_generation_seed\s*\(\s*\)\s*->\s*u64/.test(scenario) &&
    /advance_seed\(\s*&mut settings\s*\)/.test(scenario),
);

// ── 4) 공급자 지원 여부 (seed 미지원에 보내면 400) ─────────────────────────────
check(
  "provider_supports_seed: Pollinations/Cloudflare 만 true",
  /pub fn provider_supports_seed\s*\(\s*provider:\s*ImageProvider\s*\)\s*->\s*bool[\s\S]{0,900}?ImageProvider::Pollinations\s*=>\s*true[\s\S]{0,300}?ImageProvider::CloudflareWorkersAi\s*=>\s*true[\s\S]{0,400}?ImageProvider::Openai\s*=>\s*false/.test(
    scenario,
  ),
);
check(
  "Cloudflare seed 는 flux 계열만 허용(비-flux 400 방지)",
  /pub fn cloudflare_accepts_seed\s*\(\s*model:\s*&str\s*\)\s*->\s*bool/.test(scenario) &&
    /pub fn generate_cloudflare_wallpaper_with_seed\s*\(/.test(scenario) &&
    /payload\.as_object_mut\(\)/.test(scenario),
);
// OpenAI 요청 조립부만 잘라서 검사한다 — 파일 전체를 훑으면 Cloudflare 의 seed 삽입
// (`obj.insert("seed", ...)`)까지 걸려 오탐이 된다.
const openaiBody = (() => {
  const start = scenario.indexOf("pub fn generate_openai_wallpaper");
  if (start < 0) return "";
  const next = scenario.indexOf("\npub fn ", start + 10);
  return scenario.slice(start, next < 0 ? scenario.length : next);
})();
check(
  "OpenAI 요청 바디에는 seed 키를 넣지 않는다(API 미지원)",
  openaiBody.length > 0 && !/"seed"/.test(openaiBody),
  openaiBody.length === 0 ? "generate_openai_wallpaper 를 찾지 못함" : "openai 조립부에 seed 키 존재",
);

// ── 5) 폴백 파이프라인이 seed 를 실제 시도 함수로 전달하고 되돌려준다 ───────────
check(
  "generate_ai_with_fallback_with_seed 가 attempt 에 seed 를 넘긴다",
  /pub fn generate_ai_with_fallback_with_seed[\s\S]{0,2500}?attempt\(\s*provider\s*,\s*&query\s*,\s*seed\s*,\s*dest\s*\)/.test(
    scenario,
  ),
);
check(
  "실네트워크 경로가 generate_online_wallpaper_with_seed 로 seed 를 넘긴다",
  /generate_online_wallpaper_with_seed\(\s*(?:query|trimmed)\s*,\s*Some\(\s*seed\s*\)\s*,/.test(
    scenario,
  ),
);
check(
  "Cloudflare 경로가 cloudflare_accepts_seed 로 게이팅해 seed 를 넘긴다",
  /cloudflare_accepts_seed\(\s*&cf\.model\s*\)/.test(scenario) &&
    /generate_cloudflare_wallpaper_with_seed\(/.test(scenario),
);

// ── 6) 수동 ② 생성(Pollinations)도 seed 를 쓴다 ────────────────────────────────
check(
  "수동 생성 경로가 take_generation_seed + _with_seed 를 쓴다",
  /let seed = wallmagic_core::take_generation_seed\(\)/.test(appLib) &&
    /generate_online_wallpaper_with_seed\(\s*trimmed_prompt\s*,\s*Some\(\s*seed\s*\)\s*,/.test(
      appLib,
    ),
);

// ── 7) 재내보내기(코어 → 앱) ─────────────────────────────────────────────────
check(
  "코어가 seed API 를 재내보낸다",
  /SeedMode/.test(coreLib) &&
    /take_generation_seed/.test(coreLib) &&
    /generate_online_wallpaper_with_seed/.test(coreLib) &&
    /pollinations_image_url/.test(coreLib),
);

// ── 8) UI: 고정/순차/랜덤 선택 + 저장 payload ─────────────────────────────────
check(
  "UI 타입에 seed_mode/seed_fixed/seed_next 가 있다",
  /seed_mode\?:\s*"fixed"\s*\|\s*"incremental"\s*\|\s*"random"/.test(app) &&
    /seed_fixed\?:\s*number/.test(app) &&
    /seed_next\?:\s*number/.test(app),
);
check(
  "UI 상태 기본값은 random 이다",
  /useState<"fixed"\s*\|\s*"incremental"\s*\|\s*"random">\("random"\)/.test(app),
);
check(
  "UI 에 seed 모드 select(3택)와 고정값 입력이 있다",
  /id="scSeedMode"/.test(app) &&
    /<option value="fixed">/.test(app) &&
    /<option value="incremental">/.test(app) &&
    /<option value="random">/.test(app) &&
    /id="scSeedFixed"/.test(app),
);
check(
  "저장 payload 가 seed_mode/seed_fixed/seed_next 를 보낸다",
  /seed_mode:\s*scSeedMode/.test(app) &&
    /seed_fixed:/.test(app) &&
    /seed_next:/.test(app),
);
check(
  "저장된 seed 설정을 조회 시 복원한다",
  /setScSeedMode\(/.test(app) && /setScSeedFixed\(/.test(app) && /setScSeedNext\(/.test(app),
);

// ── 9) seed 안내 문구: 선택된 공급자에 해당하는 문구만 표시 ────────────────────
// 배경(사용자 지적): 안내가 "Pollinations 캐시 / Cloudflare flux 전용 / OpenAI 미지원"
// 세 줄을 한꺼번에 나열해, 선택한 공급자와 무관한 문구까지 화면에 떠 있었다.
// 공급자가 선택되면 그 공급자에 유효한 문구 1개만 보여야 한다.
const seedGuidance = (() => {
  const start = app.indexOf('htmlFor="scSeedMode"');
  if (start < 0) return "";
  const end = app.indexOf('htmlFor="scProvider"', start);
  return app.slice(start, end < 0 ? app.length : end);
})();

check("seed 안내 블록을 찾는다", seedGuidance.length > 0);

for (const id of ["pollinations", "cloudflare-workers-ai", "openai", "puter"]) {
  check(
    `안내 문구가 공급자(${id}) 조건부로 분기된다`,
    seedGuidance.includes(`scProvider === "${id}"`),
    "조건부 렌더링 없음",
  );
}

const cfBranch = seedGuidance.indexOf('scProvider === "cloudflare-workers-ai"');
check(
  "Cloudflare 안내는 Cloudflare 분기 안에서만 나온다(타 공급자 선택 시 비노출)",
  cfBranch >= 0 && seedGuidance.indexOf("Cloudflare Workers AI") > cfBranch,
);
const oaBranch = seedGuidance.indexOf('scProvider === "openai"');
check(
  "OpenAI 안내는 OpenAI 분기 안에서만 나온다(타 공급자 선택 시 비노출)",
  oaBranch >= 0 && seedGuidance.indexOf("OpenAI Images API") > oaBranch,
);
check(
  "이전의 일괄 나열 문구가 남아 있지 않다",
  !/Cloudflare 는 flux 계열 모델만 seed 를 받고/.test(seedGuidance),
  "공급자 무관 나열 문구가 잔존",
);
check(
  "Cloudflare 안내는 현재 모델의 flux 지원 여부로 분기한다",
  /cloudflareAcceptsSeed\(/.test(app) && /cloudflareAcceptsSeed\(/.test(seedGuidance),
  "모델 단위 게이팅 안내 없음",
);
check(
  "seed 카운터는 seed 를 쓰는 공급자에서만 표시한다",
  /providerUsesSeed/.test(seedGuidance) && /providerUsesSeed/.test(app),
  "카운터 노출 조건 없음",
);
check(
  "검색(Search)은 seed 를 쓰지 않는다는 안내가 있다",
  /scProvider === "search"/.test(seedGuidance),
);

// ── 출력 ─────────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`ok   ${r.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed === 0 ? 0 : 1);
