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
    /// 생성 공급자 식별자: `pollinations` | `puter` | `cloudflare-workers-ai`
    /// | `openai` | `local-file` | `url` (없으면 이 배경은 앱이 생성한 것이 아니다).
    pub provider: Option<String>,
    /// 생성 경로 상세 (사용 모델명·SDK 등). UI 가 "생성 정보"로 그대로 표시한다.
    pub source: Option<String>,
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

/// 외부 URL 스킴 검증 — http/https만 허용하고 그 외(`file://`, 임의 명령 등)는 거부한다.
/// 참고: 오프너는 셸(`cmd /c start`)을 거치지 않고 rundll32 FileProtocolHandler로
/// argv 하나를 그대로 전달하므로, URL의 `&`, `|`, `^` 메타문자가 cmd.exe 재파싱으로
/// 추가 명령이 되지 않는다. 이 검증은 1차 방어(비-Web 스킴 차단)다.
pub fn validate_external_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("invalid url scheme: empty url".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!(
            "invalid url scheme (expected http/https): {trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

/// IPC: 시스템 기본 브라우저로 URL을 연다.
/// Puter 로그인 팝업이 차단되었을 때 안내에 그치지 않고 실제 열기를 시도하는 대체 경로.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;
    #[cfg(windows)]
    {
        // 보안(지적 1): `cmd /c start`를 쓰지 않는다 — cmd.exe가 명령줄을 재파싱해
        // URL의 `&`, `|`, `^` 메타문자가 추가 명령이 된다. rundll32 FileProtocolHandler는
        // URL을 argv 하나로 그대로 전달하므로 재파싱 경로가 존재하지 않는다.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &validated])
            .spawn()
            .map_err(|e| format!("failed to open external browser: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        return Err("open_external_url: unsupported platform".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod external_url_tests {
    use super::validate_external_url;

    /// 수용: http/https 스킴은 trim 후 그대로 통과
    #[test]
    fn test_validate_external_url_accepts_http_https() {
        assert_eq!(
            validate_external_url("  https://puter.com/auth/  ").unwrap(),
            "https://puter.com/auth/"
        );
        assert!(validate_external_url("http://example.com").is_ok());
    }

    /// 거부: 빈 값·비-Web 스킴은 명시적 오류로 실패 (조용한 폴스루 금지)
    #[test]
    fn test_validate_external_url_rejects_bad_scheme() {
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("   ").is_err());
        assert!(validate_external_url("file:///c:/windows/system32").is_err());
        assert!(validate_external_url("cmd /c calc").is_err());
    }

    /// 메타문자(&)가 포함된 URL은 오프너가 셸을 거치지 않으므로(argv 1개 전달)
    /// 추가 명령이 되지 않는다 — `https://a&calc`는 정상 http 스킴으로 통과하고,
    /// 실제 오픈은 rundll32 FileProtocolHandler가 수행한다 (cmd.exe 재파싱 경로 없음).
    #[test]
    fn test_validate_external_url_meta_char_url_no_shell() {
        assert_eq!(
            validate_external_url("https://a&calc").unwrap(),
            "https://a&calc"
        );
    }
}

/// 프론트엔드(Puter.js)가 넘긴 base64 이미지 payload를 디코딩한다.
///
/// - `data:image/png;base64,<본문>` 형태의 data URL 접두사를 허용하고 본문만 디코딩한다.
/// - 비-base64·빈 payload는 조용한 폴스루 없이 명시적 오류 문자열로 실패한다
///   (Puter SDK 응답이 비었을 때 `set_wallpaper`가 엉뚱한 파일을 읽는 것을 막는다).
pub fn decode_image_payload(payload: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let trimmed = payload.trim();
    let body = match trimmed.find(";base64,") {
        Some(idx) => trimmed[idx + ";base64,".len()..].trim(),
        None => trimmed,
    };
    if body.is_empty() {
        return Err("image payload is empty: decoded 0 bytes".to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .map_err(|e| format!("invalid base64 image payload: {e}"))?;
    if decoded.is_empty() {
        return Err("image payload is empty: decoded 0 bytes".to_string());
    }
    Ok(decoded)
}

/// IPC #10d: 프론트엔드(Puter.js)가 생성한 base64 이미지를 파일로 저장하고 배경에 적용한다.
///
/// Puter.js(`https://js.puter.com/v2/`, `puter.ai.txt2img`)는 브라우저 JS SDK + 사용자
/// 세션 전제라 Rust 백엔드에서 서버 측 REST로 호출할 수 없다. 따라서 생성은 WebView(프론트)가
/// 담당하고, 이 커맨드는 그 결과(base64 / data URL)를 받아 **검증·스테이징·적용**만 수행한다
/// (파일 쓰기·해상도 검증·스냅샷 복원 로직을 코어 한 곳에 유지).
#[tauri::command]
fn apply_generated_image(
    image_base64: String,
    label: Option<String>,
    position: Option<String>,
    monitor_id: Option<String>,
    model: Option<String>,
) -> Result<WallpaperState, String> {
    apply_generated_image_impl(
        &image_base64,
        label.as_deref(),
        position.as_deref(),
        monitor_id.as_deref(),
        model.as_deref(),
    )
}

pub fn apply_generated_image_impl(
    image_base64: &str,
    label: Option<&str>,
    position: Option<&str>,
    monitor_id: Option<&str>,
    model: Option<&str>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position)?;
    let bytes = decode_image_payload(image_base64)?;

    let dir = wallmagic_core::app_data_dir().join("online_cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create online_cache failed: {e}"))?;
    // 무라벨 호출을 'puter' 로 둔갑시키지 않는다 (검수 지적 [medium]).
    // 기본값이 존재하면 프론트가 label 을 빠뜨려도 provider 가 조용히 "puter" 로 기록되어
    // "Pollinations 로 생성했는데 Puter 로 표시"되는 오표시가 재발한다.
    let label = label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "apply_generated_image: label(공급자 id)이 필요합니다".to_string())?;
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(24)
        .collect();
    // 파일명 접두어를 'puter_' 고정에서 'generated_' 로 바꾼다 (검수 지적 [medium]).
    // 접두어가 공급자와 무관하게 puter 로 고정되면 파일 경로
    // (active_puter_puter_primary.bmp)만 보고 사용자가 생성 경로를 오판한다.
    let path = dir.join(format!("generated_{safe}.png"));
    std::fs::write(&path, &bytes).map_err(|e| format!("write generated image failed: {e}"))?;

    // 생성 정보 기록: WebView(Puter.js)가 만든 이미지도 `state.json` 에
    // "어떤 경로로 생성됐는지"(SDK + 사용 모델)를 남겨 UI 가 항상 표시할 수 있게 한다.
    // 기록이 없으면 사용자는 무료 폴백(Pollinations)과 Puter 결과를 구분할 수 없다.
    // 상세 문구도 label 에 종속시킨다 — 라벨이 puter 가 아닌데 "Puter.js txt2img" 가
    // 기록되면 생성 정보 자체가 거짓이 된다 (검수 지적 [medium]).
    let detail = if label == "puter" {
        match model.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => format!("Puter.js txt2img (WebView 브라우저 SDK) · model={m}"),
            None => "Puter.js txt2img (WebView 브라우저 SDK) · Puter 기본 모델".to_string(),
        }
    } else {
        match model.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => format!("apply_generated_image (WebView) · provider={label} · model={m}"),
            None => format!("apply_generated_image (WebView) · provider={label}"),
        }
    };

    // 생성 파일 자체에도 사이드카를 남긴다 (검수 지적: 읽는 곳이 없던 미완성 계약).
    // 파일이 스스로 귀속 정보를 갖고 있어야 "현재 배경" 기록(state.json)과 어긋나도
    // 해당 이미지가 어떤 공급자로 만들어졌는지 파일 단위로 정확히 표시된다.
    // 사이드카 기록 실패는 조용히 넘기지 않고 적용 자체를 실패시킨다 (무음 손실 금지).
    wallmagic_core::write_generation_sidecar(&path, Some(label), Some(&detail))
        .map_err(err_to_string)?;

    // `set_wallpaper_with`가 내부에서 디코딩·해상도(640x480) 검증·스테이징을 수행하므로
    // 손상 payload나 저해상도 이미지는 여기서 명시적 오류로 실패한다 (조용한 폴스루 없음).
    wallmagic_core::set_wallpaper_with(&path, monitor_id, pos, Some(label), Some(&detail))
        .map_err(err_to_string)
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
    // 검수 지적 [medium](1): api_token이 비어 있으면 디스크 scenario.json의 저장 토큰으로
    // 폴백한다. get_scenario 응답은 마스킹("")이므로 앱 재시작 후 프론트 토큰이 비어도
    // 저장된 토큰으로 수동 AI 생성이 동작한다.
    let effective_token: String = if api_token.trim().is_empty() {
        wallmagic_core::load_scenario()
            .map(|s| s.cloudflare.api_token)
            .unwrap_or_default()
    } else {
        api_token.to_string()
    };
    let dest = wallmagic_core::app_data_dir()
        .join("online_cache")
        .join("cf_manual.jpg");
    let generated = wallmagic_core::generate_cloudflare_wallpaper(
        account_id,
        &effective_token,
        model,
        prompt,
        &dest,
    )
    .map_err(err_to_string)?;
    // 생성 정보 기록: 수동 Cloudflare 생성도 어떤 모델로 만들었는지 state.json 에 남긴다.
    wallmagic_core::set_wallpaper_with(
        &generated,
        monitor_id,
        pos,
        Some("cloudflare-workers-ai"),
        Some(&format!("Cloudflare Workers AI · model={model} · manual")),
    )
    .map_err(err_to_string)
}

/// IPC #10b: OpenAI Images 이미지 생성 → 디코드 → 배경 적용.
/// - `POST https://api.openai.com/v1/images/generations` + `Authorization: Bearer {api_key}`
/// - 키는 이 Rust 커맨드 안에서만 `Authorization` 헤더에 사용한다
///   (프론트에서 직접 fetch 금지 — 반드시 이 커맨드 경유).
/// - 빈 키면 디스크 scenario.json의 저장 키로 폴백한다 (CF와 동일 패턴).
/// - 실패(401/429/네트워크/디코드) 시 기존 배경을 유지하고 오류 문자열을 반환한다.
#[tauri::command]
fn generate_wallpaper_openai(
    api_key: String,
    model: String,
    prompt: String,
    position: Option<String>,
    monitor_id: Option<String>,
) -> Result<WallpaperState, String> {
    generate_wallpaper_openai_impl(
        &api_key,
        &model,
        &prompt,
        position.as_deref(),
        monitor_id.as_deref(),
    )
}

pub fn generate_wallpaper_openai_impl(
    api_key: &str,
    model: &str,
    prompt: &str,
    position: Option<&str>,
    monitor_id: Option<&str>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position)?;
    let effective_key: String = if api_key.trim().is_empty() {
        wallmagic_core::load_scenario()
            .map(|s| s.openai.api_key)
            .unwrap_or_default()
    } else {
        api_key.to_string()
    };
    let dest = wallmagic_core::app_data_dir()
        .join("online_cache")
        .join("openai_manual.jpg");
    let generated =
        wallmagic_core::generate_openai_wallpaper(&effective_key, model, prompt, &dest)
            .map_err(err_to_string)?;
    wallmagic_core::set_wallpaper_with(
        &generated,
        monitor_id,
        pos,
        Some("openai"),
        Some(&format!("OpenAI Images API · model={model} · manual")),
    )
    .map_err(err_to_string)
}

/// IPC #10c: 우선순위 순서대로 이미지 생성 후 적용.
/// - 공용 프롬프트 하나로 설정된 순서(effective_provider_order)대로 시도하고 실패 시 다음 공급자로 폴백한다.
/// - 기본값 무료 우선 = Pollinations -> Cloudflare -> OpenAI. 키 없는 공급자는 자동 건너뜀.
/// - 전부 실패 시 마지막 오류를 반환해 기존 배경을 유지한다 (조용한 폴스루 금지).
#[tauri::command]
fn generate_wallpaper_priority(
    prompt: String,
    position: Option<String>,
    monitor_id: Option<String>,
    provider_order: Option<Vec<wallmagic_core::ImageProvider>>,
) -> Result<WallpaperState, String> {
    generate_wallpaper_priority_impl(
        &prompt,
        position.as_deref(),
        monitor_id.as_deref(),
        provider_order,
    )
}

pub fn generate_wallpaper_priority_impl(
    prompt: &str,
    position: Option<&str>,
    monitor_id: Option<&str>,
    provider_order: Option<Vec<wallmagic_core::ImageProvider>>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position)?;
    let mut settings = wallmagic_core::load_scenario().map_err(err_to_string)?;
    if let Some(order) = provider_order {
        // 지적 2: 화면 순서를 그대로 전달 — effective_provider_order가
        // 빈 배열·중복을 정규화하므로 미저장 상태에서도 화면 순서 = 실제 시도 순서.
        settings.provider_order = order;
    }
    let dest = wallmagic_core::app_data_dir()
        .join("online_cache")
        .join("priority_manual.jpg");
    let (used, path) =
        wallmagic_core::generate_ai_with_fallback(&settings, prompt, &dest)
            .map_err(err_to_string)?;
    // 생성 정보 기록: 우선순위 폴백에서 **실제로 성공한 공급자**를 state.json 에 남긴다.
    // `_used` 를 버리면 사용자는 어떤 경로로 생성됐는지 알 수 없다 (요구 ① 위반).
    let detail = wallmagic_core::generation_source_detail(&settings, used);
    wallmagic_core::set_wallpaper_with(
        &path,
        monitor_id,
        pos,
        Some(used.as_id()),
        Some(&format!("{detail} · priority")),
    )
    .map_err(err_to_string)
}

/// IPC #3b: 적용된 배경 파일 경로를 ③ 미리보기용 후보로 변환한다.
///
/// `validate_and_stage_image`는 원본을 `active/active_<원본 stem>_<모니터>.bmp`로
/// 재인코딩·스테이징하므로, 적용 결과 경로(`current_wallpaper`)와 미리보기 후보 경로
/// (`selected.path`)는 **문자열이 절대 같을 수 없다**. 적용 후 selected 를 그대로 두면
/// "현재 배경과 다른 파일" 경고가 계속 뜬다.
/// 이 커맨드는 스테이징된 파일 자체를 후보(썸네일·해상도)로 되돌려, UI 가 미리보기를
/// 실제 적용 파일로 교체할 수 있게 한다.
#[tauri::command]
fn candidate_for_path(path: String) -> Result<WallpaperCandidate, String> {
    candidate_for_path_impl(&path)
}

pub fn candidate_for_path_impl(path: &str) -> Result<WallpaperCandidate, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("candidate_for_path: path 가 필요합니다".to_string());
    }
    let candidate_path = PathBuf::from(trimmed);
    if !candidate_path.exists() {
        return Err(format!("candidate_for_path: 파일이 없습니다 — {trimmed}"));
    }
    wallmagic_core::load_candidate(&candidate_path).ok_or_else(|| {
        format!(
            "candidate_for_path: 후보로 변환할 수 없습니다(디코딩 실패 또는 640x480 미만) — {trimmed}"
        )
    })
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
        provider: state.provider,
        source: state.source,
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
    // 프론트는 저장 시에만 토큰을 전달하고, 조회 응답의 api_token/api_key는 항상 ""이다.
    let mut settings = wallmagic_core::load_scenario().map_err(err_to_string)?;
    settings.cloudflare.api_token = String::new();
    settings.openai.api_key = String::new();
    Ok(settings)
}

/// IPC #8: 시나리오 설정 저장 (UI 토글·주기·소스·순서).
#[tauri::command]
fn save_scenario(settings: ScenarioSettings) -> Result<ScenarioSettings, String> {
    save_scenario_impl(settings)
}

pub fn save_scenario_impl(mut settings: ScenarioSettings) -> Result<ScenarioSettings, String> {
    // 검수 지적 [medium](2): 명시적 삭제 플래그 — clear_api_token=true일 때만 빈 토큰으로
    // 덮어쓰고, 그 외 빈 토큰은 "기존 저장값 유지"로 해석한다. 플래그는 저장 전 false로
    // 리셋하므로 scenario.json에 잔류하지 않는다.
    let clear_requested = settings.clear_api_token;
    settings.clear_api_token = false;
    if settings.cloudflare.api_token.is_empty() && !clear_requested {
        if let Ok(existing) = wallmagic_core::load_scenario() {
            settings.cloudflare.api_token = existing.cloudflare.api_token;
        }
    }
    // OpenAI api_key도 동일 패턴: clear_api_key=true일 때만 빈 키로 덮어쓰고,
    // 그 외 빈 키는 기존 저장값 유지. 플래그는 저장 전 false로 리셋한다.
    let clear_key_requested = settings.clear_api_key;
    settings.clear_api_key = false;
    if settings.openai.api_key.is_empty() && !clear_key_requested {
        if let Ok(existing) = wallmagic_core::load_scenario() {
            settings.openai.api_key = existing.openai.api_key;
        }
    }
    wallmagic_core::save_scenario(&settings).map_err(err_to_string)?;
    let mut saved = wallmagic_core::load_scenario().map_err(err_to_string)?;
    saved.cloudflare.api_token = String::new();
    saved.openai.api_key = String::new();
    Ok(saved)
}

/// IPC #9: 시나리오 스케줄러 틱 (주기 도래 시 다음 이미지 적용).
#[tauri::command]
fn tick_scenario_now() -> Result<Option<WallpaperState>, String> {
    let now = wallmagic_core::now_unix_secs();
    wallmagic_core::tick_scenario(now).map_err(err_to_string)
}

/// Tauri v2 애플리케이션 진입 — 메인 창을 띄우고 IPC 커맨드 11종을 배선한다.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            search_wallpapers,
            generate_library_wallpaper,
            generate_wallpaper_ai,
            generate_wallpaper_openai,
            apply_wallpaper,
            candidate_for_path,
            restore_wallpaper,
            list_monitors,
            get_app_status,
            get_scenario,
            save_scenario,
            tick_scenario_now,
            generate_wallpaper_priority,
            apply_generated_image,
            open_external_url,
        ])
        .setup(|app| {
            // 팝업 차단의 구조적 원인 해소: `tauri.conf.json` 의 `app.windows` 로 자동 생성된
            // 창은 wry 의 `on_new_window` 핸들러가 없어 WebView2 가 새 창 요청을 무조건
            // 차단한다 (wry-0.57.1/src/webview2/mod.rs:861-863 의 `SetHandled(true)`).
            // 즉 Puter 로그인 팝업은 그 경로에서 100% 차단된다.
            // 따라서 메인 창을 코드로 직접 만들고 `on_new_window` 를 등록해 https 팝업을
            // 실제 창으로 열어준다 (라벨 "main" 은 capabilities/default.json 과 일치).
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("WallMagic — Windows Wallpaper Studio")
                .inner_size(1080.0, 720.0)
                .resizable(true)
                .on_new_window(|url, _features| {
                    // Puter 로그인 팝업(https)은 실제 창으로 열어준다.
                    // 비-Web 스킴(file://, 커스텀 스킴)은 명시적으로 거부한다.
                    match url.scheme() {
                        "https" | "http" => tauri::webview::NewWindowResponse::Allow,
                        _ => tauri::webview::NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
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

    /// Puter 경로 회귀 테스트 (Red→Green): 프론트엔드(Puter.js)가 넘긴 base64 이미지
    /// payload를 백엔드가 디코딩한다. data URL 접두사 허용, 비-base64/빈 payload는
    /// 조용한 폴스루 없이 명시적 오류를 반환해야 한다.
    #[test]
    fn test_decode_image_payload_contract() {
        // (1) 잘못된 base64 → 명시적 오류
        let err = decode_image_payload("@@not-base64@@").expect_err("invalid base64 must fail");
        assert!(
            err.contains("invalid base64"),
            "error must name the cause: {err}"
        );

        // (2) data URL 접두사는 허용하고 본문만 디코딩한다.
        let decoded = decode_image_payload("data:image/png;base64,aGVsbG8=").expect("data url");
        assert_eq!(decoded, b"hello".to_vec());

        // (3) 공백/빈 문자열 → 0바이트 오류
        let err = decode_image_payload("   ").expect_err("empty payload must fail");
        assert!(
            err.contains("0 bytes"),
            "empty payload must be reported: {err}"
        );
    }

    /// 검수 지적 [medium]: label(공급자 id)을 생략한 호출은 'puter' 로 둔갑하지 않고 오류다.
    ///
    /// 무라벨 기본값(`unwrap_or("puter")`)이 존재하면 프론트가 label 을 빠뜨렸을 때
    /// Pollinations 등 다른 공급자로 만든 이미지가 조용히 "Puter" 로 기록된다.
    /// 이 테스트는 (1) None/공백 label 이 label 오류로 실패하고
    /// (2) 정상 label 은 label 검사에서 막히지 않음(대조군)을 확인한다.
    #[test]
    fn test_apply_generated_image_requires_label() {
        // 1x1 PNG data URL — label 검사는 디코딩 직후·해상도 검증 전에 수행된다.
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
        let _guard = DataDirGuard::new("requires_label");

        let err = apply_generated_image_impl(png, None, None, None, None)
            .expect_err("label 없이 호출하면 오류여야 한다");
        assert!(
            err.contains("label"),
            "label 누락은 label 오류로 보고돼야 한다(무라벨→puter 둔갑 금지): {err}"
        );

        let err_blank = apply_generated_image_impl(png, Some("   "), None, None, None)
            .expect_err("공백 label 도 오류여야 한다");
        assert!(
            err_blank.contains("label"),
            "공백 label 은 label 오류로 보고돼야 한다: {err_blank}"
        );

        // 대조군: 정상 label 은 label 검사에 걸리지 않아야 한다.
        // (1x1 이미지는 해상도 검증에서 실패하므로 Err 이지만, 문구가 label 오류가 아니어야 한다)
        let other = apply_generated_image_impl(png, Some("pollinations"), None, None, None)
            .expect_err("1x1 이미지는 해상도 검증에서 실패해야 한다");
        assert!(
            !other.contains("label(공급자 id)이 필요합니다"),
            "정상 label 이 label 검사에서 막히면 안 된다: {other}"
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

    /// `WALLMAGIC_DATA_DIR`를 격리 임시 디렉터리로 돌리는 가드.
    /// `scenario.json`이 실제 `%LOCALAPPDATA%\WallMagic`을 건드리지 않게 한다.
    struct DataDirGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        temp_dir: std::path::PathBuf,
        previous: Option<String>,
    }

    fn data_dir_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl DataDirGuard {
        fn new(label: &str) -> Self {
            let lock = data_dir_lock();
            let temp_dir = std::env::temp_dir().join(format!("wallmagic_app_test_{label}"));
            let _ = std::fs::remove_dir_all(&temp_dir);
            std::fs::create_dir_all(&temp_dir).expect("create isolated test data dir");
            let previous = std::env::var("WALLMAGIC_DATA_DIR").ok();
            std::env::set_var("WALLMAGIC_DATA_DIR", &temp_dir);
            Self {
                _lock: lock,
                temp_dir,
                previous,
            }
        }
    }

    impl Drop for DataDirGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("WALLMAGIC_DATA_DIR", value),
                None => std::env::remove_var("WALLMAGIC_DATA_DIR"),
            }
            let _ = std::fs::remove_dir_all(&self.temp_dir);
        }
    }

    fn scenario_with_token(token: &str, clear_flag: bool) -> ScenarioSettings {
        ScenarioSettings {
            enabled: false,
            interval_minutes: 60,
            source: wallmagic_core::ScenarioSource {
                urls: vec![],
                local_dir: None,
            },
            order: wallmagic_core::ScenarioOrder::Sequential,
            next_index: 0,
            last_run_at: None,
            position: "fill".to_string(),
            provider: wallmagic_core::ImageProvider::default(),
            provider_order: wallmagic_core::default_provider_order(),
            prompt: String::new(),
            cloudflare: wallmagic_core::CloudflareAiConfig {
                account_id: "acc".to_string(),
                api_token: token.to_string(),
                model: wallmagic_core::default_cf_model(),
            },
            clear_api_token: clear_flag,
            openai: wallmagic_core::OpenAiConfig::default(),
            clear_api_key: false,
        }
    }

    #[test]
    fn test_get_scenario_masks_api_token() {
        let _guard = DataDirGuard::new("mask_token");
        // arrange: 토큰이 든 scenario.json 저장
        wallmagic_core::save_scenario(&scenario_with_token("secret-123", false))
            .expect("seed scenario with token");
        // act: get_scenario_impl()
        let got = get_scenario_impl().expect("get_scenario_impl");
        // assert: 조회 응답의 토큰은 항상 빈 문자열
        assert_eq!(got.cloudflare.api_token, "");
        // 디스크 원본은 그대로 보존되어야 한다
        let on_disk = wallmagic_core::load_scenario().expect("load disk scenario");
        assert_eq!(on_disk.cloudflare.api_token, "secret-123");
    }

    #[test]
    fn test_save_scenario_keeps_existing_token_when_empty() {
        let _guard = DataDirGuard::new("keep_token");
        wallmagic_core::save_scenario(&scenario_with_token("keep-me", false))
            .expect("seed scenario with token");
        // act: clear_api_token=false + api_token="" → 기존 토큰 유지
        let saved =
            save_scenario_impl(scenario_with_token("", false)).expect("save_scenario_impl");
        assert_eq!(saved.cloudflare.api_token, "");
        let on_disk = wallmagic_core::load_scenario().expect("load disk scenario");
        assert_eq!(on_disk.cloudflare.api_token, "keep-me");
        assert!(
            !on_disk.clear_api_token,
            "clear_api_token must not persist on disk"
        );
    }

    #[test]
    fn test_save_scenario_clears_token_only_when_flagged() {
        let _guard = DataDirGuard::new("clear_token");
        wallmagic_core::save_scenario(&scenario_with_token("to-delete", false))
            .expect("seed scenario with token");
        // act: clear_api_token=true → 토큰 비워짐
        let saved =
            save_scenario_impl(scenario_with_token("", true)).expect("save_scenario_impl");
        assert_eq!(saved.cloudflare.api_token, "");
        let on_disk = wallmagic_core::load_scenario().expect("load disk scenario");
        assert_eq!(on_disk.cloudflare.api_token, "");
        assert!(
            !on_disk.clear_api_token,
            "saved clear_api_token must be reset to false"
        );
    }

    #[test]
    fn test_get_scenario_masks_openai_api_key() {
        let _guard = DataDirGuard::new("mask_openai_key");
        let mut seed = scenario_with_token("secret-123", false);
        seed.prompt = "aurora".to_string();
        seed.openai = wallmagic_core::OpenAiConfig {
            api_key: "sk-test-abc".to_string(),
            model: wallmagic_core::default_openai_model(),
        };
        wallmagic_core::save_scenario(&seed).expect("seed scenario with openai key");
        let got = get_scenario_impl().expect("get_scenario_impl");
        assert_eq!(got.openai.api_key, "");
        let on_disk = wallmagic_core::load_scenario().expect("load disk scenario");
        assert_eq!(on_disk.openai.api_key, "sk-test-abc");
    }

    #[test]
    fn test_save_scenario_keeps_openai_key_when_empty() {
        let _guard = DataDirGuard::new("keep_openai_key");
        let mut seed = scenario_with_token("keep-me", false);
        seed.openai = wallmagic_core::OpenAiConfig {
            api_key: "sk-keep".to_string(),
            model: wallmagic_core::default_openai_model(),
        };
        wallmagic_core::save_scenario(&seed).expect("seed scenario with openai key");
        let mut input = scenario_with_token("", false);
        input.openai = wallmagic_core::OpenAiConfig {
            api_key: String::new(),
            model: wallmagic_core::default_openai_model(),
        };
        let saved = save_scenario_impl(input).expect("save_scenario_impl");
        assert_eq!(saved.openai.api_key, "");
        let on_disk = wallmagic_core::load_scenario().expect("load disk scenario");
        assert_eq!(on_disk.openai.api_key, "sk-keep");
        assert!(
            !on_disk.clear_api_key,
            "clear_api_key must not persist on disk"
        );
    }

    #[test]
    fn test_save_scenario_clears_openai_key_only_when_flagged() {
        let _guard = DataDirGuard::new("clear_openai_key");
        let mut seed = scenario_with_token("to-delete", false);
        seed.openai = wallmagic_core::OpenAiConfig {
            api_key: "sk-del".to_string(),
            model: wallmagic_core::default_openai_model(),
        };
        wallmagic_core::save_scenario(&seed).expect("seed scenario with openai key");
        let mut input = scenario_with_token("", false);
        input.openai = wallmagic_core::OpenAiConfig {
            api_key: String::new(),
            model: wallmagic_core::default_openai_model(),
        };
        input.clear_api_key = true;
        let saved = save_scenario_impl(input).expect("save_scenario_impl");
        assert_eq!(saved.openai.api_key, "");
        let on_disk = wallmagic_core::load_scenario().expect("load disk scenario");
        assert_eq!(on_disk.openai.api_key, "");
        assert!(
            !on_disk.clear_api_key,
            "saved clear_api_key must be reset to false"
        );
    }
}
