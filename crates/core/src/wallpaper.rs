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
/// Failures are returned as Network/HttpStatus/CandidateLoad so the UI
/// can show a clear error instead of a silent offline gradient.
///
/// seed 없는 하위호환 래퍼 — seed 정책을 쓰는 호출부는
/// `generate_online_wallpaper_with_seed` 를 써야 한다.
pub fn generate_online_wallpaper(
    prompt: &str,
    output_path: &Path,
) -> Result<PathBuf, WallpaperError> {
    generate_online_wallpaper_with_seed(prompt, None, output_path)
}

/// seed 를 명시해 Pollinations 이미지를 생성한다.
///
/// `seed = Some(n)` 이면 URL 에 `&seed=n` 이 붙어 같은 프롬프트라도 다른 결과가 나온다.
pub fn generate_online_wallpaper_with_seed(
    prompt: &str,
    seed: Option<u64>,
    output_path: &Path,
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
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(90))
        .call()
        .map_err(|e| WallpaperError::Network(format!("image generation request failed: {e}")))?;
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
    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| WallpaperError::Network(format!("reading generated image failed: {e}")))?;
    if bytes.is_empty() {
        return Err(WallpaperError::Network(
            "image generation API returned an empty body".to_string(),
        ));
    }
    let img = image::load_from_memory(&bytes).map_err(|e| {
        WallpaperError::CandidateLoad(format!("generated image decode failed: {e}"))
    })?;
    // AI 배경화면 품질 기준은 `normalize_to_hd`에 일원화한다 (1024x576 등 저해상도
    // 응답 → Lanczos3 1920x1080 업스케일, 640x480 미만 → ResolutionTooLow 실패).
    let img_hd = normalize_to_hd(img)?;
    img_hd.save(output_path)?;
    Ok(output_path.to_path_buf())
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
