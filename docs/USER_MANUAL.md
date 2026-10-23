# WallMagic 사용 매뉴얼 (v0.1.0 — M1 네이티브 코어)

> **대상 버전**: `wallmagic-core` / `wallmagic-cli` / `wallmagic-app` v0.1.0
> **기준 커밋**: M1 검증 완료 시점 (문서 작성 시점 HEAD)
> **플랫폼**: Windows 10 / 11 (COM `IDesktopWallpaper` 1차 경로, `SystemParametersInfoW` 2차 폴백)
> **관련 문서**: `docs/development-plan.md` (개발 계획서), `docs/VERIFY_M1.md` (M1 검증 보고서)

---

## 1. WallMagic란 무엇인가

WallMagic은 Windows PC의 바탕화면을 **자동 검색·생성·설정**하는 프로그램입니다.

현재 M1 단계에서 제공되는 기능은 다음 3가지 축입니다.

| 축 | 설명 |
|---|---|
| **네이티브 배경 제어** | `IDesktopWallpaper` COM API를 1차로 사용하고, 실패 시 `SystemParametersInfoW` 로 자동 폴백합니다. |
| **안전한 적용** | 이미지를 검증(존재·디코딩·최소 640×480)한 뒤 **원자적 스테이징**하고, 기존 배경은 스냅샷으로 보존해 언제든 원복할 수 있습니다(Zero-Black-Screen). |
| **프롬프트 기반 생성** | 외부 API 없이 프롬프트 문자열을 시드로 1920×1080 그라디언트 이미지를 결정론적으로 생성합니다(네트워크·비용 0). |

> **중요**: M1은 **시제품(프로토타입)** 입니다. 실제 사진 검색 API, AI 이미지 생성, 트레이 상주, 자동 스케줄러는 M3~M5에서 추가 예정입니다(§7 참고).

---

## 2. 설치와 빌드

### 2.1 필요 환경

| 항목 | 버전 | 비고 |
|---|---|---|
| Rust | 1.82 이상 | `rust-version = "1.82"` (Cargo.toml 기준) |
| Node.js | 20 이상 (권장) | 프론트엔드(`src-ui`) 빌드용 |
| OS | Windows 10 / 11 | COM/SPI 경로는 Windows 전용 (`#[cfg(windows)]`) |

### 2.2 빌드

```bash
# Rust 워크스페이스 전체 (core / cli / src-tauri)
cargo build --workspace

# 린트 + 포맷 검사
cargo clippy --workspace --all-targets
cargo fmt --all -- --check

# 프론트엔드 번들 (dist/)
npm install
npm run build
```

### 2.3 테스트 실행

```bash
# 전체 테스트 (OS 배경을 건드리지 않는 기본 실행)
cargo test --workspace

# 실제 배경을 변경하는 통합 테스트 (opt-in)
#   → 이 실행은 사용자 desktops의 배경화면을 실제로 바꾸고 되돌립니다.
cargo test -p wallmagic-core -- --ignored
```

기본 실행 결과 기준선: **core 4 passed / 1 ignored, app 1 passed** (총 5 passed, 0 failed).

---

## 3. 빠른 시작 (5분)

```bash
# 1) 현재 적용된 배경화면 경로 조회
cargo run -q -p wallmagic-cli -- get
# 예) C:\Users\<user>\AppData\Local\WallMagic\active\active_xxx_primary.bmp

# 2) 프롬프트로 샘플 배경 생성 (파일에만 저장, 적용하지 않음)
cargo run -q -p wallmagic-cli -- generate "cyberpunk neon street" --out %TEMP%\wm.bmp

# 3) 생성한 이미지를 배경으로 적용
cargo run -q -p wallmagic-cli -- set %TEMP%\wm.bmp --pos fill

# 4) 되돌리기
cargo run -q -p wallmagic-cli -- restore
```

`set` 은 **적용 전에 기존 배경 경로를 스냅샷**으로 저장하므로, 4번 `restore` 로 원래 배경이 복구됩니다.

---

## 4. CLI 사용법 (`wallmagic-cli`)

### 4.1 문법

```
wallmagic-cli <SUBCOMMAND> [OPTIONS]
```

| 서브커맨드 | 설명 |
|---|---|
| `get` | 현재 적용된 데스크톱 배경화면 경로를 출력 |
| `set <PATH> [--pos <STYLE>]` | 이미지를 검증·스테이징 후 배경으로 적용 |
| `generate <PROMPT> [--apply] [--out <PATH>]` | 프롬프트 기반 1920×1080 이미지 생성(선택: 즉시 적용) |
| `restore` | 스냅샷된 이전 배경으로 복원 |
| `-h`, `--help`, `help` | 도움말 출력 (exit 0) |
| `-V`, `--version`, `version` | 버전 출력 (exit 0) |

### 4.2 종료 코드 규약

| 상황 | 출력 | 종료 코드 |
|---|---|---|
| 정상 처리 | stdout | `0` |
| 도움말/버전 | stdout | `0` |
| 알 수 없는 서브커맨드 | stderr에 `error: unknown subcommand or option '...'` + 도움말(stdout) | `1` |
| 알 수 없는 옵션 값 | stderr에 `error: ...` | `1` |
| 필수 인자 누락 | stderr에 `error: ...` + 도움말 | `1` |
| OS API 실패 | stderr에 `error: failed to ...` | `1` |

> **설계 원칙**: 어떤 입력에 대해서도 "버전만 출력하고 exit 0"으로 끝나지 않습니다. 알 수 없는 인자는 항상 stderr + non-zero로 종료합니다.

### 4.3 `get` — 현재 배경 조회

```bash
cargo run -q -p wallmagic-cli -- get
```

- 1차: `IDesktopWallpaper::GetWallpaper` (COM)
- 2차: `SystemParametersInfoW(SPI_GETDESKWALLPAPER)`
- 출력이 비어 있으면 OS에 설정된 배경이 없는 상태입니다.

### 4.4 `set` — 이미지 적용

```bash
wallmagic-cli set <PATH> [--pos <STYLE>]
```

- `<PATH>`: PNG / JPEG / BMP 등 `image` 크레이트가 지원하는 포맷의 **로컬 파일 경로**
- `--pos <STYLE>`: 배치 스타일. 기본값은 `fill`

| 스타일 | 동작 |
|---|---|
| `fill` | 화면을 꽉 채우되 비율 유지 (기본) |
| `fit` | 이미지 전체가 보이도록 축소 |
| `stretch` | 화면 크기로 늘이기 (비율 왜곡) |
| `center` | 원본 크기 그대로 중앙 정렬 |
| `tile` | 타일 반복 |
| `span` | 다중 모니터 전체를 하나의 이미지로 맞춤 |

적용 절차:

1. **검증** — 파일 존재 → 디코딩 성공 → 해상도 ≥ 640×480 (미달 시 `image resolution too low (WxH); minimum is 640x480` 로 거부)
2. **원자적 스테이징** — `<데이터디렉터리>\active\staged_<이름>_<모니터>.bmp` 로 저장 후 `active_<이름>_<모니터>.bmp` 로 원자적 rename
3. **스냅샷** — 현재 OS 배경 경로를 `state.json` 의 `previous_wallpaper` 에 기록
   - *현재 배경이 WallMagic이 스테이징한 파일이면* 스냅샷을 덮어쓰지 않습니다 → 연속 적용해도 원본이 살아남습니다
4. **적용** — COM 1차 → 실패 시 SPI 폴백 → **둘 다 실패하면 스냅샷된 이전 배경을 재적용**해 빈 화면을 방지

성공 시 출력 예시:

```
OK: applied wallpaper 'C:\Users\<user>\AppData\Local\WallMagic\active\active_wm_doc_demo_primary.bmp' via IDesktopWallpaper (COM)
```

`via ...` 부분으로 어떤 백엔드가 실제로 성공했는지 확인할 수 있습니다.

### 4.5 `generate` — 프롬프트 기반 이미지 생성

```bash
wallmagic-cli generate <PROMPT> [--apply] [--out <PATH>]
```

- `<PROMPT>`: 자유 텍스트. 문자열을 FNV-1a 해시로 시드 삼아 **결정론적** 1920×1080 그라디언트를 생성합니다 (같은 프롬프트 → 같은 이미지).
- `--out <PATH>`: 저장 경로. 미지정 시 `<데이터디렉터리>\generated_prompt.bmp`
- `--apply`: 생성 직후 배경으로 적용

> **주의**: 현재 생성기는 **순수 절차적 그라디언트**입니다. 사진이나 AI 생성 이미지가 아닙니다. 프롬프트는 색상 팔레트를 파생하는 시드로만 사용됩니다.

### 4.6 `restore` — 원복

```bash
wallmagic-cli restore
```

- `state.json` 의 `previous_wallpaper` 를 읽어 그 경로의 이미지를 다시 배경으로 적용합니다.
- 스냅샷이 없으면 `no previous wallpaper snapshot available to restore` 로 실패(exit 1).
- 스냅샷 파일이 삭제/이동되었으면 `file not found: ...` 로 실패(exit 1) — 이 경우 **원래 배경으로 자동 복구되지 않으니** 백업 경로를 확인하세요.

---

## 5. 데이터 디렉터리와 환경변수

### 5.1 경로 해석 순서

`app_data_dir()` 는 아래 순서로 결정됩니다.

| 순위 | 경로 | 용도 |
|---|---|---|
| 1 | `WALLMAGIC_DATA_DIR` 환경변수 | 명시적 오버라이드 (테스트·다중 프로필용) |
| 2 | `%LOCALAPPDATA%\WallMagic` | 기본값 |
| 3 | `%TEMP%\WallMagic` | `LOCALAPPDATA` 가 없을 때 폴백 |

`WALLMAGIC_DATA_DIR` 는 **state 파일과 스테이징 디렉터리 전체**를 함께 리다이렉트합니다. 빈 문자열/공백 값은 오버라이드로 인정하지 않습니다.

### 5.2 디렉터리 구조

```
<데이터디렉터리>\
├── state.json                  # 스냅샷/현재 배경/사용 백엔드
├── generated_prompt.bmp        # generate 기본 출력
└── active\
    ├── staged_<stem>_<monitor>.bmp    # 검증 통과한 임시 파일
    └── active_<stem>_<monitor>.bmp    # 실제 적용되는 스테이징 파일
```

### 5.3 `state.json` 스키마

```json
{
  "previous_wallpaper": "D:\\path\\to\\original.jpg",
  "current_wallpaper": "D:\\path\\to\\current.jpg",
  "backend_used": "IDesktopWallpaper (COM)"
}
```

| 필드 | 의미 |
|---|---|
| `previous_wallpaper` | `restore` 로 되돌릴 대상 (사용자 원본 배경) |
| `current_wallpaper` | 마지막으로 WallMagic이 적용한 스테이징 경로 |
| `backend_used` | 마지막 적용에 사용된 백엔드 표기 |

### 5.4 환경변수로 격리 실행 (권장 예시)

```bash
cmd /c "set WALLMAGIC_DATA_DIR=D:\path\to\wm_profile&& wallmagic-cli set D:\path\to\img.bmp --pos fill"
```

PowerShell:

```powershell
$env:WALLMAGIC_DATA_DIR = "D:\path\to\wm_profile"
wallmagic-cli set D:\path\to\img.bmp --pos fill
```

---

## 6. GUI (`src-ui`) 및 IPC 명령

### 6.1 상태

M1에서 `src-tauri` 는 **Tauri 런타임 없이 순수 Rust IPC 래퍼**로 동작합니다. `#[tauri::command]` 매크로와 `invoke_handler` 연결은 M5 예정입니다. 따라서 지금은 `npm run dev` 로 띄운 웹 화면에서 `invoke()` 가 실제 백엔드에 닿지 않습니다(프론트엔드 빌드/타입체크는 통과하지만 Tauri 런타임 미연결).

### 6.2 IPC 명령 계약 (`src-tauri/src/lib.rs`)

| 명령 | 인자 | 반환 | 비고 |
|---|---|---|---|
| `get_current_wallpaper` | `monitor_id: Option<String>` | `String` | 현재 배경 경로 |
| `set_wallpaper` | `path: String`, `monitor_id: Option<String>`, `position: Option<String>` | `WallpaperState` | `position` 미지정 시 `fill` |
| `restore_wallpaper` | `monitor_id: Option<String>` | `WallpaperState` | 스냅샷 복원 |
| `generate_and_apply_wallpaper` | `prompt: String`, `monitor_id: Option<String>`, `position: Option<String>` | `WallpaperState` | 생성 후 적용 |

`position` 허용값: `center | tile | stretch | fit | fill | span`. 그 외 값은 `invalid position '<x>' (expected: ...)` 로 거부됩니다.

### 6.3 화면 구성 (`src-ui/App.tsx`)

1. **현재 적용된 배경화면 경로** 표시
2. **프롬프트 기반 생성 및 즉시 적용** (입력 + `생성 및 적용` 버튼)
3. **로컬 이미지 경로 직접 지정 + 배치 스타일 선택 + 적용**
4. **이전 배경으로 원복 / 현재 배경 새로고침** 버튼

---

## 7. 문제 해결 (Troubleshooting)

| 증상 | 원인 | 조치 |
|---|---|---|
| `image resolution too low (320x240); minimum is 640x480` | 입력 이미지가 하한 미달 | 640×480 이상 이미지 사용 |
| `file not found: <path>` | 경로 오타 또는 파일 이동/삭제 | 경로 확인. `restore` 실패 시 스냅샷 파일이 살아 있는지 확인 |
| `no previous wallpaper snapshot available to restore` | 아직 `set` 을 한 번도 하지 않았거나 `state.json` 이 없음 | `set` 실행 후 `restore` |
| `io error: 지정된 경로를 찾을 수 없습니다. (os error 3)` | 데이터 디렉터리 경로에 공백/따옴표가 섞인 `set VAR=... &` 사용 | `cmd /c "set VAR=값&& 명령"` 형태 또는 PowerShell `$env:` 사용 |
| 화면이 검게 보임 | COM·SPI 모두 실패 | WallMagic은 실패 시 스냅샷을 재적용합니다. 그래도 검다면 `restore` 실행 |
| `set` 후 `restore` 했는데 원본이 아닌 이전 WallMagic 이미지로 돌아옴 | 1차 적용에서 이미 WallMagic 스테이징 파일이 활성화된 상태 | 정상 동작입니다. `state.json` 의 `previous_wallpaper` 가 원본 경로인지 확인 |
| 다중 모니터에서 원하는 화면만 바뀌지 않음 | M1은 `monitor_id` 미지정 시 **전체 모니터**에 동일 적용 | 현재 CLI에는 모니터 지정 옵션이 없습니다(§8 후보 ①) |
| 테스트가 사용자 배경을 바꿨다 | `--ignored` 옵션 실행 | 기본 `cargo test --workspace` 는 OS 배경을 건드리지 않습니다 |

---

## 8. 알려진 제약 (M1)

1. **모니터별 개별 지정 미지원** — `set_wallpaper` 코어는 `monitor_id` 파라미터를 받지만, CLI에는 노출된 옵션이 없고 `None`(=전체 모니터 적용)만 사용됩니다.
2. **SPI 폴백 경로 미실측** — 이 PC에서 COM 1차가 항상 성공해 폴백이 발동하지 않았습니다(컴파일·클리핑만 통과).
3. **잘못된(손상된) 이미지의 "기존 배경 유지" 시나리오 미실측** — 해상도 하한 거부는 단위 테스트로 확인, 확장자 위장 텍스트 파일은 미실측.
4. **프롬프트 생성기는 그라디언트 한정** — 사진/AI 이미지가 아닙니다.
5. **Tauri 런타임 미연결** — `src-ui` 는 현재 동작 데모가 아니라 계약 정의 수준입니다.
6. **잠금화면(Lock Screen) 배경 미지원**.
7. **트레이 상주·자동 스케줄러 미구현** — 자동 변경이 필요하면 `set` 을 예약 실행하는 외부 스케줄러를 사용하세요(예: `schtasks`).
8. **exe/인스톨러 패키징 미수행** — `tauri build` 는 아직 산출물을 만들지 않습니다.

---

## 9. 후속 작업 후보 (우선순위 제안)

아래는 M1 이후 구현 후보 목록입니다. **이번 턴에는 실행하지 않았습니다** (문서화만).

### 9.1 M2 — 데이터/보안 기반

| # | 후보 | 근거·효과 |
|---|---|---|
| 1 | `secrets.bin` 저장소 + Windows DPAPI 암호화 | 계획서 §8.5. API 키를 평문으로 두지 않기 위한 선행 작업 |
| 2 | `config.json` 도입 | 지금은 `state.json` 만 존재. 사용자 설정(배치 스타일 기본값, 자동 변경 주기 등) 분리 |
| 3 | `credits/<sha>.json` 어트리뷰션 저장소 | 나중에 외부 이미지 API를 붙일 때 저작권 출처 기록 기반 필요 |
| 4 | `quota.json` 일일 요청 상한 | M3 검색 API 도입 시 비용 0 보장 장치 |

### 9.2 M3 — 이미지 검색 연동

| # | 후보 | 근거 |
|---|---|---|
| 5 | `net.rs` 아웃바운드 호스트 화이트리스트 | 계획서 §17.2. **화이트리스트에 `thumb.wikimedia.org` 추가 필수**(§7.3 함정 3) |
| 6 | Met Museum 어댑터 (`/v1.1/search`, `isPublicDomain` 필터) | 실측 확정된 계약 |
| 7 | Wikimedia Commons 어댑터 (`imageinfo.width` 기준 판정, `thumburl` 미사용) | 거짓 `thumbwidth` 보고 실측 대응 |
| 8 | NASA 이미지 어댑터 | 실측된 2800×1400 등 해상도 규칙 반영 |
| 9 | SHA-256 중복 제거 + 최근 N장 회피 링 버퍼 | 반복 노출 방지 |

### 9.3 M3/M5 — CLI·UX 개선

| # | 후보 | 근거 |
|---|---|---|
| 10 | **CLI에 `--monitor <ID>` 옵션 추가** | §8-1의 제약 해소. 코어 `monitor_id` 인자는 이미 존재 |
| 11 | `list` / `history` 서브커맨드 (적용 이력 조회) | 스냅샷은 1개뿐이라 여러 번 변경 시 원복 대상이 첫 상태로 유지됨 |
| 12 | `set --no-snapshot` 옵션 | 스냅샷을 덮어쓰지 않고 적용만 하는 용도 |
| 13 | JSON 출력 모드 (`--json`) | 스크립트/자동화 연동 |
| 14 | `generate` 의 실제 AI/이미지 소스 연동 옵션 | BYOK 구조(DPAPI 저장) 준비 후 |

### 9.4 M5 — 앱 통합

| # | 후보 | 근거 |
|---|---|---|
| 15 | `src-tauri` 에 `tauri`/`tauri-build`/`tauri-plugin-opener` 복원 + `invoke_handler` 연결 | 현재 IPC는 래퍼만 존재. 루트 `[workspace.dependencies]` 에 Tauri 항목은 유지되어 있음 |
| 16 | 트레이 아이콘 + 상주 | 계획서 핵심 |
| 17 | 자동 스케줄러(부팅/시간 트리거) | 상시 구동 제품의 핵심 가치 |
| 18 | 단일 인스턴스 방지 (`single_instance.rs`) | 계획서 §3.3 파일 트리에 이미 명시 |

### 9.5 M8 — 상용화 게이트

| # | 후보 | 근거 |
|---|---|---|
| 19 | 자동 업데이트 서명 검증 (`minisign-verify`/`ed25519-dalek` + `updater.rs` + `tests/updater_sig.rs`) | 계획서 §3.2/§3.3에 아직 미기재 |
| 20 | 자동 시작 옵션 (`HKCU\Run`) — `windows` crate `Win32_System_Registry` feature 필요 | 계획서 §3.2 features에 미포함 |
| 21 | NSIS 제거 훅 (`src-tauri/installer-hooks.nsh`) — 제거 시 데이터 보존/삭제 선택 | `tauri.conf.json`의 `bundle.windows.nsis.installerHooks` 설정 필요 |
| 22 | SBOM 생성 (`cyclonedx-bom` 또는 `Cargo.lock` 수기 변환 — **방식 미결정**) | AC-8.7 |
| 23 | 법률 문서 5종 (`LICENSE`/`PRIVACY`/`SECURITY`/`THIRD_PARTY_NOTICES`/`CODE_SIGNING`) 본문 작성 | 저장소 루트에 아직 없음 |

---

## 10. 부록 — 명령 빠른 참조

```bash
# 도움말
wallmagic-cli --help
wallmagic-cli -V

# 조회
wallmagic-cli get

# 적용
wallmagic-cli set "C:\Pictures\my.jpg"
wallmagic-cli set "C:\Pictures\my.jpg" --pos stretch
wallmagic-cli set "C:\Pictures\my.jpg" --pos tile

# 생성
wallmagic-cli generate "sunset over mountains"
wallmagic-cli generate "sunset over mountains" --out "%TEMP%\s.bmp"
wallmagic-cli generate "sunset over mountains" --apply

# 복원
wallmagic-cli restore

# 진단
type "%LOCALAPPDATA%\WallMagic\state.json"
```

---

*본 매뉴얼은 `crates/cli/src/main.rs`, `crates/core/src/wallpaper.rs`, `crates/core/src/lib.rs`, `src-tauri/src/lib.rs`, `src-ui/App.tsx`의 실측 동작을 기준으로 작성되었습니다. M2 이후 기능 추가 시 본 문서를 갱신하십시오.*
