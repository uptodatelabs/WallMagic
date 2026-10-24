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
    if settings.source.urls.is_empty()
        && settings
            .source
            .local_dir
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
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

/// 원격 URL 1건을 다운로드해 스테이징 전 임시 파일로 저장한다.
fn download_to_temp(url: &str, dest: &PathBuf) -> Result<(), WallpaperError> {
    let response = ureq::get(url)
        .timeout(std::time::Duration::from_secs(60))
        .call()
        .map_err(|e| WallpaperError::Network(format!("scenario download failed: {e}")))?;
    if response.status() != 200 {
        let body = response
            .into_string()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(WallpaperError::HttpStatus {
            status: 502,
            body: format!("scenario image HTTP error: {body}"),
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
pub fn tick_scenario(now_secs: u64) -> Result<Option<WallpaperState>, WallpaperError> {
    let mut settings = load_scenario()?;
    if !should_run(&settings, now_secs) {
        return Ok(None);
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
        download_to_temp(&url, &tmp)?;
        let state = crate::wallpaper::set_wallpaper(&tmp, None, settings.position_enum())?;
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
}
