//! WallMagic Core Engine (M1 Prototype)
//! - Windows native wallpaper control:
//!   1st: `IDesktopWallpaper` COM API
//!   2nd: `SystemParametersInfoW` Win32 API fallback
//! - Atomic staging & snapshot/restore (`Zero-Black-Screen` invariant)
//! - Built-in procedural/gradient wallpaper generator for zero-config verification

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod wallpaper;

// Public facade: the canonical implementation lives in the `wallpaper` module.
// Types and functions are re-exported here so downstream crates keep a stable import path.
pub use wallpaper::{
    app_data_dir, generate_sample_wallpaper, get_current_wallpaper, is_staged_path, load_state,
    restore_wallpaper, save_state, set_wallpaper, state_file_path, validate_and_stage_image,
    WallpaperError, WallpaperPosition, WallpaperState,
};

// NOTE: The canonical doc comments for the re-exported items live on their definitions
// in the `wallpaper` module. Re-declaring them here would create orphan doc comments
// (clippy::empty_line_after_doc_comments), so they are intentionally not duplicated.

#[cfg(all(windows, test))]
use crate::wallpaper::win32;

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, RgbImage};
    use std::fs;
    use std::path::Path;

    #[test]
    fn test_rejects_low_resolution_image() {
        let tmp = std::env::temp_dir().join("wallmagic_test_small.bmp");
        let small: RgbImage = ImageBuffer::from_pixel(320, 240, Rgb([10, 20, 30]));
        small.save(&tmp).expect("save small bmp");

        let res = validate_and_stage_image(&tmp, Some("test"));
        let _ = fs::remove_file(&tmp);
        assert!(matches!(
            res,
            Err(WallpaperError::ResolutionTooLow {
                width: 320,
                height: 240
            })
        ));
    }

    #[test]
    fn test_generate_and_stage_valid_wallpaper() {
        let tmp = std::env::temp_dir().join("wallmagic_test_hd.bmp");
        let generated = generate_sample_wallpaper("cyberpunk neon city", &tmp).expect("generate");
        assert!(generated.exists());

        let staged = validate_and_stage_image(&generated, Some("unit_test")).expect("stage");
        assert!(staged.exists());

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_double_set_then_restore_preserves_original_wallpaper() {
        // Backup real OS wallpaper & state before test
        let real_os_wall = get_current_wallpaper(None)
            .ok()
            .filter(|p| Path::new(p).exists());
        let real_state = load_state().ok();

        let temp_dir = std::env::temp_dir().join("wallmagic_repro_double_set");
        let _ = fs::create_dir_all(&temp_dir);

        let orig_path = temp_dir.join("user_original.bmp");
        let wall1_path = temp_dir.join("wall_first.bmp");
        let wall2_path = temp_dir.join("wall_second.bmp");

        generate_sample_wallpaper("original user desktop", &orig_path).expect("gen orig");
        generate_sample_wallpaper("first theme aurora", &wall1_path).expect("gen wall1");
        generate_sample_wallpaper("second theme sunset", &wall2_path).expect("gen wall2");

        // Set OS wallpaper to user_original.bmp and clear state.json to simulate initial user state
        #[cfg(windows)]
        let _ = win32::set_wallpaper_com(None, &orig_path, WallpaperPosition::Fill)
            .or_else(|_| win32::set_wallpaper_spi(&orig_path));
        let _ = fs::remove_file(state_file_path());

        // 1st set: stages active_wall_first_primary.bmp and applies wallpaper
        let state1 =
            set_wallpaper(&wall1_path, None, WallpaperPosition::Fill).expect("1st set_wallpaper");
        assert_eq!(
            state1.previous_wallpaper.as_deref(),
            Some(orig_path.to_string_lossy().as_ref()),
            "after 1st set, previous_wallpaper must be original wallpaper"
        );
        let os_after_1st = get_current_wallpaper(None).expect("get after 1st set");
        assert!(
            is_staged_path(&os_after_1st),
            "OS wallpaper after 1st set must be recognized as a staged path: {os_after_1st}"
        );

        // 2nd set: stages active_wall_second_primary.bmp while OS wallpaper is active_wall_first_primary.bmp
        let state2 =
            set_wallpaper(&wall2_path, None, WallpaperPosition::Fill).expect("2nd set_wallpaper");
        assert_ne!(
            state1.current_wallpaper, state2.current_wallpaper,
            "1st and 2nd staged paths must be distinct"
        );
        assert_eq!(
            state2.previous_wallpaper.as_deref(),
            Some(orig_path.to_string_lossy().as_ref()),
            "after 2nd set, previous_wallpaper must still be original wallpaper (not overwritten by 1st staged path)"
        );

        // Restore must bring back user_original.bmp
        let restored = restore_wallpaper(None).expect("restore_wallpaper");
        assert_eq!(
            restored.current_wallpaper.as_deref(),
            Some(orig_path.to_string_lossy().as_ref()),
            "restore must restore the initial original wallpaper"
        );
        let os_after_restore = get_current_wallpaper(None).expect("get after restore");
        assert!(
            os_after_restore.eq_ignore_ascii_case(&orig_path.to_string_lossy()),
            "OS wallpaper after restore must match original wallpaper"
        );

        // Cleanup & restore real environment
        #[cfg(windows)]
        if let Some(ref real_wall) = real_os_wall {
            if !real_wall.is_empty() && Path::new(real_wall).exists() {
                let _ =
                    win32::set_wallpaper_com(None, Path::new(real_wall), WallpaperPosition::Fill)
                        .or_else(|_| win32::set_wallpaper_spi(Path::new(real_wall)));
            }
        }
        if let Some(st) = real_state {
            let _ = save_state(&st);
        }
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
