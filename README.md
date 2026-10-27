# WallMagic

**Windows 바탕화면을 검색 · AI 생성 · 적용 · 복원하는 데스크톱 앱**

Tauri v2 · Rust · React 19 · TypeScript · Windows 10 (1809+) / Windows 11 (x64)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB)
![Rust](https://img.shields.io/badge/Rust-1.82%2B-000000)

---

## 1. 개요

WallMagic은 Windows 데스크톱의 바탕화면을 **찾고(검색) · 만들고(생성) · 적용하고(적용) · 되돌리는(복원)** 네 가지 흐름을 한 화면에서 처리하는 데스크톱 애플리케이션입니다.

- **네이티브 적용** — `IDesktopWallpaper` COM API를 1차 사용하고, 실패하면 `SystemParametersInfoW`로 자동 폴백합니다. 모니터별 개별 적용과 6가지 배치 방식을 지원합니다.
- **Zero-Black-Screen** — 적용 전 원본 배경을 스냅샷하므로, 어떤 실패 상황에서도 검은 화면으로 남지 않습니다.
- **BYOK(Bring Your Own Key)** — AI 이미지 생성은 사용자가 연결한 공급자 API를 그대로 사용합니다. 이 저장소에는 어떤 API 키도 하드코딩되어 있지 않습니다.
- **로컬 우선** — 검색·히스토리·설정·스냅샷은 모두 사용자 PC(`%LOCALAPPDATA%\WallMagic`)에 저장됩니다. 자체 서버가 없습니다.

### 주요 기능

| 구분 | 내용 |
|---|---|
| **검색** | 로컬 라이브러리 + 원격 이미지 검색, 키워드/해상도 필터, 순환 검색어 |
| **생성** | 5개 공급자(무료 Pollinations · Cloudflare Workers AI · OpenAI Images · Puter · 검색), 모델 선택, 자격증명 관리 |
| **seed 제어** | `random`(기본) · `incremental` · `fixed` 3모드 — 같은 프롬프트 반복 시 결과 고정/변화 제어 |
| **미리보기** | 뷰어 3모드(fit / fill / actual) + 원본 해상도 로딩 + 전체화면 |
| **적용·복원** | 모니터별 적용, 배치 방식, 스냅샷 기반 원복, 적용 이력 동기화 |
| **히스토리** | 별도 창에서 생성·검색 이력 관리(생성 일시·최신순·개별 삭제·프롬프트 재사용) |
| **파일 관리** | 후보 이미지 파일 삭제(허용 루트 검증 + 사이드카 `*.geninfo.json` 동시 정리) |
| **시나리오** | 공급자 우선순위 · 자동 실행 간격 · 검색어 순환 · On/Off 토글 |
| **다국어** | 한국어 / 영어 완전 지원(모든 사용자 노출 문자열이 사전 경유) |

> IPC 커맨드 **26개**, 화면 **5개** + 히스토리 창 1개. 상세 인벤토리는 [`docs/VERIFY_ALL_FEATURES.md`](docs/VERIFY_ALL_FEATURES.md) 참조.

### 스크린샷

<!-- docs/screenshots/ 에 main.png · history.png · scenario.png 를 추가하면 아래 표에 표시됩니다. -->

| 메인 스튜디오 | 히스토리 창 | 시나리오 설정 |
|---|---|---|
| _docs/screenshots/main.png_ | _docs/screenshots/history.png_ | _docs/screenshots/scenario.png_ |

---

## 2. 요구 사항

| 항목 | 요구 사항 |
|---|---|
| OS | Windows 10 (1809 이상) / Windows 11 (x64) |
| 런타임 | WebView2 (Windows 10/11 기본 탑재 — 별도 설치 불필요) |
| 빌드 도구 | Node.js 20+ / npm, Rust 1.82+ (`rustup`), MSVC 빌드 도구(C++ 워크로드) |
| 디스크 | 약 50 MB |

---

## 3. 빠른 시작 (개발)

```bash
# 1) 의존성 설치
npm install

# 2) 프론트엔드 타입체크 + 번들
npx tsc --noEmit
npm run build

# 3) Rust 빌드 + 테스트
cargo build --workspace
cargo test --workspace

# 4) 개발 모드 실행 (Vite dev 서버 + Tauri 창)
npm run tauri dev
```

`npm run dev` 는 1420 포트를 선점 정리한 뒤 Vite만 띄웁니다. 창까지 필요하면 `npm run tauri dev` 를 사용하세요.

### 배포 산출물

```bash
npm run tauri build
```

| 산출물 | 경로 |
|---|---|
| 실행 파일 | `target/release/wallmagic-app.exe` |
| NSIS 인스톨러 | `target/release/bundle/nsis/` |
| MSI 인스톨러 | `target/release/bundle/msi/` |

Windows 편의 배치 파일: `build-installer.cmd`(인스톨러 빌드) · `run-app.cmd`(실행) · `stop-app.cmd`(종료) · `check-app.cmd`(`cargo check`) · `test-workspace.cmd`(테스트).

---

## 4. 검증

이 저장소는 **계약 검증 스크립트 27종**을 함께 운영합니다. IPC 이름·인자 키, i18n 키, seed 정책, 미리보기 모드, 창 생성 스레드 규칙 등이 코드 변경으로 깨지면 자동으로 감지됩니다.

```bash
# 전체 계약 검증 (27종)
node scripts/run-all-verify.mjs

# 개별 실행
node scripts/verify-ipc-contract.mjs        # IPC 이름 + 인자 키 ↔ Rust 시그니처
node scripts/verify-persist-i18n-meta.mjs   # i18n 키 · 메타데이터 계약
node scripts/verify-seed.mjs                # seed 모드 · 공급자별 안내 분기
node scripts/verify-window-builder-async.mjs # 창 생성 커맨드는 async 여야 한다
```

Rust 단위 테스트에는 실네트워크·실 OS 배경 변경이 필요한 케이스가 `#[ignore]`로 분리되어 있습니다. CI·로컬 기본 실행에서는 제외됩니다.

```bash
cargo test --workspace              # 기본 (ignored 제외)
cargo test --workspace -- --ignored # opt-in: 실제 네트워크/바탕화면 변경
```

> ⚠️ `--ignored` 실행은 **실제 데스크톱 배경을 변경**합니다. 본인 환경에서만 실행하세요.

문서: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) · [`docs/VERIFY_ALL_FEATURES.md`](docs/VERIFY_ALL_FEATURES.md) · [`docs/CLOUDFLARE_SCENARIO.md`](docs/CLOUDFLARE_SCENARIO.md) · [`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md)

---

## 5. 디렉터리 구조

```
WallMagic/
├── Cargo.toml                  # 워크스페이스 · 버전/제작자/라이선스 단일 소스
├── package.json                # 프론트엔드 의존성 · 스크립트
├── index.html                  # 두 창(메인·히스토리)이 공유하는 진입 HTML
├── crates/core/                # [라이브러리] UI·IPC를 모르는 순수 Rust 코어
│   ├── src/lib.rs              #   퍼블릭 퍼사드
│   ├── src/wallpaper.rs        #   검증·스테이징·COM/SPI 이중화·스냅샷/복원
│   ├── src/scenario.rs         #   시나리오 스케줄 · 공급자 라우팅 · seed 정책
│   ├── src/search.rs           #   로컬/원격 검색 · 썸네일 · 고유 경로 생성
│   ├── src/store.rs            #   설정·히스토리·state 영속화
│   └── tests/                  #   통합 테스트
├── src-tauri/                  # [GUI 셸] Tauri v2 런타임 + IPC 커맨드
│   ├── src/lib.rs              #   #[tauri::command] 26종 + 창 관리
│   ├── src/main.rs             #   진입점
│   ├── capabilities/           #   IPC 권한
│   └── tauri.conf.json         #   창 · 번들 · 보안 설정
├── src-ui/                     # [프론트엔드] React 19 + TypeScript
│   ├── App.tsx                 #   메인 스튜디오(5개 화면)
│   ├── HistoryWindow.tsx       #   히스토리 전용 창
│   ├── i18n.ts                 #   ko/en 사전
│   └── styles.css
├── scripts/                    # 검증 스크립트(verify-*) · 유틸
└── docs/                       # 설계 · 매뉴얼 · 검증 기록
```

**의존 방향(단방향 고정)**: `src-ui` —(IPC/JSON)→ `src-tauri` —(함수 호출)→ `wallmagic-core`.
`wallmagic-core` 는 UI·IPC 타입을 참조하지 않습니다.

---

## 6. 데이터 위치

| 파일 | 위치 | 내용 |
|---|---|---|
| `state.json` | `%LOCALAPPDATA%\WallMagic\` | 현재/이전 배경, 사용 백엔드 |
| `scenario.json` | 〃 | 시나리오 설정(공급자 우선순위·간격·자격증명) |
| `history.json` | 〃 | 생성/검색 히스토리 |
| `active\` | 〃 | 적용 직전 스테이징 이미지 |
| `online_cache\` | 〃 | 원격 이미지 임시 캐시 |
| `*.geninfo.json` | 이미지 옆 | 생성 정보 사이드카(공급자·모델·prompt·seed) |

---

## 7. 보안 · 알려진 제한

이 프로젝트는 **현재 코드 서명 · 자동 업데이트 · CSP가 적용되지 않은 개발 빌드 단계**입니다. 공개 저장소로 공개되어 있으나, 상용 배포 전 다음 항목이 남아 있습니다([`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md) P0):

- 코드 서명 · 공증 미설정
- 자동 업데이트 경로 없음
- CSP `null` (Tauri 기본값)
- 공급자 API 키가 `scenario.json` 에 **평문 저장** — 값은 IPC 응답에서 마스킹되지만 파일 자체는 암호화되지 않습니다
- 단일 인스턴스 미보장

취약점 제보 방법은 [`SECURITY.md`](SECURITY.md) 를 참조하세요.

---

## 8. 기여

버그 제보 · 기능 제안 · PR 모두 환영합니다. 시작 전에 [`CONTRIBUTING.md`](CONTRIBUTING.md) 를 읽어 주세요. 특히 **IPC 계약과 i18n 규칙**은 검증 스크립트가 강제하므로 PR 전에 `node scripts/run-all-verify.mjs` 를 실행해야 합니다.

---

## 9. 라이선스

[MIT License](LICENSE) — Copyright (c) 2026 **uptodatelabs**

> 이 저장소의 기본 라이선스는 **MIT** 입니다. MIT는 소프트웨어를 자유롭게 사용·수정·배포·재판매할 수 있게 하는 관대한 라이선스이며, 저작권 고지와 라이선스 전문을 유지하는 조건이 붙습니다.
>
> 배포 정책을 바꾸려면 `LICENSE` 파일과 `Cargo.toml`(`[workspace.package] license`), `package.json`(`license`)을 **함께** 수정해야 합니다. 세 곳이 어긋나면 `node scripts/verify-app-meta.mjs` 가 실패합니다.

---

## English summary

**WallMagic** is a Windows desktop app that **searches, AI-generates, applies, and restores desktop wallpapers**. Built with Tauri v2 + Rust + React 19 + TypeScript.

- Native wallpaper control via `IDesktopWallpaper` COM with `SystemParametersInfoW` fallback; per-monitor apply, 6 layout modes, snapshot-based restore (Zero-Black-Screen guarantee).
- Bring-your-own-key image generation: Pollinations (free), Cloudflare Workers AI, OpenAI Images, Puter, plus image search. No API keys are bundled in this repository.
- Everything is stored locally under `%LOCALAPPDATA%\WallMagic`. No backend server.
- Fully bilingual (Korean / English) UI.

Quick start: `npm install` → `npm run build` → `npm run tauri dev`.
Run the contract suite with `node scripts/run-all-verify.mjs`.

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 uptodatelabs.
