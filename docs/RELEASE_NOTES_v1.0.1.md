# WallMagic v1.0.1 릴리스 노트 / Release Notes

- 릴리스일 / Released: 2026-10-28
- 태그 / Tag: [`v1.0.1`](https://github.com/uptodatelabs/WallMagic/releases/tag/v1.0.1)
- 저장소 / Repository: <https://github.com/uptodatelabs/WallMagic>

[한국어](#ko) · [English](#en)

> 이 문서는 **한국어 원문 + English 번역을 1:1 구조로 병기**한다. 절·불릿·코드블록 수가 어긋나면
> `node scripts/verify-release.mjs` 가 실패한다. GitHub Release `v1.0.1` 본문과 같은 내용이다.
> v1.0.0 노트는 [`RELEASE_NOTES_v1.0.0.md`](./RELEASE_NOTES_v1.0.0.md) 에 남아 있다.

---

<a id="ko"></a>

## 한국어 (Korean)

크리티컬 버그 수정 릴리스입니다. **검색 공급자로 자동 업데이트를 설정해도 배경화면이 바뀌지 않던 결함**을 고쳤습니다.

### 설치

- `WallMagic_1.0.1_x64-setup.exe` — NSIS 인스톨러(권장). 설치 마법사가 시작 메뉴와 제거 항목을 등록합니다
- `WallMagic_1.0.1_x64_en-US.msi` — MSI 패키지. 그룹 정책·관리 배포용입니다
- 서명이 없어 Windows SmartScreen 경고가 표시됩니다 — "추가 정보" → "실행"으로 진행합니다

### 크리티컬 수정

- **자동 업데이트가 같은 이미지에 고정되던 결함** — 검색 공급자로 60분 간격 자동 업데이트를 설정해도 배경이 바뀌지 않았습니다. `generate_search_wallpaper` 가 검색 결과의 **첫 번째 후보만** 사용해, 같은 캐시 파일을 계속 다시 적용했습니다
- 검색 후보를 **순환 선택**하도록 수정 — `pick_candidate_index(후보 수, nonce)` 가 `nonce % 후보 수` 로 후보를 돌려가며 고릅니다
- 실행마다 다음 후보로 이동하도록 프로세스 전역 nonce(`next_search_variant`)를 추가했습니다. 캐시 재사용 설계는 그대로 두어 네트워크 요청은 늘지 않습니다
- 회귀 방지 테스트 3종을 추가했습니다 — 후보 순환 · 전체 순회 · nonce 단조 증가

### Added

- 릴리스 노트 한/영 병기 — 이 문서. `verify-release` 가 절 · 불릿 · 코드블록 · 표 행 수를 1:1 대조합니다
- `docs/README.md` 인덱스에 v1.0.1 릴리스 노트 행 추가

> `PRIVACY.md` · `THIRD_PARTY_NOTICES.md` · `.gitattributes` 는 **v1.0.0 에 이미 포함**되어 있습니다
> (태그 `v1.0.0` 트리 실측). 이 버전에서 새로 추가된 문서가 아닙니다.

### Changed

- 버전 3곳(`Cargo.toml` · `package.json` · `src-tauri/tauri.conf.json`)을 `1.0.1` 로 동기화했습니다
- README 와 릴리스 노트의 인스톨러 파일명을 `_1.0.1_` 로 갱신했습니다

### Known limitations

- API 키가 `scenario.json` 에 평문 저장됨 (암호화 미적용)
- 코드 서명 · 자동 업데이트 · CSP 미적용
- 배포 산출물은 서명되지 않아 Windows SmartScreen 경고가 표시된다

<a id="en"></a>

## English

A critical bug-fix release. It fixes **the defect where automatic updates using the search provider never changed the wallpaper.**

### Installation

- `WallMagic_1.0.1_x64-setup.exe` — NSIS installer (recommended). The wizard registers Start Menu and uninstall entries.
- `WallMagic_1.0.1_x64_en-US.msi` — MSI package for Group Policy and managed deployment.
- The builds are unsigned, so Windows SmartScreen shows a warning — choose "More info" → "Run anyway".

### Critical fix

- **The automatic update was pinned to the same image** — setting a 60-minute automatic update with the search provider never changed the wallpaper. `generate_search_wallpaper` used only the **first candidate** of the search results, so the same cache file was re-applied every time.
- The search candidate is now **chosen in rotation** — `pick_candidate_index(candidate count, nonce)` picks `nonce % candidate count`, cycling through the candidates.
- Added a process-wide nonce (`next_search_variant`) so each run moves to the next candidate. The cache-reuse design is unchanged, so the number of network requests does not increase.
- Added three regression tests — candidate rotation · full traversal · monotonic nonce.

### Added

- Bilingual release notes — this document. `verify-release` compares section · bullet · code-block · table-row counts 1:1.
- Added the v1.0.1 release-notes row to the `docs/README.md` index

> `PRIVACY.md` · `THIRD_PARTY_NOTICES.md` · `.gitattributes` were **already included in v1.0.0**
> (measured against the `v1.0.0` tree). They are not new in this version.

### Changed

- Synchronized the version in three places (`Cargo.toml` · `package.json` · `src-tauri/tauri.conf.json`) to `1.0.1`
- Updated the installer file names in the README and the release notes to `_1.0.1_`

### Known limitations

- API keys are stored in plain text in `scenario.json` (no encryption yet)
- No code signing, automatic updates or CSP yet
- Distributed builds are unsigned, so Windows SmartScreen shows a warning
