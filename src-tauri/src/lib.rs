//! WallMagic IPC Command Handlers (M1 Core Logic)
//! Provides the Rust command handler functions (`get_current_wallpaper`, `set_wallpaper`,
//! `restore_wallpaper`, `generate_and_apply_wallpaper`) backed by `wallmagic-core`
//! (`IDesktopWallpaper` COM 1st -> `SystemParametersInfoW` fallback).
//!
//! Note on M1 Scope: Per `docs/development-plan.md` §8.2, M1 focuses on the Win32 Core Engine
//! (`wallmagic-core` + `wallmagic-cli`). Full `tauri` / `tauri-build` crate dependency,
//! `#[tauri::command]` macro attributes, and `tauri::Builder::invoke_handler` runtime wiring
//! are not yet completed in M1 (scheduled for M5: "M5. Tauri UI, 트레이 & 스마트 스케줄러").
//! In M1, `src-tauri` provides pure Rust command wrapper functions and unit tests without the Tauri runtime.

use std::path::PathBuf;
use wallmagic_core::{WallpaperPosition, WallpaperState};

pub fn parse_position_arg(position: Option<&str>) -> Result<WallpaperPosition, String> {
    match position.unwrap_or("fill").to_ascii_lowercase().as_str() {
        "center" => Ok(WallpaperPosition::Center),
        "tile" => Ok(WallpaperPosition::Tile),
        "stretch" => Ok(WallpaperPosition::Stretch),
        "fit" => Ok(WallpaperPosition::Fit),
        "fill" => Ok(WallpaperPosition::Fill),
        "span" => Ok(WallpaperPosition::Span),
        other => Err(format!(
            "invalid position '{other}' (expected: center|tile|stretch|fit|fill|span)"
        )),
    }
}

/// Tauri IPC Command: `get_current_wallpaper`
pub fn get_current_wallpaper(monitor_id: Option<String>) -> Result<String, String> {
    wallmagic_core::get_current_wallpaper(monitor_id.as_deref()).map_err(|e| e.to_string())
}

/// Tauri IPC Command: `set_wallpaper`
pub fn set_wallpaper(
    path: String,
    monitor_id: Option<String>,
    position: Option<String>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position.as_deref())?;
    wallmagic_core::set_wallpaper(&PathBuf::from(path), monitor_id.as_deref(), pos)
        .map_err(|e| e.to_string())
}

/// Tauri IPC Command: `restore_wallpaper`
pub fn restore_wallpaper(monitor_id: Option<String>) -> Result<WallpaperState, String> {
    wallmagic_core::restore_wallpaper(monitor_id.as_deref()).map_err(|e| e.to_string())
}

/// Tauri IPC Command: `generate_and_apply_wallpaper`
pub fn generate_and_apply_wallpaper(
    prompt: String,
    monitor_id: Option<String>,
    position: Option<String>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position.as_deref())?;
    let out_path = wallmagic_core::app_data_dir().join("generated_ipc.bmp");
    let generated =
        wallmagic_core::generate_sample_wallpaper(&prompt, &out_path).map_err(|e| e.to_string())?;
    wallmagic_core::set_wallpaper(&generated, monitor_id.as_deref(), pos).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ipc_commands_roundtrip() {
        let initial = get_current_wallpaper(None).expect("get_current_wallpaper");
        let state = generate_and_apply_wallpaper(
            "tauri ipc test theme".to_string(),
            None,
            Some("fill".to_string()),
        )
        .expect("generate_and_apply_wallpaper");
        assert!(state.current_wallpaper.is_some());

        let restored = restore_wallpaper(None).expect("restore_wallpaper");
        if !initial.is_empty() {
            assert!(restored.current_wallpaper.is_some());
        }
    }
}
