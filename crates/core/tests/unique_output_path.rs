//! 생성 산출물 파일명 고유화 계약 (파일 덮어쓰기 방지).
//!
//! 완료 기준 ①: 같은 프롬프트로 두 번 생성하면 **두 개의 상이한 파일명**이 나오고
//! 기존 파일이 유지되어야 한다. 이 테스트는 그 계약을 파일 시스템 수준에서 고정한다.

use std::fs;
use std::path::PathBuf;

fn scratch_dir(tag: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("wallmagic_unique_{tag}_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir 생성");
    dir
}

/// 같은 base 에 대해 두 번 고유화하면 서로 다른 이름이 나오고,
/// 앞서 만든 파일이 그대로 남아 있어야 한다.
#[test]
fn unique_output_path_never_overwrites_existing_generation() {
    let dir = scratch_dir("noclobber");
    let base = dir.join("generated_Cyberpunk_rainy_541ef24f.jpg");

    let first = wallmagic_core::unique_output_path(&base);
    assert_ne!(first, base, "고유화는 베이스 경로를 그대로 반환하지 않는다");
    fs::write(&first, b"first").expect("첫 산출물 기록");

    let second = wallmagic_core::unique_output_path(&base);
    assert_ne!(second, first, "두 번째 생성은 다른 파일명이어야 한다");
    assert!(!second.exists(), "두 번째 경로는 아직 존재하지 않아야 한다");
    fs::write(&second, b"second").expect("두 번째 산출물 기록");

    // ① 기존 파일 유지 — 두 파일이 각자의 내용을 보존한다.
    assert_eq!(fs::read(&first).unwrap(), b"first");
    assert_eq!(fs::read(&second).unwrap(), b"second");
    assert!(!base.exists(), "베이스 경로를 새로 덮어써 만들지 않는다");

    let names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names.len(), 2, "두 번 생성 = 두 개 파일, 실제: {names:?}");

    let _ = fs::remove_dir_all(&dir);
}

/// 확장자·디렉터리가 보존되고, 이미 점유된 이름과 충돌해도 존재하는 경로를 반환하지 않는다.
#[test]
fn unique_output_path_keeps_extension_and_avoids_collision_suffix() {
    let dir = scratch_dir("suffix");
    let base = dir.join("generated_pollinations_deadbeef.png");

    let taken = wallmagic_core::unique_output_path(&base);
    fs::write(&taken, b"occupied").expect("점유 파일 생성");
    assert!(taken.exists());

    for _ in 0..5 {
        let next = wallmagic_core::unique_output_path(&base);
        assert!(
            !next.exists(),
            "존재하는 경로를 반환하면 덮어쓰기가 발생한다: {}",
            next.display()
        );
        assert_eq!(
            next.parent().unwrap(),
            dir.as_path(),
            "디렉터리가 보존되어야 한다"
        );
        assert_eq!(
            next.extension().and_then(|e| e.to_str()),
            Some("png"),
            "확장자가 보존되어야 한다"
        );
    }

    // 점유 파일은 그대로 남아 있다.
    assert_eq!(fs::read(&taken).unwrap(), b"occupied");
    let _ = fs::remove_dir_all(&dir);
}
