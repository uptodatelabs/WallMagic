# 변경 이력 (CHANGELOG)

이 문서는 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르며, [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 사용합니다.

## [Unreleased]

아직 릴리스되지 않은 변경. 릴리스 시 아래 **승격 규칙**에 따라 버전 섹션으로 옮긴다.

### Added

- README 에 **후원(Support) 섹션** 추가 — GitHub Sponsors · Ko-fi 실링크와 배지 (CodeNexus README `## Support` 형식 참조)

### Changed

- (아직 없음)

### 예정 (Planned)

- 코드 서명 · 공증, 자동 업데이트 경로, CSP 적용, API 키 암호화(DPAPI/키체인), 단일 인스턴스 보장 — [`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md) P0
- 생성/검색 취소 · 진행률 표시, 구조화 로깅, CI 파이프라인 (P1)

### 릴리스 시 승격 규칙 (Release promotion rule)

릴리스는 **버전 3곳 정합 → CHANGELOG 승격 → 번들 빌드 → 산출물 검증** 순서로만 진행한다.

1. **버전 범프 — 세 곳을 같은 값으로** (한 곳만 바꾸면 `verify-release` 가 실패한다)
   - `Cargo.toml` `[workspace.package].version` ← 단일 소스
   - `package.json` `version`
   - `src-tauri/tauri.conf.json` `version`
2. **이 `[Unreleased]` 블록을 `## [X.Y.Z] — YYYY-MM-DD` 로 승격**하고, 새 `[Unreleased]` 블록을 만든다
3. `node scripts/verify-release.mjs` — 버전 정합 · CHANGELOG 섹션 존재 확인 (산출물은 아직 없어도 통과)
4. `npm run release:build` — NSIS / MSI 생성 (`beforeBuildCommand` 가 웹 번들을 먼저 만든다)
5. `npm run release:check` — 산출물 실재 + **파일명에 버전 포함** 여부까지 확인
6. `git tag -a vX.Y.Z -m "WallMagic X.Y.Z"` → `git push origin vX.Y.Z`
7. GitHub Release 생성 후 `bundle/nsis/*.exe` · `bundle/msi/*.msi` 첨부

> 서명 · 자동 업데이트가 아직 없으므로 4~7단계는 **로컬 산출물 생성 + 수동 업로드**다.
> 자동화(tauri-action 등)를 도입할 때는 코드 서명 설정과 함께 넣어야 서명 없는 산출물이 배포되지 않는다.

---

## [1.0.0] — 2026-10-27

첫 공개 릴리스. Windows 바탕화면 **검색 · 생성 · 적용 · 복원** 전체 흐름을 하나의 앱으로 제공합니다.

### Added

**핵심 기능**
- `IDesktopWallpaper` COM 1차 + `SystemParametersInfoW` 폴백 이중화로 바탕화면 적용
- 모니터별 개별 적용, 6가지 배치 방식, 스냅샷 기반 이전 배경 복원 (Zero-Black-Screen)
- 로컬 라이브러리 + 원격 이미지 검색 (키워드 · 해상도 필터, 순환 검색어)
- AI 이미지 생성 5개 공급자: Pollinations(무료) · Cloudflare Workers AI · OpenAI Images · Puter · 검색
- 공급자 자격증명 관리 및 IPC 응답 마스킹

**seed 제어**
- `random`(기본) / `incremental` / `fixed` 3모드 seed 정책
- 나노초 시각 + 프로세스 nonce 기반 `fresh_seed` — 같은 초에 두 번 생성해도 seed가 반복되지 않음
- 공급자별 seed 지원 게이팅 (Cloudflare는 flux 계열만, OpenAI는 미지원으로 미전송)
- 공급자 선택에 따라 **해당 공급자용 안내 문구 1개만** 표시

**미리보기 · 뷰어**
- 뷰어 3모드(fit / fill / actual)가 실제 렌더 크기를 변경하도록 컨테이너 높이 분기
- 원본 해상도 로딩(`load_preview_image`)으로 전체화면에서도 선명하게 표시
- 전체화면 뷰어가 현재 보기 방식을 그대로 따름

**히스토리**
- 프롬프트 · 검색어 히스토리를 **전용 창**으로 분리 (생성 일시 표시, 최신순 정렬, 개별/전체 삭제, 메인으로 재사용)
- 읽기 경로에서 최신순 정렬 보장

**파일 관리**
- 후보 이미지 파일 삭제 (`app_data_dir` / `Pictures` 허용 루트 검증, `*.geninfo.json` 사이드카 동시 정리)
- 사용자 산출물 저장 시 고유 경로 생성 — 같은 프롬프트 재생성에도 이전 결과를 덮어쓰지 않음

**시나리오 (자동 업데이트)**
- 공급자 우선순위 · On/Off 토글 · 자동 실행 간격 · 검색어 순환
- 실패 백오프 및 실행 조건(provider configured) 게이팅

**다국어**
- 한국어 / 영어 완전 지원 — 모든 사용자 노출 문자열이 i18n 사전 경유
- React 외부 모듈 스코프용 접근자(`th`, `setActiveLang`) 제공

**네트워크 견고성**
- 구조화된 HTTP 오류(`kind` · `status` · `url` · `body_snippet`)로 실패 원인 노출
- 일시적 오류(429 / 5xx / 타임아웃) 지수 백오프 재시도, `Retry-After` 존중
- Pollinations 무료 한도(HTTP 402 `FREE_LIMIT`) 별도 분류 및 재시도 시각 안내
- `content-type` 검증으로 오류 페이지를 이미지로 오인하지 않음

**릴리스 · 검증 인프라**
- `npm run release:build` — Tauri 번들 빌드(NSIS · MSI). Rust 릴리스 컴파일이 길어 `beforeBuildCommand` 가 웹 번들을 먼저 만든다
- `npm run release:check` — 버전 3곳 정합 · CHANGELOG 릴리스 섹션 · 산출물 실재 + **파일명 버전 포함**까지 검증
- `scripts/verify-release.mjs` — 릴리스 계약 검사기 (계약 모드 / `--require-artifacts` 산출물 모드)
- 저장소 위생 검사기 `scripts/verify-repo-hygiene.mjs` — 비밀정보 · 빌드 산출물 · 로컬 절대경로 추적 차단
- 계약 검증 스크립트 29종 (`scripts/verify-*.mjs`) 및 일괄 러너 `node scripts/run-all-verify.mjs`
- IPC 이름 + 인자 키 ↔ Rust 시그니처 대조, i18n 키 계약, seed 정책, 미리보기 모드, 창 생성 async 규칙, 메타데이터 단일 소스 검증
- Windows 편의 배치 파일 (인스톨러 빌드 · 실행 · 종료 · 검사)

**문서**
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`(MIT)
- `docs/` — 아키텍처 · 사용 매뉴얼 · Cloudflare 시나리오 설계 · 전기능 검증 보고서 · 상용화 준비도 감사

### Changed

- 프론트엔드 번들 크기 최적화 및 미리보기 패널 폭 확대(320px → 380px)
- 앱 메타데이터(버전 · 제작자 · 라이선스)를 워크스페이스 단일 소스로 통합 — 표시 버전은 `1.0` 으로 포매팅하되 semver 소스는 `1.0.0` 유지

### Fixed

- 히스토리 창이 흰 화면으로 뜨고 닫히지 않던 문제 (동기 커맨드에서 창 생성 → 메인 스레드 재진입) — `async fn` 전환, 메인 창 종료 시 전체 종료
- 미리보기 보기 형식을 바꿔도 크기가 동일하던 문제 (고정 180px 높이)
- 같은 프롬프트로 반복 생성 시 동일 seed가 재사용되던 문제
- 시나리오 tick 경로에서 seed 카운터가 전진하지 않던 문제
- Cloudflare 검색이 prompt로 폴백되던 문제 (`search_queries` 필수화)

### Security

- IPC 응답에서 API 키 마스킹 (`get_scenario`)
- `open_external_url` 스킴 화이트리스트(http/https)
- 파일 삭제 허용 루트 검증
- 저장소에 하드코딩된 API 키 없음 — 테스트 픽스처는 가짜 값만 사용

### Known limitations

- API 키가 `scenario.json` 에 평문 저장됨 (암호화 미적용)
- 코드 서명 · 자동 업데이트 · CSP 미적용
- 단일 인스턴스 미보장

---

## [0.2.0] — 2026-10-24

CLI → Windows GUI 전환 릴리스 (내부 개발 버전, 공개되지 않음).

### Changed

- CLI 인터페이스 폐기, Tauri v2 + React 19 GUI 로 전면 개편
- Rust 코어(`wallmagic-core`)를 라이브러리로 유지하고 GUI가 그대로 링크

### Added

- NSIS / MSI 인스톨러 번들 생성 (`npm run tauri build`)

---

## [0.1.0] — 2026-10-23

최초 내부 프로토타입 (CLI).

### Added

- `wallmagic-core` — 이미지 검증 · 스테이징 · `IDesktopWallpaper` COM / `SystemParametersInfoW` 이중화 · 스냅샷/복원
- CLI 액션 4종: `get` / `set` / `generate` / `restore`
