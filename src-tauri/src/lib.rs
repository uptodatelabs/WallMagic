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
    // 저장 경로는 반드시 `unique_output_path` 를 거친다 — 이전에는 같은 라벨로 다시
    // 생성/적용하면 같은 파일을 덮어써 앞서 만든 결과물이 사라졌다
    // (검수 지적: 파일 덮어쓰기 방지 — 고유 파일명 생성).
    let path = wallmagic_core::unique_output_path(&dir.join(format!("generated_{safe}.png")));
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

/// ② 생성의 코어 위임 함수 (Pollinations 고정).
///
/// IPC 표면(`#[tauri::command]`)에서는 제거되었다 — UI 는 공급자를 명시하는
/// `generate_library_wallpaper_with_provider` 만 호출한다. 죽은 IPC 명령을 등록해 두면
/// `verify-ipc-contract.mjs`(UI invoke 집합 ≡ Rust command 집합)가 불일치로 실패하고,
/// "어떤 공급자로 생성되는지"가 호출 경로마다 갈라진다.
/// 스모크 테스트(`test_ipc_smoke_search_generate_apply_restore`)가 이 위임 함수를 쓴다.
pub fn generate_library_wallpaper_impl(prompt: &str) -> Result<WallpaperCandidate, String> {
    wallmagic_core::generate_library_wallpaper(prompt).map_err(err_to_string)
}

/// IPC #2b (액션 ② 생성): **선택한 공급자**로 프롬프트 기반 이미지를 생성해 라이브러리에 저장한다.
///
/// 배경(결함): ② 생성이 코어의 `generate_library_wallpaper`(Pollinations 하드코딩)만 호출해,
/// 이미지 공급자를 Cloudflare/OpenAI 로 설정해도 항상 Pollinations 결과가 만들어졌다.
/// 이 커맨드는 프론트가 보낸 공급자 id(`scProvider`)로 **명시적으로 분기**하고,
/// 미지원 값은 조용한 폴스루 없이 오류로 실패시킨다.
#[tauri::command]
fn generate_library_wallpaper_with_provider(
    prompt: String,
    provider: String,
    account_id: Option<String>,
    api_token: Option<String>,
    model: Option<String>,
) -> Result<WallpaperCandidate, String> {
    generate_library_wallpaper_with_provider_impl(
        &prompt,
        &provider,
        account_id.as_deref(),
        api_token.as_deref(),
        model.as_deref(),
    )
}

pub fn generate_library_wallpaper_with_provider_impl(
    prompt: &str,
    provider: &str,
    account_id: Option<&str>,
    api_token: Option<&str>,
    model: Option<&str>,
) -> Result<WallpaperCandidate, String> {
    let trimmed_prompt = prompt.trim();
    if trimmed_prompt.is_empty() {
        return Err(
            "generate_library_wallpaper_with_provider: 프롬프트가 필요합니다".to_string(),
        );
    }
    // 같은 프롬프트로 다시 생성해도 앞선 결과물을 덮어쓰지 않는다 — 베이스 이름에
    // 타임스탬프·nonce 를 붙인 고유 경로를 쓴다(파일 덮어쓰기 방지 계약).
    let base = wallmagic_core::library_output_path(trimmed_prompt).map_err(err_to_string)?;
    let dest = wallmagic_core::unique_output_path(&base);
    // 공급자별 생성 경로를 명시적 match 로 분기한다 (미구현 공급자를 조용히 폴스루하지 않는다).
    let detail = match provider {
        "pollinations" => {
            // 수동 ② 생성도 seed 정책(`scenario.json` 의 seed_mode)을 따른다.
            // seed 없이 요청하면 Pollinations 가 같은 URL(프롬프트+파라미터)을 캐시해
            // **같은 프롬프트 = 항상 같은 이미지**가 된다(사용자 보고 결함).
            let seed = wallmagic_core::take_generation_seed();
            wallmagic_core::generate_online_wallpaper_with_seed(
                trimmed_prompt,
                Some(seed),
                &dest,
            )
            .map_err(err_to_string)?;
            format!("Pollinations image API (image.pollinations.ai · 무료·키 불필요) · prompt: {trimmed_prompt} · seed: {seed}")
        }
        "cloudflare-workers-ai" => {
            let account = account_id.map(str::trim).unwrap_or_default();
            if account.is_empty() {
                return Err(
                    "Cloudflare Workers AI: Account ID가 필요합니다 (설정에서 입력 후 저장)"
                        .to_string(),
                );
            }
            // 수동 생성 경로와 동일 규칙: 입력 토큰이 비면 디스크 scenario.json 저장 토큰으로 폴백.
            let token = match api_token.map(str::trim).filter(|t| !t.is_empty()) {
                Some(t) => t.to_string(),
                None => wallmagic_core::load_scenario()
                    .map(|s| s.cloudflare.api_token)
                    .unwrap_or_default(),
            };
            if token.trim().is_empty() {
                return Err(
                    "Cloudflare Workers AI: API Token이 없습니다 (설정에서 입력 후 저장)".to_string(),
                );
            }
            let cf_model = match model.map(str::trim).filter(|m| !m.is_empty()) {
                Some(m) => m.to_string(),
                None => wallmagic_core::default_cf_model(),
            };
            wallmagic_core::generate_cloudflare_wallpaper(
                account,
                &token,
                &cf_model,
                trimmed_prompt,
                &dest,
            )
            .map_err(err_to_string)?;
            format!("Cloudflare Workers AI · model={cf_model}")
        }
        "openai" => {
            let key = match api_token.map(str::trim).filter(|k| !k.is_empty()) {
                Some(k) => k.to_string(),
                None => wallmagic_core::load_scenario()
                    .map(|s| s.openai.api_key)
                    .unwrap_or_default(),
            };
            if key.trim().is_empty() {
                return Err("OpenAI: API Key가 없습니다 (설정에서 입력 후 저장)".to_string());
            }
            let oa_model = match model.map(str::trim).filter(|m| !m.is_empty()) {
                Some(m) => m.to_string(),
                None => wallmagic_core::default_openai_model(),
            };
            wallmagic_core::generate_openai_wallpaper(&key, &oa_model, trimmed_prompt, &dest)
                .map_err(err_to_string)?;
            format!("OpenAI Images API · model={oa_model}")
        }
        // 검색(Search): 프롬프트를 **키워드**로 사용해 공개 이미지 1건을 검색·확정한다.
        // 생성 API 대신 실제 검색 결과를 쓰는 공급자라, 키가 없어도 동작한다.
        "search" => {
            wallmagic_core::generate_search_wallpaper(trimmed_prompt, &dest)
                .map_err(err_to_string)?;
            format!("Wikimedia Commons image search (키워드 검색) · query: {trimmed_prompt}")
        }
        // Puter 는 브라우저 SDK 전용이라 이 커맨드로 생성할 수 없다 — 프론트가 만든 이미지는
        // `save_generated_image` 로 저장한다. 조용히 다른 공급자로 대체하지 않는다.
        "puter" => {
            return Err(
                "Puter는 WebView 전용 SDK 경로입니다 — 프론트가 생성한 이미지는 save_generated_image 로 저장하세요"
                    .to_string(),
            )
        }
        other => {
            return Err(format!(
                "unknown provider '{other}' (expected: pollinations|cloudflare-workers-ai|openai|search|puter)"
            ))
        }
    };
    // 생성 파일 자체에 귀속을 남긴다 — ② 생성은 배경을 적용하지 않으므로 state.json 이
    // 갱신되지 않는다. 사이드카가 없으면 미리보기가 "현재 배경" 기록과 오귀속된다.
    wallmagic_core::write_generation_sidecar(&dest, Some(provider), Some(&detail))
        .map_err(err_to_string)?;
    wallmagic_core::load_candidate(&dest).ok_or_else(|| {
        format!(
            "generate_library_wallpaper_with_provider: 후보 생성 실패 — {}",
            dest.display()
        )
    })
}

/// IPC #2c (액션 ② 생성): WebView(Puter.js SDK)가 만든 base64 이미지를 **라이브러리**에 저장하고
/// 썸네일 후보로 반환한다.
///
/// `apply_generated_image` 는 배경까지 적용하는 커맨드이므로, ② 생성(후보만 추가)에는
/// 이 커맨드를 쓴다. 저장 파일 옆에 사이드카를 남겨 미리보기가 자기 생성 경로를 표시한다.
#[tauri::command]
fn save_generated_image(
    image_base64: String,
    label: Option<String>,
    model: Option<String>,
) -> Result<WallpaperCandidate, String> {
    save_generated_image_impl(&image_base64, label.as_deref(), model.as_deref())
}

pub fn save_generated_image_impl(
    image_base64: &str,
    label: Option<&str>,
    model: Option<&str>,
) -> Result<WallpaperCandidate, String> {
    let bytes = decode_image_payload(image_base64)?;
    let library = wallmagic_core::app_data_dir().join("library");
    std::fs::create_dir_all(&library).map_err(|e| format!("create library failed: {e}"))?;
    // 무라벨 호출을 'puter' 로 둔갑시키지 않는다 — `apply_generated_image` 와 같은 계약.
    // 기본값이 있으면 프론트가 label 을 빠뜨려도 provider 가 조용히 "puter" 로 기록되어
    // "다른 공급자로 생성했는데 Puter 로 표시"되는 오귀속이 재발한다.
    let label = label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "save_generated_image: label(공급자 id)이 필요합니다".to_string())?;
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(24)
        .collect();
    // 접두어는 라벨에서 파생한다(파일 경로만 보고 공급자를 오판하지 않도록).
    // 해시는 "어떤 이미지인지"를 이름에 남기는 용도로만 쓰고, 저장 경로는 반드시
    // `unique_output_path` 를 거쳐 timestamp·nonce 가 붙은 **고유 경로**를 쓴다.
    // 이전에는 같은 이미지 = 같은 파일명이라 재생성 시 앞서 만든 결과물을 덮어썼다
    // (검수 지적: 파일 덮어쓰기 방지 — 고유 파일명 생성).
    let mut hash: u32 = 2166136261;
    for b in &bytes {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    let path =
        wallmagic_core::unique_output_path(&library.join(format!("generated_{safe}_{hash:08x}.png")));
    std::fs::write(&path, &bytes).map_err(|e| format!("write generated image failed: {e}"))?;
    // 상세 문구도 라벨에 종속시킨다 (puter 가 아닌 라벨에 "Puter.js txt2img" 기록 금지).
    let detail = match (label == "puter", model.map(str::trim).filter(|m| !m.is_empty())) {
        (true, Some(m)) => format!("Puter.js txt2img (WebView 브라우저 SDK) · model={m}"),
        (true, None) => "Puter.js txt2img (WebView 브라우저 SDK) · Puter 기본 모델".to_string(),
        (false, Some(m)) => format!("save_generated_image (WebView) · provider={label} · model={m}"),
        (false, None) => format!("save_generated_image (WebView) · provider={label}"),
    };
    wallmagic_core::write_generation_sidecar(&path, Some(label), Some(&detail))
        .map_err(err_to_string)?;
    wallmagic_core::load_candidate(&path).ok_or_else(|| {
        format!(
            "save_generated_image: 후보 생성 실패 — {}",
            path.display()
        )
    })
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
    // 생성 산출물은 절대 덮어쓰지 않는다 — 수동 Cloudflare 생성도 앞서 만든 결과물을 보존한다.
    // (이전에는 cf_manual.jpg 고정 이름이라 두 번째 생성이 첫 결과물을 파괴했다.)
    let dest = wallmagic_core::unique_output_path(
        &wallmagic_core::app_data_dir()
            .join("online_cache")
            .join("cf_manual.jpg"),
    );
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
    // 생성 산출물은 절대 덮어쓰지 않는다 — 수동 OpenAI 생성도 기존 결과물을 보존한다.
    let dest = wallmagic_core::unique_output_path(
        &wallmagic_core::app_data_dir()
            .join("online_cache")
            .join("openai_manual.jpg"),
    );
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
    // IPC 로 받은 시도 순서는 **이번 생성 시도용 복제본에만** 적용한다.
    // 원본 `settings.provider_order` 를 덮어쓰면 아래 `save_scenario(&settings)` 가
    // 그 값을 디스크에 영구 저장해 사용자의 시나리오 자동 생성 순서가 손상된다
    // (검수 지적 [high]: ② 생성·적용 검색이 provider_order 를 ["search"] 로 오염).
    // effective_provider_order 가 빈 배열·중복을 정규화하므로 미저장 상태에서도
    // 화면 순서 = 실제 시도 순서는 그대로 유지된다.
    let mut gen = settings.clone();
    if let Some(order) = provider_order {
        gen.provider_order = order;
    }
    // 생성 산출물은 절대 덮어쓰지 않는다 — 우선순위 폴백 생성도 기존 결과물을 보존한다.
    let dest = wallmagic_core::unique_output_path(
        &wallmagic_core::app_data_dir()
            .join("online_cache")
            .join("priority_manual.jpg"),
    );
    // 3-튜플 판(`_query`)을 쓴다 — 폴백에서 **실제로 성공한 공급자**와 **실제로 사용된
    // 질의문**을 함께 받아 기록한다. 2-튜플 판 + `search_query_for` 재호출은
    // 순차(next_index)/랜덤(seed) 순환에서 다른 검색어를 만들어 UI 표기와 어긋난다
    // (검수 지적 [medium]: ② 검색 경로의 검색어 표기 불일치).
    let (used, path, used_query) =
        wallmagic_core::generate_ai_with_fallback_query(&gen, prompt, &dest)
            .map_err(err_to_string)?;
    // 생성 정보 기록: 우선순위 폴백에서 **실제로 성공한 공급자**를 state.json 에 남긴다.
    // `_used` 를 버리면 사용자는 어떤 경로로 생성됐는지 알 수 없다 (요구 ① 위반).
    let mut detail = wallmagic_core::generation_source_detail(&settings, used);
    if used == wallmagic_core::ImageProvider::Search {
        detail = format!("{detail} · query: {used_query}");
        let query_count = wallmagic_core::valid_search_queries(&settings).len();
        if query_count > 0 {
            settings.next_index = settings.next_index.wrapping_add(1) % query_count;
            let _ = wallmagic_core::save_scenario(&settings);
        }
    }
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

/// 적용(IPC #3) 직전 **후보 파일의 사이드카에서 생성 정보를 복원**하는 배선 지점.
///
/// `set_wallpaper` 는 `set_wallpaper_with(.., None, None)` 로 위임하므로, 이 복원을 거치지
/// 않고 적용하면 `record_generation(None, None)` 이 `state.json` 의 provider/source 를
/// **지운다**. 그러면 생성한 이미지를 적용할 때마다 "미기록"으로 보여 사용자가 "또 다른
/// 이미지가 생성된 것 같다"고 느낀다(검수 지적: 정의만 있고 호출부가 없던 미완성 계약).
///
/// 사이드카가 없는 사용자 로컬 이미지는 `(None, None)` — 임의 라벨을 붙이지 않는다.
fn generation_info_for_apply_arg(path: &str) -> (Option<String>, Option<String>) {
    wallmagic_core::generation_info_for_apply(&PathBuf::from(path))
}

/// 사용자 Pictures 폴더(존재하는 경우에만).
fn user_pictures_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let pictures = home.join("Pictures");
    pictures.is_dir().then_some(pictures)
}

/// 삭제 가능한 루트 목록 — 앱 데이터 디렉터리(`library`·`online_cache` 등)와 사용자 Pictures.
///
/// 이 앱이 스스로 만들어 보여주는 이미지 파일만 지울 수 있게 하는 최소 방어선이다.
/// 임의 경로를 그대로 받는 삭제 IPC 는 위험하므로, 허용 루트 밖 경로는
/// `delete_within_roots` 가 **명시적 오류**로 거부한다(조용히 무시하지 않는다).
fn allowed_delete_roots() -> Vec<PathBuf> {
    let mut roots = vec![wallmagic_core::app_data_dir()];
    if let Some(pictures) = user_pictures_dir() {
        roots.push(pictures);
    }
    roots
}

/// 두 경로가 같은 파일인지 — 심볼릭/표기 차이를 흡수하기 위해 canonicalize 후 비교한다.
fn same_file_path(a: &str, b: &str) -> bool {
    let normalize = |p: &str| {
        PathBuf::from(p)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(p))
            .to_string_lossy()
            .to_lowercase()
    };
    normalize(a) == normalize(b)
}

/// 허용 루트 안의 파일만 삭제하고, 생성 정보 사이드카(`.geninfo.json`)도 함께 정리한다.
///
/// 사이드카를 남기면 같은 이름의 파일을 다시 만들었을 때 **이전 공급자 정보**가
/// 그대로 붙어 "미리보기 파일의 생성 정보"가 실제와 어긋난다.
fn delete_within_roots(target: &PathBuf, roots: &[PathBuf]) -> Result<(), String> {
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("delete_image_file: 경로를 확인할 수 없습니다 — {e}"))?;
    let allowed = roots.iter().any(|root| match root.canonicalize() {
        Ok(root_canon) => canonical.starts_with(&root_canon),
        Err(_) => false,
    });
    if !allowed {
        return Err(format!(
            "delete_image_file: 라이브러리 외 경로는 삭제할 수 없습니다 — {}",
            canonical.display()
        ));
    }
    std::fs::remove_file(&canonical).map_err(|e| format!("delete_image_file: 삭제 실패 — {e}"))?;
    let sidecar = wallmagic_core::generation_sidecar_path(&canonical);
    if sidecar.exists() {
        let _ = std::fs::remove_file(&sidecar);
    }
    Ok(())
}

/// IPC #3c: 검색/생성 이미지 파일 삭제 (라이브러리·Pictures 안의 파일만).
fn delete_image_file_impl(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("delete_image_file: path 가 필요합니다".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(format!("delete_image_file: 파일이 없습니다 — {trimmed}"));
    }
    // 현재 바탕화면으로 적용된 파일을 지우면 배경이 존재하지 않는 경로를 가리키게 된다.
    if let Ok(current) = wallmagic_core::get_current_wallpaper(None) {
        if !current.trim().is_empty() && same_file_path(&current, trimmed) {
            return Err(
                "delete_image_file: 현재 바탕화면으로 적용 중인 파일은 삭제할 수 없습니다 — \
                 먼저 다른 배경을 적용하거나 '이전 배경으로 복원' 후 다시 시도하세요."
                    .to_string(),
            );
        }
    }
    delete_within_roots(&target, &allowed_delete_roots())
}

#[tauri::command]
fn delete_image_file(path: String) -> Result<(), String> {
    delete_image_file_impl(&path)
}

/// 삭제 로직 단위 테스트 — 파일 삭제·사이드카 정리·허용 루트 밖 거부.
///
/// 실제 사용자 데이터(`%LOCALAPPDATA%`·Pictures)를 건드리지 않도록 **임시 디렉터리를
/// 허용 루트로 주입**한다 (`delete_within_roots(target, &roots)` 의 roots 인자).
/// `app_data_dir()` 를 통한 전역 오버라이드(WALLMAGIC_DATA_DIR)는 다른 테스트와
/// 경합하므로 이 테스트에서는 쓰지 않는다.
#[cfg(test)]
mod delete_tests {
    use super::*;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wallmagic-delete-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("임시 루트 생성");
        dir
    }

    #[test]
    fn test_delete_within_roots_removes_file_and_sidecar() {
        let root = temp_root("ok");
        let image = root.join("generated_test.jpg");
        fs::write(&image, b"stub").expect("이미지 생성");
        let sidecar = wallmagic_core::generation_sidecar_path(&image);
        fs::write(&sidecar, br#"{"provider":"pollinations"}"#).expect("사이드카 생성");

        delete_within_roots(&image, std::slice::from_ref(&root)).expect("허용 루트 안 파일 삭제");

        assert!(!image.exists(), "이미지 파일이 삭제되어야 한다");
        assert!(
            !sidecar.exists(),
            "생성 정보 사이드카(.geninfo.json)도 함께 삭제되어야 한다"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_delete_within_roots_rejects_outside_path() {
        let root = temp_root("root");
        let outside = temp_root("outside");
        let image = outside.join("victim.jpg");
        fs::write(&image, b"stub").expect("대상 파일 생성");

        let err = delete_within_roots(&image, std::slice::from_ref(&root))
            .expect_err("허용 루트 밖 경로는 거부되어야 한다");
        assert!(
            err.contains("삭제할 수 없습니다"),
            "거부 사유가 설명되어야 한다 — {err}"
        );
        assert!(image.exists(), "거부된 경우 파일은 남아 있어야 한다");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}

/// IPC #3 (액션 ③ 적용): 선택한 이미지를 검증·스테이징 후 바탕화면에 적용한다.
#[tauri::command]
fn apply_wallpaper(
    path: String,
    monitor_id: Option<String>,
    position: Option<String>,
) -> Result<WallpaperState, String> {
    let pos = parse_position_arg(position.as_deref())?;
    let candidate = PathBuf::from(&path);
    // 후보 파일이 스스로 가진 생성 정보(사이드카)를 적용까지 이어받는다.
    let (provider, source) = generation_info_for_apply_arg(&path);
    wallmagic_core::set_wallpaper_with(
        &candidate,
        monitor_id.as_deref(),
        pos,
        provider.as_deref(),
        source.as_deref(),
    )
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
    // seed 카운터(`seed_next`)는 **백엔드 소유**다 — 생성이 성공할 때마다 코어가 전진시켜
    // 디스크에 저장한다(`advance_seed`/`take_generation_seed`). UI 는 화면 표시용으로 값을
    // 들고 있을 뿐인데, 저장 요청에 그 **낡은 값**을 실어 보내면 그 사이 진행된 전진이
    // 되돌아간다. 그러면 `Incremental` 모드가 같은 seed 를 재사용해 "같은 프롬프트 =
    // 같은 이미지" 결함이 재발한다(사용자 보고: seed 가 random 인데도 같은 이미지).
    // 그래서 IPC 로 들어온 `seed_next` 는 무시하고 디스크 값을 유지한다.
    // (`seed_mode`/`seed_fixed` 는 사용자 의도이므로 그대로 저장한다.)
    if let Ok(existing) = wallmagic_core::load_scenario() {
        settings.seed_next = existing.seed_next;
    }
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
            generate_library_wallpaper_with_provider,
            save_generated_image,
            apply_generated_image,
            delete_image_file,
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

    /// 회귀 테스트 (요구: "설정된 공급자로 정확하게 생성"):
    /// ② 생성은 `generate_library_wallpaper_with_provider` 로 선택 공급자를 명시 전달한다.
    /// 미지원·미구현 공급자를 조용히 Pollinations 로 대체하면 "Puter/Cloudflare 로
    /// 설정했는데 Pollinations 결과가 나온다"는 신고 증상이 재발한다.
    /// 네트워크 호출 **전** 단계에서 명시적 오류를 반환하는지 확인한다(오프라인 결정적).
    #[test]
    fn test_generate_library_with_provider_routes_or_fails_explicitly() {
        let _guard = DataDirGuard::new("provider_routing");

        // (1) 미지원 공급자 → 오류 문구에 공급자 이름이 그대로 나와야 한다.
        let err = generate_library_wallpaper_with_provider_impl(
            "neon harbor",
            "midjourney",
            None,
            None,
            None,
        )
        .expect_err("unknown provider must fail");
        assert!(
            err.contains("unknown provider 'midjourney'"),
            "unknown provider must be named in the error: {err}"
        );

        // (2) puter 는 백엔드 생성 경로가 없다 → 프론트 저장 커맨드를 안내하는 명시적 오류.
        //     (Pollinations 결과로 조용히 대체되지 않아야 한다)
        let err =
            generate_library_wallpaper_with_provider_impl("neon harbor", "puter", None, None, None)
                .expect_err("puter must not be generated by the backend");
        assert!(
            err.contains("save_generated_image"),
            "puter error must point to the front-end save command: {err}"
        );
        assert!(
            !err.contains("pollinations"),
            "puter 호출이 Pollinations 로 폴스루되면 안 된다: {err}"
        );

        // (3) 빈 프롬프트 → 오류 (빈 프롬프트로 생성 API 를 호출하지 않는다)
        assert!(generate_library_wallpaper_with_provider_impl(
            "   ",
            "pollinations",
            None,
            None,
            None
        )
        .is_err());

        // (4) Cloudflare: Account ID 가 비면 네트워크 호출 전에 실패해야 한다.
        let err = generate_library_wallpaper_with_provider_impl(
            "neon harbor",
            "cloudflare-workers-ai",
            Some("   "),
            Some("token"),
            None,
        )
        .expect_err("cloudflare without account id must fail");
        assert!(
            err.contains("Account ID"),
            "error must name the missing field: {err}"
        );

        // (5) OpenAI: 입력·저장 키가 모두 비면 명시적 오류 (조용한 폴스루 금지).
        let _ = wallmagic_core::save_scenario(&wallmagic_core::ScenarioSettings::default());
        let err = generate_library_wallpaper_with_provider_impl(
            "neon harbor",
            "openai",
            None,
            None,
            None,
        )
        .expect_err("openai without api key must fail");
        assert!(
            err.contains("API Key"),
            "error must name the missing field: {err}"
        );
    }

    /// 회귀 가드 (검수 지적 [high]: 공급자별 자격증명 교차 전달).
    /// 수정 전 `handleGenerate` 는 OpenAI 선택 시에도 `apiToken` 에 Cloudflare 토큰을
    /// 넘겼고, 백엔드 openai 분기는 그 값을 API 키로 썼다. 그래서 (1) OpenAI 키를
    /// 입력해도 전달되지 않고 (2) 남아 있던 Cloudflare 토큰으로 인증을 시도했다.
    /// 프론트는 `credential` 분기로 고쳤고, 백엔드는 **디스크 폴백에서도 교차 사용하지
    /// 않는다**는 계약을 여기서 고정한다: cloudflare.api_token 만 저장된 상태에서
    /// openai 요청은 네트워크 호출 전에 키 부재 오류로 끝나야 한다.
    #[test]
    fn test_provider_credentials_are_not_cross_used() {
        let _guard = DataDirGuard::new("credential_isolation");
        let mut seed = scenario_with_token("cf-only-token", false);
        seed.openai = wallmagic_core::OpenAiConfig {
            api_key: String::new(),
            model: wallmagic_core::default_openai_model(),
        };
        wallmagic_core::save_scenario(&seed).expect("seed scenario with cloudflare token only");

        let err =
            generate_library_wallpaper_with_provider_impl("neon harbor", "openai", None, None, None)
                .expect_err("openai must not fall back to the cloudflare token");
        assert!(
            err.contains("API Key"),
            "openai 는 cloudflare.api_token 을 키로 쓰면 안 된다: {err}"
        );
        assert!(
            !err.contains("cf-only-token"),
            "오류 문구에 Cloudflare 토큰이 노출되면 안 된다: {err}"
        );
    }

    /// ② 생성의 Puter 경로는 프론트가 만든 base64 이미지를 `save_generated_image` 로
    /// 라이브러리에 저장한다. 이 커맨드도 무라벨을 'puter' 로 둔갑시키면 다른 공급자
    /// 결과가 Puter 로 오표시되고, 파일명 접두어까지 puter_ 로 고정되어 경로만 보고도
    /// 공급자를 오판하게 된다. label 필수 계약과 라벨 파생 파일명을 함께 검증한다.
    #[test]
    fn test_save_generated_image_requires_label_and_derives_file_name() {
        let _guard = DataDirGuard::new("save_requires_label");
        // 1x1 PNG — label 검사는 디코딩 직후, 후보 변환(640x480) 전에 수행된다.
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

        let err = save_generated_image_impl(png, None, None)
            .expect_err("label 없이 호출하면 오류여야 한다");
        assert!(
            err.contains("label"),
            "label 누락은 label 오류로 보고돼야 한다(무라벨→puter 둔갑 금지): {err}"
        );

        let err_blank = save_generated_image_impl(png, Some("   "), None)
            .expect_err("공백 label 도 오류여야 한다");
        assert!(
            err_blank.contains("label"),
            "공백 label 은 label 오류로 보고돼야 한다: {err_blank}"
        );

        // 대조군: 정상 label 은 label 검사에 걸리지 않는다 (1x1 이라 후보 변환에서 실패).
        let err = save_generated_image_impl(png, Some("pollinations"), Some("flux"))
            .expect_err("1x1 이미지는 후보 변환(640x480)에서 실패해야 한다");
        assert!(
            !err.contains("label(공급자 id)이 필요합니다"),
            "정상 label 이 label 검사에서 막히면 안 된다: {err}"
        );

        // 파일명 접두어가 라벨에서 파생됐는지 실제 라이브러리 디렉터리로 확인한다.
        let library = wallmagic_core::app_data_dir().join("library");
        let names: Vec<String> = std::fs::read_dir(&library)
            .expect("library dir must exist")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names.iter().any(|n| n.starts_with("generated_pollinations_")),
            "저장 파일명 접두어는 라벨에서 파생되어야 한다(puter_ 고정 금지): {names:?}"
        );
    }

    /// 회귀 테스트 (파일 덮어쓰기 방지 — 완료 기준 ①).
    ///
    /// 같은 이미지 바이트를 두 번 저장해도 앞서 만든 결과물을 **덮어쓰지 않고** 서로 다른
    /// 파일명으로 남아야 한다. 호출부(`save_generated_image_impl`) 수준에서
    /// `unique_output_path` 가 실제로 쓰이는지를 고정한다 — 코어 단위 테스트만으로는
    /// "고유화 함수는 맞지만 저장 지점이 그 함수를 안 쓴다"를 잡을 수 없다.
    #[test]
    fn test_save_generated_image_never_overwrites_previous_output() {
        let _guard = DataDirGuard::new("save_noclobber");
        let fixture_dir = wallmagic_core::app_data_dir().join("fixture");
        std::fs::create_dir_all(&fixture_dir).expect("create fixture dir");
        // 두 번째 인자는 **파일 경로**다 — 디렉터리를 넘기면 확장자가 없어
        // image 크레이트의 포맷 추론이 실패한다(ImageDecode(Unsupported(Unknown))).
        let sample = wallmagic_core::generate_sample_wallpaper(
            "unique name fixture",
            &fixture_dir.join("fixture.png"),
        )
        .expect("generate fixture image");
        let bytes = std::fs::read(&sample).expect("read fixture bytes");

        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let first = save_generated_image_impl(&payload, Some("pollinations"), Some("flux"))
            .expect("first save must succeed");
        let second = save_generated_image_impl(&payload, Some("pollinations"), Some("flux"))
            .expect("second save must succeed");

        assert_ne!(
            first.path, second.path,
            "같은 이미지를 재저장하면 반드시 다른 파일명이어야 한다(덮어쓰기 금지)"
        );
        assert!(
            Path::new(&first.path).exists(),
            "첫 결과물이 두 번째 저장으로 사라지면 안 된다: {}",
            first.path
        );
        assert!(
            Path::new(&second.path).exists(),
            "두 번째 결과물이 남아야 한다: {}",
            second.path
        );
        // 입력 바이트가 같으므로 내용은 동일하되, 파일은 별개다.
        assert_eq!(
            std::fs::read(&first.path).unwrap(),
            std::fs::read(&second.path).unwrap(),
            "동일 입력이므로 바이트는 같아야 한다"
        );
        assert_ne!(
            first.file_name, second.file_name,
            "후보 메타데이터의 파일명도 서로 달라야 한다"
        );
    }

    /// 검수 지적(high) 회귀 방지 — ④ 적용(IPC #3)은 후보 파일의 **사이드카에서 생성 정보를
    /// 복원해** `set_wallpaper_with` 로 넘겨야 한다.
    ///
    /// 수정 전 `apply_wallpaper` 는 `set_wallpaper(...)` 만 호출했고, `set_wallpaper` 는
    /// `set_wallpaper_with(.., None, None)` 로 위임하므로 `record_generation(None, None)` 이
    /// `state.json` 의 provider/source 를 지웠다. 그 결과 생성한 이미지를 적용할 때마다
    /// "미기록"으로 보여 사용자가 "또 다른 이미지가 생성된 것 같다"고 느꼈다.
    /// `generation_info_for_apply` 가 정의·재export 만 되고 호출부가 없던 미완성 계약을
    /// 이 테스트로 고정한다.
    #[test]
    fn test_apply_wallpaper_inherits_sidecar_generation_info() {
        let _guard = DataDirGuard::new("apply_sidecar");
        let dir = wallmagic_core::app_data_dir().join("library");
        std::fs::create_dir_all(&dir).expect("create library dir");

        // (1) 사이드카가 있는 생성 파일 — 라벨이 그대로 복원돼야 한다.
        let generated = dir.join("generated_pollinations_sidecar_test.jpg");
        std::fs::write(&generated, b"not-a-real-image").expect("write fake generated image");
        wallmagic_core::write_generation_sidecar(
            &generated,
            Some("pollinations"),
            Some("Pollinations · flux"),
        )
        .expect("write generation sidecar");

        let (provider, source) = generation_info_for_apply_arg(&generated.to_string_lossy());
        assert_eq!(
            provider.as_deref(),
            Some("pollinations"),
            "적용 경로는 사이드카의 provider 를 이어받아야 한다(무라벨 적용 금지)"
        );
        assert_eq!(
            source.as_deref(),
            Some("Pollinations · flux"),
            "적용 경로는 사이드카의 source(모델 표기)도 이어받아야 한다"
        );

        // (2) 사이드카가 없는 사용자 로컬 이미지 — 임의 라벨을 붙이지 않는다.
        let local = dir.join("user_local_photo.jpg");
        std::fs::write(&local, b"not-a-real-image").expect("write fake local image");
        let (local_provider, local_source) = generation_info_for_apply_arg(&local.to_string_lossy());
        assert_eq!(local_provider, None, "로컬 이미지에 임의 provider 금지");
        assert_eq!(local_source, None, "로컬 이미지에 임의 source 금지");
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
                search_queries: vec![],
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
            disabled_providers: Vec::new(),
            // seed 정책 기본값 — `ScenarioSettings::default()` 와 동일하게 Random.
            // (구조체 리터럴이라 필드 누락 시 컴파일 오류가 나므로 여기서도 명시한다)
            seed_mode: wallmagic_core::SeedMode::Random,
            seed_fixed: 0,
            seed_next: 0,
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

    /// 검색(Search) 자격은 **검색 창에서 입력한 검색어(`source.search_queries`) 단독**으로 판정한다.
    ///
    /// 프롬프트(`settings.prompt`)와 호출 인자 `prompt` 는 검색 자격·검색어 어디에도 관여하지
    /// 않는다 — 검색어와 프롬프트는 서로 무관한 별개 입력이다(프롬프트→검색어 폴백 제거).
    #[test]
    fn test_priority_search_requires_search_queries_not_prompt() {
        let _guard = DataDirGuard::new("priority_search_default");
        // 디스크 scenario.json 의 prompt·search_queries 가 모두 빈 기본 상태.
        let default_sc = wallmagic_core::ScenarioSettings::default();
        assert!(default_sc.prompt.is_empty());
        assert!(default_sc.source.search_queries.is_empty());
        wallmagic_core::save_scenario(&default_sc).expect("save default scenario");

        let mut loaded = wallmagic_core::load_scenario().expect("load default scenario");
        // 기본 provider_order 는 [Pollinations, Cloudflare, OpenAI] 라 Search 가 후보에 없다.
        // 실제 검색 경로도 `providerOrder: ["search"]` 로 후보를 명시 전달하므로
        // (handleGenerate·handleGenerateAi 의 search 분기) 테스트도 같은 계약을 따른다.
        assert!(!wallmagic_core::default_provider_order()
            .contains(&wallmagic_core::ImageProvider::Search));
        loaded.provider_order = vec![wallmagic_core::ImageProvider::Search];
        let dest = wallmagic_core::app_data_dir().join("online_cache").join("test.jpg");

        // ① 검색어가 없으면 프롬프트가 있어도 Search 는 시도되지 않는다.
        let err = wallmagic_core::scenario::generate_ai_with_fallback_with(
            &loaded,
            "manual keyword",
            &dest,
            |_, _, d| Ok(d.clone()),
        )
        .expect_err("프롬프트만으로는 검색 자격이 생기지 않아야 한다");
        assert!(matches!(err, wallmagic_core::WallpaperError::CandidateLoad(_)));

        // ② 검색 창에 검색어를 넣으면 프롬프트와 무관하게 그 검색어로 시도된다.
        loaded.source.search_queries = vec!["aurora".to_string()];
        let (used, _) = wallmagic_core::scenario::generate_ai_with_fallback_with(
            &loaded,
            "manual keyword",
            &dest,
            |provider, query, d| {
                assert_eq!(provider, wallmagic_core::ImageProvider::Search);
                assert_eq!(
                    query, "aurora",
                    "검색어는 프롬프트가 아니라 source.search_queries 에서 와야 한다"
                );
                Ok(d.clone())
            },
        )
        .expect("검색어가 있으면 Search 가 시도되어야 한다");
        assert_eq!(used, wallmagic_core::ImageProvider::Search);
    }
}
