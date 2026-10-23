//! WallMagic Core Engine (M1 Prototype)
//! - Windows native wallpaper control:
//!   1st: `IDesktopWallpaper` COM API
//!   2nd: `SystemParametersInfoW` Win32 API fallback
//! - Atomic staging & snapshot/restore (`Zero-Black-Screen` invariant)
//! - Built-in procedural/gradient wallpaper generator for zero-config verification

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod search;
pub mod wallpaper;

// Public facade: the canonical implementation lives in the `wallpaper` / `search` modules.
// Types and functions are re-exported here so downstream crates keep a stable import path.
pub use search::{
    generate_library_wallpaper, search_wallpapers, WallpaperCandidate, SUPPORTED_EXTENSIONS,
};
pub use wallpaper::{
    app_data_dir, generate_sample_wallpaper, get_current_wallpaper, is_staged_path, list_monitors,
    load_state, restore_wallpaper, save_state, set_wallpaper, state_file_path,
    validate_and_stage_image, WallpaperError, WallpaperPosition, WallpaperState, MonitorInfo,
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
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Serializes every test that mutates the process-wide `WALLMAGIC_DATA_DIR` override.
    fn data_dir_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Redirects `WALLMAGIC_DATA_DIR` to an isolated temporary directory for the lifetime of
    /// the guard, so neither `state.json` nor the staging directory touches the real user
    /// environment. On drop the previous environment value is restored and the temp directory
    /// is removed.
    struct DataDirGuard {
        _lock: MutexGuard<'static, ()>,
        temp_dir: PathBuf,
        previous: Option<String>,
    }

    impl DataDirGuard {
        fn new(label: &str) -> Self {
            let lock = data_dir_lock();
            let temp_dir = std::env::temp_dir().join(format!("wallmagic_test_{label}"));
            let _ = fs::remove_dir_all(&temp_dir);
            fs::create_dir_all(&temp_dir).expect("create isolated test data dir");
            let previous = std::env::var("WALLMAGIC_DATA_DIR").ok();
            std::env::set_var("WALLMAGIC_DATA_DIR", &temp_dir);
            Self {
                _lock: lock,
                temp_dir,
                previous,
            }
        }

        fn dir(&self) -> &Path {
            &self.temp_dir
        }
    }

    impl Drop for DataDirGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("WALLMAGIC_DATA_DIR", value),
                None => std::env::remove_var("WALLMAGIC_DATA_DIR"),
            }
            let _ = fs::remove_dir_all(&self.temp_dir);
        }
    }

    /// Restores the real OS wallpaper when the guard is dropped — including on panic,
    /// so a failed assertion can never leave the user's desktop changed.
    #[cfg(windows)]
    struct OsWallpaperGuard {
        original: Option<String>,
    }

    #[cfg(windows)]
    impl OsWallpaperGuard {
        fn capture() -> Self {
            let original = get_current_wallpaper(None)
                .ok()
                .filter(|p| !p.trim().is_empty());
            Self { original }
        }
    }

    #[cfg(windows)]
    impl Drop for OsWallpaperGuard {
        fn drop(&mut self) {
            if let Some(ref path) = self.original {
                let path = Path::new(path);
                if path.exists() {
                    let _ = win32::set_wallpaper_com(None, path, WallpaperPosition::Fill)
                        .or_else(|_| win32::set_wallpaper_spi(path));
                }
            }
        }
    }

    #[test]
    fn test_rejects_low_resolution_image() {
        let _guard = DataDirGuard::new("low_resolution");
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
        let guard = DataDirGuard::new("staging");
        let tmp = std::env::temp_dir().join("wallmagic_test_hd.bmp");
        let generated = generate_sample_wallpaper("cyberpunk neon city", &tmp).expect("generate");
        assert!(generated.exists());

        let staged = validate_and_stage_image(&generated, Some("unit_test")).expect("stage");
        assert!(staged.exists());
        assert!(
            staged.starts_with(guard.dir()),
            "staged wallpaper must be written inside the isolated data dir: {}",
            staged.display()
        );

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_state_file_is_isolated_by_data_dir_override() {
        let guard = DataDirGuard::new("state_isolation");
        let state_path = state_file_path();
        assert!(
            state_path.starts_with(guard.dir()),
            "state.json must be redirected into the isolated data dir: {}",
            state_path.display()
        );
        assert!(
            !state_path.exists(),
            "isolated data dir must start without a pre-existing state file"
        );

        let state = WallpaperState {
            previous_wallpaper: Some("C:\\Users\\test\\original.jpg".to_string()),
            current_wallpaper: Some("C:\\Users\\test\\current.jpg".to_string()),
            backend_used: Some("unit-test".to_string()),
        };
        save_state(&state).expect("save state");
        assert!(
            state_path.exists(),
            "state.json must be created inside the isolated data dir"
        );

        let loaded = load_state().expect("load state");
        assert_eq!(loaded.previous_wallpaper, state.previous_wallpaper);
        assert_eq!(loaded.current_wallpaper, state.current_wallpaper);
        assert_eq!(loaded.backend_used, state.backend_used);
    }

    #[test]
    fn test_resolve_previous_wallpaper_preserves_original_user_wallpaper() {
        let _guard = DataDirGuard::new("previous_wallpaper");
        let original = "C:\\Users\\test\\original.jpg";

        // 1st set: no snapshot yet -> the currently active wallpaper becomes the snapshot.
        assert_eq!(
            crate::wallpaper::resolve_previous_wallpaper(None, original),
            Some(original.to_string())
        );

        // 2nd set: the active wallpaper is one of our own staged files -> the snapshot is kept.
        let staged = app_data_dir()
            .join("active")
            .join("active_first_theme_primary.bmp");
        assert!(
            is_staged_path(&staged.to_string_lossy()),
            "staged path detection must work inside the isolated data dir"
        );
        assert_eq!(
            crate::wallpaper::resolve_previous_wallpaper(Some(original), &staged.to_string_lossy()),
            Some(original.to_string()),
            "the original user wallpaper must survive a second set"
        );
    }

    /// Opt-in end-to-end test: it really changes the wallpaper of the current desktop session.
    ///
    /// It is `#[ignore]`d by default because it mutates the user environment. Run it with
    /// `cargo test -p wallmagic-core -- --ignored`. The state file is redirected to an
    /// isolated temp dir (never the real `%LOCALAPPDATA%\WallMagic\state.json`) and the real
    /// wallpaper is restored by a `Drop` guard even when an assertion fails.
    #[cfg(windows)]
    #[test]
    #[ignore = "changes the real OS wallpaper; run explicitly with `cargo test -- --ignored`"]
    fn test_double_set_then_restore_preserves_original_wallpaper() {
        let data_guard = DataDirGuard::new("e2e_double_set");
        let os_guard = OsWallpaperGuard::capture();

        let assets_dir = data_guard.dir().join("assets");
        fs::create_dir_all(&assets_dir).expect("create assets dir");

        let orig_path = assets_dir.join("user_original.bmp");
        let wall1_path = assets_dir.join("wall_first.bmp");
        let wall2_path = assets_dir.join("wall_second.bmp");

        generate_sample_wallpaper("original user desktop", &orig_path).expect("gen orig");
        generate_sample_wallpaper("first theme aurora", &wall1_path).expect("gen wall1");
        generate_sample_wallpaper("second theme sunset", &wall2_path).expect("gen wall2");

        // Put a known, non-staged wallpaper on the desktop so the snapshot logic is exercised.
        let _ = win32::set_wallpaper_com(None, &orig_path, WallpaperPosition::Fill)
            .or_else(|_| win32::set_wallpaper_spi(&orig_path));

        // 1st set: stages active_wall_first_primary.bmp and applies the wallpaper.
        let state1 =
            set_wallpaper(&wall1_path, None, WallpaperPosition::Fill).expect("1st set_wallpaper");
        assert_eq!(
            state1.previous_wallpaper.as_deref(),
            Some(orig_path.to_string_lossy().as_ref()),
            "after 1st set, previous_wallpaper must be the original wallpaper"
        );
        let os_after_1st = get_current_wallpaper(None).expect("get after 1st set");
        assert!(
            is_staged_path(&os_after_1st),
            "OS wallpaper after 1st set must be recognized as a staged path: {os_after_1st}"
        );

        // 2nd set: stages active_wall_second_primary.bmp while the OS wallpaper is the 1st one.
        let state2 =
            set_wallpaper(&wall2_path, None, WallpaperPosition::Fill).expect("2nd set_wallpaper");
        assert_ne!(
            state1.current_wallpaper, state2.current_wallpaper,
            "1st and 2nd staged paths must be distinct"
        );
        assert_eq!(
            state2.previous_wallpaper.as_deref(),
            Some(orig_path.to_string_lossy().as_ref()),
            "after 2nd set, previous_wallpaper must still be the original wallpaper (not overwritten by the 1st staged path)"
        );

        // Restore must bring back the original wallpaper.
        let restored = restore_wallpaper(None).expect("restore_wallpaper");
        assert_eq!(
            restored.current_wallpaper.as_deref(),
            Some(orig_path.to_string_lossy().as_ref()),
            "restore must restore the initial original wallpaper"
        );
        let os_after_restore = get_current_wallpaper(None).expect("get after restore");
        assert!(
            os_after_restore.eq_ignore_ascii_case(&orig_path.to_string_lossy()),
            "OS wallpaper after restore must match the original wallpaper"
        );

        // Restore the real user wallpaper explicitly (the guard would do it on drop as well).
        drop(os_guard);
    }

    #[test]
    fn test_search_wallpapers_filters_by_name_and_resolution() {
        let guard = DataDirGuard::new("search_filter");
        let root = guard.dir().join("pics");
        fs::create_dir_all(root.join("sub")).expect("create search root");

        let big: RgbImage = ImageBuffer::from_pixel(800, 600, Rgb([10, 20, 30]));
        big.save(root.join("sunset_a.bmp")).expect("save sunset_a");
        big.save(root.join("aurora_b.bmp")).expect("save aurora_b");
        let small: RgbImage = ImageBuffer::from_pixel(320, 240, Rgb([10, 20, 30]));
        small
            .save(root.join("sunset_small.bmp"))
            .expect("save sunset_small");
        big.save(root.join("sub").join("sunset_c.png"))
            .expect("save sunset_c");

        let results = search_wallpapers("sunset", Some(&root)).expect("search_wallpapers");
        let names: Vec<String> = results.iter().map(|c| c.file_name.clone()).collect();
        assert_eq!(
            names,
            vec!["sunset_a.bmp".to_string(), "sunset_c.png".to_string()],
            "search must return only name-matching, decodable, >=640x480 images in sorted order"
        );
    }

    #[test]
    fn test_generate_library_wallpaper_returns_candidate_with_bounded_thumbnail() {
        let guard = DataDirGuard::new("generate_library");
        let candidate = generate_library_wallpaper("neon harbor at dusk")
            .expect("generate_library_wallpaper");

        assert!(
            Path::new(&candidate.path).exists(),
            "generated candidate file must exist"
        );
        assert!(
            candidate
                .path
                .starts_with(&guard.dir().to_string_lossy().to_string()[..]),
            "generated candidate must live inside the isolated data dir: {}",
            candidate.path
        );
        assert_eq!(candidate.width, 1920);
        assert_eq!(candidate.height, 1080);

        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&candidate.thumb_base64)
            .expect("thumb_base64 must decode");
        let thumb = image::load_from_memory(&raw).expect("thumbnail must be a decodable image");
        assert!(
            thumb.width() <= 320 && thumb.height() <= 320,
            "thumbnail must be downscaled to <=320px, got {}x{}",
            thumb.width(),
            thumb.height()
        );
    }
}
