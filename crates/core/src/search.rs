//! 로컬 배경화면 라이브러리 검색·생성 (GUI "검색" / "생성" 액션의 코어 로직)
//!
//! `wallpaper` 모듈이 이미지 검증·스테이징·적용·복원을 담당한다면, 이 모듈은 그 앞단의
//! "후보 탐색"(사용자 폴더에서 키워드로 이미지 검색)과 "프롬프트 기반 생성"을 담당한다.
//! UI는 반환된 `WallpaperCandidate`(썸네일 포함)를 그대로 렌더링하고, 선택된 후보의
//! `path`를 `wallpaper::set_wallpaper`에 넘긴다.

use crate::wallpaper::{generate_sample_wallpaper, WallpaperError};
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
}

/// 디코딩 가능한 이미지 확장자 화이트리스트 (PNG·JPEG·BMP — `image` 크레이트 활성 feature와 일치).
pub const SUPPORTED_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "bmp"];

/// 검색 시 탐색하는 최대 디렉터리 깊이 (무한 재귀 방지).
const MAX_SEARCH_DEPTH: u32 = 3;

/// 썸네일 최대 한 변 (px). JPEG q80으로 인코딩해 base64로 전달한다.
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
fn load_candidate(path: &Path) -> Option<WallpaperCandidate> {
    let img = image::open(path).ok()?;
    let (width, height) = (img.width(), img.height());
    if width < 640 || height < 480 {
        return None;
    }

    // `DynamicImage::thumbnail`은 in-place가 아니라 축소된 새 이미지를 반환하므로
    // 반환값을 바인딩해 사용한다 (반환값 무시 시 1920x1080 원본이 그대로 인코딩됨).
    let thumb = img.thumbnail(THUMBNAIL_MAX_DIM, THUMBNAIL_MAX_DIM);
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
    })
}

fn collect_candidates(dir: &Path, query_lower: &str, out: &mut Vec<WallpaperCandidate>, depth: u32) {
    if depth > MAX_SEARCH_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_candidates(&path, query_lower, out, depth + 1);
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
        if let Some(candidate) = load_candidate(&path) {
            out.push(candidate);
        }
    }
}

/// 키워드로 로컬 배경화면 후보를 검색한다.
///
/// - `root`가 주어지면 그 폴더만, 없으면 `default_search_roots()`(앱 라이브러리 + Pictures)를 탐색한다.
/// - `query`가 파일명(대소문자 무시)에 포함된 이미지 중 **디코딩 가능 + 640x480 이상**인 것만 반환한다.
/// - 결과는 파일명 오름차순으로 정렬되어 반환된다 (결정적 순서).
pub fn search_wallpapers(
    query: &str,
    root: Option<&Path>,
) -> Result<Vec<WallpaperCandidate>, WallpaperError> {
    let query_lower = query.trim().to_lowercase();
    let roots: Vec<PathBuf> = match root {
        Some(root) => vec![root.to_path_buf()],
        None => default_search_roots(),
    };

    let mut out = Vec::new();
    for root in roots {
        if root.is_dir() {
            collect_candidates(&root, &query_lower, &mut out, 0);
        }
    }
    out.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    Ok(out)
}

/// 프롬프트 기반으로 배경화면을 생성해 앱 라이브러리(`app_data_dir()/library`)에 저장하고,
/// GUI가 바로 선택·적용할 수 있는 `WallpaperCandidate`(썸네일 포함)로 반환한다.
pub fn generate_library_wallpaper(prompt: &str) -> Result<WallpaperCandidate, WallpaperError> {
    let library = crate::wallpaper::app_data_dir().join("library");
    std::fs::create_dir_all(&library)?;

    // 파일명: 프롬프트 슬러그 + FNV-1a 해시 8자리 (같은 프롬프트 = 같은 파일, 재생성 시 덮어씀)
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
    let file_name = format!("generated_{slug}_{hash:08x}.bmp");
    let out_path = library.join(file_name);

    generate_sample_wallpaper(prompt, &out_path)?;
    load_candidate(&out_path).ok_or_else(|| {
        WallpaperError::CandidateLoad(out_path.to_string_lossy().to_string())
    })
}
