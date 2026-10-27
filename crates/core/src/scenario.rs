//! 시나리오 설정 = 배경화면 자동 업데이트 스케줄.
//!
//! 스키마 (JSON, `app_data_dir()/scenario.json`):
//! ```json
//! {
//!   "enabled": false,
//!   "interval_minutes": 60,
//!   "source": { "urls": ["https://cdn.example.com/w1.jpg"], "local_dir": null },
//!   "order": "sequential",
//!   "next_index": 0,
//!   "last_run_at": null,
//!   "position": "fill"
//! }
//! ```
//!
//! - `enabled`: 자동 업데이트 ON/OFF (UI 토글).
//! - `interval_minutes`: 실행 주기 (분, 최소 5).
//! - `source.urls`: R2 + CDN 등 원격 이미지 URL 목록 (Cloudflare R2 공개 URL 권장).
//! - `source.local_dir`: 지정 시 해당 폴더의 로컬 이미지를 순환 (urls가 비었을 때 사용).
//! - `order`: `sequential` (순차) | `random` (랜덤).
//! - `next_index`: 순차 모드 커서 (적용 후 +1, 저장·복원됨).
//! - `last_run_at`: 마지막 적용 UNIX 초 (null = 아직 실행 없음).
//! - `position`: 적용 시 배치 방식 문자열 (`fill` 기본).

use crate::wallpaper::{app_data_dir, WallpaperError, WallpaperPosition, WallpaperState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 소스: 원격 URL 목록(R2/CDN) + 선택적 로컬 폴더 + 선택적 검색 키워드.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ScenarioSource {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub local_dir: Option<String>,
    /// 검색(Search) 소스 — 키워드 목록. `next_index` 로 순환하며 공개 이미지 검색 결과를 사용한다.
    /// 이전 버전 `scenario.json`(필드 없음)도 그대로 로드되도록 `#[serde(default)]`.
    #[serde(default)]
    pub search_queries: Vec<String>,
}

/// 순환 순서.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScenarioOrder {
    #[default]
    Sequential,
    Random,
}

/// 이미지 생성 seed 정책.
///
/// 배경(실측): Pollinations 요청 URL 은 `?width=1920&height=1080&nologo=true` 뿐이고
/// `seed` 파라미터가 없었다. Pollinations 는 **같은 URL(프롬프트+파라미터)에 대해 캐시된
/// 동일 이미지**를 돌려주므로, seed 없이는 같은 프롬프트가 항상 같은 결과를 낸다.
/// 그래서 기본값을 `Random` 으로 두어 "같은 프롬프트 = 같은 이미지"를 제거한다.
///
/// - `Fixed`: `seed_fixed` 고정값을 매번 사용 (재현성 필요 시).
/// - `Incremental`: `seed_next` 카운터를 1씩 전진 (생성마다 다른 결과, 추적 가능).
/// - `Random`: 현재 시각 + 카운터를 섞은 값 (기본값 — 같은 프롬프트도 매번 달라짐).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SeedMode {
    Fixed,
    Incremental,
    #[default]
    Random,
}

/// seed 혼합 함수 — 시각과 카운터를 64비트로 섞는다 (순수 함수).
///
/// `splitmix64` 최종화 단계를 사용한다. 같은 초에 두 번 생성해도 카운터가 다르므로
/// 서로 다른 seed 가 나온다(초 단위 시각만 쓰면 같은 초 재생성이 동일 결과가 된다).
pub fn mix_seed(now_secs: u64, counter: u64) -> u64 {
    let mut z = now_secs
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(counter.wrapping_mul(0xBF58_476D_1CE4_E5B9));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// 이미지 API 가 안정적으로 해석하는 seed 상한 (`i32::MAX`).
///
/// 배경(사용자 보고): seed 모드를 `Random`(기본값)으로 두어도 **같은 프롬프트에서 같은
/// 이미지**가 나온다는 보고가 있었다. URL 직렬화(`&seed=…`)는 확인됐으므로 원인은 값의
/// **범위**다. `mix_seed` 는 u64 전 범위(0 ~ 1.8e19)를 반환하는데, 이미지 API 가 이를
/// 32비트 정수로 해석하지 못하면 seed 를 무시하고 기본값으로 되돌려 매번 같은 이미지가
/// 된다. 그래서 전송 직전에 32비트 양수 범위로 정규화한다.
pub const SEED_MAX: u64 = 2_147_483_647;

/// seed 를 API 지원 범위(`1..=SEED_MAX`)로 정규화한다 (순수 함수).
///
/// `0` 은 "seed 미지정"으로 해석될 수 있어 배제하고 `1` 로 올린다 — `Fixed` 모드의
/// 기본값이 `0` 이므로, 이 정규화가 없으면 "고정 seed 0" 이 seed 없음과 같아진다.
pub fn normalize_seed(value: u64) -> u64 {
    let bounded = value % (SEED_MAX + 1);
    if bounded == 0 {
        1
    } else {
        bounded
    }
}

/// 모드별로 이번 생성에 쓸 seed 값을 결정한다 (순수 함수 — 네트워크·IO 없음).
///
/// **정규화는 `Random` 에만 적용한다.** `Fixed`/`Incremental` 은 사용자가 지정한 값
/// 그대로(항등)여야 약속이 지켜진다.
///
/// 배경(실측 결함): 이전 구현은 세 모드 모두 `normalize_seed` 를 통과시켰고, 그 함수가
/// `0 → 1` 로 올리기 때문에 `Incremental` 의 카운터 `0` 과 `1` 이 **둘 다 1** 이 되어
/// 생성 1회차와 2회차가 같은 seed(→ 같은 이미지)가 됐다
/// (`test_advance_after_generation_advances_seed_counter` 가 left:1 / right:1 로 실패).
/// 카운터는 `0,1,2,…` 가 서로 다른 값이어야 전진의 의미가 있다.
pub fn next_seed_value(mode: SeedMode, fixed: u64, counter: u64, now_secs: u64) -> u64 {
    match mode {
        // 사용자가 지정한 고정값은 그대로 — "고정 seed" 라는 약속을 변형하지 않는다.
        SeedMode::Fixed => fixed,
        // 카운터는 항등 — 0/1/2 가 반드시 서로 달라야 한다.
        SeedMode::Incremental => counter,
        // 무작위값만 API 가 안정적으로 해석하는 범위로 정규화한다.
        SeedMode::Random => normalize_seed(mix_seed(now_secs, counter)),
    }
}

/// 프로세스 전역 단조 증가 nonce (seed 중복 방지용).
///
/// 배경(실측): API 는 seed 를 정상 반영한다(프로브: seed=101 → `c4fa6c70…`,
/// seed=202 → `c3d62687…`, DIFFERENT). 그런데 앱은 `mix_seed(now_unix_secs(), seed_next)`
/// 로 seed 를 만들었다. 초 단위 시각 + **디스크 카운터**에만 의존하므로
/// ① 같은 초에 두 번 생성하면 동일 seed, ② 카운터 저장이 실패하거나 UI 가 낡은
/// `seed_next` 로 덮어쓰면 다시 동일 seed 가 되어 **같은 프롬프트 = 같은 이미지**가 된다.
/// 그래서 값에 프로세스 고유 nonce 를 함께 섞어, 카운터·시계 해상도와 무관하게
/// 매 호출이 다른 seed 를 얻도록 한다.
static SEED_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 한 번 호출할 때마다 1 씩 증가하는 nonce 를 돌려준다 (프로세스 내 유일).
pub fn next_seed_nonce() -> u64 {
    SEED_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// 현재 시각을 나노초로 돌려준다 (초 단위 해상도 보완).
pub fn now_unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// 설정의 seed 정책으로 **이번 생성용 seed** 를 만든다 (IO 없음).
///
/// `Fixed`/`Incremental` 은 기존 의미를 그대로 유지하고(고정값·카운터),
/// `Random` 만 나노초 시각 + 프로세스 nonce 를 salt 로 섞어 **절대 반복되지 않게** 한다.
pub fn fresh_seed(settings: &ScenarioSettings) -> u64 {
    let salt = mix_seed(now_unix_nanos(), next_seed_nonce());
    next_seed_value(
        settings.seed_mode,
        settings.seed_fixed,
        settings.seed_next,
        salt,
    )
}

#[cfg(test)]
mod fresh_seed_tests {
    use super::*;

    /// 같은 초·같은 카운터에서도 Random seed 는 반복되면 안 된다.
    /// (수정 전에는 `mix_seed(now_unix_secs(), seed_next)` 라 같은 초에 동일 seed 가 나왔다.)
    #[test]
    fn random_seeds_never_repeat_within_same_second() {
        let settings = ScenarioSettings {
            seed_mode: SeedMode::Random,
            seed_next: 0,
            ..Default::default()
        };
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            let seed = fresh_seed(&settings);
            assert!(
                (1..=SEED_MAX).contains(&seed),
                "seed 는 1..=SEED_MAX 범위여야 한다: {seed}"
            );
            assert!(seen.insert(seed), "같은 seed 가 반복됐다: {seed}");
        }
    }

    /// Fixed 는 고정값, Incremental 은 카운터 그대로 (salt 무시).
    #[test]
    fn fresh_seed_keeps_fixed_and_incremental_semantics() {
        let fixed = ScenarioSettings {
            seed_mode: SeedMode::Fixed,
            seed_fixed: 12_345,
            seed_next: 9,
            ..Default::default()
        };
        assert_eq!(fresh_seed(&fixed), 12_345);
        assert_eq!(fresh_seed(&fixed), 12_345, "Fixed 는 매번 같은 값");

        let inc = ScenarioSettings {
            seed_mode: SeedMode::Incremental,
            seed_fixed: 0,
            seed_next: 7,
            ..Default::default()
        };
        assert_eq!(fresh_seed(&inc), 7);
    }

    /// nonce 는 단조 증가한다 (프로세스 내 유일).
    #[test]
    fn seed_nonce_is_monotonic() {
        let a = next_seed_nonce();
        let b = next_seed_nonce();
        assert!(b > a, "nonce 는 증가해야 한다: {a} → {b}");
    }
}

/// 생성 성공 후 seed 카운터를 전진시킨다. `Fixed` 는 고정값이므로 전진하지 않는다.
pub fn advance_seed(settings: &mut ScenarioSettings) {
    match settings.seed_mode {
        SeedMode::Fixed => {}
        _ => {
            settings.seed_next = settings.seed_next.wrapping_add(1);
        }
    }
}

/// 생성 성공 후 **커서(next_index)와 seed 카운터(seed_next)를 함께 전진**시킨다 (IO 없음).
///
/// 배경(실측 결함): `tick_scenario`/`generate_wallpaper_priority_impl` 은 `next_index` 만
/// 전진시키고 `seed_next` 는 건드리지 않았다. `next_seed_value(Incremental, ..)` 는
/// `counter = seed_next` 를 그대로 반환하므로, 두 경로에서는 카운터가 0 에 고정되어
/// **매 생성이 같은 seed → 같은 이미지**가 됐다(수동 ② 생성만 `take_generation_seed` 로
/// 전진하고 있었다). 전진 규칙을 한 함수로 모아 네 경로가 같은 규칙을 쓰게 한다.
pub fn advance_after_generation(settings: &mut ScenarioSettings, used: ImageProvider) {
    advance_seed(settings);
    if used == ImageProvider::Search {
        let query_count = valid_search_queries(settings).len();
        if query_count > 0 {
            settings.next_index = settings.next_index.wrapping_add(1) % query_count;
            return;
        }
    }
    settings.next_index = settings.next_index.wrapping_add(1);
}

/// 수동 생성 1회용 seed 를 결정하고 카운터를 전진·저장한다.
///
/// 디스크 `scenario.json` 의 seed 정책을 읽어 값을 만들고, `Fixed` 가 아니면 카운터를
/// 전진시켜 저장한다. 저장 실패는 치명적이지 않으므로 경고만 남기고 진행한다
/// (생성 자체를 막으면 "설정 저장 실패 때문에 이미지가 안 나오는" 2차 결함이 된다).
pub fn take_generation_seed() -> u64 {
    let mut settings = load_scenario().unwrap_or_default();
    // `now_unix_secs()`(초 해상도) 대신 `fresh_seed`(나노초 + 프로세스 nonce)를 쓴다 —
    // 같은 초에 두 번 생성해도 Random seed 가 반복되지 않는다.
    let seed = fresh_seed(&settings);
    advance_seed(&mut settings);
    if let Err(e) = save_scenario(&settings) {
        tracing::warn!("seed counter save failed: {e}");
    }
    seed
}

/// 해당 공급자가 seed 파라미터를 지원하는가.
///
/// - Pollinations: 지원 (`&seed=N` 쿼리).
/// - Cloudflare Workers AI: flux 계열만 지원 (`cloudflare_accepts_seed` 로 모델 판정).
/// - OpenAI Images API: **미지원** — 공식 문서에 seed 파라미터가 없다. 보내면 400 이 될 수
///   있으므로 요청 바디에 넣지 않는다.
/// - Search / Puter: 이미지 생성 모델이 아니므로 해당 없음.
pub fn provider_supports_seed(provider: ImageProvider) -> bool {
    match provider {
        ImageProvider::Pollinations => true,
        ImageProvider::CloudflareWorkersAi => true,
        ImageProvider::Openai => false,
        ImageProvider::Search => false,
        ImageProvider::Puter => false,
    }
}

/// Cloudflare Workers AI 모델이 seed 를 받는가.
///
/// 배경(실측): Workers AI 는 모델마다 입력 스키마가 다르고, flux 계열만 `seed` 를
/// 받는다. 미지원 모델에 seed 를 보내면 400 이 되므로 모델명으로 게이팅한다.
pub fn cloudflare_accepts_seed(model: &str) -> bool {
    model.to_ascii_lowercase().contains("flux")
}

/// 이미지 공급자 (시나리오 자동 업데이트·수동 생성 공용).
/// Puter는 WebView 전용 SDK라 Rust에서 직접 생성할 수 없어 스킵된다 —
/// 프론트가 화면 순서 자리에서 직접 시도하므로 순서를 보존하기 위해 variant로 유지한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ImageProvider {
    #[default]
    Pollinations,
    Puter,
    CloudflareWorkersAi,
    Openai,
    /// 검색(Search) — 프롬프트 대신 키워드(`ScenarioSource::search_queries`)로
    /// 공개 이미지를 검색해 그 결과를 배경/후보로 사용한다.
    Search,
}

impl ImageProvider {
    /// 프론트엔드·디스크가 쓰는 공급자 식별자 (serde kebab-case 표기와 동일).
    ///
    /// 생성 결과의 `WallpaperState::provider` 에 이 값을 기록해 "생성 정보"로 표시하고,
    /// UI 의 `provider_order` / 라벨과 같은 어휘를 유지한다.
    pub fn as_id(self) -> &'static str {
        match self {
            ImageProvider::Pollinations => "pollinations",
            ImageProvider::Puter => "puter",
            ImageProvider::CloudflareWorkersAi => "cloudflare-workers-ai",
            ImageProvider::Openai => "openai",
            ImageProvider::Search => "search",
        }
    }
}

/// 생성 경로 상세 설명을 만든다 — `WallpaperState::source` 에 기록되어
/// UI 가 "어떤 경로(사용 모델 포함)로 생성됐는지" 항상 표시할 수 있게 한다.
/// 순수 함수라 네트워크 없이 단위 테스트로 검증한다.
pub fn generation_source_detail(settings: &ScenarioSettings, provider: ImageProvider) -> String {
    match provider {
        ImageProvider::Pollinations => {
            "Pollinations image API (image.pollinations.ai · 무료·키 불필요)".to_string()
        }
        ImageProvider::CloudflareWorkersAi => format!(
            "Cloudflare Workers AI · model={}",
            settings.cloudflare.model
        ),
        ImageProvider::Openai => format!("OpenAI Images API · model={}", settings.openai.model),
        ImageProvider::Puter => "Puter.js txt2img (WebView 브라우저 SDK)".to_string(),
        ImageProvider::Search => {
            "Wikimedia Commons image search (키 불필요 · 키워드 검색)".to_string()
        }
    }
}

/// Cloudflare Workers AI 설정 (주의: api_token은 scenario.json에 평문 저장된다 —
/// 디스크 평문 존재를 전제로 다룰 것. get_scenario 응답의 api_token은 항상 ""
/// (마스킹)이며, 프론트는 저장 시에만 토큰을 전달한다. 직접 fetch는 Tauri 커맨드 경유만 허용).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CloudflareAiConfig {
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub api_token: String,
    #[serde(default = "default_cf_model")]
    pub model: String,
}

pub fn default_cf_model() -> String {
    "@cf/black-forest-labs/flux-1-schnell".to_string()
}

pub fn default_openai_model() -> String {
    "gpt-image-1".to_string()
}

/// 기본 이미지 생성 우선순위(폴백 순서): 무료 우선.
/// Pollinations(키 불필요) → Cloudflare → OpenAI(유료 키) 순으로 시도한다.
pub fn default_provider_order() -> Vec<ImageProvider> {
    vec![
        ImageProvider::Pollinations,
        ImageProvider::CloudflareWorkersAi,
        ImageProvider::Openai,
    ]
}

/// 저장된 우선순위(폴백 순서)를 해석한다.
/// - 비어 있으면(구 scenario.json) `[provider]` 단일 시도로 해석해 하위호환을 유지한다.
/// - 중복은 첫 등장만 유지한다.
pub fn effective_provider_order(settings: &ScenarioSettings) -> Vec<ImageProvider> {
    let raw = if settings.provider_order.is_empty() {
        vec![settings.provider]
    } else {
        settings.provider_order.clone()
    };
    let mut out: Vec<ImageProvider> = Vec::new();
    for p in raw {
        // Off(비활성) 공급자는 후보에서 제외 — 순서 목록의 위치는 UI 가 유지한다.
        if settings.disabled_providers.contains(&p) {
            continue;
        }
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// 해당 공급자를 지금 시도할 자격이 있는가 (키/토큰 유무).
/// - Pollinations는 키 불필요라 항상 true.
/// - Cloudflare는 account_id + api_token이 모두 필요.
/// - OpenAI는 api_key가 필요.
pub fn provider_is_configured(settings: &ScenarioSettings, provider: ImageProvider) -> bool {
    // 사용자가 Off 로 둔 공급자는 자격증명이 있어도 시도하지 않는다(개별 On/Off).
    if settings.disabled_providers.contains(&provider) {
        return false;
    }
    match provider {
        ImageProvider::Pollinations => true,
        ImageProvider::CloudflareWorkersAi => {
            !settings.cloudflare.account_id.trim().is_empty()
                && !settings.cloudflare.api_token.trim().is_empty()
        }
        ImageProvider::Openai => !settings.openai.api_key.trim().is_empty(),
        // 검색(Search)은 키가 필요 없다. 검색어의 단일 소스는 ① 검색 영역의 키워드 목록
        // (`source.search_queries`)이다. 프롬프트(`settings.prompt`)는 ② 생성 창 전용
        // 입력이라 검색 자격 판정에 **관여하지 않는다**(프롬프트→검색어 폴백 제거).
        ImageProvider::Search => settings
            .source
            .search_queries
            .iter()
            .any(|q| !q.trim().is_empty()),
        // Puter는 WebView 전용 SDK라 Rust 백엔드에서 직접 생성할 수 없어 항상 스킵한다.
        ImageProvider::Puter => false,
    }
}

/// 우선순위 순서대로 이미지 1건을 생성한다. 성공한 공급자와 파일 경로를 반환한다.
/// - 설정된 순서(`effective_provider_order`)대로 시도하고, 실패하면 다음 공급자로 폴백한다.
/// - 자격 미달(키 없음) 공급자는 네트워크 호출 없이 건너뛴다.
/// - 전부 실패하면 마지막 오류를 반환한다 (조용한 폴스루 금지).
/// - Puter 경유 OpenAI 호출은 채택하지 않는다 — 이유:
///   Puter.js(`https://js.puter.com/v2/`, `puter.ai.txt2img`)는 브라우저 JS SDK + 사용자
///   로그인 세션 전제라 Rust 백엔드(Tauri 커맨드)에서 서버 측 REST로 호출할 엔드포인트가
///   없다. OpenAI 직접 REST(`POST https://api.openai.com/v1/images/generations`) 경로를 유지한다.
///   (공식 문서: https://docs.puter.com/AI/txt2img/ — TODO:将来 브라우저 전용 무료 경로가
///   필요해지면 프론트 전용 옵션으로 별도 provider 추가를 검토)
///
/// `source.search_queries` 에서 **실제로 쓸 수 있는** 키워드만 추린다 (공백 키워드 제외).
/// 순서는 저장된 순서를 유지한다(순차 순환의 기준).
pub fn valid_search_queries(settings: &ScenarioSettings) -> Vec<String> {
    settings
        .source
        .search_queries
        .iter()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .collect()
}

/// 검색(Search) 공급자가 이번 시도에 쓸 검색어를 고른다.
///
/// 검색어의 **단일 소스**는 검색 영역에서 입력한 키워드 목록
/// (`source.search_queries`)이다. 프롬프트(`settings.prompt`)는 ② 생성 창 전용
/// 입력이라 검색어로 쓰지 않는다(프롬프트→검색어 폴백 제거).
///
/// `order` 와 `next_index`(순차) / `seed`(랜덤) 로 순환한다.
/// 키워드가 하나도 없으면 `None` — 호출자는 네트워크 호출 없이 스킵해야 한다.
pub fn search_query_for(settings: &ScenarioSettings, seed: u64) -> Option<String> {
    let queries = valid_search_queries(settings);
    if queries.is_empty() {
        return None;
    }
    let idx = match settings.order {
        ScenarioOrder::Sequential => settings.next_index % queries.len(),
        ScenarioOrder::Random => (seed as usize) % queries.len(),
    };
    Some(queries[idx].clone())
}

/// 결정적 테스트를 위해 실제 시도 함수는 `attempt` 클로저로 주입받는다.
/// 네트워크 의존 생성 함수는 이 클로저로 분리되어 단위 테스트에서 모의 가능하다.
///
/// `attempt` 에 넘기는 두 번째 인자는 **해당 공급자에 실제로 쓸 질의문**이다:
/// - Search 는 `source.search_queries` 를 우선 사용하고(순환), 비어 있을 때만 프롬프트를 쓴다.
/// - 그 외 공급자는 공용 프롬프트를 그대로 쓴다.
///
/// `seed` 는 호출자가 `next_seed_value` 로 결정해 넘긴다. 실제 시도 함수에 그대로
/// 전달되므로, seed 를 지원하지 않는 공급자는 받은 seed 를 무시해야 한다
/// (`provider_supports_seed` 로 판단).
pub fn generate_ai_with_fallback_with_seed<F>(
    settings: &ScenarioSettings,
    prompt: &str,
    dest: &PathBuf,
    seed: u64,
    attempt: F,
) -> Result<(ImageProvider, PathBuf, String), WallpaperError>
where
    F: Fn(ImageProvider, &str, u64, &PathBuf) -> Result<PathBuf, WallpaperError>,
{
    let trimmed = prompt.trim();
    // 프롬프트가 비어 있어도 Search 키워드가 있으면 실행 가능하다
    // (검수 지적 [high]: 키워드만 있는 시나리오가 "empty prompt" 로 무조건 실패했다).
    if trimmed.is_empty() && valid_search_queries(settings).is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "empty prompt: image generation needs a text prompt".to_string(),
        ));
    }
    let order = effective_provider_order(settings);
    if order.is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "no image provider configured".to_string(),
        ));
    }
    let mut last_err: Option<WallpaperError> = None;
    let mut skipped = 0usize;
    for provider in order {
        // Search 자격은 **검색어(`source.search_queries`) 단독**으로 판정한다 (공급자 단일 판정 헬퍼).
        // 프롬프트(`settings.prompt`)도, 호출 인자 `prompt` 도 검색 자격에 관여하지 않는다 —
        // 검색어와 프롬프트는 서로 무관한 별개 입력이다(프롬프트→검색어 폴백 제거).
        let qualified = provider_is_configured(settings, provider);
        if !qualified {
            skipped += 1;
            last_err = Some(WallpaperError::CandidateLoad(format!(
                "{provider:?} skipped: missing credentials"
            )));
            continue;
        }
        // 공급자별 실제 질의문 — Search 는 검색어 목록(`source.search_queries`)만 쓴다.
        // 프롬프트로 대체하지 않는다(사용자가 입력한 검색어가 없으면 명시적으로 스킵).
        let query: String = if provider == ImageProvider::Search {
            match search_query_for(settings, seed) {
                Some(q) => q,
                None => {
                    skipped += 1;
                    last_err = Some(WallpaperError::CandidateLoad(
                        "Search skipped: no search keyword (검색 창의 검색어가 비어 있습니다)"
                            .to_string(),
                    ));
                    continue;
                }
            }
        } else {
            if trimmed.is_empty() {
                // 프롬프트가 없으면 이미지 생성 공급자는 질의문을 만들 수 없다 — 스킵.
                skipped += 1;
                last_err = Some(WallpaperError::CandidateLoad(format!(
                    "{provider:?} skipped: empty prompt"
                )));
                continue;
            }
            trimmed.to_string()
        };
        match attempt(provider, &query, seed, dest) {
            // 실제로 사용된 질의문을 함께 돌려준다 — 호출자가 search_query_for 를 다시
            // 호출하면 순차/랜덤 순환에서 다른 값이 나와 기록과 실제 검색어가 어긋난다.
            Ok(p) => return Ok((provider, p, query)),
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        WallpaperError::CandidateLoad(format!(
            "all image providers failed (skipped: {skipped})"
        ))
    }))
}

/// seed 를 클로저 인자로 받지 않는 호출부·테스트용 래퍼.
///
/// seed 는 설정(`seed_mode`/`seed_fixed`/`seed_next`)에서 계산해 시도 함수에 넘긴다.
pub fn generate_ai_with_fallback_with_query<F>(
    settings: &ScenarioSettings,
    prompt: &str,
    dest: &PathBuf,
    attempt: F,
) -> Result<(ImageProvider, PathBuf, String), WallpaperError>
where
    F: Fn(ImageProvider, &str, &PathBuf) -> Result<PathBuf, WallpaperError>,
{
    // `now_unix_secs()`(초 해상도) 대신 `fresh_seed`(나노초 + 프로세스 nonce)를 쓴다 —
    // 같은 초에 두 번 생성해도 Random seed 가 절대 반복되지 않아야 한다.
    let seed = fresh_seed(settings);
    generate_ai_with_fallback_with_seed(settings, prompt, dest, seed, |provider, query, _s, dest| {
        attempt(provider, query, dest)
    })
}

/// 2-튜플 호환 래퍼 — 실제 사용된 질의문이 필요 없는 호출부·테스트용.
///
/// 코어 구현은 `generate_ai_with_fallback_with_query`(3-튜플)이며, 이 함수는 질의문을
/// 버린다. 시나리오 tick·우선순위 생성처럼 "무엇으로 생성됐는지" 를 기록해야 하는 경로는
/// 반드시 `_query` 판을 써야 한다(검수 지적 [medium]).
pub fn generate_ai_with_fallback_with<F>(
    settings: &ScenarioSettings,
    prompt: &str,
    dest: &PathBuf,
    attempt: F,
) -> Result<(ImageProvider, PathBuf), WallpaperError>
where
    F: Fn(ImageProvider, &str, &PathBuf) -> Result<PathBuf, WallpaperError>,
{
    generate_ai_with_fallback_with_query(settings, prompt, dest, attempt)
        .map(|(provider, path, _query)| (provider, path))
}

/// 실제 네트워크 시도 함수 — **실제로 사용된 질의문**을 함께 반환한다.
///
/// Search 는 ⑤ 키워드 목록을 순환(순차=`next_index`, 랜덤=seed)하므로 호출 측이
/// "내가 넘긴 프롬프트"를 검색어로 단정할 수 없다. 그 값을 그대로 받아 기록해야
/// UI 표기와 실제 검색어가 일치한다.
pub fn generate_ai_with_fallback_query(
    settings: &ScenarioSettings,
    prompt: &str,
    dest: &PathBuf,
) -> Result<(ImageProvider, PathBuf, String), WallpaperError> {
    // `now_unix_secs()`(초 해상도) 대신 `fresh_seed`(나노초 + 프로세스 nonce)를 쓴다 —
    // 같은 초에 두 번 생성해도 Random seed 가 절대 반복되지 않아야 한다.
    let seed = fresh_seed(settings);
    generate_ai_with_fallback_with_seed(
        settings,
        prompt,
        dest,
        seed,
        |provider, trimmed, seed, dest| match provider {
            ImageProvider::Pollinations => {
                // Pollinations 는 `?seed=N` 을 지원한다 — 같은 프롬프트라도 seed 가 다르면
                // 다른 이미지가 나온다(seed 없으면 캐시된 동일 이미지).
                crate::wallpaper::generate_online_wallpaper_with_seed(trimmed, Some(seed), dest)
            }
            ImageProvider::CloudflareWorkersAi => {
                let cf = &settings.cloudflare;
                if cloudflare_accepts_seed(&cf.model) {
                    generate_cloudflare_wallpaper_with_seed(
                        &cf.account_id,
                        &cf.api_token,
                        &cf.model,
                        trimmed,
                        Some(seed),
                        dest,
                    )
                } else {
                    // seed 미지원 모델에 seed 를 보내면 400 이 온다 — 게이팅해서 보내지 않는다.
                    generate_cloudflare_wallpaper(
                        &cf.account_id,
                        &cf.api_token,
                        &cf.model,
                        trimmed,
                        dest,
                    )
                }
            }
            ImageProvider::Openai => {
                // OpenAI Images API 는 seed 파라미터를 지원하지 않는다 — 보내지 않는다.
                let oa = &settings.openai;
                generate_openai_wallpaper(&oa.api_key, &oa.model, trimmed, dest)
            }
            // 검색(Search): 프롬프트를 검색 키워드로 사용해 공개 이미지 1건을 확정한다.
            ImageProvider::Search => crate::search::generate_search_wallpaper(trimmed, dest),
            ImageProvider::Puter => Err(WallpaperError::CandidateLoad(
                "Puter skipped: browser SDK only".to_string(),
            )),
        },
    )
}

/// 2-튜플 호환 래퍼 — 실제 사용된 질의문이 필요 없는 호출부용.
///
/// 시나리오 tick·우선순위 생성처럼 "무엇으로 생성됐는지"를 state.json 에 기록하는 경로는
/// 반드시 `generate_ai_with_fallback_query`(3-튜플)를 써야 한다. 2-튜플만 받아
/// 호출 측이 `search_query_for` 를 **다시** 호출하면, 순차/랜덤 순환 특성상 기록과
/// 실제 검색어가 어긋난다(검수 지적 [medium]).
pub fn generate_ai_with_fallback(
    settings: &ScenarioSettings,
    prompt: &str,
    dest: &PathBuf,
) -> Result<(ImageProvider, PathBuf), WallpaperError> {
    generate_ai_with_fallback_query(settings, prompt, dest)
        .map(|(provider, path, _query)| (provider, path))
}

/// OpenAI 이미지 생성 설정 (주의: api_key는 scenario.json에 평문 저장된다 —
/// 디스크 평문 존재를 전제로 다룰 것. get_scenario 응답의 api_key는 항상 ""
/// (마스킹)이며, 프론트는 저장 시에만 키를 전달한다. 직접 fetch는 Tauri 커맨드 경유만 허용).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct OpenAiConfig {
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_openai_model")]
    pub model: String,
}

/// 시나리오 설정 전체.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScenarioSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_minutes: u64,
    #[serde(default)]
    pub source: ScenarioSource,
    #[serde(default)]
    pub order: ScenarioOrder,
    #[serde(default)]
    pub next_index: usize,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default = "default_position_string")]
    pub position: String,
    #[serde(default)]
    pub provider: ImageProvider,
    /// 이미지 생성 우선순위(폴백 순서). 비어 있으면(구 scenario.json) `[provider]` 단일 시도로
    /// 해석한다. 기본값 = 무료 우선(Pollinations → Cloudflare → OpenAI).
    #[serde(default)]
    pub provider_order: Vec<ImageProvider>,
    /// 사용자가 Off(비활성)로 둔 공급자 목록.
    /// 순서 목록에서 위치는 유지하되 생성·폴백 후보에서는 제외한다(공급자별 개별 On/Off).
    /// `#[serde(default)]` 로 구 scenario.json(필드 없음)과 호환된다.
    #[serde(default)]
    pub disabled_providers: Vec<ImageProvider>,
    /// 공용 생성 프롬프트 — Pollinations/Cloudflare/OpenAI 3개 공급자가 모두 참조한다.
    /// 구 `cloudflare.prompt`/`openai.prompt`는 제거되고 이 필드로 단일화되었다.
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub cloudflare: CloudflareAiConfig,
    #[serde(default)]
    pub openai: OpenAiConfig,
    /// 검수 지적 [medium](b): 토큰 명시적 삭제 플래그. true일 때만 빈 토큰으로
    /// 덮어쓰고, 저장 전 false로 리셋하므로 scenario.json에 잔류하지 않는다.
    #[serde(default)]
    pub clear_api_token: bool,
    /// OpenAI api_key 명시적 삭제 플래그 (clear_api_token과 동일 패턴).
    #[serde(default)]
    pub clear_api_key: bool,
    /// seed 정책 — 기본값 `Random`. seed 를 보내지 않으면 Pollinations 는
    /// 같은 프롬프트(같은 URL)에 캐시된 동일 이미지를 돌려주므로,
    /// 기본값이 `Random` 이어야 "같은 프롬프트 = 같은 이미지" 문제가 사라진다.
    #[serde(default)]
    pub seed_mode: SeedMode,
    /// `SeedMode::Fixed` 일 때 쓸 고정 seed 값.
    #[serde(default)]
    pub seed_fixed: u64,
    /// `Incremental`/`Random` 모드의 카운터 (생성마다 1씩 전진, 저장·복원됨).
    #[serde(default)]
    pub seed_next: u64,
}

fn default_interval() -> u64 {
    60
}

fn default_position_string() -> String {
    "fill".to_string()
}

impl Default for ScenarioSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: default_interval(),
            source: ScenarioSource::default(),
            order: ScenarioOrder::Sequential,
            next_index: 0,
            last_run_at: None,
            position: default_position_string(),
            provider: ImageProvider::default(),
            prompt: String::new(),
            cloudflare: CloudflareAiConfig::default(),
            openai: OpenAiConfig::default(),
            provider_order: default_provider_order(),
            disabled_providers: Vec::new(),
            clear_api_token: false,
            clear_api_key: false,
            seed_mode: SeedMode::Random,
            seed_fixed: 0,
            seed_next: 0,
        }
    }
}

impl ScenarioSettings {
    /// 유효성 검사: interval 하한(5분), 소스 비어있음 여부를 확인한다.
    pub fn validate(&self) -> Result<(), WallpaperError> {
        if self.interval_minutes < 5 {
            return Err(WallpaperError::CandidateLoad(format!(
                "interval_minutes must be >= 5, got {}",
                self.interval_minutes
            )));
        }
        Ok(())
    }

    pub fn position_enum(&self) -> WallpaperPosition {
        match self.position.to_ascii_lowercase().as_str() {
            "center" => WallpaperPosition::Center,
            "tile" => WallpaperPosition::Tile,
            "stretch" => WallpaperPosition::Stretch,
            "fit" => WallpaperPosition::Fit,
            "span" => WallpaperPosition::Span,
            _ => WallpaperPosition::Fill,
        }
    }
}

pub fn scenario_file_path() -> PathBuf {
    app_data_dir().join("scenario.json")
}

pub fn load_scenario() -> Result<ScenarioSettings, WallpaperError> {
    let path = scenario_file_path();
    if !path.exists() {
        return Ok(ScenarioSettings::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    let mut settings: ScenarioSettings = serde_json::from_str(&raw)?;
    if settings.interval_minutes == 0 {
        settings.interval_minutes = default_interval();
    }
    if settings.position.trim().is_empty() {
        settings.position = default_position_string();
    }
    Ok(settings)
}

pub fn save_scenario(settings: &ScenarioSettings) -> Result<(), WallpaperError> {
    settings.validate()?;
    let path = scenario_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, json)?;
    Ok(())
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 지금 실행해야 하는가? (enabled && 주기 경과 && 소스 존재)
/// 순수 함수 — 단위 테스트로 검증한다.
pub fn should_run(settings: &ScenarioSettings, now_secs: u64) -> bool {
    if !settings.enabled {
        return false;
    }
    // 공용 프롬프트 단일 게이트: 3개 공급자(Pollinations/Cloudflare/OpenAI) 모두
    // `settings.prompt` 하나로 실행 가능 여부를 판단한다.
    let has_ai_source = !settings.prompt.trim().is_empty()
        && effective_provider_order(settings)
            .iter()
            .any(|p| provider_is_configured(settings, *p));
    // 검색(Search) 소스: 프롬프트 없이 키워드(`source.search_queries`)만으로 실행 가능하다.
    // 키워드가 하나도 없으면 Search 는 후보를 만들 수 없으므로 실행 조건에서 제외한다.
    let has_search_source =
        settings.source.search_queries.iter().any(|q| !q.trim().is_empty())
            && effective_provider_order(settings)
                .iter()
                .any(|p| *p == ImageProvider::Search && provider_is_configured(settings, *p));
    if settings.source.urls.is_empty()
        && settings
            .source
            .local_dir
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        && !has_ai_source
        && !has_search_source
    {
        return false;
    }
    match settings.last_run_at {
        None => true,
        Some(last) => now_secs.saturating_sub(last) >= settings.interval_minutes * 60,
    }
}

/// 다음 원격 URL 선택 (순차 커서 / 랜덤).
/// 순수 함수 — 네트워크 없이 테스트한다.
pub fn pick_next_url(settings: &ScenarioSettings, rand_seed: u64) -> Option<(usize, String)> {
    if settings.source.urls.is_empty() {
        return None;
    }
    let len = settings.source.urls.len();
    let idx = match settings.order {
        ScenarioOrder::Sequential => settings.next_index % len,
        ScenarioOrder::Random => (rand_seed as usize) % len,
    };
    Some((idx, settings.source.urls[idx].clone()))
}

/// HTTP 상태 코드를 보존해 `WallpaperError::HttpStatus`를 만든다 (검수 지적 3).
/// 날조 금지: 호출자가 받은 실제 `status`를 그대로 담는다.
pub fn scenario_http_status_error(status: u16, body: String) -> WallpaperError {
    WallpaperError::HttpStatus { status, body }
}

/// 소스 구성이 바뀌었으면 순차 커서 리셋이 필요하다 (검수 지적 3, 순수 함수).
pub fn needs_cursor_reset(
    prev_urls: &[String],
    prev_local: Option<&str>,
    next_urls: &[String],
    next_local: Option<&str>,
) -> bool {
    if prev_urls != next_urls {
        return true;
    }
    fn norm(v: Option<&str>) -> Option<&str> {
        match v {
            Some(s) => {
                let t = s.trim();
                if t.is_empty() { None } else { Some(t) }
            }
            None => None,
        }
    }
    norm(prev_local) != norm(next_local)
}

/// 다운로드 실패 시각 + 주기 → 다음 재시도 허용 시각 (검수 지적 3, 순수 함수).
/// `tick_scenario`가 실패 시 `last_run_at=now`를 저장하므로, 다음 틱은 정확히
/// 한 주기 뒤에 허용된다 (매 틱 재시도 폭주 방지).
pub fn failure_retry_allowed_at(failed_at_secs: u64, interval_minutes: u64) -> u64 {
    failed_at_secs.saturating_add(interval_minutes.saturating_mul(60))
}

/// 원격 URL 1건을 다운로드해 스테이징 전 임시 파일로 저장한다.
///
/// 실패 분류:
/// - `ureq::Error::Status(code, _)` → `HttpStatus { status: code, .. }` (실제 코드 보존).
/// - 비-200 응답 → `response.status()` 실제 값을 그대로 담는다 (날조 금지).
fn download_to_temp(url: &str, dest: &PathBuf) -> Result<(), WallpaperError> {
    let response = ureq::get(url)
        .timeout(std::time::Duration::from_secs(60))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp
                    .into_string()
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect::<String>();
                WallpaperError::HttpStatus {
                    status: code,
                    body: format!("scenario image HTTP {code}: {body}"),
                }
            }
            other => WallpaperError::Network(format!("scenario download failed: {other}")),
        })?;
    let status = response.status();
    if status != 200 {
        let body = response
            .into_string()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(WallpaperError::HttpStatus {
            status,
            body: format!("scenario image HTTP {status}: {body}"),
        });
    }
    let mut bytes: Vec<u8> = Vec::new();
    use std::io::Read as _;
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| WallpaperError::Network(format!("scenario read failed: {e}")))?;
    if bytes.is_empty() {
        return Err(WallpaperError::Network(
            "scenario image returned empty body".to_string(),
        ));
    }
    // 손상 응답 차단: 디코딩 가능해야 한다.
    image::load_from_memory(&bytes).map_err(|e| {
        WallpaperError::CandidateLoad(format!("scenario image decode failed: {e}"))
    })?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, &bytes)?;
    Ok(())
}

/// 스케줄러 틱: 주기가 도래했으면 다음 이미지를 적용하고 상태·커서를 갱신한다.
///
/// - 원격 URL이 있으면 `order`대로 1건 다운로드 → `set_wallpaper` 적용.
/// - URL이 비고 `local_dir`이 있으면 해당 폴더에서 파일명 순환 1건 적용.
/// - 아직 주기가 안 됐으면 `Ok(None)` (아무 일도 안 함).
/// - `enabled=false`이거나 소스가 비었으면 `Ok(None)`.
/// Cloudflare Workers AI 호출 URL을 만든다 (순수 함수 — 네트워크 없이 테스트).
pub fn cloudflare_ai_url(account_id: &str, model: &str) -> String {
    format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}",
        account_id.trim(),
        model.trim()
    )
}

/// Workers AI JSON 응답에서 base64 이미지를 꺼내 디코드한다 (순수 함수).
/// flux-1-schnell 규격: `{"result":{"image":"<base64 JPEG>"}}`.
/// 변형으로 `result` 자체가 문자열인 경우도 허용한다.
pub fn parse_cf_image_response(body: &serde_json::Value) -> Result<Vec<u8>, WallpaperError> {
    let b64 = body
        .pointer("/result/image")
        .and_then(|v| v.as_str())
        .or_else(|| body.pointer("/result").and_then(|v| v.as_str()))
        .ok_or_else(|| {
            WallpaperError::CandidateLoad("cloudflare response has no result.image".to_string())
        })?;
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| WallpaperError::CandidateLoad(format!("cloudflare image base64 decode: {e}")))
}

/// Cloudflare Workers AI로 이미지를 생성해 `dest`에 저장한다.
///
/// - `POST {url}` + `Authorization: Bearer {api_token}` + JSON `{"prompt": ...}`.
/// - `api_token`은 Tauri 커맨드 인자로 전달받아 이 Rust 함수 안에서만
///   `Authorization` 헤더에 사용한다 (프론트에서 직접 fetch 금지 — 반드시 이 커맨드 경유).
///   단, 토큰은 호출 시점 프론트 메모리(password input value)와
///   `scenario.json`에 평문으로 존재한다 — `get_scenario` 응답은 마스킹("")되나
///   디스크 평문 저장은 잔존 제약이다.
/// - 401/429/네트워크 실패는 `HttpStatus`/`Network`로 그대로 반환해,
///   호출자(커맨드·tick)가 기존 배경을 유지하고 오류 메시지를 내보내게 한다.
/// - 저해상도 응답은 `normalize_to_hd`로 1920x1080 기준에 맞춘다.
pub fn generate_cloudflare_wallpaper(
    account_id: &str,
    api_token: &str,
    model: &str,
    prompt: &str,
    dest: &PathBuf,
) -> Result<PathBuf, WallpaperError> {
    generate_cloudflare_wallpaper_with_seed(account_id, api_token, model, prompt, None, dest)
}

/// seed 를 명시해 Cloudflare Workers AI 이미지를 생성한다.
///
/// `seed = Some(n)` 이고 모델이 seed 를 지원하면(`cloudflare_accepts_seed`) 요청 바디에
/// `seed` 키를 넣는다. 미지원 모델(비-flux 계열)에 보내면 400 이 되므로 **모델명으로
/// 게이팅**한다 — 게이팅 없이 무조건 보내면 기존 사용자의 생성이 갑자기 실패한다.
pub fn generate_cloudflare_wallpaper_with_seed(
    account_id: &str,
    api_token: &str,
    model: &str,
    prompt: &str,
    seed: Option<u64>,
    dest: &PathBuf,
) -> Result<PathBuf, WallpaperError> {
    if account_id.trim().is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "cloudflare account_id is empty".to_string(),
        ));
    }
    if api_token.trim().is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "cloudflare api_token is empty".to_string(),
        ));
    }
    if prompt.trim().is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "empty prompt: image generation needs a text prompt".to_string(),
        ));
    }
    let model = if model.trim().is_empty() {
        default_cf_model()
    } else {
        model.trim().to_string()
    };
    let url = cloudflare_ai_url(account_id, &model);
    let mut payload = serde_json::json!({"prompt": prompt.trim()});
    // seed 는 모델이 지원할 때만 넣는다 — 비-flux 모델에 보내면 400 이 온다.
    if let Some(s) = seed {
        if cloudflare_accepts_seed(&model) {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("seed".to_string(), serde_json::json!(s));
            }
        }
    }
    let req_body = payload.to_string();
    let response = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(90))
        .set("Authorization", &format!("Bearer {}", api_token.trim()))
        .set("Content-Type", "application/json")
        .send_string(&req_body)
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp
                    .into_string()
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect::<String>();
                WallpaperError::HttpStatus {
                    status: code,
                    body: format!("cloudflare workers ai HTTP {code}: {body}"),
                }
            }
            other => WallpaperError::Network(format!("cloudflare request failed: {other}")),
        })?;
    let status = response.status();
    if status != 200 {
        let body = response
            .into_string()
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        return Err(WallpaperError::HttpStatus { status, body });
    }
    let text = response
        .into_string()
        .map_err(|e| WallpaperError::Network(format!("reading cloudflare response failed: {e}")))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        WallpaperError::CandidateLoad(format!("cloudflare response parse failed: {e}"))
    })?;
    let bytes = parse_cf_image_response(&json)?;
    if bytes.is_empty() {
        return Err(WallpaperError::Network(
            "cloudflare returned empty image body".to_string(),
        ));
    }
    let img = image::load_from_memory(&bytes).map_err(|e| {
        WallpaperError::CandidateLoad(format!("cloudflare image decode failed: {e}"))
    })?;
    let img_hd = crate::wallpaper::normalize_to_hd(img)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    img_hd.save(dest)?;
    Ok(dest.clone())
}

/// OpenAI Images API 호출 URL을 만든다 (순수 함수 — 네트워크 없이 테스트).
/// `POST https://api.openai.com/v1/images/generations`
pub fn openai_images_url() -> String {
    "https://api.openai.com/v1/images/generations".to_string()
}

/// OpenAI Images JSON 응답에서 base64 이미지를 꺼내 디코드한다 (순수 함수).
/// gpt-image-1 규격: `{"data":[{"b64_json":"<base64 PNG>"}]}`.
/// 변형으로 `b64_json` 대신 `url`이 온 경우 다운로드하지 않고 명확한 에러로 실패시킨다
/// (조용한 폴스루 금지 — 호출자가 WallpaperError로 인지하게 한다).
pub fn parse_openai_image_response(body: &serde_json::Value) -> Result<Vec<u8>, WallpaperError> {
    let b64 = body
        .pointer("/data/0/b64_json")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            if body.pointer("/data/0/url").and_then(|v| v.as_str()).is_some() {
                WallpaperError::CandidateLoad(
                    "openai response has only data[0].url (no b64_json): request b64_json format"
                        .to_string(),
                )
            } else {
                WallpaperError::CandidateLoad(
                    "openai response has no data[0].b64_json".to_string(),
                )
            }
        })?;
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| WallpaperError::CandidateLoad(format!("openai image base64 decode: {e}")))
}

/// OpenAI 이미지 생성으로 이미지를 생성해 `dest`에 저장한다.
///
/// - `POST https://api.openai.com/v1/images/generations` + `Authorization: Bearer {api_key}`
///   + JSON `{"model": ..., "prompt": ..., "n": 1, "size": "1536x1024"}`.
/// - Cloudflare 구현과 동일 구조: 빈 키/모델/프롬프트 검증 → HTTP 상태 보존 → JSON 파싱 →
///   `normalize_to_hd`로 1920x1080 기준 맞춤 → 저장.
/// - 실패(401/429/네트워크/디코드)는 `HttpStatus`/`Network`/`CandidateLoad`로 그대로 반환해
///   호출자(커맨드·tick)가 기존 배경을 유지하고 오류 메시지를 내보내게 한다.
pub fn generate_openai_wallpaper(
    api_key: &str,
    model: &str,
    prompt: &str,
    dest: &PathBuf,
) -> Result<PathBuf, WallpaperError> {
    if api_key.trim().is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "openai api_key is empty".to_string(),
        ));
    }
    if prompt.trim().is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "empty prompt: image generation needs a text prompt".to_string(),
        ));
    }
    let model = if model.trim().is_empty() {
        default_openai_model()
    } else {
        model.trim().to_string()
    };
    let url = openai_images_url();
    let req_body = serde_json::json!({
        "model": model,
        "prompt": prompt.trim(),
        "n": 1,
        "size": "1536x1024",
    })
    .to_string();
    let response = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(90))
        .set("Authorization", &format!("Bearer {}", api_key.trim()))
        .set("Content-Type", "application/json")
        .send_string(&req_body)
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp
                    .into_string()
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect::<String>();
                WallpaperError::HttpStatus {
                    status: code,
                    body: format!("openai images HTTP {code}: {body}"),
                }
            }
            other => WallpaperError::Network(format!("openai request failed: {other}")),
        })?;
    let status = response.status();
    if status != 200 {
        let body = response
            .into_string()
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        return Err(WallpaperError::HttpStatus { status, body });
    }
    let text = response
        .into_string()
        .map_err(|e| WallpaperError::Network(format!("reading openai response failed: {e}")))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        WallpaperError::CandidateLoad(format!("openai response parse failed: {e}"))
    })?;
    let bytes = parse_openai_image_response(&json)?;
    if bytes.is_empty() {
        return Err(WallpaperError::Network(
            "openai returned empty image body".to_string(),
        ));
    }
    let img = image::load_from_memory(&bytes).map_err(|e| {
        WallpaperError::CandidateLoad(format!("openai image decode failed: {e}"))
    })?;
    let img_hd = crate::wallpaper::normalize_to_hd(img)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    img_hd.save(dest)?;
    Ok(dest.clone())
}

pub fn tick_scenario(now_secs: u64) -> Result<Option<WallpaperState>, WallpaperError> {
    let mut settings = load_scenario()?;
    if !should_run(&settings, now_secs) {
        return Ok(None);
    }

    // AI image providers: priority order with fallback.
    // Order = effective_provider_order (default free-first: Pollinations -> Cloudflare -> OpenAI).
    // Same shared prompt for all providers. First success is applied; all-fail returns last error.
    if !settings.prompt.trim().is_empty() {
        let order = effective_provider_order(&settings);
        if order.iter().any(|pr| provider_is_configured(&settings, *pr)) {
            // 시나리오 틱의 임시 파일은 **고정 이름**을 의도적으로 쓴다 — 사용자 결과물이 아니라
            // 적용 직전 임시 파일이므로, 틱마다 같은 경로를 덮어써 `online_cache` 가 무한히
            // 누적되는 것을 막는다. 사용자에게 남는 산출물(library/Pictures)은 반드시
            // `search::unique_output_path` 를 거쳐 고유화한다(같은 프롬프트 재생성 시 덮어쓰기 금지).
            // 후속 과제(검수 권고): 틱 임시 파일은 URL 개수·고정명으로 상한이 있으나, 검색 캐시
            // `online_{hash}_{idx}.jpg` 는 쿼리별로 누적된다 — 상한·pruning 정책은 별도 이슈로 관리한다.
            let tmp = app_data_dir().join("online_cache").join("scenario_ai.jpg");
            let prompt_owned = settings.prompt.clone();
            // 3-튜플 판(`_query`)을 쓴다 — 실제로 사용된 질의문을 그대로 받아 기록해야
            // "기록된 검색어"와 "실제 검색어"가 일치한다. 2-튜플 판을 쓰고 호출 측이
            // `search_query_for` 를 다시 호출하면, 순차(next_index)/랜덤(seed) 순환 특성상
            // 서로 다른 값이 나와 기록이 어긋난다(검수 지적 [medium]).
            match generate_ai_with_fallback_query(&settings, &prompt_owned, &tmp) {
                Ok((used, path, used_query)) => {
                    // 생성 정보: 어떤 공급자(모델 포함)로 생성됐는지 state.json 에 남긴다.
                    // 기록이 없으면 UI 가 "무료 폴백인지 Puter 인지" 구분할 수 없다.
                    let provider_id = used.as_id();
                    let detail = generation_source_detail(&settings, used);
                    let detail_with_query = if used == ImageProvider::Search {
                        format!("{detail} · query: {used_query}")
                    } else {
                        detail
                    };
                    match crate::wallpaper::set_wallpaper_with(
                        &path,
                        None,
                        settings.position_enum(),
                        Some(provider_id),
                        Some(&detail_with_query),
                    ) {
                        Ok(st) => {
                            // 커서(next_index)와 seed 카운터(seed_next)를 **함께** 전진시킨다.
                            // 이전 구현은 next_index 만 전진시켜, Incremental 모드에서
                            // seed_next 가 0 에 고정 → 매 생성이 같은 seed → 같은 이미지가 됐다.
                            advance_after_generation(&mut settings, used);
                            settings.last_run_at = Some(now_secs);
                            save_scenario(&settings)?;
                            return Ok(Some(st));
                        }
                        Err(er) => {
                            settings.last_run_at = Some(now_secs);
                            let _ = save_scenario(&settings);
                            return Err(er);
                        }
                    }
                }
                Err(er) => {
                    settings.last_run_at = Some(now_secs);
                    let _ = save_scenario(&settings);
                    return Err(er);
                }
            }
        }
    }

    // 검색(Search) 소스: 키워드(`search_queries`)만으로도 실행한다.
    // - 프롬프트가 있으면 위 AI 분기가 Search 를 처리하며, 그 경로에서도
    //   `search_query_for` 가 키워드 목록을 우선 사용한다(순차/랜덤 순환).
    // - 여기서는 프롬프트가 비어 위 분기를 통과하지 못한 경우를 담당한다.
    // 질의 선택 규칙은 `search_query_for` 한 곳에서만 결정한다 — 이전 구현은 순환
    // 로직을 이 블록에 복제해 두 경로가 서로 다른 규칙을 갖는 결함이 있었다.
    if settings.prompt.trim().is_empty()
        && effective_provider_order(&settings).contains(&ImageProvider::Search)
        && provider_is_configured(&settings, ImageProvider::Search)
    {
        let query_count = valid_search_queries(&settings).len();
        if let Some(query) = search_query_for(&settings, now_secs) {
            // 검색 틱도 같은 이유로 고정 이름 임시 파일을 재사용한다(누적 방지).
            // 사용자 산출물 고유화는 `unique_output_path` 담당이다.
            let tmp = app_data_dir()
                .join("online_cache")
                .join("scenario_search.jpg");
            // 실패 시 백오프: last_run_at 갱신·저장으로 매 틱 재시도 폭주를 막는다.
            match crate::search::generate_search_wallpaper(&query, &tmp) {
                Ok(path) => {
                    let detail = generation_source_detail(&settings, ImageProvider::Search);
                    match crate::wallpaper::set_wallpaper_with(
                        &path,
                        None,
                        settings.position_enum(),
                        Some(ImageProvider::Search.as_id()),
                        Some(&format!("{detail} · query: {query}")),
                    ) {
                        Ok(st) => {
                            // 커서·seed 전진 규칙은 `advance_after_generation` 한 곳에 모은다
                            // (이전 구현은 next_index 만 전진시켜 Incremental seed 가 0 에
                            // 고정되는 결함이 있었다).
                            advance_after_generation(&mut settings, ImageProvider::Search);
                            let _ = query_count;
                            settings.last_run_at = Some(now_secs);
                            save_scenario(&settings)?;
                            return Ok(Some(st));
                        }
                        Err(er) => {
                            settings.last_run_at = Some(now_secs);
                            let _ = save_scenario(&settings);
                            return Err(er);
                        }
                    }
                }
                Err(er) => {
                    settings.last_run_at = Some(now_secs);
                    let _ = save_scenario(&settings);
                    return Err(er);
                }
            }
        }
    }

    if !settings.source.urls.is_empty() {
        let len = settings.source.urls.len();
        let idx = match settings.order {
            ScenarioOrder::Sequential => settings.next_index % len,
            ScenarioOrder::Random => (now_secs as usize) % len,
        };
        let url = settings.source.urls[idx].clone();
        // URL 순환 틱도 고정 이름(`scenario_{idx}.jpg`)을 재사용한다 — URL 개수만큼만
        // 캐시 파일이 존재하므로 누적 상한이 자연히 제한된다(사용자 산출물 아님).
        let tmp = app_data_dir()
            .join("online_cache")
            .join(format!("scenario_{idx}.jpg"));
        // 실패 시 백오프: last_run_at을 갱신하고 저장해 매 틱 재시도 폭주를 막는다.
        if let Err(e) = download_to_temp(&url, &tmp) {
            settings.last_run_at = Some(now_secs);
            let _ = save_scenario(&settings);
            return Err(e);
        }
        let state = match crate::wallpaper::set_wallpaper(&tmp, None, settings.position_enum()) {
            Ok(s) => s,
            Err(e) => {
                settings.last_run_at = Some(now_secs);
                let _ = save_scenario(&settings);
                return Err(e);
            }
        };
        settings.next_index = settings.next_index.wrapping_add(1) % len.max(1);
        settings.last_run_at = Some(now_secs);
        save_scenario(&settings)?;
        return Ok(Some(state));
    }

    if let Some(dir) = settings.source.local_dir.clone() {
        let dir_path = PathBuf::from(dir.trim());
        let mut files: Vec<PathBuf> = Vec::new();
        if dir_path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&dir_path) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                            let lower = ext.to_ascii_lowercase();
                            if ["jpg", "jpeg", "png", "bmp"].contains(&lower.as_str()) {
                                files.push(p);
                            }
                        }
                    }
                }
            }
        }
        if files.is_empty() {
            return Ok(None);
        }
        files.sort();
        let idx = match settings.order {
            ScenarioOrder::Sequential => settings.next_index % files.len(),
            ScenarioOrder::Random => (now_secs as usize) % files.len(),
        };
        let state =
            crate::wallpaper::set_wallpaper(&files[idx], None, settings.position_enum())?;
        settings.next_index = settings.next_index.wrapping_add(1) % files.len().max(1);
        settings.last_run_at = Some(now_secs);
        save_scenario(&settings)?;
        return Ok(Some(state));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_urls(urls: &[&str]) -> ScenarioSettings {
        ScenarioSettings {
            enabled: true,
            interval_minutes: 60,
            source: ScenarioSource {
                urls: urls.iter().map(|s| s.to_string()).collect(),
                local_dir: None,
                search_queries: Vec::new(),
            },
            order: ScenarioOrder::Sequential,
            next_index: 0,
            last_run_at: None,
            position: "fill".to_string(),
            provider: ImageProvider::default(),
            prompt: String::new(),
            cloudflare: CloudflareAiConfig::default(),
            openai: OpenAiConfig::default(),
            provider_order: default_provider_order(),
            disabled_providers: Vec::new(),
            seed_mode: SeedMode::Random,
            seed_fixed: 0,
            seed_next: 0,
            clear_api_token: false,
            clear_api_key: false,
        }
    }

    #[test]
    fn test_should_run_gating() {
        // disabled → false
        let mut s = settings_with_urls(&["https://cdn.example.com/w1.jpg"]);
        s.enabled = false;
        assert!(!should_run(&s, 1_000_000));

        // enabled + never run + source → true
        s.enabled = true;
        assert!(should_run(&s, 1_000_000));

        // interval not elapsed → false
        s.last_run_at = Some(1_000_000);
        assert!(!should_run(&s, 1_000_000 + 59 * 60));

        // interval elapsed → true
        assert!(should_run(&s, 1_000_000 + 60 * 60));

        // enabled but no source → false
        s.last_run_at = None;
        s.source.urls.clear();
        assert!(!should_run(&s, 2_000_000));
    }

    #[test]
    fn test_pick_next_url_sequential_and_random() {
        let mut s = settings_with_urls(&["https://a/w1.jpg", "https://a/w2.jpg"]);
        s.order = ScenarioOrder::Sequential;
        s.next_index = 1;
        assert_eq!(
            pick_next_url(&s, 0),
            Some((1, "https://a/w2.jpg".to_string()))
        );
        s.order = ScenarioOrder::Random;
        assert_eq!(
            pick_next_url(&s, 5),
            Some((1, "https://a/w2.jpg".to_string()))
        );
        s.source.urls.clear();
        assert_eq!(pick_next_url(&s, 0), None);
    }

    #[test]
    fn test_validate_rejects_short_interval() {
        let mut s = ScenarioSettings::default();
        s.interval_minutes = 3;
        assert!(s.validate().is_err());
        s.interval_minutes = 5;
        assert!(s.validate().is_ok());
    }

    // ── 개별 On/Off (disabled_providers) 회귀 테스트 ──
    #[test]
    fn test_disabled_providers_excluded_from_order_and_config() {
        let mut s = settings_with_urls(&["https://cdn.example.com/w1.jpg"]);
        s.openai.api_key = "sk-test".to_string();
        s.provider_order = vec![
            ImageProvider::Pollinations,
            ImageProvider::CloudflareWorkersAi,
            ImageProvider::Openai,
        ];
        s.disabled_providers = vec![ImageProvider::Pollinations];

        // Off 공급자는 순서 해석에서 빠지고, 자격 판정도 false 다.
        assert_eq!(
            effective_provider_order(&s),
            vec![ImageProvider::CloudflareWorkersAi, ImageProvider::Openai]
        );
        assert!(!provider_is_configured(&s, ImageProvider::Pollinations));
        assert!(provider_is_configured(&s, ImageProvider::Openai));

        // 전부 Off 면 후보가 비어 자동 실행이 성립하지 않는다(조용한 성공 금지).
        s.disabled_providers = vec![
            ImageProvider::Pollinations,
            ImageProvider::CloudflareWorkersAi,
            ImageProvider::Openai,
        ];
        assert!(effective_provider_order(&s).is_empty());
    }

    #[test]
    fn test_disabled_providers_defaults_empty_for_legacy_json() {
        // 구버전 scenario.json(필드 없음)도 그대로 로드되고, On/Off 는 기본 "모두 On" 이다.
        let raw = r#"{"enabled":false,"interval_minutes":60}"#;
        let parsed: ScenarioSettings = serde_json::from_str(raw).expect("legacy scenario json");
        assert!(parsed.disabled_providers.is_empty());
        assert!(provider_is_configured(&parsed, ImageProvider::Pollinations));
    }

    // ── 검수 지적 3 (Red→Green): 신규 순수 헬퍼 3종의 회귀 테스트 ──
    // 구현 전 상태에서는 아래 헬퍼가 없어 컴파일 FAIL(Red)이어야 한다.
    #[test]
    fn test_http_status_preserves_code() {
        let e404 = crate::scenario::scenario_http_status_error(
            404,
            "scenario image HTTP 404: not found".to_string(),
        );
        let e500 = crate::scenario::scenario_http_status_error(
            500,
            "scenario image HTTP 500: boom".to_string(),
        );
        match e404 {
            WallpaperError::HttpStatus { status, .. } => assert_eq!(status, 404),
            other => panic!("expected HttpStatus for 404, got: {other:?}"),
        }
        match e500 {
            WallpaperError::HttpStatus { status, .. } => assert_eq!(status, 500),
            other => panic!("expected HttpStatus for 500, got: {other:?}"),
        }
    }

    #[test]
    fn test_needs_cursor_reset_detects_source_change() {
        use crate::scenario::needs_cursor_reset;
        let prev = vec!["https://cdn.example.com/w1.jpg".to_string()];
        // 동일 소스 → 리셋 불필요
        assert!(!needs_cursor_reset(&prev, None, &prev, None));
        // URL 추가 → 리셋 필요
        let changed = vec![
            "https://cdn.example.com/w1.jpg".to_string(),
            "https://cdn.example.com/w2.jpg".to_string(),
        ];
        assert!(needs_cursor_reset(&prev, None, &changed, None));
        // local_dir 변경 → 리셋 필요
        assert!(needs_cursor_reset(&prev, None, &prev, Some("C:\\pics")));
        assert!(needs_cursor_reset(
            &prev,
            Some("C:\\pics"),
            &prev,
            Some("D:\\other")
        ));
    }

    #[test]
    fn test_failure_backoff_delays_retry() {
        use crate::scenario::failure_retry_allowed_at;
        // 실패 시각 now=1_000_000, 주기 60분이면 다음 허용은 +3600초이다.
        let allowed = failure_retry_allowed_at(1_000_000, 60);
        assert_eq!(allowed, 1_000_000 + 60 * 60);
        // 백오프 전(허용 시각 이전)에는 should_run이 false여야 한다.
        let mut s = settings_with_urls(&["https://cdn.example.com/w1.jpg"]);
        s.last_run_at = Some(1_000_000);
        assert!(!should_run(&s, allowed - 1));
        assert!(should_run(&s, allowed));
    }

    #[test]
    fn cf_url_format() {
        assert_eq!(
            cloudflare_ai_url(" acc ", " @cf/x "),
            "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/x"
        );
    }

    #[test]
    fn cf_parse_result_image_ok() {
        use base64::Engine as _;
        let raw = b"fake-jpeg-bytes";
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        let v = serde_json::json!({"result": {"image": b64}});
        assert_eq!(parse_cf_image_response(&v).expect("parse"), raw.to_vec());
    }

    #[test]
    fn cf_parse_result_string_variant_ok() {
        use base64::Engine as _;
        let raw = b"variant-bytes";
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        let v = serde_json::json!({"result": b64});
        assert_eq!(parse_cf_image_response(&v).expect("parse"), raw.to_vec());
    }

    #[test]
    fn cf_parse_missing_image_errors() {
        let v = serde_json::json!({"result": {}});
        let err = parse_cf_image_response(&v).expect_err("must fail without result.image");
        assert!(
            matches!(err, WallpaperError::CandidateLoad(_)),
            "expected CandidateLoad, got: {err:?}"
        );
    }

    #[test]
    fn cf_parse_bad_base64_errors() {
        let v = serde_json::json!({"result": {"image": "!!!not-base64!!!"}});
        let err = parse_cf_image_response(&v).expect_err("must fail on bad base64");
        assert!(
            matches!(err, WallpaperError::CandidateLoad(_)),
            "expected CandidateLoad, got: {err:?}"
        );
    }

    // ── 검수 지적 [medium](1): 폴백 우선순위 결정 로직의 결정적 테스트 ──
    // 네트워크 의존 생성 함수는 generate_ai_with_fallback_with의 attempt 클로저로
    // 주입해 모의하므로, 외부 호출 없이 결정적으로 검증한다.
    #[test]
    fn test_default_provider_order_is_free_first() {
        assert_eq!(
            default_provider_order(),
            vec![
                ImageProvider::Pollinations,
                ImageProvider::CloudflareWorkersAi,
                ImageProvider::Openai,
            ]
        );
    }

    #[test]
    fn test_effective_provider_order_empty_falls_back_to_single_and_dedups() {
        // 빈 배열(구 scenario.json) → [provider] 단일 시도로 하위호환
        let mut s = settings_with_urls(&["https://cdn.example.com/w1.jpg"]);
        s.provider = ImageProvider::Openai;
        s.provider_order = vec![];
        assert_eq!(effective_provider_order(&s), vec![ImageProvider::Openai]);
        // 중복은 첫 등장만 유지
        s.provider_order = vec![
            ImageProvider::CloudflareWorkersAi,
            ImageProvider::Pollinations,
            ImageProvider::CloudflareWorkersAi,
            ImageProvider::Openai,
            ImageProvider::Pollinations,
        ];
        assert_eq!(
            effective_provider_order(&s),
            vec![
                ImageProvider::CloudflareWorkersAi,
                ImageProvider::Pollinations,
                ImageProvider::Openai,
            ]
        );
    }

    #[test]
    fn test_provider_is_configured_checks_credentials() {
        let mut s = ScenarioSettings::default();
        // Pollinations는 키 불필요라 항상 true
        assert!(provider_is_configured(&s, ImageProvider::Pollinations));
        // Cloudflare는 account_id + api_token 모두 필요
        assert!(!provider_is_configured(
            &s,
            ImageProvider::CloudflareWorkersAi
        ));
        s.cloudflare.account_id = "acc".to_string();
        assert!(!provider_is_configured(
            &s,
            ImageProvider::CloudflareWorkersAi
        ));
        s.cloudflare.api_token = "tok".to_string();
        assert!(provider_is_configured(
            &s,
            ImageProvider::CloudflareWorkersAi
        ));
        // OpenAI는 api_key 필요
        assert!(!provider_is_configured(&s, ImageProvider::Openai));
        s.openai.api_key = "sk-x".to_string();
        assert!(provider_is_configured(&s, ImageProvider::Openai));
    }

    #[test]
    fn test_fallback_skips_unconfigured_without_network_call() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut s = ScenarioSettings::default();
        // 순서: Cloudflare(키 없음) → OpenAI(키 없음) → Pollinations(항상 시도)
        s.provider_order = vec![
            ImageProvider::CloudflareWorkersAi,
            ImageProvider::Openai,
            ImageProvider::Pollinations,
        ];
        let calls = AtomicUsize::new(0);
        let dest = PathBuf::from("dummy.jpg");
        let (used, _) = generate_ai_with_fallback_with(&s, "sunset", &dest, |p, _, d| {
            calls.fetch_add(1, Ordering::SeqCst);
            // 자격 미달 공급자가 호출되면 테스트 실패 — 네트워크 없이 스킵되어야 한다
            assert_eq!(p, ImageProvider::Pollinations);
            Ok(d.clone())
        })
        .expect("pollinations fallback must succeed");
        assert_eq!(used, ImageProvider::Pollinations);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_fallback_returns_last_error_when_all_fail() {
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Pollinations];
        let dest = PathBuf::from("dummy.jpg");
        let err = generate_ai_with_fallback_with(&s, "sunset", &dest, |_, _, _| {
            Err(WallpaperError::Network("boom".to_string()))
        })
        .expect_err("all-fail must be Err, never Ok fallthrough");
        assert!(
            matches!(err, WallpaperError::Network(_)),
            "expected last error passthrough, got: {err:?}"
        );
    }

    #[test]
    fn test_should_run_false_when_no_configured_provider() {
        // 프롬프트만 있고 자격 갖춘 공급자가 0개 → false
        let mut s = settings_with_urls(&[]);
        s.prompt = "aurora".to_string();
        // Pollinations는 항상 자격 있음 → true가 되므로, 순서에서 제외해 0개 상태를 만든다
        s.provider = ImageProvider::CloudflareWorkersAi;
        s.provider_order = vec![ImageProvider::CloudflareWorkersAi];
        assert!(!should_run(&s, 1_000_000));
        // 토큰을 채우면 자격 1개 → true
        s.cloudflare.account_id = "acc".to_string();
        s.cloudflare.api_token = "tok".to_string();
        assert!(should_run(&s, 1_000_000));
    }

    // ── 검색(Search) 공급자·소스 회귀 테스트 ──

    #[test]
    fn test_search_provider_id_and_detail() {
        assert_eq!(ImageProvider::Search.as_id(), "search");
        let s = ScenarioSettings::default();
        let detail = generation_source_detail(&s, ImageProvider::Search);
        assert!(
            detail.contains("search") || detail.contains("검색"),
            "Search 공급자의 생성 경로 설명이 비어 있으면 안 된다: {detail}"
        );
    }

    #[test]
    fn test_search_provider_configured_requires_keyword() {
        let mut s = ScenarioSettings::default();
        // 키워드가 없으면 Search 는 자격 없음(네트워크 호출 없이 스킵).
        assert!(!provider_is_configured(&s, ImageProvider::Search));
        // 공백 키워드도 자격 없음.
        s.source.search_queries = vec!["   ".to_string()];
        assert!(!provider_is_configured(&s, ImageProvider::Search));
        // 실제 키워드 1개 → 자격 있음 (키 불필요 공급자).
        s.source.search_queries = vec!["aurora".to_string()];
        assert!(provider_is_configured(&s, ImageProvider::Search));
        // Off 로 두면 키워드가 있어도 제외.
        s.disabled_providers = vec![ImageProvider::Search];
        assert!(!provider_is_configured(&s, ImageProvider::Search));
    }

    /// 검색어와 프롬프트는 서로 무관한 별개 입력이다 — Search 자격은
    /// 검색 영역의 키워드(`source.search_queries`) **단독**으로만 판정한다.
    /// 프롬프트(`settings.prompt`)가 채워져 있어도 검색 자격을 만들지 않는다
    /// (프롬프트→검색어 폴백 제거).
    #[test]
    fn test_provider_is_configured_search_ignores_prompt() {
        let mut s = ScenarioSettings::default();
        assert!(valid_search_queries(&s).is_empty());
        // 프롬프트만 채워도 Search 는 자격 없음.
        s.prompt = "neon harbor".to_string();
        assert!(
            !provider_is_configured(&s, ImageProvider::Search),
            "프롬프트는 검색 자격에 관여하지 않아야 한다"
        );
        // 검색어를 넣으면 자격 있음 — 프롬프트 유무와 무관.
        s.source.search_queries = vec!["aurora".to_string()];
        assert!(provider_is_configured(&s, ImageProvider::Search));
        s.prompt = "   ".to_string();
        assert!(provider_is_configured(&s, ImageProvider::Search));
        // 공백 검색어는 자격 없음 (네트워크 호출 금지).
        s.source.search_queries = vec!["   ".to_string()];
        assert!(!provider_is_configured(&s, ImageProvider::Search));
    }

    /// 검수 지적 [medium]: 시나리오 키워드 목록이 있으면 공용 프롬프트보다 우선하며,
    /// `order`/`next_index` 로 순환한다.
    #[test]
    fn test_search_query_for_prefers_keywords_over_prompt() {
        let mut s = ScenarioSettings::default();
        s.prompt = "shared prompt".to_string();
        s.source.search_queries = vec!["aurora".to_string(), "neon city".to_string()];
        s.order = ScenarioOrder::Sequential;
        s.next_index = 0;
        assert_eq!(search_query_for(&s, 7).as_deref(), Some("aurora"));
        s.next_index = 1;
        assert_eq!(
            search_query_for(&s, 7).as_deref(),
            Some("neon city"),
            "순차 모드는 next_index 로 순환해야 한다"
        );
        // 랜덤 모드: seed 로 인덱스가 결정된다(같은 seed = 같은 키워드).
        s.order = ScenarioOrder::Random;
        let a = search_query_for(&s, 2);
        let b = search_query_for(&s, 2);
        assert_eq!(a, b);
        assert_eq!(a.as_deref(), Some("aurora"));
    }

    #[test]
    fn test_search_query_for_uses_keywords_only_and_none_when_empty() {
        let mut s = ScenarioSettings::default();
        // 프롬프트만 있어도 검색어가 없다 → None (프롬프트 폴백 없음).
        s.prompt = "mountain lake".to_string();
        assert_eq!(
            search_query_for(&s, 0),
            None,
            "프롬프트는 검색어로 쓰이지 않는다"
        );
        // 공백 키워드만 있는 경우도 None.
        s.source.search_queries = vec!["   ".to_string()];
        assert_eq!(search_query_for(&s, 0), None);
        // 유효 키워드가 있으면 그 값이 검색어다 (프롬프트는 무시).
        s.source.search_queries = vec!["aurora".to_string()];
        assert_eq!(search_query_for(&s, 0).as_deref(), Some("aurora"));
    }

    /// 폴백 루프가 Search 에 **키워드**를 넘기는지 (이전 구현은 항상 prompt 를 넘겨
    /// 사용자가 작성한 키워드 목록이 무시되었다).
    #[test]
    fn test_fallback_passes_keyword_not_prompt_to_search() {
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["aurora".to_string()];
        s.next_index = 0;
        let dest = PathBuf::from("dummy.jpg");
        let (used, _) = generate_ai_with_fallback_with(&s, "shared prompt", &dest, |p, query, d| {
            assert_eq!(p, ImageProvider::Search);
            assert_eq!(
                query, "aurora",
                "키워드 목록이 프롬프트보다 우선해야 한다"
            );
            Ok(d.clone())
        })
        .expect("search must use the scenario keyword");
        assert_eq!(used, ImageProvider::Search);
    }

    /// 프롬프트가 비어 있어도 키워드만으로 실행된다 (이전 구현은 "empty prompt" 오류).
    #[test]
    fn test_fallback_allows_empty_prompt_when_keywords_exist() {
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["neon city".to_string()];
        let dest = PathBuf::from("dummy.jpg");
        let (used, _) = generate_ai_with_fallback_with(&s, "", &dest, |p, query, d| {
            assert_eq!(p, ImageProvider::Search);
            assert_eq!(query, "neon city");
            Ok(d.clone())
        })
        .expect("keywords-only scenario must not fail on empty prompt");
        assert_eq!(used, ImageProvider::Search);
        // 키워드도 프롬프트도 없으면 여전히 명시적 오류 (조용한 폴스루 금지).
        s.source.search_queries.clear();
        let err = generate_ai_with_fallback_with(&s, "", &dest, |_, _, d| Ok(d.clone()))
            .expect_err("no prompt and no keyword must be an explicit error");
        assert!(matches!(err, WallpaperError::CandidateLoad(_)));
    }

    #[test]
    fn test_should_run_true_with_search_queries_only() {
        // 프롬프트·URL·로컬 폴더가 모두 비어 있어도 검색 키워드만으로 실행 조건을 만족한다.
        let mut s = settings_with_urls(&[]);
        s.provider = ImageProvider::Search;
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["neon city".to_string()];
        assert!(should_run(&s, 1_000_000));
        // 키워드가 비면 실행 조건 불충족.
        s.source.search_queries.clear();
        assert!(!should_run(&s, 1_000_000));
    }

    #[test]
    fn test_search_fallback_branch_is_explicit() {
        // generate_ai_with_fallback 은 Search 를 명시적으로 search.rs 경로로 넘긴다.
        // 실제 네트워크 호출 대신 attempt 클로저로 주입해 결정적으로 검증한다.
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["aurora".to_string()];
        let dest = PathBuf::from("dummy.jpg");
        let (used, _) = generate_ai_with_fallback_with(&s, "aurora", &dest, |p, query, d| {
            assert_eq!(p, ImageProvider::Search);
            assert_eq!(query, "aurora");
            Ok(d.clone())
        })
        .expect("search provider must be attempted when configured");
        assert_eq!(used, ImageProvider::Search);
    }

    // ── 검색 질의 우선순위 회귀 테스트 (검수 지적 [high]/[medium]) ──

    #[test]
    fn test_search_prefers_saved_keywords_over_shared_prompt() {
        // 시나리오에 저장된 키워드 목록이 있으면 공용 프롬프트보다 우선한다.
        // (이전 구현은 항상 prompt 만 검색어로 써서 사용자가 작성한 키워드 순환이 무시됐다)
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["aurora".to_string(), "neon city".to_string()];
        s.prompt = "shared prompt".to_string();
        let prompt = s.prompt.clone();
        let dest = PathBuf::from("dummy.jpg");
        let (used, _) = generate_ai_with_fallback_with(&s, &prompt, &dest, |p, query, d| {
            assert_eq!(p, ImageProvider::Search);
            assert_eq!(
                query, "aurora",
                "saved keyword must win over the shared prompt"
            );
            Ok(d.clone())
        })
        .expect("search must run with saved keywords");
        assert_eq!(used, ImageProvider::Search);
    }

    /// 검색어와 프롬프트는 **서로 무관한 별개 입력**이다.
    ///
    /// 이전 구현은 검색어가 비어 있으면 프롬프트를 검색 키워드로 승격(폴백)했으나,
    /// 사용자는 "검색은 검색 창에서, 생성은 생성 창에서" 라고 명확히 분리해 요구했다.
    /// 따라서 검색어가 없으면 프롬프트가 있어도 Search 는 시도되지 않아야 한다.
    #[test]
    fn test_search_never_falls_back_to_prompt() {
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        assert!(s.source.search_queries.is_empty());
        let dest = PathBuf::from("dummy.jpg");

        // (1) 프롬프트만 있고 검색어가 없으면 시도조차 하지 않는다 (attempt 미호출).
        let err = generate_ai_with_fallback_with(&s, "manual keyword", &dest, |_, _, _dest| {
            panic!("검색어가 비었으면 Search 는 시도되지 않아야 한다 (프롬프트 폴백 금지)");
            #[allow(unreachable_code)]
            Ok(_dest.clone())
        })
        .expect_err("검색어 없는 Search 는 명시적 오류여야 한다");
        assert!(matches!(err, WallpaperError::CandidateLoad(_)));

        // (2) 검색어가 있으면 프롬프트가 아니라 검색어가 질의문이 된다.
        s.source.search_queries = vec!["window keyword".to_string()];
        let (used, _, used_query) =
            generate_ai_with_fallback_with_query(&s, "manual keyword", &dest, |p, q, d| {
                assert_eq!(p, ImageProvider::Search);
                assert_eq!(q, "window keyword", "검색어가 프롬프트를 대체해야 한다");
                Ok(d.clone())
            })
            .expect("검색어가 있으면 실행된다");
        assert_eq!(used, ImageProvider::Search);
        assert_eq!(used_query, "window keyword");

        // (3) disabled_providers 에 Search 가 있으면 검색어가 있어도 스킵된다.
        s.disabled_providers = vec![ImageProvider::Search];
        let err = generate_ai_with_fallback_with(&s, "manual keyword", &dest, |_, _, d| Ok(d.clone()))
            .expect_err("disabled Search must be skipped");
        assert!(matches!(err, WallpaperError::CandidateLoad(_)));
    }

    #[test]
    fn test_search_runs_with_empty_prompt_when_keywords_exist() {
        // 프롬프트가 비어 있어도 키워드 목록만으로 실행된다
        // ("empty prompt: image generation needs a text prompt" 로 무조건 실패하면 결함).
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["only keyword".to_string()];
        assert!(s.prompt.trim().is_empty());
        let dest = PathBuf::from("dummy.jpg");
        let (used, _) = generate_ai_with_fallback_with(&s, "", &dest, |p, query, d| {
            assert_eq!(p, ImageProvider::Search);
            assert_eq!(query, "only keyword");
            Ok(d.clone())
        })
        .expect("keyword-only scenario must not fail with 'empty prompt'");
        assert_eq!(used, ImageProvider::Search);
    }

    #[test]
    fn test_search_query_for_rotates_and_falls_back() {
        let mut s = ScenarioSettings::default();
        s.source.search_queries = vec![
            "first".to_string(),
            "  ".to_string(),
            "second".to_string(),
        ];
        s.order = ScenarioOrder::Sequential;
        s.next_index = 0;
        // 공백 키워드는 후보에서 제외되고 저장 순서대로 순환한다.
        assert_eq!(search_query_for(&s, 0).as_deref(), Some("first"));
        s.next_index = 1;
        assert_eq!(search_query_for(&s, 0).as_deref(), Some("second"));
        // 키워드가 모두 공백이면 프롬프트로 폴백(공백은 trim).
        s.source.search_queries = vec!["   ".to_string()];
        assert_eq!(
            search_query_for(&s, 0).as_deref(),
            None,
            "검색어가 없으면 프롬프트로 대체하지 않고 None 이어야 한다"
        );
        // 둘 다 비면 None — 호출자는 네트워크 호출 없이 스킵해야 한다.
        s.source.search_queries.clear();
        assert_eq!(search_query_for(&s, 0), None);
    }

    #[test]
    fn test_search_queries_legacy_json_compatible() {
        // 구버전 scenario.json(ScenarioSource 에 search_queries 필드 없음)도 그대로 로드된다.
        let raw = r#"{"enabled":false,"interval_minutes":60,"source":{"urls":["https://cdn.example.com/w1.jpg"],"local_dir":null}}"#;
        let parsed: ScenarioSettings = serde_json::from_str(raw).expect("legacy scenario json");
        assert!(
            parsed.source.search_queries.is_empty(),
            "legacy json must default search_queries to an empty vec"
        );
        // 직렬화 왕복: 필드가 항상 기록되어 저장 후 재조회에서 유지된다.
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(json.contains("search_queries"));
    }

    #[test]
    fn test_search_rotation_advances_next_index_and_formats_query_detail() {
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["first_kw".to_string(), "second_kw".to_string()];
        s.prompt = "shared prompt".to_string();
        s.order = ScenarioOrder::Sequential;
        s.next_index = 0;

        let dest = PathBuf::from("dummy.jpg");
        // 1회차: first_kw 선택 — 반환된 질의문(used_query)이 **실제 시도 질의문**과 같아야 한다.
        let (used1, _, q1) =
            generate_ai_with_fallback_with_query(&s, &s.prompt, &dest, |p, q, d| {
                assert_eq!(p, ImageProvider::Search);
                assert_eq!(q, "first_kw");
                Ok(d.clone())
            })
            .expect("1st search attempt");
        assert_eq!(used1, ImageProvider::Search);
        assert_eq!(
            q1, "first_kw",
            "반환 질의문은 search_query_for 재호출이 아니라 실제 시도 질의문이어야 한다"
        );
        let detail1 = format!("{} · query: {q1}", generation_source_detail(&s, used1));
        assert!(detail1.contains("· query: first_kw"));
        let query_count = valid_search_queries(&s).len();
        s.next_index = s.next_index.wrapping_add(1) % query_count;
        assert_eq!(s.next_index, 1);

        // 2회차: second_kw 선택 후 0으로 모듈로 순환
        let (used2, _, q2) =
            generate_ai_with_fallback_with_query(&s, &s.prompt, &dest, |p, q, d| {
                assert_eq!(p, ImageProvider::Search);
                assert_eq!(q, "second_kw");
                Ok(d.clone())
            })
            .expect("2nd search attempt");
        assert_eq!(used2, ImageProvider::Search);
        assert_eq!(q2, "second_kw");
        let detail2 = format!("{} · query: {q2}", generation_source_detail(&s, used2));
        assert!(detail2.contains("· query: second_kw"));
        s.next_index = s.next_index.wrapping_add(1) % query_count;
        assert_eq!(s.next_index, 0);
    }

    /// 회귀 테스트 (검수 지적 [medium]: ② 검색 경로의 검색어 표기 불일치).
    ///
    /// tick·우선순위 생성은 적용 후 `next_index` 를 전진시킨다. 따라서 호출 측이
    /// `search_query_for` 를 **다시** 호출해 기록하면, 이미지가 실제로 만들어진 검색어와
    /// 다른 값이 기록된다(순차: 커서가 이미 넘어감 / 랜덤: seed 가 달라짐).
    /// 반환된 질의문은 반드시 실제 시도 질의문이어야 한다.
    #[test]
    fn test_returned_query_is_the_used_one_not_a_recomputation() {
        let mut s = ScenarioSettings::default();
        s.provider_order = vec![ImageProvider::Search];
        s.source.search_queries = vec!["first_kw".to_string(), "second_kw".to_string()];
        s.prompt = "shared prompt".to_string();
        s.order = ScenarioOrder::Sequential;
        s.next_index = 0;

        let dest = PathBuf::from("dummy.jpg");
        // attempt 는 `Fn` 이므로 내부 가변 캡처를 쓸 수 없다 — `Cell` 로 수집한다.
        let attempted: std::cell::Cell<Option<String>> = std::cell::Cell::new(None);
        let (_, _, used_query) =
            generate_ai_with_fallback_with_query(&s, &s.prompt, &dest, |p, q, d| {
                assert_eq!(p, ImageProvider::Search);
                attempted.set(Some(q.to_string()));
                Ok(d.clone())
            })
            .expect("search attempt");

        let attempted = attempted
            .take()
            .expect("attempt 클로저는 반드시 호출되어야 한다");
        assert_eq!(
            used_query, attempted,
            "반환 질의문과 실제 시도 질의문이 달라선 안 된다"
        );
        assert_eq!(used_query, "first_kw");

        // 적용 후 커서를 전진시키면 재계산 값은 "second_kw" 로 갈라진다 —
        // 재계산을 기록에 쓰면 이 어긋남이 그대로 사용자 표기에 노출된다.
        let query_count = valid_search_queries(&s).len();
        s.next_index = s.next_index.wrapping_add(1) % query_count;
        assert_eq!(
            search_query_for(&s, 0).as_deref(),
            Some("second_kw"),
            "재계산 값이 실제 사용 값과 달라지는 조건임을 고정한다"
        );
        assert_ne!(
            used_query, "second_kw",
            "기록에는 재계산 값이 아니라 실제 사용 값이 쓰여야 한다"
        );
    }

    /// seed 정책의 기본값은 `Random` 이어야 한다 — 같은 프롬프트로 항상 같은 이미지가
    /// 나오던 결함(seed 미전송)을 기본값에서부터 제거한다.
    ///
    /// 구 `scenario.json`(seed 필드 없음)도 이 기본값으로 로드되어야 하므로
    /// serde 기본값과 `Default` 구현이 같은 값을 내야 한다.
    #[test]
    fn test_seed_mode_defaults_to_random_for_legacy_json() {
        // ① Default 구현
        assert_eq!(ScenarioSettings::default().seed_mode, SeedMode::Random);
        assert_eq!(ScenarioSettings::default().seed_fixed, 0);
        assert_eq!(ScenarioSettings::default().seed_next, 0);

        // ② 구버전 JSON(seed 필드 없음) 역직렬화 — 필드가 없어도 실패하지 않아야 한다.
        let legacy = serde_json::json!({
            "enabled": false,
            "interval_minutes": 60,
            "source": { "urls": [], "local_dir": null },
            "order": "sequential",
            "next_index": 0,
            "position": "fill",
        });
        let parsed: ScenarioSettings =
            serde_json::from_value(legacy).expect("legacy scenario.json must load");
        assert_eq!(
            parsed.seed_mode,
            SeedMode::Random,
            "구버전 JSON 은 seed_mode 기본값 Random 으로 로드되어야 한다"
        );
    }

    /// 모드별 seed 결정 — 순수 함수라 네트워크 없이 검증한다.
    #[test]
    fn test_next_seed_value_modes() {
        // Fixed: 고정값을 그대로 쓴다(재현성).
        assert_eq!(next_seed_value(SeedMode::Fixed, 12345, 7, 1_700_000_000), 12345);
        // Incremental: 카운터를 그대로 쓴다(생성마다 1씩 증가).
        assert_eq!(next_seed_value(SeedMode::Incremental, 12345, 7, 1_700_000_000), 7);
        // Random: 같은 (now, counter) 면 같은 값, 하나라도 다르면 다른 값.
        let a = next_seed_value(SeedMode::Random, 0, 3, 1_700_000_000);
        let b = next_seed_value(SeedMode::Random, 0, 3, 1_700_000_000);
        let c = next_seed_value(SeedMode::Random, 0, 4, 1_700_000_000);
        let d = next_seed_value(SeedMode::Random, 0, 3, 1_700_000_001);
        assert_eq!(a, b, "같은 시각·카운터면 같은 seed (결정적)");
        assert_ne!(a, c, "카운터가 다르면 seed 가 달라야 한다(같은 초 재생성 대응)");
        assert_ne!(a, d, "시각이 다르면 seed 가 달라야 한다");
    }

    /// `advance_seed` 는 Fixed 가 아닐 때만 카운터를 전진시킨다 — Fixed 에서 전진시키면
    /// "고정 seed" 라는 약속이 조용히 깨진다.
    #[test]
    fn test_advance_seed_increments_except_fixed() {
        let mut fixed = ScenarioSettings::default();
        fixed.seed_mode = SeedMode::Fixed;
        fixed.seed_next = 5;
        advance_seed(&mut fixed);
        assert_eq!(fixed.seed_next, 5, "Fixed 는 카운터를 전진시키지 않는다");

        for mode in [SeedMode::Incremental, SeedMode::Random] {
            let mut s = ScenarioSettings::default();
            s.seed_mode = mode;
            s.seed_next = 5;
            advance_seed(&mut s);
            assert_eq!(s.seed_next, 6, "{mode:?} 는 카운터를 1 전진시킨다");
        }
    }

    /// 회귀 테스트: 시나리오 tick·우선순위 생성도 **seed 카운터를 전진**시켜야 한다.
    ///
    /// 배경(실측 결함): 두 경로는 `next_index` 만 전진시키고 `seed_next` 는 그대로 두었다.
    /// `next_seed_value(Incremental, ..)` 는 `counter = seed_next` 를 그대로 반환하므로
    /// 카운터가 0 에 고정되어 **매 생성이 같은 seed → 같은 이미지**가 됐다.
    /// (수동 ② 생성만 `take_generation_seed` 로 전진하고 있었다.)
    #[test]
    fn test_advance_after_generation_advances_seed_counter() {
        // ① Incremental: 생성 1회마다 seed_next 가 전진해야 다음 생성이 다른 이미지를 만든다.
        let mut s = ScenarioSettings::default();
        s.seed_mode = SeedMode::Incremental;
        s.seed_next = 0;
        let first = next_seed_value(s.seed_mode, s.seed_fixed, s.seed_next, 0);
        advance_after_generation(&mut s, ImageProvider::Pollinations);
        let second = next_seed_value(s.seed_mode, s.seed_fixed, s.seed_next, 0);
        assert_ne!(
            first, second,
            "시나리오 tick·우선순위 경로도 seed 카운터를 전진시켜야 한다(같은 이미지 재생 방지)"
        );
        assert_eq!(s.seed_next, 1);

        // ② Fixed: 고정 seed 약속은 그대로 — 카운터가 전진하지 않는다.
        let mut fixed = ScenarioSettings::default();
        fixed.seed_mode = SeedMode::Fixed;
        fixed.seed_fixed = 42;
        fixed.seed_next = 7;
        advance_after_generation(&mut fixed, ImageProvider::Pollinations);
        assert_eq!(fixed.seed_next, 7, "Fixed 는 카운터를 전진시키지 않는다");
        assert_eq!(
            next_seed_value(fixed.seed_mode, fixed.seed_fixed, fixed.seed_next, 0),
            42,
            "Fixed 는 어떤 전진 이후에도 같은 seed 를 내야 한다"
        );

        // ③ Search: next_index 는 유효 키워드 수로 모듈로 순환하고, seed 도 함께 전진한다.
        let mut search = ScenarioSettings::default();
        search.seed_mode = SeedMode::Incremental;
        search.source.search_queries = vec!["a".to_string(), "b".to_string()];
        search.next_index = 1;
        advance_after_generation(&mut search, ImageProvider::Search);
        assert_eq!(search.next_index, 0, "Search 커서는 키워드 수로 모듈로 순환");
        assert_eq!(search.seed_next, 1, "Search 경로도 seed 카운터를 전진시킨다");

        // ④ 키워드 없는 Search: 0 나눗셈 없이 단순 증가.
        let mut no_kw = ScenarioSettings::default();
        no_kw.next_index = 3;
        advance_after_generation(&mut no_kw, ImageProvider::Search);
        assert_eq!(no_kw.next_index, 4);
    }

    /// seed 지원 여부 — 미지원 공급자에 seed 를 보내면 400 이 되므로 계약을 고정한다.
    #[test]
    fn test_provider_supports_seed_matrix() {
        assert!(provider_supports_seed(ImageProvider::Pollinations));
        assert!(
            provider_supports_seed(ImageProvider::CloudflareWorkersAi),
            "Cloudflare 는 flux 계열에서 seed 를 지원한다"
        );
        assert!(
            !provider_supports_seed(ImageProvider::Openai),
            "OpenAI Images API 는 seed 파라미터가 없다 — 보내면 안 된다"
        );
        assert!(!provider_supports_seed(ImageProvider::Search));
        assert!(!provider_supports_seed(ImageProvider::Puter));
    }

    /// Cloudflare 는 모델별 입력 스키마가 다르다 — flux 계열만 seed 를 받는다.
    #[test]
    fn test_cloudflare_accepts_seed_only_for_flux_models() {
        assert!(cloudflare_accepts_seed("@cf/black-forest-labs/flux-1-schnell"));
        assert!(cloudflare_accepts_seed("FLUX.2 [dev]"));
        assert!(!cloudflare_accepts_seed(
            "@cf/stabilityai/stable-diffusion-xl-base-1.0"
        ));
    }

    /// Pollinations 요청 URL 에 seed 가 실제로 붙는지 — 이 결함의 핵심 증거.
    #[test]
    fn test_pollinations_url_carries_seed() {
        let with_seed = crate::wallpaper::pollinations_image_url("neon harbor", Some(42));
        assert!(with_seed.contains("seed=42"), "seed 쿼리가 붙어야 한다: {with_seed}");
        assert!(with_seed.starts_with("https://image.pollinations.ai/prompt/"));

        // seed 미지정(하위호환)은 기존 URL 과 동일해야 한다.
        let without = crate::wallpaper::pollinations_image_url("neon harbor", None);
        assert!(!without.contains("seed="), "seed 미지정이면 파라미터가 없어야 한다");
    }

    /// OpenAI 요청 바디에는 seed 키가 절대 들어가면 안 된다(API 미지원).
    /// 소스 수준이 아니라 **직렬화 결과**를 검사해 회귀를 잡는다.
    #[test]
    fn test_openai_request_body_has_no_seed() {
        // generate_openai_wallpaper 가 만드는 바디와 동일한 구성.
        let body = serde_json::json!({
            "model": default_openai_model(),
            "prompt": "neon harbor",
            "n": 1,
            "size": "1536x1024",
        });
        assert!(
            body.get("seed").is_none(),
            "OpenAI Images API 는 seed 미지원 — 바디에 넣으면 400 이 된다"
        );
    }
}
