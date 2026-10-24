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

/// 소스: 원격 URL 목록(R2/CDN) + 선택적 로컬 폴더.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ScenarioSource {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub local_dir: Option<String>,
}

/// 순환 순서.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScenarioOrder {
    #[default]
    Sequential,
    Random,
}

/// 이미지 공급자 (시나리오 자동 업데이트·수동 생성 공용).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ImageProvider {
    #[default]
    Pollinations,
    CloudflareWorkersAi,
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
    #[serde(default)]
    pub prompt: String,
}

pub fn default_cf_model() -> String {
    "@cf/black-forest-labs/flux-1-schnell".to_string()
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
    #[serde(default)]
    pub cloudflare: CloudflareAiConfig,
    /// 검수 지적 [medium](b): 토큰 명시적 삭제 플래그. true일 때만 빈 토큰으로
    /// 덮어쓰고, 저장 전 false로 리셋하므로 scenario.json에 잔류하지 않는다.
    #[serde(default)]
    pub clear_api_token: bool,
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
            cloudflare: CloudflareAiConfig::default(),
            clear_api_token: false,
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
    let has_cf_source = matches!(settings.provider, ImageProvider::CloudflareWorkersAi)
        && !settings.cloudflare.prompt.trim().is_empty();
    if settings.source.urls.is_empty()
        && settings
            .source
            .local_dir
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        && !has_cf_source
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
    let req_body =
        serde_json::json!({"prompt": prompt.trim()}).to_string();
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

pub fn tick_scenario(now_secs: u64) -> Result<Option<WallpaperState>, WallpaperError> {
    let mut settings = load_scenario()?;
    if !should_run(&settings, now_secs) {
        return Ok(None);
    }

    // Cloudflare Workers AI provider: 시나리오 프롬프트로 이미지 생성 후 적용.
    // 실패 시 기존 배경 유지 + 오류 반환 (호출자가 last_run_at 백오프로 처리).
    if matches!(settings.provider, ImageProvider::CloudflareWorkersAi) {
        let cf = settings.cloudflare.clone();
        if !cf.prompt.trim().is_empty() {
            let tmp = app_data_dir().join("online_cache").join("scenario_cf.jpg");
            let gen = generate_cloudflare_wallpaper(
                &cf.account_id,
                &cf.api_token,
                &cf.model,
                &cf.prompt,
                &tmp,
            );
            let tmp = match gen {
                Ok(p) => p,
                Err(e) => {
                    settings.last_run_at = Some(now_secs);
                    let _ = save_scenario(&settings);
                    return Err(e);
                }
            };
            let state = match crate::wallpaper::set_wallpaper(&tmp, None, settings.position_enum())
            {
                Ok(s) => s,
                Err(e) => {
                    settings.last_run_at = Some(now_secs);
                    let _ = save_scenario(&settings);
                    return Err(e);
                }
            };
            settings.next_index = settings.next_index.wrapping_add(1);
            settings.last_run_at = Some(now_secs);
            save_scenario(&settings)?;
            return Ok(Some(state));
        }
    }

    if !settings.source.urls.is_empty() {
        let len = settings.source.urls.len();
        let idx = match settings.order {
            ScenarioOrder::Sequential => settings.next_index % len,
            ScenarioOrder::Random => (now_secs as usize) % len,
        };
        let url = settings.source.urls[idx].clone();
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
            },
            order: ScenarioOrder::Sequential,
            next_index: 0,
            last_run_at: None,
            position: "fill".to_string(),
            provider: ImageProvider::default(),
            cloudflare: CloudflareAiConfig::default(),
            clear_api_token: false,
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
}
