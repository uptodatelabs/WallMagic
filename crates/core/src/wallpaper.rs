//! Windows Native Wallpaper Engine (`IDesktopWallpaper` COM 1st -> `SystemParametersInfoW` fallback)
//! Implements atomic image validation/staging and snapshot/restore (`Zero-Black-Screen` invariant).

use image::{ImageBuffer, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
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
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WallpaperState {
    pub previous_wallpaper: Option<String>,
    pub current_wallpaper: Option<String>,
    pub backend_used: Option<String>,
}

/// Core errors for wallpaper operations
#[derive(Debug, Error)]
pub enum WallpaperError {
    #[error("file not found: {0}")]
    FileNotFound(String),

    #[error("image decode error: {0}")]
    ImageDecode(#[from] image::ImageError),

    #[error("image resolution too low ({width}x{height}); minimum is 640x480")]
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

    let stem: String = candidate_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("wallpaper")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();

    let sanitized_suffix: String = monitor_id
        .unwrap_or("primary")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();

    let staged_tmp = active_dir.join(format!("staged_{stem}_{sanitized_suffix}.bmp"));
    let active_final = active_dir.join(format!("active_{stem}_{sanitized_suffix}.bmp"));

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
    let staged_path = validate_and_stage_image(candidate_path, monitor_id)?;
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
