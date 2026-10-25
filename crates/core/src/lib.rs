//! WallMagic Core Engine (M1 Prototype)
//! - Windows native wallpaper control:
//!   1st: `IDesktopWallpaper` COM API
//!   2nd: `SystemParametersInfoW` Win32 API fallback
//! - Atomic staging & snapshot/restore (`Zero-Black-Screen` invariant)
//! - Built-in procedural/gradient wallpaper generator for zero-config verification

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod scenario;
pub mod search;
pub mod wallpaper;

// Public facade: the canonical implementation lives in the `wallpaper` / `search` modules.
// Types and functions are re-exported here so downstream crates keep a stable import path.
pub use scenario::{
    cloudflare_ai_url, default_cf_model, default_openai_model, default_provider_order,
    effective_provider_order, failure_retry_allowed_at, generate_ai_with_fallback,
    generation_source_detail, provider_is_configured,
    generate_cloudflare_wallpaper, generate_openai_wallpaper, load_scenario, needs_cursor_reset,
    now_unix_secs, openai_images_url, parse_cf_image_response, parse_openai_image_response,
    pick_next_url, save_scenario, scenario_file_path, scenario_http_status_error, should_run,
    tick_scenario, CloudflareAiConfig, ImageProvider, OpenAiConfig, ScenarioOrder,
    ScenarioSettings, ScenarioSource,
};
pub use search::{
    generate_library_wallpaper, online_cache_file_name, search_wallpapers, WallpaperCandidate,
    SearchResult, SUPPORTED_EXTENSIONS,
};
pub use wallpaper::{
    app_data_dir, generate_online_wallpaper, generate_sample_wallpaper, get_current_wallpaper,
    is_staged_path, list_monitors, load_state, normalize_to_hd, record_generation,
    restore_wallpaper, save_state, set_wallpaper, set_wallpaper_with, state_file_path,
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
            ..WallpaperState::default()
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

    /// 회귀 테스트 (검수 지적 ①): 생성 정보(`provider`/`source`)가 state.json 에 기록되어야
    /// UI 가 "어떤 경로로 생성되었는지" 항상 표시할 수 있다. 기록이 없으면 사용자는
    /// 무료 폴백(Pollinations)으로 생성됐는지 Puter 로 생성됐는지 구분할 수 없다.
    ///
    /// OS 를 건드리지 않도록 순수 함수 `apply_generation_info` + state 파일 왕복으로만 검증한다.
    #[test]
    fn test_generation_info_is_recorded_and_persisted() {
        let _guard = DataDirGuard::new("generation_info");

        let mut state = WallpaperState::default();
        assert!(state.provider.is_none(), "default state has no provider");

        record_generation(
            &mut state,
            Some("puter"),
            Some("Puter.js txt2img (model: openai/gpt-image-2)"),
        );
        assert_eq!(state.provider.as_deref(), Some("puter"));
        assert_eq!(
            state.source.as_deref(),
            Some("Puter.js txt2img (model: openai/gpt-image-2)")
        );

        // 디스크에 영속되어 앱 재시작 후에도 표시 가능해야 한다.
        save_state(&state).expect("save state");
        let loaded = load_state().expect("load state");
        assert_eq!(loaded.provider.as_deref(), Some("puter"));
        assert_eq!(
            loaded.source.as_deref(),
            Some("Puter.js txt2img (model: openai/gpt-image-2)")
        );

        // 정보 없는 적용(로컬 파일 등)에서 이전 생성 정보가 잔류하면 오표시가 된다.
        record_generation(&mut state, None, None);
        assert_eq!(state.provider, None, "previous provider must not linger");
        assert_eq!(state.source, None, "previous source must not linger");

        // 공백 문자열도 None 으로 정규화한다 (빈 값 표시 금지).
        record_generation(&mut state, Some("  "), Some(""));
        assert_eq!(state.provider, None);
        assert_eq!(state.source, None);
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
        let names: Vec<String> = results
            .candidates
            .iter()
            .map(|c| c.file_name.clone())
            .collect();
        assert_eq!(
            names,
            vec!["sunset_a.bmp".to_string(), "sunset_c.png".to_string()],
            "search must return only name-matching, decodable, >=640x480 images in sorted order"
        );
    }

    /// 회귀 테스트 (검수 지적 1): 알파 채널이 있는 PNG는 JPEG 인코더가 Rgba8을 거부하므로
    /// RGB 변환 없이는 `load_candidate`가 조용히 None을 반환해 검색 결과에서 사라진다.
    #[test]
    fn test_search_includes_rgba_png_with_alpha_channel() {
        let guard = DataDirGuard::new("rgba_png");
        let root = guard.dir().join("pics");
        fs::create_dir_all(&root).expect("create search root");

        let rgba: image::RgbaImage =
            image::ImageBuffer::from_pixel(800, 600, image::Rgba([10, 20, 30, 128]));
        rgba.save(root.join("alpha_sunset.png"))
            .expect("save rgba png");

        let results = search_wallpapers("alpha", Some(&root)).expect("search_wallpapers");
        let names: Vec<String> = results
            .candidates
            .iter()
            .map(|c| c.file_name.clone())
            .collect();
        assert_eq!(
            names,
            vec!["alpha_sunset.png".to_string()],
            "RGBA PNG (with alpha channel) must appear in search results"
        );
    }

    /// 회귀 테스트 (검수 지적 2): 결과 상한 없이 수천 장을 디코딩하면 IPC가 장시간 블로킹된다.
    #[test]
    fn test_search_caps_results_at_max() {
        let guard = DataDirGuard::new("cap_results");
        let root = guard.dir().join("pics");
        fs::create_dir_all(&root).expect("create search root");

        let solid: RgbImage = ImageBuffer::from_pixel(640, 480, Rgb([5, 6, 7]));
        let total = 205usize;
        for i in 0..total {
            solid
                .save(root.join(format!("cap_{i:03}.png")))
                .expect("save cap png");
        }

        let results = search_wallpapers("cap_", Some(&root)).expect("search_wallpapers");
        assert_eq!(
            results.total_matched, total,
            "total_matched must count every name-matched file before the cap"
        );
        assert!(
            results.truncated,
            "truncated must be true when total_matched exceeds the cap"
        );
        assert_eq!(
            results.candidates.len(),
            200,
            "search results must be capped at MAX_RESULTS (200), got {}",
            results.candidates.len()
        );
    }

    #[test]
    #[ignore = "requires network access to the image generation API"]
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
        assert!(
            candidate.width >= 1280 && candidate.height >= 720,
            "generated candidate must be at least 1280x720, got {}x{}",
            candidate.width,
            candidate.height
        );

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

    /// 회귀 테스트 (결함 #1: "생성 결과가 너무 엉망"):
    /// "생성"이 프롬프트 해시로 만든 오프라인 그라디언트 합성이라면 이미지 생성 API가
    /// 호출되지 않은 것이다. 생성 결과는 실제 생성 API 응답에서 나와야 하고, 저장된
    /// 파일은 손상 없이 디코딩되어야 한다.
    /// (네트워크 필요 — `cargo test -p wallmagic-core -- --ignored <name>`으로 opt-in)
    #[test]
    #[ignore = "requires network access to the image generation API"]
    fn test_online_generate_is_not_offline_gradient_stub() {
        let _guard = DataDirGuard::new("online_generate");
        let prompt = "a vivid photo of a mountain lake at sunrise";
        let candidate = generate_library_wallpaper(prompt).expect("generate_library_wallpaper");
        assert!(
            Path::new(&candidate.path).exists(),
            "generated file must exist: {}",
            candidate.path
        );

        // 오프라인 스텁(그라디언트) 산출물과 바이트가 같으면 = 생성 API 미호출.
        let stub_path = std::env::temp_dir().join("wallmagic_test_stub_gradient.bmp");
        generate_sample_wallpaper(prompt, &stub_path).expect("generate offline stub");
        let generated_bytes = fs::read(&candidate.path).expect("read generated");
        let stub_bytes = fs::read(&stub_path).expect("read stub");
        let _ = fs::remove_file(&stub_path);
        assert!(
            generated_bytes != stub_bytes,
            "generated image is byte-identical to the offline gradient stub \
             — the image generation API was never called"
        );

        // 손상 없이 디코딩되어야 한다 (트렁케이트·오손상 응답 차단).
        let decoded = image::open(&candidate.path).expect("generated image must decode cleanly");
        assert!(
            decoded.width() >= 640 && decoded.height() >= 480,
            "generated image must be at least 640x480, got {}x{}",
            decoded.width(),
            decoded.height()
        );
    }

    /// 회귀 테스트 (결함 #2: "검색 결과가 없어"):
    /// 로컬 폴더에 일치 이미지가 없어도 검색은 0건으로 끝나면 안 되고, 온라인 공개 이미지
    /// 검색으로 폴백해 실제 후보를 내려받아 돌려줘야 한다. 폴백도 실패하면 명시적 오류.
    /// (네트워크 필요 — `cargo test -p wallmagic-core -- --ignored <name>`으로 opt-in)
    #[test]
    #[ignore = "requires network access to the online image search API"]
    fn test_online_search_falls_back_when_local_has_no_matches() {
        let guard = DataDirGuard::new("online_search");
        let empty_root = guard.dir().join("empty_pictures");
        fs::create_dir_all(&empty_root).expect("create empty search root");

        let results = search_wallpapers("aurora borealis", Some(&empty_root)).expect("search");
        assert!(
            !results.candidates.is_empty(),
            "local 0 results must fall back to online search — an empty list is the reported defect"
        );
        for candidate in &results.candidates {
            assert!(
                Path::new(&candidate.path).exists(),
                "online candidates must be downloaded locally before they are offered: {}",
                candidate.path
            );
            assert!(
                !candidate.thumb_base64.is_empty(),
                "thumbnail must be present for the result grid"
            );
        }
    }

    /// 검수 지적 1: `normalize_to_hd` 해상도 정규화 경로의 오프라인 검증.
    /// 1024x576(Classic 무료 티어 응답 크기) 입력이면 1920x1080 업스케일을 반환한다.
    #[test]
    fn test_normalize_upscales_1024x576_to_hd() {
        let small = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(
            1024,
            576,
            image::Rgb([1, 2, 3]),
        ));
        let hd = normalize_to_hd(small).expect("upscale");
        assert_eq!((hd.width(), hd.height()), (1920, 1080));
    }

    /// 검수 지적 1: 640x480 미만 입력이면 `ResolutionTooLow` 실패를 반환한다.
    #[test]
    fn test_normalize_rejects_below_minimum() {
        let tiny = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(
            320,
            240,
            image::Rgb([9, 9, 9]),
        ));
        assert!(matches!(
            normalize_to_hd(tiny),
            Err(WallpaperError::ResolutionTooLow {
                width: 320,
                height: 240
            })
        ));
    }

    /// 검수 지적 2: 앞 20자가 같은 서로 다른 쿼리가 같은 캐시 파일을 공유하면 안 된다.
    #[test]
    fn test_online_cache_file_name_separates_prefix_collisions() {
        let a = crate::search::online_cache_file_name("sunset over mountains", 0);
        let b = crate::search::online_cache_file_name("sunset over mountain lake", 0);
        assert_ne!(
            a, b,
            "same 20-char prefix queries must not share a cache file"
        );
    }

    /// 회귀 테스트 (요구: "생성 정보에 어떤 경로로 생성됐는지 표시"):
    /// `set_wallpaper` 계열은 어떤 공급자/경로로 생성된 배경화면인지
    /// `WallpaperState.provider` / `source` 에 남겨야 UI 가 항상 표시할 수 있다.
    /// OS 를 건드리지 않도록 정보 기록은 순수 함수 `record_generation` 으로 분리한다.
    #[test]
    fn test_record_generation_stores_provider_and_source() {
        let mut state = WallpaperState::default();
        record_generation(
            &mut state,
            Some("puter"),
            Some("Puter.js txt2img · model=openai/gpt-image-2"),
        );
        assert_eq!(state.provider.as_deref(), Some("puter"));
        assert_eq!(
            state.source.as_deref(),
            Some("Puter.js txt2img · model=openai/gpt-image-2")
        );
    }

    /// 공백·빈 문자열은 생성 정보를 남기지 않는다 (오라벨 방지).
    #[test]
    fn test_record_generation_clears_on_blank() {
        let mut state = WallpaperState {
            provider: Some("openai".to_string()),
            source: Some("old".to_string()),
            ..WallpaperState::default()
        };
        record_generation(&mut state, Some("   "), None);
        assert_eq!(state.provider, None);
        assert_eq!(state.source, None);
    }

    /// 생성 정보는 state.json 에 영속되고, 필드가 없는 구버전 state.json 도 로드된다.
    #[test]
    fn test_generation_info_persists_in_state_json() {
        let _guard = DataDirGuard::new("generation_info");
        let mut state = WallpaperState::default();
        record_generation(
            &mut state,
            Some("cloudflare-workers-ai"),
            Some("Cloudflare Workers AI · model=@cf/x"),
        );
        save_state(&state).expect("save state");

        let loaded = load_state().expect("load state");
        assert_eq!(loaded.provider.as_deref(), Some("cloudflare-workers-ai"));
        assert_eq!(
            loaded.source.as_deref(),
            Some("Cloudflare Workers AI · model=@cf/x")
        );

        // 구버전 state.json (provider/source 필드 없음) — serde(default) 로 로드 성공해야 한다.
        let legacy = r#"{"previous_wallpaper":null,"current_wallpaper":"C:\\x.bmp","backend_used":"IDesktopWallpaper (COM)"}"#;
        let parsed: WallpaperState = serde_json::from_str(legacy).expect("legacy state must load");
        assert_eq!(parsed.provider, None);
        assert_eq!(parsed.source, None);
    }

    /// 시나리오(자동 업데이트) 경로에서도 공급자별 생성 경로 설명이 만들어진다 (모델명 포함).
    #[test]
    fn test_generation_source_detail_includes_model() {
        use crate::scenario::generation_source_detail;
        let mut settings = ScenarioSettings::default();
        settings.cloudflare.model = "@cf/black-forest-labs/flux-1-schnell".to_string();
        settings.openai.model = "gpt-image-1".to_string();

        let cf = generation_source_detail(&settings, ImageProvider::CloudflareWorkersAi);
        assert!(
            cf.contains("@cf/black-forest-labs/flux-1-schnell"),
            "cloudflare source must contain the model: {cf}"
        );
        let oa = generation_source_detail(&settings, ImageProvider::Openai);
        assert!(
            oa.to_lowercase().contains("openai") && oa.contains("gpt-image-1"),
            "openai source must contain provider and model: {oa}"
        );
        let puter = generation_source_detail(&settings, ImageProvider::Puter);
        assert!(
            puter.to_lowercase().contains("puter"),
            "puter source must name the Puter SDK path: {puter}"
        );
    }
}
