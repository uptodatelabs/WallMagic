//! 앱 데이터 영속 저장소 — 프롬프트·검색 히스토리와 생성 이미지 인덱스.
//!
//! 배경(결함 ②): 생성 이미지 목록과 프롬프트/검색 이력이 **메모리에만** 존재해
//! 프로그램을 껐다 켜면 사라졌다. 이 모듈은 `app_data_dir()` 아래 두 JSON 파일
//! (`history.json`, `library_index.json`)로 영속화하고, 시작 시 로드 경로를 제공한다.
//!
//! 원칙
//! - **깨진/없는 파일**은 빈 목록으로 시작한다(첫 실행 정상 경로). 읽기 실패는 `Err` 로
//!   전달해 조용한 손실로 위장하지 않는다.
//! - **저장은 원자적**이다(임시 파일 → rename). 도중 종료로 반쪽 JSON 이 남지 않는다.
//! - **중복·상한 규칙은 순수 함수**(`push_history`/`push_library`/`prune_missing`)로 분리해
//!   파일 IO 없이 테스트한다.

use crate::wallpaper::{app_data_dir, WallpaperError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 프롬프트 히스토리 보관 상한.
pub const HISTORY_CAP: usize = 50;
/// 생성 이미지 인덱스 보관 상한.
pub const LIBRARY_CAP: usize = 200;

/// 히스토리 종류 — 생성 프롬프트와 검색 키워드는 서로 다른 입력이므로 섞지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryKind {
    Prompt,
    Search,
}

impl Default for HistoryKind {
    fn default() -> Self {
        HistoryKind::Prompt
    }
}

/// 히스토리 1건 — 텍스트 + 그때 쓴 공급자/모델(재적용 시 참고).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct HistoryEntry {
    #[serde(default)]
    pub kind: HistoryKind,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub at: u64,
}

/// `history.json` 루트.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct HistoryStore {
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}

/// 생성 이미지 1건 — 재시동 후 목록 복원용.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LibraryEntry {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub created_at: u64,
}

/// `library_index.json` 루트.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LibraryIndex {
    #[serde(default)]
    pub entries: Vec<LibraryEntry>,
}

/// 앱 메타데이터 — 버전/제작자의 **단일 소스**는 `Cargo.toml`(`workspace.package`)이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppMeta {
    pub product: String,
    pub version: String,
    pub author: String,
}

/// Cargo 메타데이터에서 앱 정보를 만든다(별도 상수 중복 정의 금지).
pub fn app_meta() -> AppMeta {
    let authors = env!("CARGO_PKG_AUTHORS");
    let author = authors
        .split(',')
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
    AppMeta {
        product: "WallMagic".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        author,
    }
}

pub fn history_file_path() -> PathBuf {
    app_data_dir().join("history.json")
}

pub fn library_index_file_path() -> PathBuf {
    app_data_dir().join("library_index.json")
}

/// 원자적 저장 — 임시 파일에 쓰고 rename 으로 교체한다.
fn write_atomic(path: &Path, json: &str) -> Result<(), WallpaperError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// 히스토리에 1건 추가한 **새 목록**을 만든다(순수).
///
/// - 같은 종류 + 같은 텍스트(공백 무시)는 **중복 저장하지 않고 맨 앞으로 이동**한다.
/// - 빈 텍스트는 무시한다(빈 항목이 목록을 채우지 않게).
/// - `cap` 을 넘으면 오래된 항목을 버린다.
pub fn push_history(entries: &[HistoryEntry], entry: HistoryEntry, cap: usize) -> Vec<HistoryEntry> {
    let text = entry.text.trim().to_string();
    if text.is_empty() {
        return entries.to_vec();
    }
    let kind = entry.kind;
    // 중복 판정 키를 **이동 전에** 따로 보관한다 — `text` 는 아래에서 `entry` 로 이동하므로
    // 이동 후 비교에 쓰면 E0382(borrow of moved value) 가 된다.
    let dedupe_key = text.clone();
    let mut out: Vec<HistoryEntry> = Vec::with_capacity(entries.len() + 1);
    out.push(HistoryEntry { text, ..entry });
    for e in entries {
        if e.kind == kind && e.text.trim() == dedupe_key {
            continue;
        }
        out.push(e.clone());
    }
    out.truncate(cap.max(1));
    out
}

/// 생성 이미지 인덱스에 1건 추가한 **새 목록**을 만든다(순수).
///
/// Windows 경로는 대소문자를 구분하지 않으므로 소문자 키로 중복을 판정한다.
pub fn push_library(entries: &[LibraryEntry], entry: LibraryEntry, cap: usize) -> Vec<LibraryEntry> {
    let path = entry.path.trim().to_string();
    if path.is_empty() {
        return entries.to_vec();
    }
    let key = path.to_lowercase();
    let mut out: Vec<LibraryEntry> = Vec::with_capacity(entries.len() + 1);
    out.push(LibraryEntry { path, ..entry });
    for e in entries {
        if e.path.trim().to_lowercase() == key {
            continue;
        }
        out.push(e.clone());
    }
    out.truncate(cap.max(1));
    out
}

/// 실제로 디스크에 **존재하는** 항목만 남긴다(순수 — 파일 존재 확인).
///
/// 사용자가 파일을 지웠거나 다른 곳으로 옮겼으면 목록에서 빠진다. 복원 시
/// 깨진 썸네일/죽은 경로를 보여주지 않기 위한 규칙이다.
pub fn prune_missing(entries: &[LibraryEntry]) -> Vec<LibraryEntry> {
    entries
        .iter()
        .filter(|e| !e.path.trim().is_empty() && Path::new(&e.path).is_file())
        .cloned()
        .collect()
}

pub fn load_history() -> Result<HistoryStore, WallpaperError> {
    let path = history_file_path();
    if !path.exists() {
        return Ok(HistoryStore::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    let store: HistoryStore = serde_json::from_str(&raw)?;
    Ok(store)
}

pub fn save_history(store: &HistoryStore) -> Result<(), WallpaperError> {
    let json = serde_json::to_string_pretty(store)?;
    write_atomic(&history_file_path(), &json)
}

/// 히스토리 1건 기록 → 갱신된 전체 목록 반환(UI 가 바로 다시 그릴 수 있게).
pub fn record_history(entry: HistoryEntry) -> Result<Vec<HistoryEntry>, WallpaperError> {
    let mut store = load_history()?;
    store.entries = push_history(&store.entries, entry, HISTORY_CAP);
    save_history(&store)?;
    Ok(store.entries)
}

pub fn clear_history() -> Result<Vec<HistoryEntry>, WallpaperError> {
    let store = HistoryStore::default();
    save_history(&store)?;
    Ok(store.entries)
}

pub fn load_library_index() -> Result<LibraryIndex, WallpaperError> {
    let path = library_index_file_path();
    if !path.exists() {
        return Ok(LibraryIndex::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    let index: LibraryIndex = serde_json::from_str(&raw)?;
    Ok(index)
}

pub fn save_library_index(index: &LibraryIndex) -> Result<(), WallpaperError> {
    let json = serde_json::to_string_pretty(index)?;
    write_atomic(&library_index_file_path(), &json)
}

/// 생성 이미지 1건 기록 → (갱신 목록, 디스크에 실제 존재하는 목록) 반환.
///
/// 반환하는 두 번째 값은 `prune_missing` 을 거친 목록이다 — 인덱스에 남아 있어도
/// 파일이 사라졌으면 UI 에 보내지 않는다.
pub fn record_library(entry: LibraryEntry) -> Result<Vec<LibraryEntry>, WallpaperError> {
    let mut index = load_library_index()?;
    index.entries = push_library(&index.entries, entry, LIBRARY_CAP);
    let existing = prune_missing(&index.entries);
    index.entries = existing.clone();
    save_library_index(&index)?;
    Ok(existing)
}

/// 시작 시 복원용 — 인덱스를 읽어 **존재하는 항목만** 돌려주고, 정리된 결과를 디스크에
/// 반영한다. 인덱스 파일이 없으면 빈 목록(첫 실행).
pub fn restore_library() -> Result<Vec<LibraryEntry>, WallpaperError> {
    let index = load_library_index()?;
    let existing = prune_missing(&index.entries);
    if existing.len() != index.entries.len() {
        save_library_index(&LibraryIndex {
            entries: existing.clone(),
        })?;
    }
    Ok(existing)
}

// ---------------------------------------------------------------------------
// UI 환경설정 (언어) — 요구 ⑤: 한국어/영어 전환 + 언어 설정 영속화
// ---------------------------------------------------------------------------

/// UI 환경설정. 현재는 언어만 있으며, 값은 `ui_prefs.json` 에 저장된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiPrefs {
    /// `ko` | `en`. 기본값 `ko`(한국어).
    #[serde(default = "default_language")]
    pub language: String,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            language: default_language(),
        }
    }
}

fn default_language() -> String {
    "ko".to_string()
}

/// 지원 언어인가? (`ko` / `en` 만 허용 — 그 외 값은 저장을 거부한다)
pub fn is_supported_language(lang: &str) -> bool {
    matches!(lang.trim().to_ascii_lowercase().as_str(), "ko" | "en")
}

pub fn ui_prefs_file_path() -> PathBuf {
    app_data_dir().join("ui_prefs.json")
}

/// 환경설정 로드 — 파일이 없으면 기본값(첫 실행). 저장된 언어가 지원 목록 밖이면 기본값으로
/// 되돌린다(손상된 값이 UI 를 알 수 없는 언어로 만들지 않게).
pub fn load_ui_prefs() -> Result<UiPrefs, WallpaperError> {
    let path = ui_prefs_file_path();
    if !path.exists() {
        return Ok(UiPrefs::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    let mut prefs: UiPrefs = serde_json::from_str(&raw)?;
    if !is_supported_language(&prefs.language) {
        prefs.language = default_language();
    }
    prefs.language = prefs.language.trim().to_ascii_lowercase();
    Ok(prefs)
}

/// 환경설정 저장 — 지원하지 않는 언어는 **조용히 대체하지 않고 오류**로 거부한다.
pub fn save_ui_prefs(prefs: &UiPrefs) -> Result<UiPrefs, WallpaperError> {
    if !is_supported_language(&prefs.language) {
        return Err(WallpaperError::CandidateLoad(format!(
            "unsupported language '{}' (expected: ko|en)",
            prefs.language
        )));
    }
    let normalized = UiPrefs {
        language: prefs.language.trim().to_ascii_lowercase(),
    };
    let json = serde_json::to_string_pretty(&normalized)?;
    write_atomic(&ui_prefs_file_path(), &json)?;
    Ok(normalized)
}

/// 히스토리 종류 문자열(`prompt`/`search`) → enum. 알 수 없는 값은 `prompt` 로 해석한다
/// (IPC 인자이므로 오타 하나로 기록이 실패하지 않게 하되, 종류 구분은 유지한다).
pub fn parse_history_kind(raw: &str) -> HistoryKind {
    match raw.trim().to_ascii_lowercase().as_str() {
        "search" => HistoryKind::Search,
        _ => HistoryKind::Prompt,
    }
}

/// 기록 시각(초). 히스토리·인덱스 항목에 남겨 최신순 정렬에 쓴다.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: HistoryKind, text: &str, at: u64) -> HistoryEntry {
        HistoryEntry {
            kind,
            text: text.to_string(),
            provider: None,
            model: None,
            at,
        }
    }

    /// 같은 프롬프트를 두 번 생성하면 히스토리에 두 줄이 쌓이지 않고 맨 앞으로 이동해야 한다.
    #[test]
    fn test_push_history_moves_duplicate_to_front() {
        let mut list = vec![
            entry(HistoryKind::Prompt, "aurora", 1),
            entry(HistoryKind::Prompt, "sunset", 2),
        ];
        list = push_history(&list, entry(HistoryKind::Prompt, "  sunset  ", 3), HISTORY_CAP);
        assert_eq!(list.len(), 2, "중복은 저장되지 않아야 한다");
        assert_eq!(list[0].text, "sunset", "최근 항목이 맨 앞으로 와야 한다");
        assert_eq!(list[0].at, 3);
        assert_eq!(list[1].text, "aurora");
    }

    /// 프롬프트와 검색어는 종류가 다르면 같은 텍스트라도 별개로 저장된다.
    #[test]
    fn test_push_history_keeps_kinds_separate() {
        let list = vec![entry(HistoryKind::Prompt, "aurora", 1)];
        let list = push_history(&list, entry(HistoryKind::Search, "aurora", 2), HISTORY_CAP);
        assert_eq!(list.len(), 2, "프롬프트와 검색어는 별개 항목이다");
        assert_eq!(list[0].kind, HistoryKind::Search);
        assert_eq!(list[1].kind, HistoryKind::Prompt);
    }

    #[test]
    fn test_push_history_ignores_blank_and_caps() {
        let list = push_history(&[], entry(HistoryKind::Prompt, "   ", 1), HISTORY_CAP);
        assert!(list.is_empty(), "빈 텍스트는 저장하지 않는다");

        let mut list: Vec<HistoryEntry> = Vec::new();
        for i in 0..(HISTORY_CAP + 5) {
            list = push_history(
                &list,
                entry(HistoryKind::Prompt, &format!("prompt {i}"), i as u64),
                HISTORY_CAP,
            );
        }
        assert_eq!(list.len(), HISTORY_CAP, "상한을 넘지 않아야 한다");
        assert_eq!(list[0].text, format!("prompt {}", HISTORY_CAP + 4));
    }

    #[test]
    fn test_push_library_dedupes_case_insensitively() {
        let mk = |p: &str| LibraryEntry {
            path: p.to_string(),
            file_name: p.rsplit(['\\', '/']).next().unwrap_or(p).to_string(),
            provider: Some("pollinations".to_string()),
            source: None,
            created_at: 1,
        };
        let list = vec![mk("C:\\pics\\A.jpg"), mk("C:\\pics\\b.jpg")];
        let list = push_library(&list, mk("c:\\pics\\a.jpg"), LIBRARY_CAP);
        assert_eq!(list.len(), 2, "대소문자만 다른 같은 경로는 중복이다");
        assert_eq!(list[0].path, "c:\\pics\\a.jpg");
    }

    /// 인덱스에 남아 있어도 파일이 사라졌으면 복원 목록에서 제외되어야 한다.
    #[test]
    fn test_prune_missing_drops_vanished_files() {
        let dir = std::env::temp_dir().join(format!("wallmagic_prune_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let kept = dir.join("kept.png");
        std::fs::write(&kept, b"x").expect("write kept");
        let gone = dir.join("gone.png");

        let entries = vec![
            LibraryEntry {
                path: kept.to_string_lossy().to_string(),
                file_name: "kept.png".to_string(),
                provider: Some("pollinations".to_string()),
                source: None,
                created_at: 1,
            },
            LibraryEntry {
                path: gone.to_string_lossy().to_string(),
                file_name: "gone.png".to_string(),
                provider: None,
                source: None,
                created_at: 2,
            },
        ];
        let pruned = prune_missing(&entries);
        assert_eq!(pruned.len(), 1, "사라진 파일은 목록에서 빠져야 한다");
        assert_eq!(pruned[0].file_name, "kept.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 버전/제작자는 Cargo 메타데이터에서 온다(하드코딩 중복 정의 금지).
    #[test]
    fn test_app_meta_reads_cargo_metadata() {
        let meta = app_meta();
        assert!(!meta.version.is_empty(), "버전이 비면 안 된다");
        assert_eq!(meta.version, env!("CARGO_PKG_VERSION"));
        assert!(!meta.author.is_empty(), "제작자가 비면 안 된다");
        assert_eq!(meta.product, "WallMagic");
    }
}
