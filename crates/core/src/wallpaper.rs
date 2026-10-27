//! Windows Native Wallpaper Engine (`IDesktopWallpaper` COM 1st -> `SystemParametersInfoW` fallback)
//! Implements atomic image validation/staging and snapshot/restore (`Zero-Black-Screen` invariant).

use image::{ImageBuffer, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;

/// Wallpaper placement style across monitors
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WallpaperPosition {
    Center,
    Tile,
    Stretch,
    Fit,
    #[default]
    Fill,
    Span,
}

/// Snapshot & state stored on disk for reliable restore (`restore_wallpaper`)
///
/// `provider` / `source` 는 "생성 정보"다 — 이 배경화면이 **어떤 경로로 생성되었는지**를
/// `state.json` 에 남겨 UI 가 항상 표시할 수 있게 한다.
/// `None` 은 생성 경로 미기록(복원 직후·구버전 state.json 등)을 뜻한다.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WallpaperState {
    pub previous_wallpaper: Option<String>,
    pub current_wallpaper: Option<String>,
    pub backend_used: Option<String>,
    /// 생성 공급자 식별자: `pollinations` | `puter` | `cloudflare-workers-ai` | `openai` | `local-file` | `url`
    #[serde(default)]
    pub provider: Option<String>,
    /// 생성 경로 상세 설명 (사용 모델명·SDK 등)
    #[serde(default)]
    pub source: Option<String>,
}

/// Core errors for wallpaper operations
#[derive(Debug, Error)]
pub enum WallpaperError {
    #[error("file not found: {0}")]
    FileNotFound(String),

    #[error("image decode error: {0}")]
    ImageDecode(#[from] image::ImageError),

    #[error("image resolution too low ({width}x{height}); below required minimum")]
    ResolutionTooLow { width: u32, height: u32 },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("failed to load generated candidate image: {0}")]
    CandidateLoad(String),

    #[error("no previous wallpaper snapshot available to restore")]
    NoSnapshotAvailable,

    #[error("Windows API error: {0}")]
    WindowsApi(String),

    #[error("network error: {0}")]
    Network(String),

    #[error("image API HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },

    /// 이미지 생성 요청 실패를 **원인별로 구분**해 전달한다.
    ///
    /// 배경(실측): 이전에는 `ureq` 오류를
    /// `Network("image generation request failed: {e}")` 한 줄로 뭉개서
    /// ① HTTP 상태 코드, ② 응답 본문(HTML 챌린지 페이지 등), ③ 요청 URL 이 모두 사라졌다.
    /// `ureq` 의 `Display` 문자열에 섞여 있던 URL 이 잘려 나가 사용자에게는
    /// `network error: image generation request failed: https://image.pollinations.ai/prompt/...`
    /// 처럼 원인 불명의 한 줄만 보였다(동일 프롬프트 2회차 실패의 증상).
    #[error("image generation failed: kind={kind} status={status:?} url={url} body={body_snippet}")]
    ImageApiRequest {
        kind: String,
        status: Option<u16>,
        url: String,
        body_snippet: String,
    },

    /// Pollinations 무료 한도 초과(402 `FREE_LIMIT`).
    ///
    /// 배경(실측 — 프로브 응답 원문): `402 {"error":{"code":"FREE_LIMIT","message":"Free limit
    /// reached: 1 image every 45 seconds per IP. Retry after 20s ..."}}` + 헤더 `retry-after: 20`.
    /// 이것은 **영구 실패가 아니라 시간이 지나면 풀리는 레이트리밋**이므로, 원인 불명의
    /// `http_status` 한 줄이 아니라 "몇 초 후 다시 시도" 를 사용자에게 그대로 알린다.
    #[error("Pollinations 무료 한도 초과(1 IP당 45초에 1장): 약 {wait_secs}초 후 다시 시도하세요 — {url}")]
    FreeLimitReached { wait_secs: u64, url: String },
}

/// Returns the application data directory.
///
/// Resolution order:
/// 1. `WALLMAGIC_DATA_DIR` environment variable (explicit override)
/// 2. `%LOCALAPPDATA%\WallMagic`
/// 3. `%TEMP%\WallMagic` (fallback)
///
/// The `WALLMAGIC_DATA_DIR` override lets tests point the whole engine (state file + staging
/// directory) at an isolated temporary directory, so a test run never touches the real user
/// state in `%LOCALAPPDATA%\WallMagic`.
pub fn app_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("WALLMAGIC_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_app_data).join("WallMagic")
    } else {
        std::env::temp_dir().join("WallMagic")
    }
}

pub fn state_file_path() -> PathBuf {
    app_data_dir().join("state.json")
}

pub fn load_state() -> Result<WallpaperState, WallpaperError> {
    let path = state_file_path();
    if !path.exists() {
        return Ok(WallpaperState::default());
    }
    let raw = fs::read_to_string(path)?;
    let state = serde_json::from_str::<WallpaperState>(&raw)?;
    Ok(state)
}

pub fn save_state(state: &WallpaperState) -> Result<(), WallpaperError> {
    let path = state_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(state)?;
    fs::write(path, json)?;
    Ok(())
}

/// 스테이징 파일명에 쓸 stem 을 정규화한다.
///
/// `active_<stem>_<monitor>.bmp` / `staged_<stem>_<monitor>.bmp` 를 다시 입력으로 받아도
/// 접두어(`active_`, `staged_`)와 모니터 접미어(`_<monitor>`)를 제거해 **원래 stem** 으로
/// 되돌린다. 이 정규화가 없으면 적용을 반복할 때마다 접두어가 누적된 새 파일이 생긴다.
/// 영숫자 외 문자는 기존 규칙대로 `_` 로 치환한다.
pub fn staged_stem(raw: &str, monitor_suffix: &str) -> String {
    let mut s = raw;
    loop {
        match s.strip_prefix("active_").or_else(|| s.strip_prefix("staged_")) {
            Some(rest) if !rest.is_empty() => s = rest,
            _ => break,
        }
    }
    let suffix = format!("_{monitor_suffix}");
    if !monitor_suffix.is_empty() {
        if let Some(rest) = s.strip_suffix(&suffix) {
            if !rest.is_empty() {
                s = rest;
            }
        }
    }
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "wallpaper".to_string()
    } else {
        cleaned
    }
}

/// Validates that the candidate image exists, decodes cleanly, and meets minimum 640x480 resolution,
/// then stages it atomically into `%LOCALAPPDATA%\WallMagic\active\active_<stem>_<monitor>.bmp`.
pub fn validate_and_stage_image(
    candidate_path: &Path,
    monitor_id: Option<&str>,
) -> Result<PathBuf, WallpaperError> {
    if !candidate_path.exists() {
        return Err(WallpaperError::FileNotFound(
            candidate_path.display().to_string(),
        ));
    }

    let img = image::open(candidate_path)?;
    let width = img.width();
    let height = img.height();
    if width < 640 || height < 480 {
        return Err(WallpaperError::ResolutionTooLow { width, height });
    }

    let active_dir = app_data_dir().join("active");
    fs::create_dir_all(&active_dir)?;

    let sanitized_suffix: String = monitor_id
        .unwrap_or("primary")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();

    // 적용된 `active_<stem>_<monitor>.bmp` 를 다시 적용해도 스테이징 접두어와 모니터
    // 접미어가 누적되지 않도록 정규화한다. 정규화가 없으면 적용할 때마다
    // `active_active_...`, `..._primary_primary.bmp` 가 새로 만들어져
    // "적용할 때마다 이미지가 또 생성된다"처럼 보인다.
    let stem = staged_stem(
        candidate_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("wallpaper"),
        &sanitized_suffix,
    );

    let staged_tmp = active_dir.join(format!("staged_{stem}_{sanitized_suffix}.bmp"));
    let active_final = active_dir.join(format!("active_{stem}_{sanitized_suffix}.bmp"));

    // 후보가 이미 최종 스테이징 경로와 같으면 재인코딩·재기록하지 않는다.
    // (같은 파일을 다시 만들어 "또 생성된 것"처럼 보이던 경로를 끊는다)
    if candidate_path == active_final.as_path() {
        tracing::info!(
            reused = %active_final.display(),
            "Wallpaper already staged — skipping re-encode"
        );
        return Ok(active_final);
    }

    img.save(&staged_tmp)?;
    fs::rename(&staged_tmp, &active_final)?;

    tracing::info!(
        staged = %active_final.display(),
        width,
        height,
        "Validated and atomically staged wallpaper image"
    );

    Ok(active_final)
}

/// Generates a high-resolution (1920x1080) gradient wallpaper based on a user prompt/theme seed.
pub fn generate_sample_wallpaper(
    prompt: &str,
    output_path: &Path,
) -> Result<PathBuf, WallpaperError> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Derive deterministic color palette from prompt bytes (FNV-1a 32-bit)
    let mut hash: u32 = 2166136261;
    for b in prompt.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(16777619);
    }

    let r1 = ((hash & 0xFF) as u8).saturating_add(20);
    let g1 = (((hash >> 8) & 0xFF) as u8).saturating_add(30);
    let b1 = (((hash >> 16) & 0xFF) as u8).saturating_add(60);

    let r2 = ((hash >> 24) & 0xFF) as u8;
    let g2 = r1.wrapping_add(90);
    let b2 = b1.wrapping_add(110);

    let width = 1920u32;
    let height = 1080u32;
    let img: RgbImage = ImageBuffer::from_fn(width, height, |x, y| {
        let tx = x as f32 / width as f32;
        let ty = y as f32 / height as f32;
        let t = (tx * 0.6 + ty * 0.4).clamp(0.0, 1.0);
        let r = (r1 as f32 * (1.0 - t) + r2 as f32 * t) as u8;
        let g = (g1 as f32 * (1.0 - t) + g2 as f32 * t) as u8;
        let b = (b1 as f32 * (1.0 - t) + b2 as f32 * t) as u8;
        Rgb([r, g, b])
    });

    img.save(output_path)?;
    Ok(output_path.to_path_buf())
}

/// 온라인 생성 응답을 HD 품질 기준으로 정규화한다.
///
/// - 640x480 미만이면 `ResolutionTooLow` 실패 (저해상도 응답을 후보로 내보내지 않음).
/// - 1280x720 미만(예: Classic 무료 티어의 1024x576 응답)이면 Lanczos3로 1920x1080 업스케일.
/// - 그 이상이면 원본 그대로 반환.
///
/// 순수 함수로 분리해 네트워크 없이 단위 테스트로 검증한다.
pub fn normalize_to_hd(img: image::DynamicImage) -> Result<image::DynamicImage, WallpaperError> {
    if img.width() < 640 || img.height() < 480 {
        return Err(WallpaperError::ResolutionTooLow {
            width: img.width(),
            height: img.height(),
        });
    }
    Ok(if img.width() < 1280 || img.height() < 720 {
        img.resize_exact(1920, 1080, image::imageops::FilterType::Lanczos3)
    } else {
        img
    })
}

/// Pollinations 이미지 URL 을 만든다 (순수 함수 — 네트워크 없이 테스트 가능).
///
/// `seed` 가 `Some` 이면 `&seed=N` 을 덧붙인다.
///
/// 배경(실측): 수정 전 URL 은 `?width=1920&height=1080&nologo=true` 뿐이었고 seed 파라미터가
/// 없었다. Pollinations 는 프롬프트+파라미터가 같은 URL 에 대해 캐시된 동일 이미지를
/// 돌려주므로, seed 없이는 **같은 프롬프트가 항상 같은 이미지**가 된다.
pub fn pollinations_image_url(prompt: &str, seed: Option<u64>) -> String {
    let encoded = urlencoding::encode(prompt.trim());
    let mut url = format!(
        "https://image.pollinations.ai/prompt/{encoded}?width=1920&height=1080&nologo=true"
    );
    if let Some(s) = seed {
        url.push_str(&format!("&seed={s}"));
    }
    url
}

/// Generate a wallpaper via the free Pollinations image API (no key needed).
///
/// GETs a JPEG from image.pollinations.ai and saves it to `output_path`.
/// Failures are returned as `ImageApiRequest`/`CandidateLoad` so the UI can show
/// 상태 코드·응답 본문 스니펫·요청 URL 이 구분된 메시지를 보여줄 수 있다.
///
/// seed 없는 하위호환 래퍼 — seed 정책을 쓰는 호출부는
/// `generate_online_wallpaper_with_seed` 를 써야 한다.
pub fn generate_online_wallpaper(
    prompt: &str,
    output_path: &Path,
) -> Result<PathBuf, WallpaperError> {
    generate_online_wallpaper_with_seed(prompt, None, output_path)
}

/// Pollinations 일시 장애(429/5xx/타임아웃)에 대한 **제한적 재시도 정책**.
///
/// 배경(실측): 동일 프롬프트 2회차 생성이 실패하던 경로에는 재시도가 전혀 없었다.
/// Pollinations 는 짧은 간격의 반복 요청에 429(레이트리밋) 또는 5xx 를 돌려주는데,
/// 요청 1회 실패가 곧바로 "생성 실패"로 확정됐다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 총 시도 횟수(첫 요청 포함). 1 이면 재시도하지 않는다.
    pub max_attempts: u32,
    /// 첫 재시도 대기(ms). 이후 2배씩 증가.
    pub base_delay_ms: u64,
    /// 재시도 대기 상한(ms). `Retry-After` 도 이 값으로 절삭한다.
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_ms: 800,
            max_delay_ms: 5_000,
        }
    }
}

/// 재시도할 가치가 있는 HTTP 상태 코드인지 판정한다 (순수 함수).
///
/// 429(레이트리밋)·408(요청 타임아웃)·425(Too Early)·5xx 만 재시도 대상이다.
/// 400/401/403/404/422 같은 요청 자체의 결함은 재시도해도 같은 결과이므로 제외한다.
pub fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429) || (500..=599).contains(&status)
}

/// Pollinations 무료 한도(402 `FREE_LIMIT`)에 대해 **자동 대기 후 재시도**를 허용하는 최대 시간(ms).
///
/// 배경(실측 — 프로브 응답 원문):
/// `402 {"error":{"code":"FREE_LIMIT","message":"Free limit reached: 1 image every 45 seconds
/// per IP. Retry after 20s, ..."}}` + 헤더 `retry-after: 20`.
/// 즉 402 는 **영구 실패가 아니라 시간이 지나면 풀리는 레이트리밋**이다(사용자 보고:
/// "시간이 지난 후에 생성 가능한데"). 그런데 402 는 `is_retryable_status` 에 없어
/// **즉시 포기**했고, 사용자에게는 원인 불명의 생성 실패로 보였다.
///
/// 무한 대기로 IPC 를 붙잡지 않도록 상한을 둔다. 서버가 알려준 대기 시간이 이 값 이하이면
/// 기다렸다가 1회 재시도하고, 초과하면 **대기 없이 명확한 안내**를 반환한다.
pub const FREE_LIMIT_MAX_WAIT_MS: u64 = 25_000;

/// 응답 본문이 Pollinations 무료 한도 초과(`FREE_LIMIT`)를 뜻하는가 (순수 함수).
pub fn is_free_limit_body(body: &str) -> bool {
    body.to_ascii_uppercase().contains("FREE_LIMIT")
}

/// 본문의 안내 문구에서 "Retry after Ns" 의 초를 뽑는다 (순수 함수 — 진단 메시지용).
///
/// 헤더(`retry-after`)가 없는 프록시·캐시 응답에서도 대기 시간을 사용자에게 알리기 위해
/// 본문 문구를 함께 해석한다.
pub fn parse_free_limit_retry_secs(body: &str) -> Option<u64> {
    let lower = body.to_ascii_lowercase();
    let idx = lower.find("retry after ")?;
    let rest = &lower[idx + "retry after ".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

/// HTTP 실패를 `(kind, 재시도 가능 여부)` 로 분류한다 (순수 함수).
///
/// - 402 + `FREE_LIMIT` → `free_limit`. 서버가 알려준 대기 시간이
///   `FREE_LIMIT_MAX_WAIT_MS` 이하일 때만 재시도한다(그 이상은 사용자를 기다리게 하지 않는다).
/// - 그 외 → `http_status`, `is_retryable_status` 규칙을 따른다.
pub fn classify_http_failure(
    status: u16,
    body: &str,
    retry_after_ms: Option<u64>,
) -> (&'static str, bool) {
    if status == 402 && is_free_limit_body(body) {
        let retryable = retry_after_ms
            .map(|ms| ms <= FREE_LIMIT_MAX_WAIT_MS)
            .unwrap_or(false);
        return ("free_limit", retryable);
    }
    ("http_status", is_retryable_status(status))
}

/// 지수 백오프 지연(ms) — `attempt` 는 1부터 시작하며 `base * 2^(attempt-1)` 을
/// `max_delay_ms` 로 절삭한다 (순수 함수).
pub fn retry_delay_ms(policy: &RetryPolicy, attempt: u32) -> u64 {
    let shift = attempt.saturating_sub(1).min(16);
    policy
        .base_delay_ms
        .saturating_mul(1u64 << shift)
        .min(policy.max_delay_ms)
}

/// 실패 종류를 반영한 **실제 대기 시간**(ms)을 계산한다 (순수 함수).
///
/// 배경(실측 결함): 이전 구현은 `backoff.max(after.min(policy.max_delay_ms))` 로
/// 서버의 `retry-after` 를 **백오프 상한(5초)으로 절삭**했다. 그런데 Pollinations 무료
/// 한도는 `retry-after: 20`(20초)을 요구하므로, 5초만 기다렸다가 다시 402 를 받고
/// 사용자에게 실패로 확정됐다. 무료 한도(`free_limit`)는 서버가 알려준 시간을
/// `FREE_LIMIT_MAX_WAIT_MS` 한도까지 **그대로** 기다린다.
pub fn retry_delay_for(
    kind: &str,
    retry_after_ms: Option<u64>,
    policy: &RetryPolicy,
    attempt: u32,
) -> u64 {
    let backoff = retry_delay_ms(policy, attempt);
    match retry_after_ms {
        Some(after) if kind == "free_limit" => after.min(FREE_LIMIT_MAX_WAIT_MS),
        Some(after) => backoff.max(after.min(policy.max_delay_ms)),
        None => backoff,
    }
}

/// `ureq` transport 오류 문자열을 **원인 kind** 로 분류한다 (순수 함수).
///
/// `ureq` 의 `Transport` 는 Display 문자열만 안정적으로 쓸 수 있어, 문자열을 근거로
/// timeout / dns / connect / tls / transport 로 나눈다. 이 kind 가 에러 메시지에
/// 그대로 노출되어 "network error" 한 줄로 뭉개지지 않는다.
pub fn classify_transport_failure(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("dns") || lower.contains("resolve") {
        "dns"
    } else if lower.contains("connection refused")
        || lower.contains("connection failed")
        || lower.contains("connection reset")
        || lower.contains("connect")
    {
        "connect"
    } else if lower.contains("tls") || lower.contains("certificate") {
        "tls"
    } else {
        "transport"
    }
}

/// 응답 본문 스니펫 — 줄바꿈·연속 공백을 공백 하나로 접고 앞 200자만 남긴다 (순수 함수).
pub fn body_snippet(body: &str) -> String {
    body.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// 응답 `content-type` 이 이미지인지 검증한다 (순수 함수).
///
/// 200 응답이라도 본문이 HTML(챌린지·에러 페이지)이면 디코드 단계에서 원인 불명으로
/// 실패한다. 그래서 `image/*` 가 아닌 `content-type` 은 명시적으로 거부한다.
/// 헤더 부재·빈 값은 통과시킨다(구 응답 호환 — 최종 판정은 이미지 디코드).
pub fn is_image_content_type(content_type: Option<&str>) -> bool {
    match content_type {
        None => true,
        Some(raw) => {
            let ct = raw.trim().to_ascii_lowercase();
            ct.is_empty() || ct.starts_with("image/")
        }
    }
}

/// `Retry-After` 헤더(초 단위 숫자)를 ms 로 변환한다 (순수 함수).
///
/// HTTP-date 형식은 지원하지 않는다(`None`).
pub fn parse_retry_after_ms(header: Option<&str>) -> Option<u64> {
    let raw = header?.trim();
    if raw.is_empty() {
        return None;
    }
    raw.parse::<u64>().ok().map(|secs| secs.saturating_mul(1_000))
}

/// 요청 실패를 **원인별 구조화 에러**로 만든다 (URL·상태 코드·본문 스니펫 보존).
pub fn request_failure(kind: &str, status: Option<u16>, url: &str, body: &str) -> WallpaperError {
    WallpaperError::ImageApiRequest {
        kind: kind.to_string(),
        status,
        url: url.to_string(),
        body_snippet: body_snippet(body),
    }
}

/// 한 번의 요청 실패를 담는다 (재시도 판단 + 진단 메시지 재료).
#[derive(Debug, Clone, PartialEq, Eq)]
struct FetchFailure {
    kind: String,
    status: Option<u16>,
    body: String,
    retryable: bool,
    retry_after_ms: Option<u64>,
}

/// Pollinations 에 이미지를 1회 요청한다. 실패는 `FetchFailure` 로 구조화한다.
fn fetch_pollinations_once(url: &str) -> Result<Vec<u8>, FetchFailure> {
    let response = match ureq::get(url).timeout(Duration::from_secs(90)).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, response)) => {
            let header_retry = parse_retry_after_ms(response.header("retry-after"));
            let body = response.into_string().unwrap_or_default();
            // 헤더가 없는 프록시·캐시 응답도 있으므로 본문의 "Retry after Ns" 를 함께 해석한다.
            let body_retry = parse_free_limit_retry_secs(&body).map(|s| s.saturating_mul(1_000));
            let retry_after_ms = header_retry.or(body_retry);
            let (kind, retryable) = classify_http_failure(status, &body, retry_after_ms);
            return Err(FetchFailure {
                kind: kind.to_string(),
                status: Some(status),
                body,
                retryable,
                retry_after_ms,
            });
        }
        Err(ureq::Error::Transport(transport)) => {
            let message = transport.to_string();
            let kind = classify_transport_failure(&message).to_string();
            let retryable = !matches!(kind.as_str(), "dns" | "tls");
            return Err(FetchFailure {
                kind,
                status: None,
                body: message,
                retryable,
                retry_after_ms: None,
            });
        }
    };

    let status = response.status();
    if !(200..300).contains(&status) {
        let retry_after_ms = parse_retry_after_ms(response.header("retry-after"));
        let body = response.into_string().unwrap_or_default();
        return Err(FetchFailure {
            kind: "http_status".to_string(),
            status: Some(status),
            body,
            retryable: is_retryable_status(status),
            retry_after_ms,
        });
    }

    let content_type = response.header("content-type").map(str::to_string);
    if !is_image_content_type(content_type.as_deref()) {
        return Err(FetchFailure {
            kind: "unexpected_content_type".to_string(),
            status: Some(status),
            body: content_type.unwrap_or_else(|| "<missing content-type>".to_string()),
            retryable: true,
            retry_after_ms: None,
        });
    }

    let mut bytes: Vec<u8> = Vec::new();
    response.into_reader().read_to_end(&mut bytes).map_err(|e| FetchFailure {
        kind: "read_body".to_string(),
        status: Some(status),
        body: e.to_string(),
        retryable: true,
        retry_after_ms: None,
    })?;
    if bytes.is_empty() {
        return Err(FetchFailure {
            kind: "empty_body".to_string(),
            status: Some(status),
            body: String::new(),
            retryable: true,
            retry_after_ms: None,
        });
    }
    Ok(bytes)
}

/// 재시도 루프 — 일시적 실패만 백오프하며 재시도하고, 최종 실패는 구조화 에러로 반환한다.
///
/// `fetch` 를 주입 가능하게 분리해 **네트워크 없이** 재시도 계약을 단위 테스트한다.
fn fetch_with_retry<F>(
    policy: &RetryPolicy,
    url: &str,
    mut fetch: F,
) -> Result<Vec<u8>, WallpaperError>
where
    F: FnMut(&str) -> Result<Vec<u8>, FetchFailure>,
{
    let max_attempts = policy.max_attempts.max(1);
    let mut attempt: u32 = 1;
    loop {
        match fetch(url) {
            Ok(bytes) => return Ok(bytes),
            Err(failure) => {
                let can_retry = failure.retryable && attempt < max_attempts;
                if !can_retry {
                    // 무료 한도는 "영구 실패"가 아니라 "잠시 후 가능"이므로,
                    // 원인 불명의 http_status 대신 대기 시간을 알려주는 전용 오류로 돌려준다.
                    if failure.kind == "free_limit" {
                        let wait_secs = failure
                            .retry_after_ms
                            .map(|ms| ms.div_ceil(1_000))
                            .unwrap_or(45);
                        return Err(WallpaperError::FreeLimitReached {
                            wait_secs,
                            url: url.to_string(),
                        });
                    }
                    return Err(request_failure(
                        &failure.kind,
                        failure.status,
                        url,
                        &failure.body,
                    ));
                }
                let delay = retry_delay_for(&failure.kind, failure.retry_after_ms, policy, attempt);
                tracing::warn!(
                    attempt,
                    max_attempts,
                    delay_ms = delay,
                    kind = %failure.kind,
                    status = ?failure.status,
                    url = %url,
                    "Pollinations 이미지 요청 실패 — 재시도합니다"
                );
                if delay > 0 {
                    std::thread::sleep(Duration::from_millis(delay));
                }
                attempt += 1;
            }
        }
    }
}

/// seed 를 명시해 Pollinations 이미지를 생성한다.
///
/// `seed = Some(n)` 이면 URL 에 `&seed=n` 이 붙어 같은 프롬프트라도 다른 결과가 나온다.
/// 일시적 오류는 기본 재시도 정책(`RetryPolicy::default`)으로 최대 3회 시도한다.
pub fn generate_online_wallpaper_with_seed(
    prompt: &str,
    seed: Option<u64>,
    output_path: &Path,
) -> Result<PathBuf, WallpaperError> {
    generate_online_wallpaper_with_policy(prompt, seed, output_path, RetryPolicy::default())
}

/// 재시도 정책을 주입해 Pollinations 이미지를 생성한다.
pub fn generate_online_wallpaper_with_policy(
    prompt: &str,
    seed: Option<u64>,
    output_path: &Path,
    policy: RetryPolicy,
) -> Result<PathBuf, WallpaperError> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "empty prompt: image generation needs a text prompt".to_string(),
        ));
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let url = pollinations_image_url(trimmed, seed);
    let bytes = fetch_with_retry(&policy, &url, fetch_pollinations_once)?;
    let img = image::load_from_memory(&bytes).map_err(|e| {
        WallpaperError::CandidateLoad(format!("generated image decode failed: {e}"))
    })?;
    // AI 배경화면 품질 기준은 `normalize_to_hd`에 일원화한다 (1024x576 등 저해상도
    // 응답 → Lanczos3 1920x1080 업스케일, 640x480 미만 → ResolutionTooLow 실패).
    let img_hd = normalize_to_hd(img)?;
    img_hd.save(output_path)?;
    Ok(output_path.to_path_buf())
}

#[cfg(test)]
mod pollinations_retry_tests {
    use super::*;

    fn no_sleep_policy(max_attempts: u32) -> RetryPolicy {
        RetryPolicy {
            max_attempts,
            base_delay_ms: 0,
            max_delay_ms: 0,
        }
    }

    fn failure(
        kind: &str,
        status: Option<u16>,
        body: &str,
        retryable: bool,
    ) -> FetchFailure {
        FetchFailure {
            kind: kind.to_string(),
            status,
            body: body.to_string(),
            retryable,
            retry_after_ms: None,
        }
    }

    #[test]
    fn test_is_retryable_status_matrix() {
        for code in [408u16, 425, 429, 500, 502, 503, 504, 599] {
            assert!(is_retryable_status(code), "{code} 는 재시도 대상이어야 한다");
        }
        for code in [200u16, 201, 204, 400, 401, 403, 404, 422] {
            assert!(!is_retryable_status(code), "{code} 는 재시도 대상이 아니다");
        }
    }

    #[test]
    fn test_retry_delay_backoff_and_cap() {
        let policy = RetryPolicy {
            max_attempts: 4,
            base_delay_ms: 800,
            max_delay_ms: 5_000,
        };
        assert_eq!(retry_delay_ms(&policy, 1), 800);
        assert_eq!(retry_delay_ms(&policy, 2), 1_600);
        assert_eq!(retry_delay_ms(&policy, 3), 3_200);
        // 6_400 → 상한 5_000
        assert_eq!(retry_delay_ms(&policy, 4), 5_000);
        assert_eq!(retry_delay_ms(&policy, 40), 5_000);
    }

    #[test]
    fn test_classify_transport_failure_kinds() {
        assert_eq!(
            classify_transport_failure("timed out waiting for response"),
            "timeout"
        );
        assert_eq!(
            classify_transport_failure("Dns Failed: no address for host"),
            "dns"
        );
        assert_eq!(classify_transport_failure("Connection refused"), "connect");
        assert_eq!(classify_transport_failure("TLS handshake failed"), "tls");
        assert_eq!(classify_transport_failure("something else"), "transport");
    }

    #[test]
    fn test_body_snippet_collapses_and_truncates() {
        assert_eq!(
            body_snippet("  <html>\n\n <body>x</body>  "),
            "<html> <body>x</body>"
        );
        let long = "a".repeat(500);
        assert_eq!(body_snippet(&long).chars().count(), 200);
    }

    #[test]
    fn test_is_image_content_type_validation() {
        assert!(is_image_content_type(Some("image/jpeg")));
        assert!(is_image_content_type(Some("IMAGE/PNG; charset=binary")));
        assert!(is_image_content_type(None));
        assert!(is_image_content_type(Some("   ")));
        assert!(!is_image_content_type(Some("text/html; charset=utf-8")));
        assert!(!is_image_content_type(Some("application/json")));
    }

    #[test]
    fn test_parse_retry_after_header() {
        assert_eq!(parse_retry_after_ms(Some("2")), Some(2_000));
        assert_eq!(parse_retry_after_ms(Some("0")), Some(0));
        assert_eq!(
            parse_retry_after_ms(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            None
        );
        assert_eq!(parse_retry_after_ms(None), None);
    }

    #[test]
    fn test_fetch_with_retry_recovers_from_transient_rate_limit() {
        // 동일 요청 1회차 429 → 2회차 성공. 재시도가 없으면 "생성 실패"로 확정됐다.
        let policy = no_sleep_policy(3);
        let mut calls = 0u32;
        let bytes = fetch_with_retry(
            &policy,
            "https://image.pollinations.ai/prompt/x?seed=1",
            |_url| {
                calls += 1;
                if calls == 1 {
                    Err(failure("rate_limited", Some(429), "Too Many Requests", true))
                } else {
                    Ok(b"jpeg-bytes".to_vec())
                }
            },
        )
        .expect("일시적 429 는 재시도로 극복해야 한다");
        assert_eq!(bytes, b"jpeg-bytes".to_vec());
        assert_eq!(calls, 2);
    }

    #[test]
    fn test_fetch_with_retry_gives_up_after_max_attempts_with_diagnostics() {
        let policy = no_sleep_policy(3);
        let mut calls = 0u32;
        let err = fetch_with_retry(
            &policy,
            "https://image.pollinations.ai/prompt/repeat?seed=7",
            |_url| {
                calls += 1;
                Err(failure(
                    "http_status",
                    Some(503),
                    "Service Unavailable",
                    true,
                ))
            },
        )
        .unwrap_err();
        assert_eq!(calls, 3, "max_attempts 만큼만 시도한다");
        let msg = err.to_string();
        assert!(msg.contains("status=Some(503)"), "상태 코드 노출: {msg}");
        assert!(
            msg.contains("https://image.pollinations.ai/prompt/repeat?seed=7"),
            "요청 URL 노출: {msg}"
        );
        assert!(
            msg.contains("Service Unavailable"),
            "응답 본문 스니펫 노출: {msg}"
        );
    }

    #[test]
    fn test_fetch_with_retry_does_not_retry_permanent_error() {
        let policy = no_sleep_policy(3);
        let mut calls = 0u32;
        let err = fetch_with_retry(
            &policy,
            "https://image.pollinations.ai/prompt/x",
            |_url| {
                calls += 1;
                Err(failure("http_status", Some(404), "not found", false))
            },
        )
        .unwrap_err();
        assert_eq!(calls, 1, "영구 오류(404)는 재시도하지 않는다");
        assert!(err.to_string().contains("status=Some(404)"));
    }

    #[test]
    fn test_empty_prompt_fails_before_network_and_names_the_reason() {
        let dir = std::env::temp_dir().join("wallmagic-pollinations-retry-test");
        let err = generate_online_wallpaper_with_policy(
            "   ",
            None,
            &dir.join("out.jpg"),
            no_sleep_policy(1),
        )
        .unwrap_err();
        assert!(matches!(err, WallpaperError::CandidateLoad(_)));
    }
}

/// Queries the currently active desktop wallpaper path (1st: IDesktopWallpaper COM, 2nd: SPI_GETDESKWALLPAPER).
pub fn get_current_wallpaper(monitor_id: Option<&str>) -> Result<String, WallpaperError> {
    #[cfg(windows)]
    {
        match win32::get_wallpaper_com(monitor_id) {
            Ok(path) if !path.is_empty() => return Ok(path),
            Ok(_) => tracing::debug!("IDesktopWallpaper returned empty path, trying SPI fallback"),
            Err(err) => tracing::warn!("IDesktopWallpaper get failed ({err}), trying SPI fallback"),
        }
        win32::get_wallpaper_spi()
    }
    #[cfg(not(windows))]
    {
        let _ = monitor_id;
        let state = load_state()?;
        Ok(state.current_wallpaper.unwrap_or_default())
    }
}

/// GUI 모니터 선택 목록에 노출되는 디스플레이 정보.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorInfo {
    /// `IDesktopWallpaper`가 인식하는 모니터 장치 경로 (예: `\\.\DISPLAY1`)
    pub id: String,
    /// 사람이 읽는 장치 설명 문자열 (예: `Generic PnP Monitor`)
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// 현재 데스크톱에 연결된(활성화된) 모니터 목록을 반환한다.
///
/// Windows에서는 `EnumDisplayDevicesW` + `EnumDisplaySettingsW`로 장치 경로·해상도·주 모니터
/// 여부를 조회한다. 비 Windows 플랫폼(빌드 검증용)에서는 목업 1대를 반환한다.
pub fn list_monitors() -> Vec<MonitorInfo> {
    #[cfg(windows)]
    {
        win32::list_monitors_win32()
    }
    #[cfg(not(windows))]
    {
        vec![MonitorInfo {
            id: "MOCK-0".to_string(),
            name: "Mock Display".to_string(),
            width: 1920,
            height: 1080,
            is_primary: true,
        }]
    }
}

/// Checks whether the given wallpaper path resides inside our active staging directory (`app_data_dir()/active/`).
pub fn is_staged_path(wallpaper_path: &str) -> bool {
    let trimmed = wallpaper_path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let active_dir = app_data_dir().join("active");
    let candidate = Path::new(trimmed);
    if let Some(parent) = candidate.parent() {
        if parent
            .to_string_lossy()
            .eq_ignore_ascii_case(&active_dir.to_string_lossy())
        {
            return true;
        }
    }
    let norm_candidate = trimmed.replace('/', "\\").to_ascii_lowercase();
    let mut norm_active = active_dir
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    if !norm_active.ends_with('\\') {
        norm_active.push('\\');
    }
    norm_candidate.starts_with(&norm_active)
}

/// Decides which wallpaper should be kept as the restore snapshot.
///
/// Rules:
/// - If no snapshot exists yet, the currently active wallpaper becomes the snapshot.
/// - If the currently active wallpaper is one of our own staged files, the existing snapshot is
///   kept — a second `set` must never overwrite the original user wallpaper with an
///   intermediate staged path.
/// - Otherwise (the active wallpaper is a genuine user wallpaper), it becomes the new snapshot.
///
/// This is a pure function so the rule can be unit tested without touching the OS.
pub fn resolve_previous_wallpaper(
    existing_snapshot: Option<&str>,
    current_os_wallpaper: &str,
) -> Option<String> {
    let current = current_os_wallpaper.trim();
    if current.is_empty() {
        return existing_snapshot.map(|s| s.to_string());
    }
    let snapshot_is_missing = existing_snapshot
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    if snapshot_is_missing || !is_staged_path(current) {
        Some(current.to_string())
    } else {
        existing_snapshot.map(|s| s.to_string())
    }
}

/// Sets the desktop wallpaper with Zero-Black-Screen protection:
/// 1. Validates image & resolution (>= 640x480) and stages atomically.
/// 2. Snapshots current wallpaper path into `state.json` (preserving non-staged original user wallpaper).
/// 3. Attempts `IDesktopWallpaper::SetWallpaper` (COM).
/// 4. Falls back to `SystemParametersInfoW(SPI_SETDESKWALLPAPER)` on COM error.
pub fn set_wallpaper(
    candidate_path: &Path,
    monitor_id: Option<&str>,
    position: WallpaperPosition,
) -> Result<WallpaperState, WallpaperError> {
    set_wallpaper_with(candidate_path, monitor_id, position, None, None)
}

/// 생성 정보(`provider` / `source`)를 기록하는 순수 함수.
///
/// `state.json` 의 두 필드는 "이 배경화면이 **어떤 경로로** 생성되었는지"를 남겨
/// UI 가 항상 표시할 수 있게 한다. 공백·빈 문자열은 `None` 으로 정규화해
/// 빈 값 표시나 이전 값 잔류로 인한 오라벨을 막는다.
pub fn record_generation(state: &mut WallpaperState, provider: Option<&str>, source: Option<&str>) {
    fn norm(value: Option<&str>) -> Option<String> {
        value
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }
    state.provider = norm(provider);
    state.source = norm(source);
}

/// 이미지 파일 옆에 저장하는 생성 정보 사이드카(`.geninfo.json`).
/// 생성 파일은 배경으로 적용되기 전까진 state.json 에 기록되지 않으므로,
/// 미리보기(라이브러리 후보) 단계의 파일이 **자신이 어떤 경로로 생성됐는지**를
/// 스스로 갖고 있어야 "현재 배경" 기록과 혼동되지 않는다 (오귀속 방지).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GenerationSidecar {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// 이미지 파일의 사이드카 경로: `<원본 파일명>.geninfo.json`
/// (예: `generated_Cyberpunk_541ef24f.jpg` → `generated_Cyberpunk_541ef24f.jpg.geninfo.json`)
/// 이 형식은 스테이징 전후 파일(다른 디렉터리)에서도 이름으로 연결된다.
pub fn generation_sidecar_path(image_path: &Path) -> PathBuf {
    let mut file_name = image_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    file_name.push_str(".geninfo.json");
    image_path.with_file_name(file_name)
}

fn norm_str(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 이미지 파일 옆에 생성 정보 사이드카를 기록한다.
/// provider/source 둘 다 비면(빈 문자열·공백 포함) 기록하지 않는다 — 무정보 사이드카 금지.
/// 기록 실패는 호출부가 정책을 결정하도록 Result 를 반환한다.
pub fn write_generation_sidecar(
    image_path: &Path,
    provider: Option<&str>,
    source: Option<&str>,
) -> Result<(), WallpaperError> {
    let sidecar = GenerationSidecar {
        provider: norm_str(provider),
        source: norm_str(source),
    };
    if sidecar.provider.is_none() && sidecar.source.is_none() {
        return Ok(());
    }
    let path = generation_sidecar_path(image_path);
    let json = serde_json::to_string_pretty(&sidecar)?;
    fs::write(&path, json)?;
    Ok(())
}

/// 이미지 파일의 생성 정보 사이드카를 읽는다.
/// 파일이 없거나 파싱할 수 없으면 `None` — 생성 정보 미기록 상태를 뜻한다.
pub fn read_generation_sidecar(image_path: &Path) -> Option<GenerationSidecar> {
    let path = generation_sidecar_path(image_path);
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// ④ 적용 시 **후보 파일의 생성 정보를 이어받기** 위한 순수 조회.
///
/// `set_wallpaper` 는 `set_wallpaper_with(.., None, None)` 로 위임하므로, 이 함수를 거치지
/// 않고 적용하면 `record_generation(&mut state, None, None)` 이 state.json 의 provider/source
/// 를 **지운다**. 그러면 생성한 이미지를 적용할 때마다 "미기록"으로 보여 사용자가
/// "또 다른 이미지가 생성된 것 같다"고 느낀다. 적용 경로는 반드시 이 함수로 사이드카를
/// 먼저 읽어 공급자·경로를 넘겨야 귀속이 유지된다.
///
/// 사이드카가 없으면 `(None, None)` — 사용자 로컬 이미지에 임의 라벨을 붙이지 않는다.
pub fn generation_info_for_apply(image_path: &Path) -> (Option<String>, Option<String>) {
    match read_generation_sidecar(image_path) {
        Some(sidecar) => (sidecar.provider, sidecar.source),
        None => (None, None),
    }
}

/// `set_wallpaper` + 생성 정보 기록. 실제 생성 경로(공급자·모델)를 함께 남긴다.
pub fn set_wallpaper_with(
    candidate_path: &Path,
    monitor_id: Option<&str>,
    position: WallpaperPosition,
    provider: Option<&str>,
    source: Option<&str>,
) -> Result<WallpaperState, WallpaperError> {
    let staged_path = validate_and_stage_image(candidate_path, monitor_id)?;
    // 스테이징 파일(`active/`)에도 생성 정보 사이드카를 남긴다 — 적용된 파일이
    // 스스로 어떤 공급자/경로로 만들어졌는지 갖고 있어야 "현재 배경" 기록(state.json)과
    // 파일 단위 귀속이 어긋나지 않는다 (검수 지적: 사이드카 읽는 곳이 없던 미완성 계약).
    if let Err(e) = write_generation_sidecar(&staged_path, provider, source) {
        tracing::warn!(
            "generation sidecar write failed ({}): {e}",
            staged_path.display()
        );
    }
    let mut state = load_state().unwrap_or_default();

    // Capture current OS wallpaper before overwriting so we can restore reliably.
    // The snapshot rule lives in `resolve_previous_wallpaper` so it can be unit tested
    // without touching the OS.
    if let Ok(current_os_wall) = get_current_wallpaper(monitor_id) {
        state.previous_wallpaper =
            resolve_previous_wallpaper(state.previous_wallpaper.as_deref(), &current_os_wall);
    }

    #[cfg(windows)]
    let backend = {
        match win32::set_wallpaper_com(monitor_id, &staged_path, position) {
            Ok(()) => "IDesktopWallpaper (COM)".to_string(),
            Err(com_err) => {
                tracing::warn!(
                    "IDesktopWallpaper failed ({com_err}), falling back to SystemParametersInfoW"
                );
                win32::set_wallpaper_spi(&staged_path).inspect_err(|_spi_err| {
                    // Zero-Black-Screen guard: if the SPI fallback also fails, re-apply the
                    // previously snapshotted wallpaper so the desktop is never left blank.
                    if let Some(ref prev) = state.previous_wallpaper {
                        let _ = win32::set_wallpaper_spi(Path::new(prev));
                    }
                })?;
                "SystemParametersInfoW (Fallback)".to_string()
            }
        }
    };

    #[cfg(not(windows))]
    let backend = {
        let _ = position;
        "MockBackend".to_string()
    };

    state.current_wallpaper = Some(staged_path.to_string_lossy().to_string());
    state.backend_used = Some(backend);
    // 생성 정보 기록: 이 배경화면이 어떤 공급자/경로로 만들어졌는지 남긴다.
    record_generation(&mut state, provider, source);
    save_state(&state)?;

    Ok(state)
}

/// Restores the previously snapshotted wallpaper.
pub fn restore_wallpaper(monitor_id: Option<&str>) -> Result<WallpaperState, WallpaperError> {
    let mut state = load_state()?;
    let prev = state
        .previous_wallpaper
        .clone()
        .ok_or(WallpaperError::NoSnapshotAvailable)?;

    let prev_path = PathBuf::from(&prev);
    if !prev_path.exists() {
        return Err(WallpaperError::FileNotFound(prev));
    }

    #[cfg(windows)]
    let backend = {
        match win32::set_wallpaper_com(monitor_id, &prev_path, WallpaperPosition::Fill) {
            Ok(()) => "IDesktopWallpaper (COM Restore)".to_string(),
            Err(com_err) => {
                tracing::warn!(
                    "IDesktopWallpaper restore failed ({com_err}), falling back to SystemParametersInfoW"
                );
                win32::set_wallpaper_spi(&prev_path)?;
                "SystemParametersInfoW (Fallback Restore)".to_string()
            }
        }
    };

    #[cfg(not(windows))]
    let backend = {
        let _ = monitor_id;
        "MockBackend (Restore)".to_string()
    };

    state.current_wallpaper = Some(prev);
    state.backend_used = Some(backend);
    // 복원은 사용자 원본 배경화면이므로 생성 정보를 지운다 (이전 생성 공급자 오표시 방지).
    record_generation(&mut state, None, None);
    save_state(&state)?;

    Ok(state)
}

#[cfg(windows)]
pub mod win32 {
    use super::{WallpaperError, WallpaperPosition};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW,
        DISPLAY_DEVICE_ATTACHED_TO_DESKTOP, DISPLAY_DEVICE_PRIMARY_DEVICE, ENUM_CURRENT_SETTINGS,
    };
    use windows::Win32::UI::Shell::{
        DesktopWallpaper, IDesktopWallpaper, DESKTOP_WALLPAPER_POSITION, DWPOS_CENTER, DWPOS_FILL,
        DWPOS_FIT, DWPOS_SPAN, DWPOS_STRETCH, DWPOS_TILE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDWININICHANGE, SPIF_UPDATEINIFILE, SPI_GETDESKWALLPAPER,
        SPI_SETDESKWALLPAPER,
    };

    struct ComApartmentGuard;

    impl ComApartmentGuard {
        fn init() -> Result<Self, WallpaperError> {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                // S_OK (0) or S_FALSE (1) or RPC_E_CHANGED_MODE (0x80010106)
                if hr.is_err() && hr.0 != 0x80010106u32 as i32 {
                    return Err(WallpaperError::WindowsApi(format!(
                        "CoInitializeEx failed: 0x{:08X}",
                        hr.0 as u32
                    )));
                }
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartmentGuard {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    fn to_wide_null(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn map_position(pos: WallpaperPosition) -> DESKTOP_WALLPAPER_POSITION {
        match pos {
            WallpaperPosition::Center => DWPOS_CENTER,
            WallpaperPosition::Tile => DWPOS_TILE,
            WallpaperPosition::Stretch => DWPOS_STRETCH,
            WallpaperPosition::Fit => DWPOS_FIT,
            WallpaperPosition::Fill => DWPOS_FILL,
            WallpaperPosition::Span => DWPOS_SPAN,
        }
    }

    pub fn get_wallpaper_com(monitor_id: Option<&str>) -> Result<String, WallpaperError> {
        let _com = ComApartmentGuard::init()?;
        unsafe {
            let desktop: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)
                .map_err(|e| WallpaperError::WindowsApi(format!("CoCreateInstance: {e}")))?;

            let raw_ptr: PWSTR = if let Some(id) = monitor_id {
                let wide_id = to_wide_null(std::ffi::OsStr::new(id));
                desktop
                    .GetWallpaper(PCWSTR(wide_id.as_ptr()))
                    .map_err(|e| WallpaperError::WindowsApi(format!("GetWallpaper(id): {e}")))?
            } else {
                let count = desktop.GetMonitorDevicePathCount().unwrap_or(0);
                if count > 0 {
                    let mon_id = desktop.GetMonitorDevicePathAt(0).map_err(|e| {
                        WallpaperError::WindowsApi(format!("GetMonitorDevicePathAt(0): {e}"))
                    })?;
                    let res = desktop.GetWallpaper(PCWSTR(mon_id.0));
                    CoTaskMemFree(Some(mon_id.0 as *const _));
                    res.map_err(|e| WallpaperError::WindowsApi(format!("GetWallpaper(0): {e}")))?
                } else {
                    desktop.GetWallpaper(PCWSTR::null()).map_err(|e| {
                        WallpaperError::WindowsApi(format!("GetWallpaper(null): {e}"))
                    })?
                }
            };

            if raw_ptr.is_null() {
                return Ok(String::new());
            }
            let result = raw_ptr
                .to_string()
                .map_err(|e| WallpaperError::WindowsApi(format!("PWSTR decode: {e}")));
            CoTaskMemFree(Some(raw_ptr.0 as *const _));
            result
        }
    }

    pub fn set_wallpaper_com(
        monitor_id: Option<&str>,
        image_path: &Path,
        position: WallpaperPosition,
    ) -> Result<(), WallpaperError> {
        let _com = ComApartmentGuard::init()?;
        let wide_path = to_wide_null(image_path.as_os_str());
        unsafe {
            let desktop: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)
                .map_err(|e| WallpaperError::WindowsApi(format!("CoCreateInstance: {e}")))?;

            let _ = desktop.SetPosition(map_position(position));

            if let Some(id) = monitor_id {
                let wide_id = to_wide_null(std::ffi::OsStr::new(id));
                desktop
                    .SetWallpaper(PCWSTR(wide_id.as_ptr()), PCWSTR(wide_path.as_ptr()))
                    .map_err(|e| WallpaperError::WindowsApi(format!("SetWallpaper(id): {e}")))?;
            } else {
                let count = desktop.GetMonitorDevicePathCount().unwrap_or(0);
                let mut applied_any = false;
                for i in 0..count {
                    if let Ok(mon_id) = desktop.GetMonitorDevicePathAt(i) {
                        let res =
                            desktop.SetWallpaper(PCWSTR(mon_id.0), PCWSTR(wide_path.as_ptr()));
                        CoTaskMemFree(Some(mon_id.0 as *const _));
                        if res.is_ok() {
                            applied_any = true;
                        }
                    }
                }
                if !applied_any {
                    desktop
                        .SetWallpaper(PCWSTR::null(), PCWSTR(wide_path.as_ptr()))
                        .map_err(|e| {
                            WallpaperError::WindowsApi(format!("SetWallpaper(all): {e}"))
                        })?;
                }
            }
            match get_wallpaper_com(monitor_id) {
                Ok(actual) if actual.eq_ignore_ascii_case(&image_path.to_string_lossy()) => {}
                _ => {
                    return Err(WallpaperError::WindowsApi(
                        "IDesktopWallpaper did not update active path; triggering SPI fallback"
                            .to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// Enumerates attached display adapters with `EnumDisplayDevicesW` and resolves each one's
    /// current resolution with `EnumDisplaySettingsW(ENUM_CURRENT_SETTINGS)`.
    ///
    /// The `DeviceName` (`\\.\DISPLAY1`) is exactly the monitor device path that
    /// `IDesktopWallpaper::SetWallpaper` accepts, so the GUI can pass `MonitorInfo::id` through
    /// unchanged.
    pub fn list_monitors_win32() -> Vec<super::MonitorInfo> {
        use super::MonitorInfo;

        fn wide_to_string(buf: &[u16]) -> String {
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            String::from_utf16_lossy(&buf[..len])
        }

        let mut out: Vec<MonitorInfo> = Vec::new();
        unsafe {
            for idx in 0..32u32 {
                let mut device = DISPLAY_DEVICEW {
                    cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    ..Default::default()
                };
                if !EnumDisplayDevicesW(PCWSTR::null(), idx, &mut device, 0).as_bool() {
                    break;
                }
                let attached = (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP).0 != 0;
                if !attached {
                    continue;
                }
                let is_primary = (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE).0 != 0;

                let mut dev_mode = DEVMODEW {
                    dmSize: std::mem::size_of::<DEVMODEW>() as u16,
                    ..Default::default()
                };
                let (width, height) = if EnumDisplaySettingsW(
                    PCWSTR(device.DeviceName.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut dev_mode,
                )
                .as_bool()
                {
                    (dev_mode.dmPelsWidth, dev_mode.dmPelsHeight)
                } else {
                    (0, 0)
                };

                out.push(MonitorInfo {
                    id: wide_to_string(&device.DeviceName),
                    name: wide_to_string(&device.DeviceString),
                    width,
                    height,
                    is_primary,
                });
            }
        }
        out
    }

    pub fn get_wallpaper_spi() -> Result<String, WallpaperError> {
        let mut buf = [0u16; 1024];
        unsafe {
            SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                buf.len() as u32,
                Some(buf.as_mut_ptr() as *mut _),
                Default::default(),
            )
            .map_err(|e| WallpaperError::WindowsApi(format!("SPI_GETDESKWALLPAPER: {e}")))?;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..len]))
    }

    pub fn set_wallpaper_spi(image_path: &Path) -> Result<(), WallpaperError> {
        let wide_path = to_wide_null(image_path.as_os_str());
        unsafe {
            SystemParametersInfoW(
                SPI_SETDESKWALLPAPER,
                0,
                Some(wide_path.as_ptr() as *mut _),
                SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE,
            )
            .map_err(|e| WallpaperError::WindowsApi(format!("SPI_SETDESKWALLPAPER: {e}")))?;
        }
        Ok(())
    }
}
