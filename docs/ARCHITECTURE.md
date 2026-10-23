# WallMagic GUI 아키텍처 — 결정 근거 및 모듈 구조

> 버전: v1.0 (상용화 1단계) / 대상: Windows 10 (1809+) / Windows 11
> 범위: CLI 인터페이스 폐기 → Windows 전용 GUI 프로그램으로 전면 개편

---

## 1. 플랫폼 결정: **Tauri v2 (Rust + React 19 + TypeScript)**

### 1.1 비교표 (Tauri v2 vs WinUI 3)

| 축 | **Tauri v2 (채택)** | WinUI 3 (미채택) | 판정 근거 |
|---|---|---|---|
| 기존 코어 로직 재사용 | **100%** — `crates/core`(검증·스테이징·COM/SPI 이중화·스냅샷)를 그대로 링크 | 0% — C#/.NET으로 전면 재작성 필요 (COM 인터롭 래핑 포함) | M1에서 검증된 Rust 코어를 이식 비용 0으로 재사용 |
| 언어 통합 | Rust 단일 언어 (백엔드+코어) + TS 프론트 | C# 백엔드 + 별도 코어 언어 | 디버깅·빌드 파이프라인 단순화 |
| 유휴 메모리 | ~15–35MB (창 닫힘 시 WebView2 해제 ~18MB) | 60–120MB (.NET 런타임 상주) | 상시 트레이 상주 프로그램에 결정적 |
| 설치 용량 | 5–15MB (WebView2 미포함, 시스템 기본) | 30–60MB (.NET 런타임 포함 또는 별도 설치) | 배포·설치 UX |
| Win32/COM 직접 호출 | `windows` 0.62 크레이트로 `IDesktopWallpaper`/`SystemParametersInfoW` 직접 호출 (이미 구현 완료) | COM 인터롭 레이어 필요 | M1 검증 코드 그대로 사용 |
| 인스톨러/배포 | NSIS + MSI 번들 내장 (`tauri build`) | MSIX / 별도 설치 프로젝트 | 상용 배포 경로 즉시 확보 |
| 런타임 의존 | **WebView2** — Win10/11 기본 탑재 | Windows App SDK 런타임 배포 필요 | 전제 조건 최소화 |
| UI 프레임워크 | React 19 (웹 생태계 전체 재사용, 가상 스크롤·다국어 등) | XAML/Fluent (네이티브 컨트롤) | 개발 속도·구인 용이성 우위 |
| MS Store 정합 | Tauri 앱 MSIX로 스토어 등록 가능 | 네이티브 우위 | 비차단 요소 |

### 1.2 결정문

> **Tauri v2로 확정한다.** 결정적 근거는 ①M1에서 검증 완료된 Rust 코어(`wallmagic-core`)를 이식 없이 재사용, ②상시 트레이 상주 특성상 메모리·설치 용량 우위, ③Win32/COM 직접 호출 경로가 이미 동작 검증됨(Zero-Black-Screen 불변식 포함), ④`tauri build`로 NSIS/MSI 상용 인스톨러를 즉시 산출.

WinUI 3가 우위인 지점(네이티브 Fluent 컨트롤, XAML 접근성 도구)은 인정하나, **코어 재작성 비용과 .NET 런타임 배포 부담**이 상용화 1단계의 일정 리스크를 키우므로 채택하지 않는다.

### 1.3 CLI 인터페이스 폐기 (사용자 지시 반영)

- `crates/cli`(wallmagic-cli)는 상용 제품의 사용자 인터페이스가 아니므로 **워크스페이스에서 제거한다.**
- CLI가 수행하던 4개 액션(`get`/`set`/`generate`/`restore`)은 전부 GUI 액션 + IPC 커맨드로 대체된다.
- 코어 로직(`wallmagic-core`)은 라이브러리로 유지되어 GUI가 그대로 사용한다.

---

## 2. 모듈 구조

```
WallMagic/
├── crates/core/                 # [라이브러리] UI·IPC를 모르는 순수 코어
│   └── src/
│       ├── lib.rs               # 퍼블릭 퍼사드 + 단위 테스트
│       ├── wallpaper.rs         # 검증·스테이징·COM/SPI 이중화·스냅샷/복원·모니터 열거
│       └── search.rs            # 로컬 라이브러리 검색 + 프롬프트 기반 생성
├── src-tauri/                   # [GUI 셸] Tauri v2 런타임 + IPC 커맨드
│   ├── src/
│   │   ├── main.rs              # 진입점 (windows_subsystem = "windows")
│   │   └── lib.rs               # #[tauri::command] 6종 + invoke_handler 배선
│   ├── capabilities/default.json# IPC 권한 (core:default, dialog:default)
│   ├── build.rs                 # tauri-build
│   └── tauri.conf.json          # 창·번들·아이콘 설정
└── src-ui/                      # [프론트엔드] React 19 스튜디오 UI
    ├── main.tsx                 # 엔트리
    ├── App.tsx                  # 3패널 스튜디오 + 상태바
    └── styles.css               # 테마 (다크 스튜디오)
```

**의존 방향 (단방향 고정):**
`src-ui` —(IPC/JSON)→ `src-tauri` —(함수 호출)→ `wallmagic-core`
`wallmagic-core`는 UI·IPC 타입을 절대 참조하지 않는다. UI 변경이 코어 재컴파일을 유발하지 않는다.

---

## 3. IPC 계약 (핵심 4개 액션 + 보조 2개)

| # | IPC 커맨드 | 인자 | 반환 | 대응 UI 액션 |
|---|---|---|---|---|
| 1 | `search_wallpapers` | `query: string`, `dir?: string` | `WallpaperCandidate[]` | **① 검색** — 키워드로 로컬 이미지 탐색 |
| 2 | `generate_library_wallpaper` | `prompt: string` | `WallpaperCandidate` | **② 생성** — 프롬프트 기반 배경 생성 |
| 3 | `apply_wallpaper` | `path: string`, `monitorId?: string`, `position?: string` | `WallpaperState` | **③ 선택/적용** — 바탕화면에 적용 |
| 4 | `restore_wallpaper` | `monitorId?: string` | `WallpaperState` | **④ 복원** — 이전 배경으로 원복 |
| 5 | `list_monitors` | — | `MonitorInfo[]` | 모니터 선택 드롭다운 |
| 6 | `get_app_status` | — | `AppStatus` | 상태바 (현재/이전 경로, 백엔드, 데이터 폴더) |

- `WallpaperCandidate`: `{ path, fileName, width, height, sizeBytes, thumbBase64 }`
  - `thumbBase64`는 JPEG 320px 축소본을 base64로 인코딩해 UI 그리드가 파일 I/O 없이 미리보기를 표시.
  - 640x480 미만·디코딩 불가 파일은 코어에서 선제외 (적용 가능 후보만 반환).
- `WallpaperState`: `{ previousWallpaper, currentWallpaper, backendUsed }` (M1 스키마 유지)
- 인자 명명: Rust `snake_case` ↔ JS `camelCase` (Tauri v2 기본 변환 규칙 준수).

---

## 4. UI 구성 — 3패널 스튜디오 + 상태바

```
┌────────────────────────────────────────────────────────────┐
│ WallMagic Studio                    [백엔드 배지] [모니터 ▾] │
├──────────────────┬─────────────────────────────────────────┤
│ ① 검색           │                                         │
│  [키워드] [검색] │   ③ 미리보기 (선택된 이미지)              │
│  [폴더 ▾]        │      ┌───────────────────────┐          │
│  ┌────┬────┐     │      │                       │          │
│  │썸  │썸  │     │      │   1920 x 1080 · 2.1MB  │          │
│  │네일│네일│ ... │      └───────────────────────┘          │
│  └────┴────┘     │   [배치 ▾] [대상 모니터 ▾]               │
│ ② 생성           │   [바탕화면에 적용] [이전 배경 복원]       │
│  [프롬프트]      │                                         │
│  [생성]          │                                         │
├──────────────────┴─────────────────────────────────────────┤
│ 상태: 현재 배경 <path> · 사용 백엔드: IDesktopWallpaper(COM) │
└────────────────────────────────────────────────────────────┘
```

- 흐름: **검색(또는 생성) → 썸네일 선택 → 미리보기 확인 → 배치/모니터 지정 → 적용 → (필요 시) 복원**
- 모든 액션은 IPC 라운드트립 실패 시 상태바에 원문 오류를 표시하고, 백엔드(COM/SPI) 사용 출처를 항상 노출한다.

---

## 5. 빌드·패키징

1. `npm run build` — 웹 번들 (`dist/`)
2. `npm run tauri build` — Rust 컴파일 + 번들링
   - 실행 파일: `src-tauri/target/release/WallMagic.exe`
   - NSIS: `src-tauri/target/release/bundle/nsis/WallMagic_*_x64-setup.exe`
   - MSI: `src-tauri/target/release/bundle/msi/WallMagic_*_x64_en-US.msi`
3. 테스트: `cargo test --workspace` (코어 단위 + IPC 래퍼) + 스모크 시나리오(검색→생성→적용→복원)

---

## 6. 데이터 레이아웃 (M1 스키마 유지)

- `%LOCALAPPDATA%\WallMagic\`
  - `state.json` — `{ previousWallpaper, currentWallpaper, backendUsed }`
  - `active\` — 원자적 스테이징 파일 (`active_<stem>_<monitor>.bmp`)
  - `library\` — 생성된 배경 + 검색 기본 루트
- `WALLMAGIC_DATA_DIR` 환경변수 오버라이드 유지 (테스트 격리용).
