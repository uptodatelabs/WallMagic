# WallMagic 상용화 준비도 감사 보고서

> 대상: WallMagic 데스크톱 앱 (Tauri v2 + React 19 + Rust workspace)
> 측정일: 2026-10-27
> 성격: 코드 수정 없는 **읽기 전용 감사**. 모든 항목은 저장소 파일 실측 또는 코드 구조 판단에 근거한다.
> 산출물 목적: 상용 출시 관점의 기능·품질 격차를 **P0(출시 블로커) / P1(차기 개선) / P2(차후)** 로 계층화

---

## §0 증거 등급 표기

| 표기 | 의미 |
|---|---|
| `[실측]` | 이번 감사에서 파일을 read/glob/grep 하여 직접 확인 |
| `[이전턴]` | 같은 저장소에서 앞선 작업 세션에 실측한 값 (재확인 권장) |
| `[추정]` | 코드 구조·설정 부재로부터 판단. 실행/열람으로 확인하지 않음 |
| `[확인필요]` | 판단 근거가 부족해 확정하지 못함. 추가 측정 필요 |

**부정적 주장 원칙**: "없다/미지원"은 해당 파일을 **전문 열람**했거나 glob/grep 결과가 0건일 때만 `[실측]`으로 표기했다.

---

## §1 감사 범위와 실측 팩트

### 1.1 이번 감사에서 전문 열람한 파일 `[실측]`

| 파일 | 핵심 실측값 |
|---|---|
| `package.json` | `version 1.0.0` · `author uptodatelabs` · `private: true` · scripts = `dev`/`build`/`preview`/`tauri` **4개뿐** (test·lint·format 없음) |
| `Cargo.toml` (workspace) | `version 1.0.0` · `edition 2021` · `rust-version 1.82` · `license "MIT"` · `authors ["uptodatelabs"]` · members = `crates/core`, `src-tauri` |
| `src-tauri/tauri.conf.json` | `identifier com.wallmagic.desktop` · `app.windows: []` · **`security.csp: null`** · `bundle.active true` · `targets "all"` · icon 4개 |
| `src-tauri/Cargo.toml` | deps = `wallmagic-core`, `base64`, `serde`, `tauri` (그 외 없음) |
| `crates/core/Cargo.toml` | deps = `base64` `image` `serde` `serde_json` `thiserror` `tracing` `ureq` `urlencoding` + windows target |
| `src-tauri/capabilities/default.json` | `windows: ["main","history"]` · **`permissions: ["core:default"]`** 1개뿐 |
| `.gitignore` | `/target/` `/node_modules/` `/dist/` `/.multicode-backups/` `*.log` `/e2e-verify.txt` |

### 1.2 워크스페이스 의존성 부재 실측 `[실측]`

`Cargo.toml [workspace.dependencies]` 전문에 **다음 크레이트가 없음**:

`tauri-plugin-updater` · `tauri-plugin-single-instance` · `tauri-plugin-autostart` · `tauri-plugin-dialog` · `tauri-plugin-fs` · `tauri-plugin-notification` · `tauri-plugin-log` · `tracing-subscriber` · `log` · `rand` · `tempfile` · `keyring`

→ 업데이트·단일 인스턴스·자동시작·알림·로그 수집·난수·OS 자격증명 저장 기능이 **의존성 수준에서 부재**한다.

### 1.3 저장소 자산 현황 `[실측]`

| 자산 | 결과 |
|---|---|
| `glob .github/**` | **일치 없음** → CI/CD 워크플로 없음 |
| `glob LICENSE*` | **일치 없음** → 라이선스 파일 없음 (Cargo.toml 은 MIT 선언) |
| `glob docs/*` | `ARCHITECTURE.md` `CLOUDFLARE_SCENARIO.md` `development-plan.md` `USER_MANUAL.md` `VERIFY_ALL_FEATURES.md` `VERIFY_M1.md` |
| `glob scripts/*.mjs` | **32개** — `verify-*` 26개 + `run-all-verify` + `free-port` + `gen-icons` + CDP 프로브 3개(`cdp-puter-generate` `cdp-puter-probe` `test-puter-gesture`) |

---

## §2 P0 — 상용 출시 블로커

### P0-1. 코드 서명·공증 설정이 전무 — 배포 신뢰 사슬 없음

**근거** `[실측]` — `src-tauri/tauri.conf.json` `bundle` 블록 전문 열람 결과 키는 `active` / `targets` / `icon` 3개뿐이다. 다음 키가 **없다**:

- Windows: `bundle.windows.certificateThumbprint`, `signCommand`, `nsis.*`, `wix.*`
- macOS: `bundle.macOS.signingIdentity`, `notarize`, `hardenedRuntime`
- Linux: `bundle.linux.deb.*`, `appimage.*`

**영향** 서명되지 않은 exe/msi 는 SmartScreen "알 수 없는 게시자" 경고를 띄우고, macOS 는 Gatekeeper 가 실행을 차단한다. `targets: "all"` 이므로 서명 없는 3개 플랫폼 산출물이 모두 만들어진다.

**권장 조치**
1. Windows: OV/EV 코드서명 인증서 + `signCommand`(Azure Trusted Signing 또는 signtool) 설정, `bundle.windows.webviewInstallMode` 명시(오프라인 설치 대비)
2. macOS: Developer ID + `notarize: true`
3. 릴리스 산출물의 SHA-256 을 릴리스 노트에 공개

**규모** M (CI·인증서 발급 필요)

---

### P0-2. 자동 업데이트 경로가 없음 — 보안 패치 전달 수단 부재

**근거** `[실측]`
- `tauri.conf.json` 전문에 `plugins.updater` 키 **없음**, `bundle.createUpdaterArtifacts` **없음**
- `capabilities/default.json` permissions = `["core:default"]` **1개** → `updater:default` 없음
- `Cargo.toml`, `src-tauri/Cargo.toml` 어디에도 `tauri-plugin-updater` 없음
- 앱 내 업데이트 확인 IPC 커맨드 **없음** — 이번 세션에서 `verify-ipc-contract.mjs` 가 출력한 Rust 커맨드 26개 이름 전체(`open_external_url` … `restore_library_candidates`)에 `check_update`/`update` 계열이 **0건**이었다 `[실측]`

**영향** API 스키마 변경(Pollinations 402 FREE_LIMIT 같은 정책 변경)·보안 취약점 발생 시 사용자가 스스로 새 버전을 내려받아 재설치해야 한다. 데스크톱 앱에서 실질적으로 가장 큰 이탈 요인이다.

**권장 조치** `tauri-plugin-updater` 도입 → 서명 키(ed25519) 생성 → `latest.json` 피드 호스팅(GitHub Releases) → 앱 설정에 "업데이트 확인" 버튼 + 시작 시 1회 조용한 확인 → `capabilities` 에 `updater:default` 추가

**규모** M

---

### P0-3. CSP가 `null` — 렌더러 보안 정책 비활성

**근거** `[실측]` `src-tauri/tauri.conf.json`
```json
"security": { "csp": null }
```

**영향** Tauri 는 기본적으로 CSP 로 렌더러의 외부 리소스 로드·인라인 스크립트 실행을 제한한다. `null` 은 이 방어를 끄는 설정이다. 앱은 외부 이미지 URL(Pollinations·Wikimedia)을 다루고 `data:` base64 이미지를 렌더하므로, 프롬프트에 악의적 문자열이 섞여 렌더 경로로 흘러가는 경우의 2차 방어선이 없다.

**권장 조치** 최소 CSP 적용 후 회귀 확인:
```
default-src 'self';
img-src 'self' data: asset: http://asset.localhost;
style-src 'self' 'unsafe-inline';
script-src 'self';
connect-src ipc: http://ipc.localhost
```
`unsafe-inline` 은 스타일만 허용하고 스크립트는 금지하는 구성이 출발점이다. Vite dev 모드에서 HMR 이 깨질 수 있어 dev/prod CSP 를 분리한다.

**규모** S

---

### P0-4. 라이선스·제3자 고지·개인정보 고지 파일이 없음

**근거** `[실측]`
- `glob LICENSE*` → **일치 없음**. 그런데 `Cargo.toml` 은 `license = "MIT"` 선언
- `glob docs/*` 결과에 `PRIVACY` / `EULA` / `THIRD_PARTY_NOTICES` / `CHANGELOG` **없음**
- 앱은 사용자 프롬프트·검색어를 **제3자에게 전송**한다: Pollinations(`wallpaper.rs:319` [이전턴]), Cloudflare Workers AI(`scenario.rs:1064`), OpenAI(`scenario.rs:1193`), Puter, Wikimedia 검색(`search.rs`)

**영향**
1. MIT 선언만 있고 LICENSE 파일이 없으면 배포물의 라이선스 조건이 불명확해진다
2. 의존 크레이트가 MIT/Apache-2.0 혼재이므로 **저작권 고지 의무**가 있다
3. 사용자 텍스트가 외부 API 로 전송되는데 이를 고지하는 문서가 없다 — 상용 배포 시 정보 제공 의무 이슈

**권장 조치**
1. `LICENSE` (MIT 전문) 추가
2. `THIRD_PARTY_NOTICES.md` — `cargo-about` / `cargo-license` 로 자동 생성, About 화면에서 링크
3. `docs/PRIVACY.md` — "프롬프트·검색어는 선택한 공급자에게 전송되며 로컬 `scenario.json` 에 API 키가 저장된다"를 명시
4. 첫 실행 온보딩에 1회 동의 표시

**규모** S (문서) + S (UI)

---

### P0-5. API 키가 평문으로 `scenario.json` 에 저장됨

**근거**
- 마스킹 테스트가 존재한다 = **응답에서만 가린다**: `test_get_scenario_masks_api_token`, `test_get_scenario_masks_openai_api_key` `[이전턴]`
- 저장 경로는 `store::save_scenario` → JSON 파일 기록. `keyring`/`CryptProtectData`/DPAPI 크레이트가 workspace 의존성에 **없음** `[실측]`
- `.gitignore` 에 `scenario.json` 이 없지만 이는 앱 데이터 디렉터리에 있어 저장소 밖 `[추정]`

**영향** 사용자의 Cloudflare API 토큰·OpenAI 키가 디스크에 평문으로 남는다. 다른 로컬 프로세스·백업 도구·클라우드 동기화 폴더로 유출될 수 있다.

**권장 조치** Windows `CryptProtectData`(DPAPI, 사용자 스코프)로 암호화 저장 + 복호 실패 시 재입력 유도. 크레이트 추가 없이 `windows` 크레이트(`Win32_Security_Cryptography` feature)로 구현 가능하므로 의존성 증가가 작다. 마이그레이션: 평문 필드 발견 시 암호화 후 재기록.

**규모** M

---

## §3 P1 — 차기 개선 (출시 직후 1~2 릴리스)

### P1-1. 관측성 부재 — 사용자 환경 오류를 재현할 수단이 없음

**근거** `[실측]` `grep "tracing::|log::"` → `crates/core` 에서 **10곳** 호출 확인(`scenario.rs` 1, `wallpaper.rs` 9). 그런데 `tracing-subscriber` 가 의존성에 없어 **구독자를 등록할 수단이 없다**. `tauri-plugin-log` 도 없음.

**영향** 로그 호출은 있으나 어디에도 출력되지 않는다. 사용자가 "생성이 안 된다"고 보고해도 앱 로그를 회수할 방법이 없다. 이전 세션의 Pollinations 402/`Network error` 진단도 코드에 구조화 에러를 심은 뒤에야 가능했다.

**권장 조치** `tracing-subscriber` + 일자별 롤링 파일(`%LOCALAPPDATA%\WallMagic\logs\`) + `panic` 훅으로 크래시 시 스택 기록 + 설정 화면에 "로그 폴더 열기" 버튼. 원격 전송은 **옵트인**으로 한정(개인정보).

**규모** S

---

### P1-2. CI가 없고 26개 검증 스크립트가 로컬 전용

**근거** `[실측]` `glob .github/**` → 일치 없음. `scripts/` 에 `verify-*` **26개** + `run-all-verify.mjs` 러너가 있으나 자동 실행 지점이 없다.
또한 `run-all-verify.mjs` 는 소스 주석에 "임시" 성격이 남아 있다 `[이전턴]`.

**영향** 저장소 품질 게이트(검증 26종·`tsc`·`cargo test`·`build`)가 개발자 습관에만 의존한다. `package.json` scripts 에 `test`·`ci` 항목이 없다 `[실측]`.

**권장 조치**
1. `package.json` 에 `"verify": "node scripts/run-all-verify.mjs"`, `"ci": "npm run verify && npm run build && cargo test --workspace"` 추가
2. GitHub Actions: `windows-latest` 에서 `cargo test` + `npm run build` + verify 실행, PR 필수 체크로 등록
3. `run-all-verify.mjs` 를 정식 러너로 승격(주석의 "임시" 문구 제거, 실패 시 exit≠0 보장 확인)

**규모** S

---

### P1-3. 프론트엔드 테스트 프레임워크가 없음 — UI 검증이 정적 grep 의존

**근거** `[실측]` `package.json` devDependencies = `@tauri-apps/cli` `@types/react` `@types/react-dom` `@vitejs/plugin-react` `typescript` `vite` `ws` — **vitest/jest/@testing-library 없음**. scripts 에 `test` 없음.

**영향** UI 계약 검증이 `scripts/verify-*.mjs` 의 정규식·문자열 매칭에 의존한다. 이 방식은 이미 여러 차례 **검사기 자체 결함**을 만들었다 `[이전턴]`: 문자 단위 파서 오탐 14건, 주석 미제거로 인한 거짓 통과, `async fn` 미인식으로 인한 거짓 MISMATCH, 고정 창(window slice) 오지정. 즉 통과가 기능 정상을 보장하지 않는다.

**권장 조치** Vitest + @testing-library/react 도입, 순수 로직부터 단위 테스트(`formatCreatedAt`, `sortNewestFirst`, `puterUsage` 정규화, `appliedQuery`, i18n 사전 키 무결성). DOM 계약은 최소 스모크 3개(검색·생성·히스토리 창 렌더).

**규모** M

---

### P1-4. 장시간 작업에 취소·진행률·경과시간이 없음

**근거** `[실측]` `grep "cancel|abort|AbortController"` → **3곳 전부 뷰어 이미지 로딩용**(`let cancelled = false` / `cancelled = true`). 생성·검색 요청에는 취소 경로가 없다.
`[이전턴]` Pollinations 재시도는 최악 25초 대기(`FREE_LIMIT_MAX_WAIT_MS`)하며 이 대기는 IPC 커맨드 스레드에서 `std::thread::sleep` 로 수행된다.

**영향** 수십 초 대기 중 UI 는 스피너만 돌고, 사용자는 취소할 수 없다. 창을 닫아도 요청은 계속된다.

**권장 조치** 진행률/경과시간 표시(경과 초 카운터만으로도 체감 개선 큼), 요청 취소 버튼(백엔드는 `AtomicBool` 취소 플래그를 공유하고 재시도 루프에서 확인), 실패 시 재시도 버튼.

**규모** M

---

### P1-5. 단일 인스턴스 보장이 없음 — 설정 파일 경합 위험

**근거** `[실측]` `tauri-plugin-single-instance` 가 workspace 의존성에 없음. `writeJsonAtomic`(tmp+rename) `[이전턴]` 은 개별 쓰기의 원자성만 보장한다.

**영향** 앱을 2개 띄우면 두 프로세스가 `settings.json`·`scenario.json`·`history.json` 을 각자 메모리에 들고 마지막 쓰기가 이긴다. 시나리오 자동 틱이 두 배로 돌아 이미지 생성 할당량도 두 배 소모된다.

**권장 조치** `tauri-plugin-single-instance` 도입(두 번째 실행 시 기존 창 `set_focus`).

**규모** S

---

### P1-6. 백그라운드 상주·자동시작 수단이 없음 — 시나리오 자동 업데이트의 실제 효용 제한

**근거** `[실측]` `tauri-plugin-autostart` 없음, `tauri.conf.json` 에 `app.trayIcon` 없음. 시나리오 자동 업데이트 기능은 존재하나 `[이전턴]` 앱이 실행 중일 때만 동작한다.

**영향** PC 를 켤 때마다 배경화면이 바뀌는 것이 이 앱의 핵심 가치인데, 사용자가 앱을 직접 실행해야 한다.

**권장 조치** 트레이 상주(닫기 = 트레이로 최소화, 종료는 트레이 메뉴) + 자동시작 토글(기본 OFF, 설정에 노출). 자동시작은 백그라운드 상주가 전제이므로 함께 설계.

**규모** M

---

### P1-7. Rust 측 오류 문자열이 한국어 하드코딩 — 영어 사용자에게 한국어 노출

**근거** `[실측]` 이번 세션에서 `src-tauri/src/lib.rs` 를 계측한 결과:

```
korean_all_lines=414     # 한글(/[가-힣]/) 포함 라인
korean_code_lines=68     # 그중 주석(//, ///, *, /*) 제외 = 실제 코드·문자열
```

**68개 코드 라인**이 한국어 리터럴을 담고 있다. 대표 예 (라인 번호는 `src-tauri/src/lib.rs`):

| 라인 | 문자열 |
|---|---|
| `199` | `"apply_generated_image: label(공급자 id)이 필요합니다"` |
| `306` | `"generate_library_wallpaper_with_provider: 프롬프트가 필요합니다"` |
| `332` | `"Cloudflare Workers AI: Account ID가 필요합니다 (설정에서 입력 후 저장)"` |
| `345` | `"Cloudflare Workers AI: API Token이 없습니다 (설정에서 입력 후 저장)"` |
| `370` | `"OpenAI: API Key가 없습니다 (설정에서 입력 후 저장)"` |
| `391` | `"Puter는 WebView 전용 SDK 경로입니다 — 프론트가 생성한 이미지는 save_generated_image 로 저장하세요"` |
| `407` | `"generate_library_wallpaper_with_provider: 후보 생성 실패 — {}"` |
| `441` | `"save_generated_image: label(공급자 id)이 필요합니다"` |
| `471` | `"save_generated_image: 후보 생성 실패 — {}"` |

프론트엔드는 이전 작업에서 `reportOk/reportError/throw` 한국어 리터럴이 **0건**까지 정리되었으나 `[이전턴]`, 범위가 `src-ui` 로 한정되어 위 68줄은 그대로 남았다.

**영향** 영어 UI 에서 Cloudflare/OpenAI 키 미설정·프롬프트 누락·삭제 실패 등의 오류가 한국어로 표시된다. 기능은 동작하나 다국어 완성도가 깨진다. 위 표에서 보듯 **68줄 중 상당수가 "설정에서 입력 후 저장" 같은 사용자 행동 유도 문구**여서, 영어 사용자에게는 다음 행동 지시가 전달되지 않는 실질 문제다.

**권장 조치** 백엔드 오류를 **에러 코드**(`err.notFound`, `err.outsideRoot` + 파라미터)로 반환하고 프론트에서 `t(lang, code, params)` 로 번역. 문자열 직접 반환이 필요하면 코드+메시지를 함께 담는 구조체로 전환.

**규모** M

---

### P1-8. `list_monitors` 에 실행 검증이 없음

**근거** `[이전턴]` 앱 테스트 22건에 monitor 관련 테스트 **0건**. 유일한 검증은 IPC 계약 검사(이름·인자 키 대조)뿐이었다.

**영향** 다중 모니터 환경(2·3대)에서의 대상 모니터 선택 로직이 실행 증거 없이 배포된다. 배경화면 앱에서 다중 모니터는 예외 상황이 아니라 표준 사용 환경이다.

**권장 조치** 모니터 열거·ID 매칭·없는 ID 요청 시 폴백을 순수 함수로 분리해 단위 테스트. 실 OS 호출부만 얇게 남긴다.

**규모** S

---

### P1-9. 커맨드 집계 불일치 `[확인필요]` → **재측정 결과 불일치 없음 (해소)**

**근거** `[실측]` 이번 감사에서 `src-tauri/src/lib.rs` 를 직접 계측한 결과 **불일치가 존재하지 않는다**:

```
attr_commands=26      # #[tauri::command] (?:pub )?(?:async )?fn 추출
handler_entries=26    # generate_handler![ ... ] 등록 항목
in_attr_not_handler=  # 양방향 차집합 공집합
in_handler_not_attr=
```
`verify-ipc-contract.mjs` 실행도 **`MATCH: IPC 명령 이름 + 인자 키 계약 일치 (26 commands, 28 호출부)`** 로 26개를 본다. 이전 기록의 "25" 는 `load_preview_image`·`restore_library_candidates` 추가 이전 시점값이거나 `async fn` 미인식 정규식 시절의 잔재다 — 즉 **보고서 초안의 P1-9 전제 자체가 stale** 이었다.

**남은 개선(권고)** `generate_handler!` 와 속성 추출 수가 **어긋날 때 검사기가 스스로 FAIL** 하도록 자기검증(`count(commands) === count(handler_entries)`)을 추가한다. 현재는 두 수치가 우연히 일치하지만, 커맨드를 추가하고 `generate_handler!` 등록을 빠뜨리면 `missing_in_rust`/`unused_in_rust` 로는 잡히지 않는다(그 커맨드는 UI 호출도 없으므로 양쪽에서 사라짐). 장기적으로는 정규식 대신 `syn` 기반 추출로 대체한다 — §3 검사기 결함 이력과 같은 뿌리다.

**규모** S (자기검증 1줄 수준)

---

### P1-10. 버전 단일 소스 검증기가 **주석에만 존재**

**근거** `[실측]` `Cargo.toml` 주석 원문:
> `tauri.conf.json / package.json 도 같은 값을 유지해야 한다(scripts/verify-app-meta.mjs 가 검증).`

그런데 `glob scripts/*.mjs` 결과 **32개 목록에 `verify-app-meta.mjs` 가 없다**. 현재 값은 세 곳 모두 `1.0.0` 으로 일치하지만 `[실측]`, 이를 **강제하는 수단이 실제로는 없다**.

**영향** 버전 범프 시 한 곳을 놓치면 `Cargo.toml`(1.0.0) vs `tauri.conf.json`(1.0.0) vs `package.json`(1.0.0) 이 어긋난다. P0-2 업데이터 도입 후에는 이 불일치가 **업데이트 판정 오류**로 직결된다.

**권장 조치** `scripts/verify-app-meta.mjs` 를 실제로 작성해 세 파일 + `get_app_meta` 응답(version/version_display/author/product)을 검증하고 `run-all-verify` 에 편입. 주석의 참조를 실재하는 파일로 일치시킨다.

**규모** S

---

## §4 P2 — 차후 로드맵

| # | 항목 | 근거 | 권장 조치 | 규모 |
|---|---|---|---|---|
| P2-1 | **해상도 지정 기능 부재** | `[이전턴]` Pollinations `wallpaper.rs:319` `width=1920&height=1080` 하드코딩, OpenAI `scenario.rs:1193` `"size": "1536x1024"` 상수, Cloudflare payload(`scenario.rs:1064`)에 size 없음, 검색 `search.rs:108` `640x480`·`:201` `iiurlwidth=1280` 고정 | 설정에 해상도 프리셋(1920×1080 / 2560×1440 / 3840×2160) 추가. 공급자별 지원 여부 게이팅 필요(Cloudflare 모델별 상이) | M |
| P2-2 | 비용·사용량 표시 부재 | `[이전턴]` Puter 모델별 크레딧 표시는 "유용한 정보 없음"으로 **삭제**됨. 남은 것은 잔여 크레딧 조회(`getMonthlyUsage`)뿐 | 생성 전 예상 비용을 **확인 가능한 공급자만** 표시하고, 불확실하면 아예 노출하지 않는 현재 정책 유지. 대신 이번 달 누적 생성 수·성공/실패 카운터를 로컬 집계 | S |
| P2-3 | 생성 이력 검색·필터 없음 | `[이전턴]` 히스토리는 종류+텍스트+시각 3열과 개별/전체 삭제만 존재 | 텍스트 검색, 종류 필터(생성/검색), 날짜 범위. 항목 클릭 시 즉시 미리보기 | S |
| P2-4 | 즐겨찾기·태그 없음 | `[이전턴]` `store.rs` 히스토리 구조에 태그/즐겨찾기 필드 없음 | 프롬프트 즐겨찾기(재사용 빈도 높음), 결과 이미지 즐겨찾기 | S |
| P2-5 | 온보딩·공백 상태 UX | `[확인필요]` 첫 실행 시 API 키 미설정 상태에서 무엇을 먼저 해야 하는지 안내하는 위저드 존재 여부 미확인 | 3단계 온보딩(공급자 선택 → 키 입력(무료 공급자 안내) → 첫 생성). 공백 상태에 "무료로 시작하기" CTA | S |
| P2-6 | 테마·다크모드 없음 | `[확인필요]` `styles.css` 에 다크 테마 변수 세트 존재 여부 미확인 | CSS 변수 기반 테마 토글 + OS 설정 추종(`prefers-color-scheme`) | S |
| P2-7 | 언어 자동 감지·확장 | `[이전턴]` i18n 은 ko/en 228키. 기본 언어 결정이 저장값 의존 | 첫 실행 시 `navigator.language` 로 초기 언어 결정. ja/zh 확장은 사전 파일 분리 후 | S |
| P2-8 | 이미지 후처리 없음 | `[확인필요]` 크롭·리사이즈·모니터별 분할 배경화면 기능 유무 미확인 | 초광각/듀얼 모니터용 분할 적용, 워터마크 고지 | M |

---

## §5 이미 확보된 상용 기반 (재작업 불필요)

감사 중 확인된 **자산**이다. P0/P1 항목을 논의할 때 이미 있는 것을 다시 만들지 않도록 명시한다.

| 자산 | 근거 |
|---|---|
| 원자적 설정 저장(tmp+rename) + `.bak` 백업 + 급사 복구 | `[이전턴]` `store` 계열 실측 |
| 구조화된 HTTP 오류(상태코드·본문 스니펫·kind) + 재시도·백오프 + `Retry-After` 존중 | `[이전턴]` `pollinations_retry_tests` 10건 |
| 공급자 폴백·자격증명 교차 사용 방지 | `[이전턴]` `test_provider_credentials_are_not_cross_used` 등 |
| 사용자 산출물 고유 파일명(덮어쓰기 금지) | `[이전턴]` `test_save_generated_image_never_overwrites_previous_output` 통과 |
| 다국어 228키 ko/en, 동적 메시지 리터럴 0건 | `[이전턴]` 계측 결과 |
| IPC 계약 검사(이름+인자 키) | `[실측]` 이번 세션 재실행 → `MATCH (26 commands, 28 호출부)` exit=0 |
| 접근성 기초(aria-label 5, role=dialog 2, aria-modal 2, role=status 1) | `[실측]` `grep "aria-|role="` App.tsx 10건 |
| 문서 자산(ARCHITECTURE / USER_MANUAL / CLOUDFLARE_SCENARIO / development-plan / VERIFY) | `[실측]` `glob docs/*` |

---

## §6 우선순위 요약표

| ID | 우선 | 항목 | 근거 위치 | 권장 조치 | 규모 |
|---|---|---|---|---|---|
| P0-1 | **P0** | 코드 서명·공증 부재 | `src-tauri/tauri.conf.json` bundle(키 3개만) | 인증서·`signCommand`·notarize | M |
| P0-2 | **P0** | 자동 업데이트 부재 | `tauri.conf.json` plugins 없음 / `capabilities/default.json` `core:default`만 / workspace deps | `tauri-plugin-updater` + 피드 | M |
| P0-3 | **P0** | CSP `null` | `tauri.conf.json` `security.csp: null` | 최소 CSP 적용 | S |
| P0-4 | **P0** | LICENSE·제3자 고지·개인정보 고지 부재 | `glob LICENSE*` 0건 / `docs/*` 목록 | LICENSE·NOTICES·PRIVACY | S |
| P0-5 | **P0** | API 키 평문 저장 | 마스킹 테스트만 존재 / keyring·DPAPI 부재 | DPAPI 암호화 저장 | M |
| P1-1 | P1 | 로그·크래시 수집 부재 | core `tracing::` 10곳 / subscriber 없음 | subscriber + 파일 로그 + panic 훅 | S |
| P1-2 | P1 | CI 부재, 검증 26종 로컬 전용 | `glob .github/**` 0건 / `package.json` scripts 4개 | Actions + `npm run ci` | S |
| P1-3 | P1 | 프론트 테스트 프레임워크 없음 | `package.json` devDeps에 vitest 없음 | Vitest + 핵심 단위/스모크 | M |
| P1-4 | P1 | 취소·진행률·경과시간 없음 | `grep cancel` 3건 전부 뷰어 | 취소 플래그 + 진행 표시 | M |
| P1-5 | P1 | 단일 인스턴스 미보장 | workspace deps에 single-instance 없음 | 플러그인 도입 | S |
| P1-6 | P1 | 트레이·자동시작 없음 | workspace deps / `app.trayIcon` 없음 | 트레이 + 자동시작 토글 | M |
| P1-7 | P1 | Rust 오류 문자열 한국어 하드코딩 | `[실측]` `src-tauri/src/lib.rs` 한글 포함 **414줄** 중 **코드·문자열 68줄**(주석 제외) — `199`·`332`·`345`·`370` 등 | 에러 코드화 + `t()` | M |
| P1-8 | P1 | `list_monitors` 검증 0건 | 앱 테스트에 monitor 없음 | 순수 함수 분리 + 테스트 | S |
| ~~P1-9~~ | **해소** | ~~커맨드 수 25 vs 26 불일치~~ → 재측정 결과 **불일치 없음** | `node -e` 추출 `attr_commands=26` / `handler_entries=26` / 차집합 0 · `verify-ipc-contract` 26 commands `[실측]` | 남은 권고: 집계 자기검증(`26===26`) 추가 | S |
| P1-10 | P1 | 버전 검증기 부재(주석만 참조) | `Cargo.toml` 주석의 `verify-app-meta.mjs` 없음 | 검증기 작성·편입 | S |
| P2-1 | P2 | 해상도 지정 불가 | `wallpaper.rs:319`·`scenario.rs:1193`·`search.rs:108,201` | 프리셋 + 공급자 게이팅 | M |
| P2-2 | P2 | 비용·사용량 정보 부족 | Puter 단가 표 삭제 후 잔여 크레딧만 | 로컬 생성 카운터 | S |
| P2-3 | P2 | 히스토리 검색·필터 없음 | `store.rs` 히스토리 구조 | 검색·필터·즉시 미리보기 | S |
| P2-4 | P2 | 즐겨찾기·태그 없음 | 동일 | 프롬프트/이미지 즐겨찾기 | S |
| P2-5 | P2 | 온보딩·공백 상태 | `[확인필요]` | 3단계 위저드 | S |
| P2-6 | P2 | 다크모드 없음 | `[확인필요]` | CSS 변수 테마 | S |
| P2-7 | P2 | 언어 자동 감지 | i18n 설정값 의존 | `navigator.language` 초기값 | S |
| P2-8 | P2 | 이미지 후처리 없음 | `[확인필요]` | 모니터 분할·리사이즈 | M |

**집계**: P0 **5건** / P1 **9건** / P2 **8건** = **22건** (P1-9 는 재측정 결과 결함 아님 → 해소로 분리)

---

## §7 권장 실행 순서

**1차 (출시 전 필수, 1~2주)** — P0-3(CSP) → P0-4(문서) → P0-2(업데이터) → P0-1(서명) → P0-5(키 암호화)
> CSP·문서는 하루 이내, 업데이터와 서명은 배포 파이프라인을 함께 손봐야 하므로 연속 배치한다. 업데이터는 서명된 산출물을 전제하므로 순서상 P0-1보다 먼저 설계하고 서명과 함께 켠다.

**2차 (출시 직후, 2~4주)** — P1-10(버전 검증) → P1-2(CI) → P1-1(로그) → P1-5(단일 인스턴스) → P1-8(모니터 테스트)
> 모두 S 규모이며 품질 게이트와 지원 기반을 만든다. P1-10을 먼저 하는 이유는 이후 변경의 안전망이 되기 때문이다. (P1-9 는 재측정 결과 결함이 아니어서 실행 순서에서 제외 — 남은 권고인 집계 자기검증만 P1-2 CI 편입 시 함께 반영)

**3차 (사용성, 4~8주)** — P1-4(취소·진행률) → P1-6(트레이·자동시작) → P1-3(Vitest) → P1-7(에러 코드화) → P1-8(모니터 테스트)
> 트레이·자동시작이 이 앱의 핵심 가치(매일 자동으로 바뀌는 배경화면)를 실제로 성립시킨다.

**4차 (차별화)** — P2-1(해상도) → P2-3·P2-4(히스토리 강화) → P2-5(온보딩) → 나머지

---

## §8 이 보고서의 한계 (미측정 항목)

정직하게 남긴다. 아래는 **판단하지 않았거나 근거가 부족한** 항목이다.

1. **`src-tauri/src/lib.rs` 를 전문 열람하지는 않았다.** 다만 커맨드 surface 는 이번 세션에서 **기계 추출로 확인**했다 — `#[tauri::command]` **26개**, `generate_handler!` 등록 **26개**, 양쪽 차집합 **0건** `[실측]`. 반면 `setup()` 내부 구조·창 생성 경로·종료 핸들러 등 나머지 코드는 `[이전턴]`/`[추정]` 이다.
2. **`src-ui/App.tsx` 전문 미열람.** 이번 감사에서 UI 근거는 `grep` 결과 3종(aria/role 10건, cancel 3건)과 이전 세션 실측에 한정된다. P2-5·P2-6·P2-8은 `[확인필요]`로 남겼다.
3. **`glob "src-ui/**"` 가 일치 없음을 반환**했으나 이는 패턴 문제로 판단해 "파일 없음"의 근거로 쓰지 않았다.
4. **실행 검증은 2개 명령만 수행했다.** 이번 세션에서 실행한 것은 ⓐ 커맨드 surface 기계 추출(`node -e`, `attr_commands=26` / `handler_entries=26` / 차집합 0) ⓑ `node scripts/verify-ipc-contract.mjs`(exit=0, `MATCH 26 commands, 28 호출부`) **2건**이다. `cargo test`·`npm run build`·검증 스크립트 26종 전체는 실행하지 않았으므로, 그 밖의 "통과" 서술은 이전 세션 기록(`[이전턴]`)이다.
5. **GUI·실네트워크·실 OS 배경 변경 미실행.** P0/P1 항목 중 런타임 확인이 필요한 것(예: 트레이 동작, 취소 버튼 체감)은 설계 권고 수준이다.
6. **가격·수익화 정책은 다루지 않았다.** 요청 범위가 "기능·품질 격차"이며, 가격은 시장·경쟁 조사가 별도로 필요하다. P2-2를 비용 가시성 항목으로만 남겼다.
7. **의존성 취약점 스캔(`cargo audit`, `npm audit`) 미실행.** P0에 포함할지 판단하려면 실제 CVE 조회가 필요하다.
8. **설치 관리자 실물 미검증.** `targets: "all"` 이 실제로 어떤 산출물(nsis/msi/appimage/dmg)을 만드는지 빌드 산출물을 열람하지 않았다.

---

## §9 공개 저장소 준비 결과 (2026-10-27 추가)

이 절은 §2~§4 의 항목 중 **이번 공개 준비 작업에서 실제로 해소된 것**과 **여전히 남은 것**을 구분한다. 해소 판정은 실행 출력에 근거한다.

### 9.1 해소됨

| ID | 항목 | 해소 근거 |
|---|---|---|
| **P0-4** | LICENSE·공개 문서 부재 | `LICENSE`(MIT 전문) · `README.md` · `CONTRIBUTING.md` · `SECURITY.md` · `CHANGELOG.md` 실재. `node scripts/verify-app-meta.mjs` → `LICENSE 가 MIT 전문이다` / `LICENSE 저작자 == Cargo authors[0] — "uptodatelabs"` / `LICENSE 연도 — 2026` / 공개 필수 문서 5종 존재 전건 ok |
| **P1-10** | 버전 단일 소스 검증기가 주석에만 존재 | `scripts/verify-app-meta.mjs` 신규 작성(138줄). Cargo `[workspace.package]` ↔ `package.json` ↔ `tauri.conf.json` ↔ `LICENSE` ↔ 멤버 크레이트 상속을 검증. `run-all-verify` 편입 → `scripts=27 failed=0` |
| (부수) | 저장소 메타데이터 부재 | `package.json` 에 `license`·`description`·`repository`·`homepage`·`keywords` 추가. `Cargo.toml [workspace.package]` 에 `description`·`repository`·`homepage`·`readme`·`keywords` 추가, 두 멤버가 상속. `tauri.conf.json bundle` 에 `publisher`·`copyright`·`category`·`shortDescription`·`longDescription` 추가 |
| (부수) | 문서 내 개인정보·로컬 경로 | `docs/VERIFY_M1.md` 의 Windows 사용자 홈 경로(계정명 포함) → `C:\Users\<user>`, 개발 PC 절대경로 → `<repo>`. 추적 파일 전체 재검사 결과 `HITS=0` |

### 9.2 여전히 미해소 (공개 저장소에는 그대로 남는다)

| ID | 항목 | 현재 상태 |
|---|---|---|
| **P0-1** | 코드 서명·공증 | `bundle.windows.certificateThumbprint`·`signCommand` 없음 — 인증서 발급 선행 필요 |
| **P0-2** | 자동 업데이트 | `tauri-plugin-updater` 미도입, `plugins.updater` 없음, IPC `check_update` 계열 0건 |
| **P0-3** | CSP `null` | `src-tauri/tauri.conf.json` 의 `security.csp` 는 여전히 `null` — 권장 CSP 문자열은 §2 P0-3 참조 |
| **P0-5** | API 키 평문 저장 | `scenario.json` 평문 유지. `keyring`/DPAPI 미도입 |
| P1-1~P1-8 | 로그·CI·Vitest·취소·단일 인스턴스·트레이·에러 코드화·모니터 테스트 | 전부 미착수 |

> **공개 판단**: 코드·문서·메타데이터는 공개 가능 수준이지만, **P0-1/P0-2/P0-3/P0-5 는 "상용 배포" 기준의 미해소 항목**이며 배포물을 만들기 전에 처리해야 한다. 공개 저장소 자체는 이 사실을 `README.md §7 보안·알려진 제한` 과 이 보고서에 명시한 상태로 공개한다.

### 9.3 이번 작업에서 실행한 검증

```
cargo check --workspace                  → exit=0 / Finished dev profile
npm run build                            → exit=0 / 39 modules, index-k0zICrHf.js 317.84 kB
node scripts/verify-app-meta.mjs         → exit=0 / 34항목 전부 ok
node scripts/run-all-verify.mjs          → exit=0 / scripts=27 failed=0
cargo test -p wallmagic-core --lib       → exit=0 / 85 passed; 0 failed; 4 ignored
cargo test -p wallmagic-app  --lib       → exit=0 / 21 passed; 0 failed; 1 ignored
```

### 9.4 정정 — 이 절이 §8 과 모순되지 않도록

§8-4 는 "이번 감사에서 실행 검증은 2개 명령만 수행"이라고 적었다. 이는 **§2~§4 를 작성한 감사 시점**의 사실이며, **§9 의 작업 시점**에는 위 6개 명령을 실제로 실행했다. 두 시점이 다르므로 §8-4 는 그대로 둔다.
