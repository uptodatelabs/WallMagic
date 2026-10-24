//! WallMagic GUI 셸 — Tauri v2 런타임 + IPC 커맨드 (상용화 1단계)
//!
//! `src-ui`(React)와 `wallmagic-core`(Win32 엔진) 사이의 IPC 계약 구현체.
//! 핵심 4개 액션: ①검색 `search_wallpapers` ②생성 `generate_library_wallpaper`
//! ③적용 `apply_wallpaper` ④복원 `restore_wallpaper` + 보조 2개(`list_monitors`, `get_app_status`).
//!
//! 의존 방향은 단방향이다: `src-ui` —(IPC)→ 이 모듈 —(함수 호출)→ `wallmagic-core`.
//! 코어는 UI·IPC 타입을 참조하지 않는다.
//!
//! 주의 1: `#[tauri::command]` 매크로는 함수 이름과 동일한 매크로 심볼을 생성하므로,
//! 코어의 동명 함수를 `use`로 가져오면 E0255 충돌이 발생한다. 따라서 코어 함수는
//! 항상 `wallmagic_core::` 경로로 직접 호출한다.
//! 주의 2: Tauri v2는 `lib.rs`의 command 함수를 `pub`로 선언할 수 없다
//! (https://v2.tauri.app/develop/calling-rust/ — "Commands defined in the lib.rs file
//! cannot be marked as pub"). `pub`를 붙이면 `__cmd__*` 매크로 심볼이 중복 reimport되어
//! E0255가 발생한다. 테스트용 진입점은 별도의 `*_impl` 함수로 노출한다.

use serde::Serialize;
use std::path::PathBuf;
use wallmagic_core::{
    MonitorInfo, ScenarioSettings, SearchResult, WallpaperCandidate, WallpaperError,
    WallpaperPosition, WallpaperState, VERSION,
};

/// 상태바용 앱 상태 스냅샷 (IPC #6 `get_app_status`).
#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    pub version: String,
    pub current_wallpaper: String,
    pub previous_wallpaper: Option<String>,
    pub backend_used: Option<String>,
    pub data_dir: String,
}

/// `center|tile|stretch|fit|fill|span` 문자열을 코어 enum으로 변환한다.
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

fn err_to_string(err: WallpaperError) -> String {
    err.to_string()
}

/// IPC #1 (액션 ① 검색): 키워드로 로컬 배경화면 후보를 검색한다.
///
/// 반환은 `SearchResult`다 — 후보 목록(`candidates`)뿐 아니라 전체 매칭 수
/// (`total_matched`)와 상한 초과 여부(`truncated`)를 함께 전달해, UI가
/// "N건 중 200건 표시"를 노출할 수 있게 한다.
#[tauri::command]
fn search_wallpapers(query: String, dir: Option<String>) -> Result<SearchResult, String> {
    search_wallpapers_impl(&query, dir.as_deref())
}

pub fn search_wallpapers_impl(query: &str, dir: Option<&str>) -> Result<SearchResult, String> {
    let root: Option<PathBuf> = dir
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    wallmagic_core::search_wallpapers(query, root.as_deref()).map_err(err_to_string)
}

/// IPC #2 (액션 ② 생성): 프롬프트 기반 배경을 생성하고 썸네일 후보로 반환한다.
#[tauri::command]
fn generate_library_wallpaper(prompt: String) -> Result<WallpaperCandidate, String> {
    generate_library_wallpaper_impl(&prompt)
}

pub fn generate_library_wallpaper_impl(prompt: &str) -> Result<WallpaperCandidate, String> {
    wallmagic_core::generate_library_wallpaper(prompt).map_err(err_to_string)
}

/// IPC #10: Cloudflare Workers AI 이미지 생성 → 디코드 → 배경 적용.
/// - `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}`
/// - 토큰은 이 Rust 커맨드 안에서만 `Authorization: Bearer`로 사용한다
///   (프론트에서 직접 fetch 금지 — 반드시 이 커맨드 경유).
/// - 실패(401/429/네트워크/디코드) 시 기존 배경을 유지하고 오류 문자열을 반환한다.
#[tauri::command]
fn generate_wallpaper_ai(
    account_id: String,
    api_token: String,
    model: String,
    prompt: String,
    position: Option<String>,
    monitor_id: Option<String>,
) -> Result<WallpaperState, String> {
    generate_wallpaper_ai_impl(
        &account_id,
        &api_token,
        &model,
        &prompt,
        position.as_deref(),
        monitor_id.as_deref(),
    )
}

pub fn generate_wallpaper_ai_impl(
    account_id: &str,
    api_token: &str,
    model: &str,
    prompt: &str,
    position: Option<&str>,
    monitor_id: Option<&str>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position)?;
    let dest = wallmagic_core::app_data_dir()
        .join("online_cache")
        .join("cf_manual.jpg");
    let generated = wallmagic_core::generate_cloudflare_wallpaper(
        account_id, api_token, model, prompt, &dest,
    )
    .map_err(err_to_string)?;
    wallmagic_core::set_wallpaper(&generated, monitor_id, pos).map_err(err_to_string)
}

/// IPC #3 (액션 ③ 적용): 선택한 이미지를 검증·스테이징 후 바탕화면에 적용한다.
#[tauri::command]
fn apply_wallpaper(
    path: String,
    monitor_id: Option<String>,
    position: Option<String>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position.as_deref())?;
    wallmagic_core::set_wallpaper(&PathBuf::from(path), monitor_id.as_deref(), pos)
        .map_err(err_to_string)
}

/// IPC #4 (액션 ④ 복원): 스냅샷된 이전 배경화면으로 원복한다.
#[tauri::command]
fn restore_wallpaper(monitor_id: Option<String>) -> Result<WallpaperState, String> {
    restore_wallpaper_impl(monitor_id.as_deref())
}

pub fn restore_wallpaper_impl(monitor_id: Option<&str>) -> Result<WallpaperState, String> {
    wallmagic_core::restore_wallpaper(monitor_id).map_err(err_to_string)
}

/// IPC #5: 모니터 목록 (모니터 선택 드롭다운).
#[tauri::command]
fn list_monitors() -> Vec<MonitorInfo> {
    wallmagic_core::list_monitors()
}

/// IPC #6: 상태바용 앱 상태.
#[tauri::command]
fn get_app_status() -> AppStatus {
    let state = wallmagic_core::load_state().unwrap_or_default();
    AppStatus {
        version: VERSION.to_string(),
        current_wallpaper: wallmagic_core::get_current_wallpaper(None).unwrap_or_default(),
        previous_wallpaper: state.previous_wallpaper,
        backend_used: state.backend_used,
        data_dir: wallmagic_core::app_data_dir().to_string_lossy().to_string(),
    }
}

/// IPC #7: 시나리오 설정 조회 (`scenario.json`, 없으면 기본값).
#[tauri::command]
fn get_scenario() -> Result<ScenarioSettings, String> {
    get_scenario_impl()
}

pub fn get_scenario_impl() -> Result<ScenarioSettings, String> {
    // 검수 지적 [medium]: api_token 마스킹 — 디스크 평문 토큰을 프론트로 되돌려보내지 않는다.
    // 프론트는 저장 시에만 토큰을 전달하고, 조회 응답의 api_token은 항상 ""이다.
    let mut settings = wallmagic_core::load_scenario().map_err(err_to_string)?;
    settings.cloudflare.api_token = String::new();
    Ok(settings)
}

/// IPC #8: 시나리오 설정 저장 (UI 토글·주기·소스·순서).
#[tauri::command]
fn save_scenario(settings: ScenarioSettings) -> Result<ScenarioSettings, String> {
    save_scenario_impl(settings)
}

pub fn save_scenario_impl(mut settings: ScenarioSettings) -> Result<ScenarioSettings, String> {
    // 검수 지적 [medium](a): api_token 마스킹 흐름 — 조회 응답은 항상 ""이므로,
    // 저장 시 토큰이 비어 있으면 "기존 저장값 유지"로 해석해 디스크 토큰을 덮어쓰지 않는다.
    if settings.cloudflare.api_token.is_empty() {
        if let Ok(existing) = wallmagic_core::load_scenario() {
            settings.cloudflare.api_token = existing.cloudflare.api_token;
        }
    }
    wallmagic_core::save_scenario(&settings).map_err(err_to_string)?;
    let mut saved = wallmagic_core::load_scenario().map_err(err_to_string)?;
    saved.cloudflare.api_token = String::new();
    Ok(saved)
}

/// IPC #9: 시나리오 스케줄러 틱 (주기 도래 시 다음 이미지 적용).
#[tauri::command]
fn tick_scenario_now() -> Result<Option<WallpaperState>, String> {
    let now = wallmagic_core::now_unix_secs();
    wallmagic_core::tick_scenario(now).map_err(err_to_string)
}

/// Tauri v2 애플리케이션 진입 — 메인 창을 띄우고 IPC 커맨드 10종을 배선한다.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            search_wallpapers,
            generate_library_wallpaper,
            generate_wallpaper_ai,
            apply_wallpaper,
            restore_wallpaper,
            list_monitors,
            get_app_status,
            get_scenario,
            save_scenario,
            tick_scenario_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WallMagic application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_parse_position_arg_contract() {
        assert_eq!(
            parse_position_arg(Some("Fill")).expect("fill"),
            WallpaperPosition::Fill
        );
        assert_eq!(
            parse_position_arg(None).expect("default"),
            WallpaperPosition::Fill
        );
        assert_eq!(
            parse_position_arg(Some("span")).expect("span"),
            WallpaperPosition::Span
        );
        let err = parse_position_arg(Some("diagonal")).expect_err("invalid position must fail");
        assert!(
            err.contains("invalid position 'diagonal'"),
            "error must name the offending value: {err}"
        );
    }

    /// GUI 핵심 4개 액션의 IPC 래퍼가 코어와 실제로 연결되는 스모크 테스트.
    /// ①검색 → ②생성 → ③적용 → ④복원 순서로 수행하고 마지막에 원래 배경으로 되돌린다.
    /// (네트워크 + 실제 OS 배경 변경 — `cargo test -p wallmagic-app -- --ignored`로 opt-in)
    #[test]
    #[ignore = "requires network access and changes the real OS wallpaper; run explicitly with `cargo test -- --ignored`"]
    fn test_ipc_smoke_search_generate_apply_restore() {
        // ② 생성: 라이브러리에 배경을 만들고 후보(썸네일 포함)를 받는다.
        let candidate = generate_library_wallpaper_impl("tauri gui smoke theme")
            .expect("generate_library_wallpaper");
        assert!(
            Path::new(&candidate.path).exists(),
            "generated candidate must exist: {}",
            candidate.path
        );
        assert!(!candidate.thumb_base64.is_empty(), "thumbnail must be present");

        // ① 검색: 생성된 파일이 키워드 검색으로 다시 조회된다.
        let results = search_wallpapers_impl("tauri", None).expect("search_wallpapers");
        assert!(
            results
                .candidates
                .iter()
                .any(|c| c.path == candidate.path),
            "search must find the generated candidate back"
        );

        // ③ 적용: 후보를 바탕화면에 적용한다.
        let state =
            apply_wallpaper(candidate.path.clone(), None, Some("fill".to_string()))
                .expect("apply_wallpaper");
        let reported = state.current_wallpaper.as_deref().unwrap_or_default();
        assert!(
            reported.contains("active_"),
            "apply must report the staged path as current, got: {reported}"
        );
        assert!(
            Path::new(reported).exists(),
            "staged wallpaper file must exist: {reported}"
        );
        assert!(state.backend_used.is_some(), "backend_used must be recorded");

        // ④ 복원: 이전 배경으로 원복한다 (백엔드 기록이 갱신되어야 한다).
        let restored = restore_wallpaper(None).expect("restore_wallpaper");
        assert!(
            restored.backend_used.is_some(),
            "restore must record the backend used"
        );
    }

    /// `get_app_status`가 상태바에 필요한 필드를 항상 채워 반환하는지 검증한다.
    #[test]
    fn test_get_app_status_reports_core_state() {
        let status = get_app_status();
        assert_eq!(status.version, VERSION);
        assert!(
            !status.data_dir.is_empty(),
            "data_dir must be reported to the status bar"
        );
    }
}
