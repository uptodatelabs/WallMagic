# WallMagic v1.0.0 릴리스 노트 / Release Notes

- 릴리스일 / Released: 2026-10-28
- 태그 / Tag: [`v1.0.0`](https://github.com/uptodatelabs/WallMagic/releases/tag/v1.0.0)
- 저장소 / Repository: <https://github.com/uptodatelabs/WallMagic>

[한국어](#한국어-korean) · [English](#english)

> 이 문서는 **한국어 원문 + English 번역을 1:1 구조로 병기**한다. 절·불릿·코드블록 수가 어긋나면
> `node scripts/verify-release.mjs` 가 실패한다. GitHub Release `v1.0.0` 본문과 같은 내용이다.

---

## 한국어 (Korean)

첫 공개 릴리스. Windows 바탕화면 **검색 · 생성 · 적용 · 복원** 전체 흐름을 하나의 앱으로 제공합니다.

### 설치

- `WallMagic_1.0.0_x64-setup.exe` — NSIS 인스톨러(권장). 설치 마법사가 시작 메뉴와 제거 항목을 등록합니다
- `WallMagic_1.0.0_x64_en-US.msi` — MSI 패키지. 그룹 정책·관리 배포용입니다
- `wallmagic-app.exe` — 포터블 실행 파일. 설치 없이 실행합니다
- 서명이 없어 Windows SmartScreen 경고가 표시됩니다 — "추가 정보" → "실행"으로 진행합니다

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
- 계약 검증 스크립트 30종 (`scripts/verify-*.mjs`) 및 일괄 러너 `node scripts/run-all-verify.mjs`
- IPC 이름 + 인자 키 ↔ Rust 시그니처 대조, i18n 키 계약, seed 정책, 미리보기 모드, 창 생성 async 규칙, 메타데이터 단일 소스 검증
- Windows 편의 배치 파일 (인스톨러 빌드 · 실행 · 종료 · 검사)

**문서**
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`(MIT)
- `docs/` — 아키텍처 · 사용 매뉴얼 · Cloudflare 시나리오 설계 · 전기능 검증 보고서 · 상용화 준비도 감사

**트레이 · 자동 시작 · 자동 전환**
- **트레이 상주** — 창 닫기(X)를 `CloseRequested` 에서 가로채 프로세스를 유지하고 트레이로 숨긴다. 트레이 메뉴 5종(열기 · 숨기기 · 시나리오 수동 선택 · 자동 시작 토글 · 종료). 프로세스 종료 경로는 트레이 "종료"뿐이므로 상주 중 자동 전환이 계속 돈다.
- **단일 인스턴스 보장** — `tauri-plugin-single-instance` 를 최우선 등록. 두 번째 실행은 새 프로세스를 만들지 않고 기존 창을 앞으로 가져온다. 설정·`history.json` 동시 쓰기와 시나리오 틱 2배 실행을 막는다.
- **로그인 자동 시작** — `tauri-plugin-autostart` 로 Windows Run 키 등록을 위임. IPC `get_autostart_enabled` / `set_autostart_enabled` 는 내부 플래그가 아니라 **OS 등록 상태를 진실의 원천**으로 읽고, 설정 후 `is_enabled()` 로 재확인한 실제 값을 반환한다.
- **시나리오 자동 전환 백그라운드 스케줄러** — `spawn_scenario_timer` 가 Rust 스레드에서 60초 주기로 규칙 평가 → `tick_scenario` 를 실행하고 `scenario://auto-applied` · `scenario://auto-tick-failed` 이벤트로 UI 에 알린다. 프론트 `setInterval` 방식은 창을 트레이로 숨기면 WebView2 타이머 스로틀링으로 주기가 늘거나 멈추고, 히스토리 창이 함께 뜨면 틱이 2배로 돌았다.
- **자동 전환 규칙의 디바운스 · 쿨다운** — 조건이 연속 참인 시간과 전환 직후 재발동 금지를 분리해 시간 경계에서의 연속 전환을 막는다.

**문서 (README)**
- README 에 **후원(Support) 섹션** 추가 — GitHub Sponsors · Ko-fi 실링크와 배지
- README **영문 섹션에 트레이 · 자동 시작 · 자동 전환 절 추가** — 한글 §와 동일 구조로 한/영 대칭 유지

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
- **릴리스 바이너리에서 소스 경로 제거** — Rust 는 panic 위치(`Location`)와 `file!()` 에 절대경로를 그대로 넣는다. `scripts/release-build.cmd` 가 `--remap-path-prefix` 로 사용자 프로필과 체크아웃 경로를 치환해 빌드하고, `verify-release` 가 `.exe` 안의 `\Users\<이름>` 패턴을 스캔해 허용 이름 외 잔존 시 실패시킨다 (리맵 전 실측 541건 → 리맵 후 0건)

### Known limitations

- API 키가 `scenario.json` 에 평문 저장됨 (암호화 미적용)
- 코드 서명 · 자동 업데이트 · CSP 미적용
- 배포 산출물은 서명되지 않아 Windows SmartScreen 경고가 표시된다

---

## English

The first public release. WallMagic brings the whole Windows desktop wallpaper workflow — **search, generate, apply, restore** — into a single app.

### Installation

- `WallMagic_1.0.0_x64-setup.exe` — NSIS installer (recommended). The wizard registers Start Menu and uninstall entries.
- `WallMagic_1.0.0_x64_en-US.msi` — MSI package for Group Policy and managed deployment.
- `wallmagic-app.exe` — Portable executable; runs without installation.
- The builds are unsigned, so Windows SmartScreen shows a warning — choose "More info" → "Run anyway".

### Added

**Core features**
- Applies wallpapers through `IDesktopWallpaper` COM as the primary path, with `SystemParametersInfoW` as a fallback
- Per-monitor wallpapers, six layout modes, snapshot-based restore of the previous wallpaper (Zero-Black-Screen)
- Local library plus remote image search (keyword and resolution filters, rotating query list)
- Five AI image providers: Pollinations (free) · Cloudflare Workers AI · OpenAI Images · Puter · Search
- Provider credential management with masking in IPC responses

**Seed control**
- Three-mode seed policy: `random` (default) / `incremental` / `fixed`
- `fresh_seed` built from nanosecond time plus a process nonce — generating twice in the same second still yields different seeds
- Per-provider seed support gating (Cloudflare for flux models only; never sent to OpenAI, which does not support it)
- Shows **only the hint for the selected provider**

**Preview · viewer**
- The three viewer modes (fit / fill / actual) now change the real render size by switching the container height
- Loads the original resolution (`load_preview_image`) so the image stays sharp in full screen
- The full-screen viewer follows the currently selected view mode

**History**
- Prompt and query history moved into a **dedicated window** (timestamp, newest-first order, delete one / delete all, reuse from the main window)
- Newest-first ordering is guaranteed on the read path

**File management**
- Deleting candidate image files (allowed-root validation for `app_data_dir` / `Pictures`, cleaning up the `*.geninfo.json` sidecar at the same time)
- Unique path generation when saving user output — regenerating the same prompt never overwrites the previous result

**Scenario (auto update)**
- Provider priority · on/off toggles · auto-run interval · rotating query list
- Failure backoff and run gating on the provider-configured condition

**Internationalization**
- Full Korean / English support — every user-facing string goes through the i18n dictionary
- Accessors for module scope outside React (`th`, `setActiveLang`)

**Network robustness**
- Structured HTTP errors (`kind` · `status` · `url` · `body_snippet`) expose the failure cause
- Exponential backoff retries for transient errors (429 / 5xx / timeout), honouring `Retry-After`
- Pollinations free-tier limit (HTTP 402 `FREE_LIMIT`) classified separately, with the retry time shown
- `content-type` validation so an error page is never mistaken for an image

**Release · verification infrastructure**
- `npm run release:build` — Tauri bundle build (NSIS · MSI). Because the Rust release compile is long, `beforeBuildCommand` builds the web bundle first
- `npm run release:check` — validates version agreement across three files, the CHANGELOG release section, and artifact presence **including the version in the file name**
- `scripts/verify-release.mjs` — release contract checker (contract mode / `--require-artifacts` artifact mode)
- Repository hygiene checker `scripts/verify-repo-hygiene.mjs` — blocks secrets, build outputs and local absolute paths from being tracked
- 30 contract verification scripts (`scripts/verify-*.mjs`) and the batch runner `node scripts/run-all-verify.mjs`
- Checks for IPC names and argument keys against Rust signatures, the i18n key contract, the seed policy, preview modes, the async window-creation rule and metadata single-source agreement
- Windows helper batch files (build installer · run · quit · check)

**Documentation**
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE` (MIT)
- `docs/` — architecture, user manual, Cloudflare scenario design, full-feature verification report, commercial readiness audit

**Tray · autostart · automatic switching**
- **Tray residency** — closing the window (X) is intercepted in `CloseRequested`, the process stays alive and the window is hidden to the tray. Five tray menu items (open · hide · pick scenario · toggle autostart · quit). The only exit path is the tray "Quit" item, so automatic switching keeps running while resident.
- **Single-instance guarantee** — `tauri-plugin-single-instance` is registered first. A second launch does not create a new process; it brings the existing window to the front. This prevents concurrent writes to settings and `history.json`, and stops the scenario tick from running twice.
- **Logon autostart** — delegates Windows Run-key registration to `tauri-plugin-autostart`. The `get_autostart_enabled` / `set_autostart_enabled` IPC commands read the **OS registration state as the source of truth** instead of an internal flag, and return the actual value re-read with `is_enabled()` after setting.
- **Background scheduler for automatic scenario switching** — `spawn_scenario_timer` runs on a Rust thread every 60 seconds, evaluates rules, then calls `tick_scenario`, and notifies the UI with the `scenario://auto-applied` and `scenario://auto-tick-failed` events. The previous frontend `setInterval` approach suffered WebView2 timer throttling — the interval stretched or stopped once the window was hidden to the tray, and the tick ran twice whenever the history window was open.
- **Debounce and cooldown for switching rules** — separates how long a condition must stay continuously true from the ban on re-firing right after a switch, preventing back-to-back switches at time boundaries.

**Documentation (README)**
- Added a **Support section** to the README — GitHub Sponsors and Ko-fi badges with real links
- Added tray · autostart · automatic switching sections to the **English README**, mirroring the Korean structure one-to-one

### Changed

- Optimized the frontend bundle size and widened the preview panel (320px → 380px)
- Unified app metadata (version · author · license) into a single workspace source — the displayed version is formatted as `1.0` while the semver source stays `1.0.0`

### Fixed

- The history window opened as a blank screen and could not be closed (window creation inside a synchronous command → main-thread re-entry) — converted to `async fn`, and the app now exits when the main window closes
- Changing the preview view mode did not change the size (fixed 180px height)
- The same seed was reused when regenerating with the same prompt
- The seed counter did not advance on the scenario tick path
- Cloudflare search fell back to `prompt` (made `search_queries` required)

### Security

- API key masking in IPC responses (`get_scenario`)
- Scheme allowlist for `open_external_url` (http/https)
- Allowed-root validation for file deletion
- No hardcoded API keys in the repository — test fixtures use fake values only
- **Source paths removed from release binaries** — Rust embeds absolute paths in panic locations (`Location`) and `file!()`. `scripts/release-build.cmd` builds with `--remap-path-prefix` so the user profile and checkout paths are rewritten, and `verify-release` scans `.exe` files for `\Users\<name>` patterns, failing on any name not on the allowlist (measured 541 hits before remapping → 0 after)

### Known limitations

- API keys are stored in plain text in `scenario.json` (no encryption yet)
- No code signing, automatic updates or CSP yet
- Distributed builds are unsigned, so Windows SmartScreen shows a warning
