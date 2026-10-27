//! 로컬 배경화면 라이브러리 검색·생성 (GUI "검색" / "생성" 액션의 코어 로직)
//!
//! `wallpaper` 모듈이 이미지 검증·스테이징·적용·복원을 담당한다면, 이 모듈은 그 앞단의
//! "후보 탐색"(사용자 폴더에서 키워드로 이미지 검색)과 "프롬프트 기반 생성"을 담당한다.
//! UI는 반환된 `SearchResult`(썸네일 포함 후보 목록)를 그대로 렌더링하고, 선택된 후보의
//! `path`를 `wallpaper::set_wallpaper`에 넘긴다.
//!
//! 성능 불변식: 후보마다 원본을 디코딩해 썸네일을 만드는 비용이 검색의 지배 비용이므로
//! **디코딩은 `MAX_RESULTS`개로 제한**한다. 폴더 탐색은 저비용(디렉터리 순회 + 파일명
//! 필터)만 수행해 `total_matched`(매칭 전체 수)를 정확히 센다 — Pictures에 이미지가
//! 수천 장이어도 IPC 페이로드와 디코딩 시간은 상한으로 묶인다.

use crate::wallpaper::{
    generate_online_wallpaper, read_generation_sidecar, write_generation_sidecar, WallpaperError,
};
use std::time::Duration;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// GUI 결과 카드 1장에 대응하는 후보 이미지 메타데이터 + 축소 썸네일.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WallpaperCandidate {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub thumb_base64: String,
    /// 이 파일 자체의 생성 정보(사이드카 `.geninfo.json`) — "현재 배경"(state.json)과 분리된 귀속.
    #[serde(default)]
    pub gen_provider: Option<String>,
    #[serde(default)]
    pub gen_source: Option<String>,
}

/// 검색 결과 묶음: 후보 목록 + 잘림(truncation) 정보.
///
/// - `total_matched`: 필터(확장자 + 키워드)에 매칭된 **전체 파일 수** (디코딩 전 저비용 카운트).
/// - `candidates`: 그중 파일명 오름차순 상위 `MAX_RESULTS`개만 디코딩해 썸네일을 만든 목록.
/// - `truncated`: `total_matched > MAX_RESULTS` — UI가 "N건 중 200건 표시"를 노출하기 위한 플래그.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub candidates: Vec<WallpaperCandidate>,
    pub total_matched: usize,
    pub truncated: bool,
}

/// 디코딩 가능한 이미지 확장자 화이트리스트 (PNG·JPEG·BMP — `image` 크레이트 활성 feature와 일치).
pub const SUPPORTED_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "bmp"];

/// 검색 결과 상한. 이 개수만큼만 원본 디코딩 + 썸네일 생성을 수행한다 (IPC 페이로드 보호).
pub const MAX_RESULTS: usize = 200;

/// 검색 시 탐색하는 최대 디렉터리 깊이 (무한 재귀 방지).
const MAX_SEARCH_DEPTH: u32 = 3;

/// 썸네일 최대 한 변 (px). JPEG로 인코딩해 base64로 전달한다.
const THUMBNAIL_MAX_DIM: u32 = 320;

/// 기본 검색 루트: 앱 라이브러리(`app_data_dir()/library`) + 사용자 Pictures 폴더(존재 시).
pub fn default_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let library = crate::wallpaper::app_data_dir().join("library");
    if library.is_dir() {
        roots.push(library);
    }
    if let Some(pictures) = pictures_dir() {
        if pictures.is_dir() {
            roots.push(pictures);
        }
    }
    roots
}

/// `%USERPROFILE%\Pictures` (Windows). 환경변수 `USERPROFILE` 우선, 없으면 홈 디렉터리 기반 추정.
pub fn pictures_dir() -> Option<PathBuf> {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.trim().is_empty() {
            return Some(PathBuf::from(profile).join("Pictures"));
        }
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Pictures"))
        .filter(|p| p.is_dir())
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS.iter().any(|allowed| *allowed == lower)
        })
        .unwrap_or(false)
}

/// 파일을 열어 유효한 후보(디코딩 가능 + 640x480 이상)로 변환하고 썸네일을 생성한다.
/// 유효하지 않으면 `None`을 반환한다 — 검색 결과에는 "적용 가능한 후보"만 노출한다.
/// 전체화면 뷰어용 미리보기의 최대 변 (px).
///
/// 카드 썸네일은 `THUMBNAIL_MAX_DIM`(320px)이라 전체화면에 그대로 쓰면 원본이 4K 여도
/// 320px 로만 그려져 "전체화면에서 그림이 작다"가 된다. 반대로 원본 픽셀을 그대로
/// base64 JPEG 로 IPC 에 넘기면 수 MB 가 되어 전송·디코딩이 무거워진다.
/// 그 사이의 절충값: 2560px 이면 1440p·2K 모니터의 전체화면을 채우고도 페이로드가
/// 수백 KB 대에 머문다(원본이 그보다 작으면 **축소하지 않는다**).
pub const PREVIEW_MAX_DIM: u32 = 2560;

/// 전체화면 뷰어용 미리보기(base64 JPEG)를 만든다 — 카드 썸네일과 달리 **원본 해상도**를 쓴다.
///
/// `load_candidate` 가 `Option`(읽기 실패를 조용히 후보 제외)인 것과 달리, 이 함수는
/// 사용자가 명시적으로 연 뷰어 경로이므로 실패를 `WallpaperError` 로 **명시적으로** 돌려준다
/// (뷰어가 흰 화면으로 남는 대신 사유를 표시할 수 있게 하기 위함).
pub fn load_preview_base64(path: &Path) -> Result<String, WallpaperError> {
    if !path.is_file() {
        return Err(WallpaperError::FileNotFound(path.display().to_string()));
    }
    let img = image::open(path)?;
    let img = if img.width().max(img.height()) > PREVIEW_MAX_DIM {
        img.resize(
            PREVIEW_MAX_DIM,
            PREVIEW_MAX_DIM,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };
    // 알파 채널이 있는 PNG를 JPEG로 인코딩하면 실패하므로 RGB로 고정한다
    // (`load_candidate` 의 썸네일 생성과 같은 이유·같은 방식).
    let mut buf: Vec<u8> = Vec::new();
    img.to_rgb8()
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)?;
    Ok(BASE64.encode(&buf))
}

pub fn load_candidate(path: &Path) -> Option<WallpaperCandidate> {
    // 파일 자체의 생성 정보(사이드카)를 먼저 읽는다 — "현재 배경" state.json 과 무관한 귀속.
    // 사이드카가 없으면(미기록) None 이므로 후보의 gen_* 는 null 로 표시된다.
    let gen = read_generation_sidecar(path);
    let img = image::open(path).ok()?;
    let (width, height) = (img.width(), img.height());
    if width < 640 || height < 480 {
        return None;
    }

    // `DynamicImage::thumbnail`은 in-place가 아니라 축소된 새 이미지를 반환하므로
    // 반환값을 바인딩해 사용한다 (반환값 무시 시 1920x1080 원본이 그대로 인코딩됨).
    // `.to_rgb8()`로 색 형식을 RGB로 고정한다 — 알파 채널이 있는 PNG는 Rgba8 상태로
    // JPEG 인코더에 들어가면 Err가 나므로, 변환 없이는 해당 파일이 조용히 검색에서 빠진다.
    let thumb = img.thumbnail(THUMBNAIL_MAX_DIM, THUMBNAIL_MAX_DIM).to_rgb8();
    let mut buf: Vec<u8> = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .ok()?;

    let meta = std::fs::metadata(path).ok()?;
    Some(WallpaperCandidate {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        width,
        height,
        size_bytes: meta.len(),
        thumb_base64: BASE64.encode(&buf),
        gen_provider: gen.as_ref().and_then(|s| s.provider.clone()),
        gen_source: gen.as_ref().and_then(|s| s.source.clone()),
    })
}

/// 필터(확장자 + 키워드)에 매칭되는 이미지 **경로만** 수집한다.
/// 디코딩·썸네일 생성은 하지 않으므로 대용량 폴더에서도 저비용이다.
fn collect_matching_paths(dir: &Path, query_lower: &str, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > MAX_SEARCH_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_matching_paths(&path, query_lower, out, depth + 1);
            continue;
        }
        if !is_supported_image(&path) {
            continue;
        }
        let name_lower = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !query_lower.is_empty() && !name_lower.contains(query_lower) {
            continue;
        }
        out.push(path);
    }
}

/// 온라인 폴백이 한 번에 내려받는 최대 이미지 수 (IPC 페이로드·대기시간 보호).
const ONLINE_FALLBACK_LIMIT: usize = 8;

/// 온라인 검색 캐시 파일명을 쿼리별로 분리해 생성한다.
///
/// 쿼리 전체(trimmed)에 대한 해시를 포함하므로, 앞 20자가 같은 서로 다른 쿼리
/// (예: 'sunset over mountains' / 'sunset over mountain lake')가 같은 캐시 파일을
/// 공유해 엉뚱한 이미지를 반환하는 충돌이 발생하지 않는다.
/// 순수 함수로 분리해 네트워크 없이 단위 테스트로 검증한다.
pub fn online_cache_file_name(query: &str, idx: usize) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    query.trim().hash(&mut h);
    format!("online_{:016x}_{idx}.jpg", h.finish())
}

/// Wikimedia Commons 무료 이미지 검색으로 폴백한다 (키 불필요).
///
/// - `query`가 비어 있으면 호출하지 않는다 (호출자가 보장).
/// - 검색 API에서 원본 URL을 받아 `app_data_dir()/online_cache`에 내려받은 뒤
///   `load_candidate`로 후보화한다. 1건 이상 성공하면 `SearchResult`로 반환한다.
/// - API 오류·다운로드 전멸 시 `Network`/`HttpStatus`를 그대로 반환해 UI에 노출한다 —
///   빈 목록으로 조용히 끝나지 않는다.
fn search_online_wallpapers(query: &str) -> Result<SearchResult, WallpaperError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResult {
            candidates: Vec::new(),
            total_matched: 0,
            truncated: false,
        });
    }
    let encoded = urlencoding::encode(trimmed);
    let url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch={encoded}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url%7Csize&iiurlwidth=1280&formatversion=2"
    );
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| WallpaperError::Network(format!("online image search failed: {e}")))?;
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
    let body = response
        .into_string()
        .map_err(|e| WallpaperError::Network(format!("reading search response failed: {e}")))?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        WallpaperError::CandidateLoad(format!("search response parse failed: {e}"))
    })?;
    let pages = json
        .pointer("/query/pages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let cache_dir = crate::wallpaper::app_data_dir().join("online_cache");
    std::fs::create_dir_all(&cache_dir)?;

    let mut candidates = Vec::new();
    let mut failures = 0usize;
    for (idx, page) in pages.iter().enumerate() {
        if candidates.len() >= ONLINE_FALLBACK_LIMIT {
            break;
        }
        let img_url = page
            .pointer("/imageinfo/0/thumburl")
            .and_then(|v| v.as_str())
            .or_else(|| page.pointer("/imageinfo/0/url").and_then(|v| v.as_str()));
        let Some(img_url) = img_url
        else {
            failures += 1;
            continue;
        };
        let file_name = online_cache_file_name(trimmed, idx);
        let dest = cache_dir.join(file_name);
        // 캐시가 있으면 재사용 (같은 키워드 반복 검색 시 네트워크 절약).
        if !dest.exists() {
            let img_resp = ureq::get(img_url)
                .timeout(Duration::from_secs(30))
                .call()
                .map_err(|e| {
                    WallpaperError::Network(format!("image download failed: {e}"))
                })?;
            if img_resp.status() != 200 {
                failures += 1;
                continue;
            }
            let mut bytes: Vec<u8> = Vec::new();
            use std::io::Read as _;
            if img_resp
                .into_reader()
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.is_empty()
            {
                failures += 1;
                continue;
            }
            if image::load_from_memory(&bytes).is_err() {
                failures += 1;
                continue;
            }
            if std::fs::write(&dest, &bytes).is_err() {
                failures += 1;
                continue;
            }
        }
        if let Some(candidate) = load_candidate(&dest) {
            candidates.push(candidate);
        } else {
            failures += 1;
        }
    }
    if candidates.is_empty() {
        return Err(WallpaperError::Network(format!(
            "online search found no downloadable images for '{trimmed}' (failures: {failures})"
        )));
    }
    let total = candidates.len();
    Ok(SearchResult {
        candidates,
        total_matched: total,
        truncated: false,
    })
}

/// 온라인 검색을 **실행할 조건**인지 판정한다 (폴백 여부 판정이 아니다).
///
/// - 키워드가 비어 있으면 온라인 검색을 하지 않는다 — 빈 검색어는 "전체 목록" 요청이고,
///   온라인에 빈 질의를 보내면 무의미한 결과가 온다.
/// - **키워드가 있으면 로컬 매칭 수와 무관하게 실행한다.** 이전 정책(`local_matched == 0`
///   일 때만 실행)은 로컬에 부분일치가 1건만 있어도 온라인을 건너뛰어, 사용자가 보는
///   "키워드를 넣었는데 로컬에서만 검색된다"는 증상을 만들었다. 두 출처는 경쟁 관계가
///   아니라 병합 대상이므로 로컬 매칭 수는 더 이상 실행 조건이 아니다.
///
/// `local_matched` 인자는 호출부 호환을 위해 남겨 둔다(판정에 사용하지 않는다).
pub fn should_search_online(query: &str, _local_matched: usize) -> bool {
    !query.trim().is_empty()
}

/// 키워드로 로컬 배경화면 후보를 검색하고, 키워드가 있으면 온라인 결과와 **병합**해 반환한다.
///
/// - `root`가 주어지면 그 폴더만, 없으면 `default_search_roots()`(앱 라이브러리 + Pictures)를 탐색한다.
/// - `query`가 파일명(대소문자 무시)에 포함된 이미지 중 **디코딩 가능 + 640x480 이상**인 것만 후보가 된다.
/// - 결과는 파일명 오름차순으로 정렬된 뒤 **상위 `MAX_RESULTS`개만 디코딩**해 반환한다 (결정적 순서 + 비용 상한).
/// - 잘림 여부는 `SearchResult::truncated`, 매칭 전체 수는 `total_matched`로 확인한다.
pub fn search_wallpapers(
    query: &str,
    root: Option<&Path>,
) -> Result<SearchResult, WallpaperError> {
    search_wallpapers_with(query, root, &search_online_wallpapers)
}

/// 온라인 검색 실행기를 주입할 수 있는 `search_wallpapers`.
///
/// 네트워크를 실제로 호출하지 않고도 "로컬 매칭이 있어도 온라인 결과가 병합된다"는
/// 계약을 단위 테스트로 고정하기 위해 실행기를 인자로 받는다.
pub fn search_wallpapers_with<F>(
    query: &str,
    root: Option<&Path>,
    online: &F,
) -> Result<SearchResult, WallpaperError>
where
    F: Fn(&str) -> Result<SearchResult, WallpaperError>,
{
    let query_lower = query.trim().to_lowercase();
    // 명시적 root 여부와 무관하게 키워드가 있으면 로컬을 먼저 훑은 뒤 온라인을 병합한다.
    // 회귀 결함 #2: 명시적 빈 폴더 지정 시 폴백 게이트(`!has_explicit_root`)가
    // 온라인 검색을 차단해 빈 목록을 반환했음 — 사용자가 보는 "검색 결과 없음" 증상.
    let roots: Vec<PathBuf> = match root {
        Some(root) => vec![root.to_path_buf()],
        None => default_search_roots(),
    };

    let mut matched_paths: Vec<PathBuf> = Vec::new();
    for root in roots {
        if root.is_dir() {
            collect_matching_paths(&root, &query_lower, &mut matched_paths, 0);
        }
    }
    matched_paths.sort_by(|a, b| {
        let name = |p: &PathBuf| {
            p.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        name(a).cmp(&name(b))
    });

    let total_matched = matched_paths.len();
    let mut local_candidates = Vec::new();
    // 조기 중단: 상한 초과 경로는 디코딩 자체를 수행하지 않는다.
    for path in matched_paths.iter().take(MAX_RESULTS) {
        if let Some(candidate) = load_candidate(path) {
            local_candidates.push(candidate);
        }
    }
    let local = SearchResult {
        candidates: local_candidates,
        total_matched,
        truncated: total_matched > MAX_RESULTS,
    };

    // 로컬 매칭이 있어도 키워드가 있으면 온라인 결과를 **병합**한다(경쟁이 아니라 합집합).
    // 온라인 실패는 로컬 결과를 버릴 이유가 아니므로, 로컬 결과가 있으면 로컬만 반환하고
    // 로컬도 0건일 때만 오류를 그대로 전파한다(무음 빈 목록 금지).
    if should_search_online(&query_lower, local.total_matched) {
        return match online(&query_lower) {
            Ok(online_result) => Ok(merge_search_results(local, Some(online_result))),
            Err(err) if local.candidates.is_empty() && local.total_matched == 0 => Err(err),
            Err(_) => Ok(local),
        };
    }
    Ok(local)
}

/// 로컬 결과와 온라인 결과를 하나의 `SearchResult`로 병합한다.
///
/// - **로컬 우선**: 로컬 후보를 먼저 두고 온라인 후보를 뒤에 붙인다(사용자 폴더 이미지 우선).
/// - **중복 제거**: 같은 경로(대소문자 무시)는 한 번만 남긴다.
/// - `total_matched`는 두 출처 매칭 수의 합, 후보 수는 `MAX_RESULTS`로 제한한다.
pub fn merge_search_results(local: SearchResult, online: Option<SearchResult>) -> SearchResult {
    let online_total = online.as_ref().map(|r| r.total_matched).unwrap_or(0);
    let online_candidates: Vec<WallpaperCandidate> =
        online.map(|r| r.candidates).unwrap_or_default();
    let total_matched = local.total_matched + online_total;

    let mut candidates: Vec<WallpaperCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for candidate in local
        .candidates
        .into_iter()
        .chain(online_candidates.into_iter())
    {
        if candidates.len() >= MAX_RESULTS {
            break;
        }
        // Windows 경로는 대소문자를 구분하지 않으므로 소문자 키로 중복을 판정한다.
        if !seen.insert(candidate.path.to_lowercase()) {
            continue;
        }
        candidates.push(candidate);
    }

    SearchResult {
        truncated: total_matched > candidates.len(),
        total_matched,
        candidates,
    }
}

/// 프롬프트 기반으로 배경화면을 생성(Pollinations 무료 이미지 API, 키 불필요)해
/// 앱 라이브러리(`app_data_dir()/library`)에 저장하고,
/// GUI가 바로 선택·적용할 수 있는 `WallpaperCandidate`(썸네일 포함)로 반환한다.
/// 프롬프트 기반 생성 결과를 저장할 라이브러리 파일 경로의 **베이스 이름**을 만든다.
///
/// 파일명: 프롬프트 슬러그 + FNV-1a 해시 8자리 (같은 프롬프트 = 같은 베이스 이름).
///
/// ⚠ 이 경로를 그대로 저장에 쓰지 말 것 — 실제 저장은 반드시 [`unique_output_path`] 를 거쳐
/// timestamp·nonce 가 붙은 고유 경로를 써야 한다. 이전에는 같은 프롬프트로 재생성하면 같은
/// 파일을 덮어써 사용자가 앞서 만든 결과물을 잃었다(검수 지적: 파일 덮어쓰기 방지).
/// 공급자별 생성 경로(Pollinations/Cloudflare/OpenAI)가 **같은 이름 규칙**을 공유하도록
/// 별도 함수로 분리했다 — 규칙이 갈라지면 같은 프롬프트로 공급자를 바꿔 생성할 때
/// 라이브러리에 중복 파일이 쌓인다.
pub fn library_output_path(prompt: &str) -> Result<PathBuf, WallpaperError> {
    let library = crate::wallpaper::app_data_dir().join("library");
    std::fs::create_dir_all(&library)?;

    let mut hash: u32 = 2166136261;
    for b in prompt.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    let slug: String = prompt
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(24)
        .collect();
    Ok(library.join(format!("generated_{slug}_{hash:08x}.jpg")))
}

/// 프로세스 전역 단조 증가 nonce — 같은 밀리초에 여러 번 생성해도 파일명이 겹치지 않게 한다.
static UNIQUE_OUTPUT_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// [`library_output_path`] 가 만든 **베이스 경로**를 "절대 덮어쓰지 않는 고유 경로"로 바꾼다.
///
/// 같은 프롬프트로 두 번 생성해도 앞서 만든 결과물을 잃지 않아야 하므로, 밀리초 타임스탬프와
/// 프로세스 nonce 를 덧붙인 새 파일명을 만든다. 반환 경로는 **호출 시점에 존재하지 않음**이
/// 보장되고, 디렉터리·확장자는 원본 그대로 보존된다.
///
/// 저장 지점은 [`library_output_path`] 를 그대로 쓰지 말고 반드시 이 함수를 거쳐야 한다
/// (이전에는 같은 프롬프트 재생성 시 같은 파일을 덮어써 사용자 결과물이 사라졌다).
pub fn unique_output_path(base: &Path) -> PathBuf {
    let parent = base.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("generated");
    let ext = base.extension().and_then(|e| e.to_str());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut nonce = UNIQUE_OUTPUT_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // 프로세스 id 도 이름에 넣는다 — nonce 는 프로세스마다 0 에서 시작하므로,
    // 두 인스턴스가 같은 밀리초에 생성하면 timestamp+nonce 만으로는 이름이 겹쳐
    // 한쪽이 다른 쪽 결과물을 덮어쓸 수 있다. pid 를 붙이면 프로세스 간 충돌도 배제된다.
    let pid = std::process::id();
    for _ in 0..10_000 {
        let name = match ext {
            Some(ext) => format!("{stem}_{ts}_{pid:08x}_{nonce:06x}.{ext}"),
            None => format!("{stem}_{ts}_{pid:08x}_{nonce:06x}"),
        };
        let candidate = parent.join(name);
        // 이미 점유된 이름이면 nonce 를 올려 접미사가 달라진다(덮어쓰기 금지).
        if !candidate.exists() {
            return candidate;
        }
        nonce = nonce.wrapping_add(1);
    }
    let fallback = format!("{stem}_{ts}_{nonce:06x}_{:08x}", std::process::id());
    match ext {
        Some(ext) => parent.join(format!("{fallback}.{ext}")),
        None => parent.join(fallback),
    }
}

pub fn generate_library_wallpaper(prompt: &str) -> Result<WallpaperCandidate, WallpaperError> {
    let out_path = unique_output_path(&library_output_path(prompt)?);

    generate_online_wallpaper(prompt, &out_path)?;

    // 생성 파일 자체에 귀속을 남긴다 (사이드카 `.geninfo.json`).
    // "② 생성"은 배경을 적용하지 않으므로 state.json 이 갱신되지 않고, 미리보기에서
    // "현재 배경" 기록(예: 과거 Puter 생성)과 오귀속되는 사태가 있었다.
    write_generation_sidecar(
        &out_path,
        Some("pollinations"),
        Some(&format!("Pollinations (무료 이미지 API) · prompt: {prompt}")),
    )?;

    load_candidate(&out_path).ok_or_else(|| {
        WallpaperError::CandidateLoad(out_path.to_string_lossy().to_string())
    })
}

/// 검색(Search) 공급자: 키워드로 공개 이미지를 검색해 그 결과 1건을 `dest`에 확정한다.
///
/// - 프롬프트(생성) 대신 **키워드 검색**을 사용하는 공급자 경로다.
/// - `search_online_wallpapers`가 내려받은 캐시 파일 중 첫 후보를 원본으로 삼아
///   `normalize_to_hd`로 1920x1080 기준에 맞춘 뒤 `dest`에 저장한다.
/// - 파일 자체에 사이드카(`provider=search`, 검색어 포함)를 남겨, ② 생성처럼 배경을
///   적용하지 않는 경로에서도 미리보기가 자기 생성 경로를 정확히 표시할 수 있게 한다.
/// - 검색 결과 0건·다운로드 전멸은 `Network`/`HttpStatus`로 그대로 반환한다(무음 폴백 금지).
pub fn generate_search_wallpaper(query: &str, dest: &PathBuf) -> Result<PathBuf, WallpaperError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(WallpaperError::CandidateLoad(
            "empty search query: search provider needs a keyword".to_string(),
        ));
    }
    let result = search_online_wallpapers(trimmed)?;
    let first = result.candidates.first().ok_or_else(|| {
        WallpaperError::Network(format!(
            "search provider found no usable image for '{trimmed}'"
        ))
    })?;
    let bytes = std::fs::read(&first.path)
        .map_err(|e| WallpaperError::CandidateLoad(format!("read searched image failed: {e}")))?;
    let img = image::load_from_memory(&bytes).map_err(|e| {
        WallpaperError::CandidateLoad(format!("searched image decode failed: {e}"))
    })?;
    let hd = crate::wallpaper::normalize_to_hd(img)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    hd.save(dest)?;
    write_generation_sidecar(
        dest,
        Some("search"),
        Some(&format!("Wikimedia Commons image search (키워드 검색) · query: {trimmed}")),
    )?;
    Ok(dest.clone())
}
