# WallMagic 사용 매뉴얼 (v0.2.0 — Windows 전용 GUI)

> **대상 버전**: `wallmagic-core` / `wallmagic-app` v0.1.0 (제품 표기 v0.2.0 — GUI 전환 릴리스)
> **플랫폼**: Windows 10 (1809+) / Windows 11 (64-bit)
> **인터페이스**: **Windows GUI 프로그램 (Tauri v2 + React)** — CLI 인터페이스는 폐기되었습니다.
> **관련 문서**: `docs/ARCHITECTURE.md` (GUI 아키텍처 결정), `docs/development-plan.md` (개발 계획서)

---

## 1. WallMagic란 무엇인가

WallMagic은 Windows PC의 바탕화면을 **검색 · 생성 · 적용 · 복원**하는 Windows 전용 데스크톱 프로그램입니다.

**창을 닫아도 배경은 그대로 유지**되며, 언제든지 "이전 배경으로 복원"으로 되돌릴 수 있습니다.

| 핵심 기능 | 설명 |
|---|---|
| **① 검색** | 내 PC의 이미지 폴더(라이브러리 + Pictures, 또는 지정 폴더)에서 키워드로 배경 후보를 찾아 썸네일로 보여줍니다. |
| **② 생성** | 테마 프롬프트를 입력하면 1920×1080 배경 이미지를 생성해 라이브러리에 저장하고 바로 적용할 수 있습니다. (네트워크·비용 0) |
| **③ 적용** | 선택한 이미지를 검증·스테이징 후 바탕화면으로 적용합니다. 모니터별 개별 적용과 6가지 배치 방식을 지원합니다. |
| **④ 복원** | 적용 전에 자동 저장한 스냅샷으로 이전 배경을 되돌립니다. |

**안전성 (Zero-Black-Screen)**
- `IDesktopWallpaper` COM API를 1차로 사용하고, 실패 시 `SystemParametersInfoW`로 자동 폴백합니다.
- 적용 전 원본 배경을 스냅샷하므로, 실패하더라도 검은 화면으로 남지 않습니다.
- 640×480 미만이거나 손상된 이미지는 자동 제외됩니다.

> **현재 상태**: 상용화 1단계 빌드입니다. 원격 이미지 검색 API, AI 이미지 생성, 트레이 상주, 자동 스케줄러는 후속 단계입니다 (§8 참고).

---

## 2. 설치와 실행

### 2.1 시스템 요구 사항

| 항목 | 요구 사항 |
|---|---|
| OS | Windows 10 (1809 이상) / Windows 11 (64-bit) |
| 런타임 | WebView2 (Windows 10/11에 기본 탑재 — 별도 설치 불필요) |
| 디스크 | 약 50 MB |
| 메모리 | 유휴 시 약 40 MB |

### 2.2 설치

**방법 A — 인스톨러 (권장, 배포용)**
```
target/release/bundle/nsis/WallMagic_0.1.0_x64-setup.exe   ← NSIS 설치 프로그램 (2.13 MiB)
target/release/bundle/msi/WallMagic_0.1.0_x64_en-US.msi    ← MSI 설치 패키지 (3.17 MiB)
```
> **검증 상태**: 위 인스톨러 2종은 `build-installer.cmd`(`npm run tauri build`)로 2026-10-24 실제 생성 확인 (`=== BUILD OK ===` 로그). 다만 **인스톨러 설치 실행 자체는 미검증**입니다 — 실제 설치를 시험하려면 방법 B/C의 개발 빌드(`run-app.cmd`)를 먼저 권장합니다.

실행 후 시작 메뉴의 **WallMagic** 바로가기로 시작합니다.

**방법 B — 소스에서 빌드 (개발용)**
```bash
# 1) 프론트엔드 의존성 설치 + 웹 번들 빌드
npm install
npm run build

# 2) Rust 코어 빌드 + 테스트
cargo build --workspace
cargo test --workspace

# 3) GUI 실행 (개발 빌드)
cargo run -p wallmagic-app
```

**방법 C — 릴리스 빌드 (배포 산출물 생성)**
```bash
npm install
npm run tauri build
```
산출물 (실측 경로, 2026-10-24):
- 실행 파일: `target/release/wallmagic-app.exe`
- NSIS 인스톨러: `target/release/bundle/nsis/WallMagic_0.1.0_x64-setup.exe`
- MSI 인스톨러: `target/release/bundle/msi/WallMagic_0.1.0_x64_en-US.msi`

> 워크스페이스 루트의 `target/`이 번들 산출 루트입니다 (`src-tauri/target/`이 아님).

### 2.3 프로그램 시작

1. 시작 메뉴 또는 `target/release/wallmagic-app.exe` 실행 (인스톨러 설치 시 시작 메뉴의 **WallMagic** 바로가기)
2. 메인 창이 열리면 상단에 **현재 배경 · 적용 백엔드 배지 · 모니터 선택**이 표시됩니다
3. 좌측 패널에서 **검색** 또는 **생성**으로 시작합니다

---

## 3. 화면 구성

```
┌────────────────────────────────────────────────────────────┐
│ WallMagic Studio       [백엔드 배지]        [모니터 선택 ▾] │
├──────────────────┬─────────────────────────────────────────┤
│ ① 검색           │                                         │
│  [키워드]        │   ③ 미리보기 (선택된 이미지)              │
│  [검색 폴더]     │      ┌───────────────────────┐          │
│  [검색]          │      │                       │          │
│                  │      │   1920 x 1080 · 2.1MB  │          │
│  ┌────┬────┐     │      └───────────────────────┘          │
│  │썸  │썸  │     │   [배치 방식 ▾]                          │
│  │네일│네일│ ... │   [④ 바탕화면에 적용]                     │
│  └────┴────┘     │   [이전 배경으로 복원]                    │
│ ② 생성           │                                         │
│  [프롬프트]      │                                         │
│  [생성]          │                                         │
├──────────────────┴─────────────────────────────────────────┤
│ 현재 배경: <경로> · 이전 배경: <경로> · 상태 메시지          │
└────────────────────────────────────────────────────────────┘
```

### 3.1 상단 바
- **백엔드 배지**: 마지막으로 성공한 적용에 사용된 API (`IDesktopWallpaper (COM)` 또는 `SystemParametersInfoW (Fallback)`)
- **모니터 선택 드롭다운**: `모든 모니터` 또는 특정 모니터를 지정 (해상도·기본 모니터 표시)

### 3.2 좌측 패널 — ① 검색 / ② 생성
- **키워드**: 파일명 기준 대소문자 무시 부분 일치. 비우면 전체 목록.
- **검색 폴더**: 비우면 기본 루트(앱 라이브러리 + `Pictures`)를 탐색. 절대 경로 입력 시 해당 폴더만 탐색.
- **프롬프트**: 테마 문장 입력 (예: `aurora over icy mountains`). 같은 프롬프트는 같은 이미지를 생성합니다.

### 3.3 중앙 패널 — 결과 그리드
- 후보별 썸네일 + 파일명 + 해상도 + 용량 표시
- 카드를 클릭하면 오른쪽 미리보기에 선택됩니다
- **적용 가능한 이미지만** 표시됩니다 (640×480 이상 + 정상 디코딩)
- **최대 200건만 표시**됩니다 — 매칭된 전체 후보가 200건을 초과하면 상위 200건만 썸네일로 표시되고, 상태 바에 "N건 중 200건 표시"로 잘림이 안내됩니다 (IPC 페이로드·메모리 보호). 더 보려면 키워드를 좁혀 검색하세요.

### 3.4 우측 패널 — ③ 미리보기 / ④ 적용 · 복원
- **미리보기**: 선택 이미지의 큰 썸네일과 상세 정보(파일명·해상도·용량·전체 경로)
- **배치 방식**: `채우기(Fill)` / `맞춤(Fit)` / `늘이기(Stretch)` / `바둑판식(Tile)` / `가운데(Center)` / `스팬(Span)`
- **바탕화면에 적용**: 검증 → 스테이징 → 스냅샷 → 적용 순서로 실행
- **이전 배경으로 복원**: 스냅샷된 원본 배경으로 되돌림

### 3.5 하단 상태 바
- **현재 배경**: OS가 보고하는 실제 배경화면 경로
- **이전 배경**: 복원용 스냅샷 경로 (없으면 "스냅샷 없음")
- **상태 메시지**: 각 액션의 성공/실패 원문 (성공=녹색, 실패=빨간색)

---

## 4. 사용법 — 핵심 4가지 액션

### 4.1 ① 검색

1. 좌측 **키워드** 입력 (예: `sunset`)
2. (선택) **검색 폴더**에 탐색할 폴더 절대 경로 입력
3. **검색** 버튼 클릭 또는 `Enter`
4. 중앙 그리드에 후보가 표시되고, 첫 번째 후보가 자동 선택됩니다

**동작 규칙**
- 파일명에 키워드가 포함된 이미지만 후보 (대소문자 무시)
- 지원 확장자: `.jpg`, `.jpeg`, `.png`, `.bmp`
- 최대 깊이 3단계까지 하위 폴더 탐색
- 640×480 미만 · 디코딩 불가 파일은 목록에서 제외
- 결과는 파일명 오름차순으로 정렬

### 4.2 ② 생성

1. 좌측 **프롬프트** 입력 (예: `cyberpunk rainy neon street in Seoul`)
2. **생성** 버튼 클릭
3. 생성된 이미지가 라이브러리에 저장되고 결과 그리드 상단에 자동 선택됩니다

**동작 규칙**
- 프롬프트를 시드로 1920×1080 그라디언트 이미지를 결정론적으로 생성 (네트워크·비용 0)
- 저장 위치: 앱 라이브러리 (`%LOCALAPPDATA%\WallMagic\library\`)
- 파일명: `generated_<프롬프트슬러그>_<해시8자리>.bmp` — 같은 프롬프트는 같은 파일을 재생성합니다

### 4.3 ③ 적용

1. 그리드에서 원하는 썸네일 클릭 → 오른쪽 미리보기에서 확인
2. **배치 방식** 선택 (기본: 채우기)
3. (다중 모니터) 상단 **모니터 선택**에서 대상 지정 — `모든 모니터`가 기본
4. **바탕화면에 적용** 클릭

**동작 규칙**
1. 이미지 검증 (존재 · 디코딩 · 640×480 이상)
2. `%LOCALAPPDATA%\WallMagic\active\` 로 **원자적 스테이징** (`staged_*.bmp` → `active_*.bmp` rename)
3. 현재 배경을 **스냅샷** (`state.json`의 `previous_wallpaper`)
4. `IDesktopWallpaper` COM으로 적용 → 실패 시 `SystemParametersInfoW` 폴백
5. 둘 다 실패하면 스냅샷된 원본을 재적용 (**검은 화면 방지**)

### 4.4 ④ 복원

1. **이전 배경으로 복원** 클릭
2. 스냅샷된 경로로 배경이 되돌아갑니다

**주의**: 한 번도 적용한 적이 없으면 `스냅샷 없음` 상태이며 복원할 대상이 없습니다.

---

## 5. 데이터 디렉터리와 설정

### 5.1 위치 해석 순서

1. `WALLMAGIC_DATA_DIR` 환경변수 (명시적 오버라이드 — 테스트 격리용)
2. `%LOCALAPPDATA%\WallMagic`
3. `%TEMP%\WallMagic` (폴백)

### 5.2 디렉터리 구조

```
%LOCALAPPDATA%\WallMagic\
├── state.json          # 스냅샷 상태 (previous/current/backend)
├── active\             # 스테이징 파일 (active_<stem>_<monitor>.bmp)
└── library\            # 생성된 배경 + 검색 기본 루트
```

### 5.3 `state.json` 스키마

```json
{
  "previous_wallpaper": "C:\\Users\\<user>\\Pictures\\original.jpg",
  "current_wallpaper": "C:\\Users\\<user>\\AppData\\Local\\WallMagic\\active\\active_sunset_primary.bmp",
  "backend_used": "IDesktopWallpaper (COM)"
}
```

| 필드 | 의미 |
|---|---|
| `previous_wallpaper` | 복원용 스냅샷 (원본 사용자 배경) |
| `current_wallpaper` | 마지막으로 적용한 스테이징 경로 |
| `backend_used` | 사용된 API (`IDesktopWallpaper (COM)` / `SystemParametersInfoW (Fallback)` 등) |

### 5.4 격리 실행 (개발·테스트용)

```powershell
$env:WALLMAGIC_DATA_DIR = "$env:TEMP\wallmagic_sandbox"
cargo run -p wallmagic-app
```
이렇게 하면 상태 파일과 스테이징이 샌드박스로 격리되어 실제 사용자 상태를 건드리지 않습니다.

---

## 6. 문제 해결 (Troubleshooting)

| 증상 | 원인 | 조치 |
|---|---|---|
| 프로그램이 시작되지 않음 | WebView2 미설치 (구형 Win10) | [WebView2 런타임](https://developer.microsoft.com/microsoft-edge/webview2/) 설치 후 재시작 |
| 검색 결과가 비어 있음 | 키워드 불일치 · 폴더에 640×480 이상 이미지 부재 · 확장자 미지원 | 키워드를 비우고 전체 목록 확인, `.jpg/.png/.bmp` 확인 |
| 검색 폴더를 지정해도 결과가 없음 | 경로 오타 · 존재하지 않는 폴더 | 절대 경로 확인 (예: `C:\Users\me\Pictures`) |
| "이미지 해상도가 너무 낮습니다" | 640×480 미만 이미지 | 더 큰 이미지 선택 |
| "이미지 디코딩 오류" | 손상된 파일 · 미지원 코덱 | 다른 이미지 사용 |
| 적용이 실패하고 원래대로 돌아감 | COM·SPI 모두 실패 (파일 잠금·권한) | 다른 이미지로 재시도, 파일이 네트워크 드라이브에 있으면 로컬로 복사 후 시도 |
| 복원이 안 됨 (`스냅샷 없음`) | 한 번도 적용하지 않음 | 정상 동작 — 적용 후 복원 가능 |
| 백엔드 배지가 `Fallback`으로 표시됨 | COM API 실패로 SPI 폴백 사용됨 | 기능은 정상. 문제 지속 시 로그 확인 |
| 창을 닫으면 프로그램이 종료됨 | 현재 버전은 트레이 상주 미지원 | 후속 버전 예정 (§8) |

---

## 7. 개발자를 위한 빌드·검증

### 7.1 필수 도구

| 항목 | 버전 |
|---|---|
| Rust | 1.82 이상 |
| Node.js | 20 이상 |
| npm | 10 이상 |
| Visual Studio Build Tools | C++ 빌드 도구 (Windows SDK 포함) |

### 7.2 검증 명령

```bash
# 전체 테스트 (코어 6 + 앱 3, OS 배경 변경 없음)
cargo test --workspace

# 실제 배경을 변경하는 opt-in 통합 테스트
cargo test -p wallmagic-core -- --ignored

# IPC 계약 검증 (UI invoke 이름 ↔ Rust #[tauri::command] 이름 일치)
node scripts/verify-ipc-contract.mjs

# 웹 번들 빌드 (tsc 타입 검사 + vite 번들)
npm run build
```

### 7.3 테스트 기준선 (v0.2.0)

```
wallmagic-app  : 3 passed / 0 failed   (IPC 스모크: 검색→생성→적용→복원)
wallmagic-core : 6 passed / 0 failed / 1 ignored (실제 배경 변경 E2E)
```

### 7.4 프로젝트 구조

```
WallMagic/
├── crates/core/       # 순수 코어 (UI·IPC 무관) — 검색·생성·스테이징·COM/SPI·스냅샷
├── src-tauri/         # Tauri v2 GUI 셸 — IPC 커맨드 6종 + 진입점
│   └── capabilities/  # IPC 권한 선언
└── src-ui/            # React 19 스튜디오 UI (App.tsx + styles.css)
```

**의존 방향**: `src-ui` —(IPC)→ `src-tauri` —(함수 호출)→ `wallmagic-core`
코어는 UI·IPC 타입을 참조하지 않습니다.

### 7.5 IPC 커맨드 계약

| 커맨드 | 인자 | 반환 | UI 액션 |
|---|---|---|---|
| `search_wallpapers` | `query`, `dir?` | `WallpaperCandidate[]` | ① 검색 |
| `generate_library_wallpaper` | `prompt` | `WallpaperCandidate` | ② 생성 |
| `apply_wallpaper` | `path`, `monitor_id?`, `position?` | `WallpaperState` | ③ 적용 |
| `restore_wallpaper` | `monitor_id?` | `WallpaperState` | ④ 복원 |
| `list_monitors` | — | `MonitorInfo[]` | 모니터 드롭다운 |
| `get_app_status` | — | `AppStatus` | 상태 바 |

---

## 8. 알려진 제약 (v0.2.0)

1. **CLI 인터페이스 없음** — 의도된 설계입니다. 모든 기능은 GUI로 제공됩니다.
2. **트레이 상주 미지원** — 창을 닫으면 종료됩니다.
3. **자동 스케줄러 미지원** — 자동 배경 교체는 후속 단계입니다.
4. **원격 이미지 검색 API 미연동** — 현재는 로컬 폴더 검색 + 프롬프트 생성만 지원합니다.
5. **AI 이미지 생성 미연동** — 프롬프트 생성은 로컬 그라디언트 방식입니다 (비용 0).
6. **생성 이미지는 그라디언트** — 사진형 사실적 이미지는 아닙니다.
7. **단일 스냅샷** — 복원 대상은 가장 최근 적용 전 상태 1개뿐입니다.
8. **Windows 전용** — macOS/Linux 미지원 (의도된 범위).
9. **코드 서명 미적용** — Windows SmartScreen 경고가 표시될 수 있습니다.

---

## 9. 부록 — 자주 묻는 질문

**Q. 창을 닫으면 배경이 되돌아가나요?**
A. 아니요. 적용된 배경은 Windows 설정에 영구 저장됩니다. 프로그램은 배경을 변경할 때만 필요합니다.

**Q. 원래 배경으로 되돌리려면?**
A. 프로그램을 실행한 뒤 **이전 배경으로 복원** 버튼을 클릭하세요. 적용 후 PC를 재시작해도 `state.json`에 스냅샷이 남아 있어 복원됩니다.

**Q. 여러 모니터에 각각 다른 배경을 지정할 수 있나요?**
A. 가능합니다. 상단 모니터 드롭다운에서 대상을 지정하고 각각 적용하세요.

**Q. 인터넷 연결이 필요한가요?**
A. 아니요. 모든 기능이 오프라인에서 동작합니다.

**Q. 생성한 이미지는 어디에 저장되나요?**
A. `%LOCALAPPDATA%\WallMagic\library\` 폴더입니다. 이 폴더는 검색 기본 루트이기도 합니다.

**Q. 비용이 발생하나요?**
A. 아니요. 외부 API·구독·인앱 결제가 없습니다.
