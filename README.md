# WallMagic **Windows 바탕화면을 검색 · AI 생성 · 적용 · 복원하는 데스크톱 앱**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Windows 10 | 11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6)](#요구-사항) [![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB)](https://tauri.app) [![Rust 1.82+](https://img.shields.io/badge/Rust-1.82%2B-000000)](https://www.rust-lang.org) [![React 19](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev)

**한국어** | [English](#english)

---

## WallMagic이란?

WallMagic은 Windows 데스크톱의 바탕화면을 **찾고 · 만들고 · 적용하고 · 되돌리는** 네 가지 흐름을 한 화면에서 끝내는 데스크톱 애플리케이션입니다. 로컬 라이브러리와 원격 이미지 검색, 5개 AI 이미지 공급자, 모니터별 적용과 스냅샷 복원을 하나의 파이프라인으로 묶었습니다.

### 주요 기능

- **네이티브 적용** — `IDesktopWallpaper` COM API를 1차 사용하고, 실패하면 `SystemParametersInfoW`로 자동 폴백합니다. 모니터별 개별 적용과 6가지 배치 방식을 지원합니다.
- **Zero-Black-Screen** — 적용 전 원본 배경을 스냅샷하므로, 어떤 실패 상황에서도 검은 화면으로 남지 않습니다.
- **BYOK (Bring Your Own Key)** — AI 이미지 생성은 사용자가 연결한 공급자 API를 그대로 씁니다. 이 저장소에는 어떤 API 키도 하드코딩되어 있지 않습니다.
- **로컬 우선** — 검색 · 히스토리 · 설정 · 스냅샷은 모두 사용자 PC(`%LOCALAPPDATA%\WallMagic`)에 저장됩니다. 자체 서버가 없습니다.
- **다국어** — 한국어 / 영어 완전 지원. 모든 사용자 노출 문자열이 사전을 경유합니다.
- **seed 제어** — `random`(기본) · `incremental` · `fixed` 3모드로, 같은 프롬프트를 반복할 때 결과를 고정할지 바꿀지 정합니다.

### 기능 요약

| 구분 | 내용 |
|---|---|
| **검색** | 로컬 라이브러리 + 원격 이미지 검색, 키워드 / 해상도 필터, 순환 검색어 |
| **생성** | 5개 공급자(무료 Pollinations · Cloudflare Workers AI · OpenAI Images · Puter · 검색), 모델 선택, 자격증명 관리 |
| **seed 제어** | `random` · `incremental` · `fixed` 3모드 — 공급자별 지원 여부를 UI가 안내 |
| **미리보기** | 뷰어 3모드(fit / fill / actual) + 원본 해상도 로딩 + 전체화면 |
| **적용 · 복원** | 모니터별 적용, 배치 방식, 스냅샷 기반 원복, 적용 이력 동기화 |
| **히스토리** | 별도 창에서 생성 · 검색 이력 관리(생성 일시 · 최신순 · 개별 삭제 · 프롬프트 재사용) |
| **파일 관리** | 후보 이미지 파일 삭제(허용 루트 검증 + 사이드카 `*.geninfo.json` 동시 정리) |
| **시나리오** | 공급자 우선순위 · 자동 실행 간격 · 검색어 순환 · On/Off 토글 |
| **다국어** | 한국어 / 영어 완전 지원(모든 사용자 노출 문자열이 사전 경유) |

> IPC 커맨드 **26개**, 화면 **5개** + 히스토리 창 1개. 상세 인벤토리는 [`docs/VERIFY_ALL_FEATURES.md`](docs/VERIFY_ALL_FEATURES.md) 참조.

---

## 기술 스택

| 계층 | 사용 기술 |
|---|---|
| GUI 셸 | [Tauri v2](https://tauri.app) — `tauri 2` · `tauri-build 2` · `tauri-plugin-opener 2` |
| 코어 | Rust 1.82+ (edition 2021) — `ureq 2`(TLS) · `image 0.25`(png/jpeg/bmp) · `serde` / `serde_json` · `thiserror 2` · `base64 0.22` · `urlencoding 2` · `tracing 0.1` |
| Windows 연동 | `windows 0.62` — `Win32_System_Com` · `Win32_UI_Shell` · `Win32_UI_Shell_Common` · `Win32_UI_WindowsAndMessaging` · `Win32_Graphics_Gdi` · `Win32_Foundation` |
| 프론트엔드 | [React 19](https://react.dev) · TypeScript 5.7 · Vite 6 · `@tauri-apps/api 2` |
| 테스트 / 검증 | `cargo test`(워크스페이스 2개 크레이트) · 계약 검증 스크립트 29종 (Node.js, 추가 프레임워크 없음) |

- **빌드 파이프라인** — `tsc` → `vite build` 로 만든 `dist/` 를 Tauri 가 정적 자산으로 번들에 포함합니다.
- **두 창이 하나의 HTML 공유** — `index.html` 하나를 메인 창과 히스토리 창이 함께 쓰고, `src-ui/main.tsx` 가 `getCurrentWindow().label` 로 렌더 대상을 고릅니다.
- **메타데이터 단일 소스** — 버전 · 라이선스 · 제작자 · 저장소는 `Cargo.toml` 의 `[workspace.package]` 에만 있고 `crates/core` · `src-tauri` 가 상속합니다. `package.json` · `tauri.conf.json` · `LICENSE` 가 이 값과 어긋나면 `node scripts/verify-app-meta.mjs` 가 실패합니다.

---

## 요구 사항

| 항목 | 요구 사항 |
|---|---|
| OS | Windows 10 (1809 이상) / Windows 11 (x64) |
| 런타임 | WebView2 (Windows 10/11 기본 탑재 — 별도 설치 불필요) |
| 빌드 도구 | Node.js 20+ / npm, Rust 1.82+ (`rustup`), MSVC 빌드 도구 (C++ 워크로드) |
| 디스크 | 약 50 MB |

---

## 빠른 시작

### 설치

```bash
git clone https://github.com/uptodatelabs/WallMagic.git
cd WallMagic
npm install
```

### 빌드

```bash
npx tsc --noEmit         # 프론트엔드 타입체크
npm run build            # tsc + vite build → dist/
cargo build --workspace  # Rust 워크스페이스 빌드
```

### 실행 (개발 모드)

```bash
npm run tauri dev
```

Vite dev 서버와 Tauri 창을 함께 띄웁니다. 창 없이 프론트엔드만 보려면 `npm run dev` — 이 명령은 **1420 포트를 선점 정리한 뒤** Vite만 실행합니다.

### 배포 산출물

릴리스는 **버전 정합 → CHANGELOG 승격 → 번들 빌드 → 산출물 검증** 순서로만 진행합니다.

```bash
npm run release:build    # = tauri build (NSIS / MSI 생성)
npm run release:check    # = verify-release.mjs --require-artifacts (버전 정합 + 산출물 확인)
```

절차 상세는 [`CHANGELOG.md`](CHANGELOG.md) 의 **릴리스 승격 규칙**을 참조하세요. 요약:

1. 버전 3곳을 같은 값으로 — `Cargo.toml` `[workspace.package].version` · `package.json` · `src-tauri/tauri.conf.json` (한 곳만 바꾸면 `release:check` 가 실패합니다)
2. `CHANGELOG.md` 의 `[Unreleased]` 를 `## [X.Y.Z] — YYYY-MM-DD` 로 승격하고 새 `[Unreleased]` 블록 생성
3. `node scripts/verify-release.mjs` — 계약 검사 (산출물 없이 통과)
4. `npm run release:build` — NSIS / MSI 생성
5. `npm run release:check` — 산출물 실재 + **파일명에 버전 포함** 확인
6. `git tag -a vX.Y.Z -m "WallMagic X.Y.Z"` → `git push origin vX.Y.Z`
7. GitHub Release 생성 후 `bundle/nsis/*.exe` · `bundle/msi/*.msi` 첨부

> 코드 서명 · 자동 업데이트가 아직 없으므로 4~7단계는 **로컬 산출물 생성 + 수동 업로드**입니다. 자동화(tauri-action)는 코드 서명 설정과 함께 도입해야 서명 없는 산출물이 배포되지 않습니다.

이전 버전 산출물이 남아 있으면 `release:check` 가 `warn` 으로 알려줍니다. 정리하려면 `target/release/bundle` · `src-tauri/target/release/bundle` 을 비우세요.

| 산출물 | 경로 |
|---|---|
| 실행 파일 | `target/release/wallmagic-app.exe` |
| NSIS 인스톨러 | `target/release/bundle/nsis/` |
| MSI 인스톨러 | `target/release/bundle/msi/` |

### Windows 편의 스크립트

| 파일 | 역할 |
|---|---|
| `build-installer.cmd` | 인스톨러(NSIS / MSI) 빌드 |
| `run-app.cmd` | 빌드된 앱 실행 |
| `stop-app.cmd` | 실행 중인 앱 종료 |
| `check-app.cmd` | `cargo check` 로 빠른 컴파일 확인 |
| `test-workspace.cmd` | 워크스페이스 테스트 |

---

## 동작 방식

```
 검색 (로컬/원격)                 생성 (AI 공급자 5종)
        │                               │
        └───────────────┬───────────────┘
                        ▼
              [ 후보 이미지 목록 ]
              · 썸네일 + 생성 정보 사이드카(*.geninfo.json)
              · 히스토리(프롬프트 · 검색어) 기록
                        ▼
              [ 미리보기 뷰어 ]
              · fit / fill / actual + 원본 해상도 + 전체화면
                        ▼
              [ 적용 (IDesktopWallpaper COM) ]
              · 적용 전 원본 스냅샷 저장   ← Zero-Black-Screen
              · 실패 시 SystemParametersInfoW 폴백
                        ▼
              [ 바탕화면 변경 ] ───▶ [ 복원 (스냅샷) ]
```

의존 방향은 단방향으로 고정되어 있습니다.

```
src-ui (React)  ── IPC / JSON ──▶  src-tauri (Tauri v2)  ── 함수 호출 ──▶  wallmagic-core
```

`wallmagic-core` 는 UI · IPC 타입을 참조하지 않습니다. 구조 상세는 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 를 참조하세요.

---

## 공급자 연결

생성 화면에서 공급자를 고르면 그 공급자에 필요한 입력만 표시됩니다. 자격증명은 앱 설정(`scenario.json`)에 저장됩니다.

#### 1. Pollinations (무료 · 키 불필요)

입력이 필요 없습니다. 바로 생성할 수 있습니다. 이미지는 1920×1080 으로 요청되며, IP당 **45초에 1장** 무료 한도가 있습니다. 한도에 걸리면 `402 FREE_LIMIT` 안내와 함께 남은 대기 시간이 표시됩니다.

#### 2. Cloudflare Workers AI

`account_id`, `api_token`, 모델명이 필요합니다.

**⚠️ 모델명에 `flux` 가 포함되어야 seed를 보냅니다.**

❌ seed가 전송되지 않는 예:

```
@cf/stabilityai/stable-diffusion-xl-base-1.0
```

→ 비-flux 모델은 seed 파라미터를 받지 않으므로, 앱이 400 오류를 피하려고 seed를 **보내지 않습니다**.

✅ seed가 전송되는 예:

```
@cf/black-forest-labs/flux-1-schnell
```

#### 3. OpenAI Images

`api_key`(`sk-...`)가 필요합니다. Images API는 **seed 파라미터를 지원하지 않습니다** — 앱도 보내지 않습니다. 출력 크기는 API가 정한 고정값입니다.

#### 4. Puter

브라우저 SDK 기반입니다. 앱에서 로그인하면 모델 목록과 **남은 크레딧**이 표시됩니다. seed는 지원하지 않습니다.

#### 5. 검색

이미지를 생성하지 않습니다. 공개 이미지를 찾아 후보로 추가하므로, 프롬프트가 아니라 **검색어**가 필요합니다.

### 공급자 요약

| 공급자 | 키 필요 | seed | 비고 |
|---|---|---|---|
| Pollinations | ❌ | ✅ | 무료 · IP당 45초에 1장 |
| Cloudflare Workers AI | ✅ | flux 모델만 | 비-flux 는 seed 미전송 |
| OpenAI Images | ✅ | ❌ | API 미지원 |
| Puter | ❌ (로그인) | ❌ | 브라우저 SDK |
| 검색 | ❌ | ❌ | 생성 아님 |

### seed 3모드

| 모드 | 동작 |
|---|---|
| `random` (기본) | 생성마다 seed를 새로 뽑습니다. 같은 프롬프트도 결과가 달라집니다. |
| `incremental` | 카운터를 1씩 올립니다. 재현 가능한 변형을 만들 때 씁니다. |
| `fixed` | 지정한 값 하나를 계속 씁니다. 같은 프롬프트 = 같은 결과(캐시 포함). |

---

## 화면 구성

| 화면 | 하는 일 |
|---|---|
| 검색 | 키워드 · 해상도 필터 · 순환 검색어로 로컬/원격 검색 |
| 생성 | 공급자 선택 · 프롬프트 · seed 모드 · 모델 · 자격증명 |
| 결과 | 후보 카드 목록 · 개별 삭제 |
| 미리보기 | fit / fill / actual · 원본 해상도 · 전체화면 · 적용 |
| 시나리오 | 공급자 우선순위 · 간격 · 검색어 순환 · On/Off · 저장 |
| 히스토리 창 | 생성 일시 포함 이력 · 최신순 · 개별 삭제 · 메인으로 재사용 |

히스토리는 메인 패널이 아니라 **별도 창**에서 엽니다. 미리보기 전체화면은 `Esc` 로 닫습니다.

---

## 데이터 위치

| 파일 / 폴더 | 위치 | 내용 |
|---|---|---|
| `state.json` | `%LOCALAPPDATA%\WallMagic\` | 현재/이전 배경, 사용 백엔드 |
| `scenario.json` | 〃 | 시나리오 설정(공급자 우선순위 · 간격 · 자격증명) |
| `history.json` | 〃 | 생성 / 검색 히스토리 |
| `active\` | 〃 | 적용 직전 스테이징 이미지 |
| `online_cache\` | 〃 | 원격 이미지 임시 캐시 |
| `*.geninfo.json` | 이미지 옆 | 생성 정보 사이드카(공급자 · 모델 · prompt · seed) |

---

## 검증

이 저장소는 **계약 검증 스크립트 29종**을 함께 운영합니다. IPC 이름과 인자 키, i18n 키, seed 정책, 미리보기 모드, 창 생성 스레드 규칙, 저장소 위생(비밀정보·개인 경로)이 코드 변경으로 깨지면 자동으로 감지됩니다.

```bash
# 전체 계약 검증 (29종)
node scripts/run-all-verify.mjs

# 개별 실행
node scripts/verify-ipc-contract.mjs         # IPC 이름 + 인자 키 ↔ Rust 시그니처
node scripts/verify-app-meta.mjs             # 버전 · 라이선스 · 제작자 단일 소스
node scripts/verify-persist-i18n-meta.mjs    # i18n 키 · 메타데이터 계약
node scripts/verify-seed.mjs                 # seed 모드 · 공급자별 안내 분기
node scripts/verify-window-builder-async.mjs # 창 생성 커맨드는 async 여야 한다
node scripts/verify-repo-hygiene.mjs         # 비밀정보 · 개인 경로 · 빌드 산출물 미추적
```

Rust 테스트 중 실네트워크 · 실 OS 배경 변경이 필요한 케이스는 `#[ignore]` 로 분리되어 있습니다.

```bash
cargo test --workspace               # 기본 (ignored 제외)
cargo test --workspace -- --ignored  # opt-in: 실제 네트워크 / 바탕화면 변경
```

> ⚠️ `--ignored` 실행은 **실제 데스크톱 배경을 변경**합니다. 본인 환경에서만 실행하세요.

문서: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) · [`docs/VERIFY_ALL_FEATURES.md`](docs/VERIFY_ALL_FEATURES.md) · [`docs/CLOUDFLARE_SCENARIO.md`](docs/CLOUDFLARE_SCENARIO.md) · [`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md)

---

## 문제 해결

**개발 서버 포트(1420)가 이미 사용 중이라고 나옵니다**

`npm run dev` 는 실행 전에 1420 포트를 정리합니다. 그래도 남으면 `stop-app.cmd` 로 잔여 프로세스를 종료한 뒤 다시 실행하세요.

**생성이 `402` 로 실패합니다**

Pollinations 무료 한도입니다(IP당 45초에 1장). 안내에 표시된 시간만큼 기다린 뒤 다시 시도하세요.

**같은 프롬프트인데 결과가 매번 같습니다**

seed 모드가 `fixed` 인지 확인하세요. `random` 이면 매 요청에 새 seed가 들어갑니다. Cloudflare 는 모델명에 `flux` 가 없으면 seed를 보내지 않습니다.

**히스토리 창이 흰 화면으로 뜹니다**

창 생성은 `async` 커맨드여야 합니다. `node scripts/verify-window-builder-async.mjs` 로 회귀를 확인할 수 있습니다.

**테스트가 오래 걸립니다**

`cargo test --workspace` 는 `#[ignore]` 를 제외합니다. 실네트워크 테스트가 필요 없다면 기본 실행만 쓰세요.

---

## 보안 · 알려진 제한

이 프로젝트는 **코드 서명 · 자동 업데이트 · CSP가 적용되지 않은 개발 빌드 단계**입니다. 공개 저장소이지만 상용 배포 전 다음 항목이 남아 있습니다([`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md) P0):

- 코드 서명 · 공증 미설정
- 자동 업데이트 경로 없음
- CSP `null` (Tauri 기본값)
- 공급자 API 키가 `scenario.json` 에 **평문 저장** — 값은 IPC 응답에서 마스킹되지만 파일 자체는 암호화되지 않습니다
- 단일 인스턴스 미보장

취약점 제보는 [`SECURITY.md`](SECURITY.md) 를 참조하세요.

---

## 기여

버그 제보 · 기능 제안 · PR 모두 환영합니다. 시작 전에 [`CONTRIBUTING.md`](CONTRIBUTING.md) 를 읽어 주세요. **IPC 계약과 i18n 규칙은 검증 스크립트가 강제**하므로, PR 전에 `node scripts/run-all-verify.mjs` 를 실행해야 합니다.

변경 이력은 [`CHANGELOG.md`](CHANGELOG.md) 에 있습니다.

---

## 라이선스

[MIT License](LICENSE) — Copyright (c) 2026 **uptodatelabs**

> MIT는 소프트웨어를 자유롭게 사용 · 수정 · 배포 · 재판매할 수 있게 하는 관대한 라이선스이며, 저작권 고지와 라이선스 전문을 유지하는 조건이 붙습니다.
>
> 배포 정책을 바꾸려면 `LICENSE` · `Cargo.toml`(`[workspace.package] license`) · `package.json`(`license`)을 **함께** 수정해야 합니다. 세 곳이 어긋나면 `node scripts/verify-app-meta.mjs` 가 실패합니다.

---

## English

**English** | [한국어](#wallmagic이란)

> Full English translation of every section above — same structure, same tables, same code blocks.

## What is WallMagic?

WallMagic is a desktop application that finishes four desktop-wallpaper flows — **find · generate · apply · restore** — in a single window. It wires the local library and remote image search, five AI image providers, per-monitor apply, and snapshot restore into one pipeline.

### Key Features

- **Native apply** — uses the `IDesktopWallpaper` COM API first and falls back to `SystemParametersInfoW` automatically on failure. Per-monitor apply and 6 layout modes are supported.
- **Zero-Black-Screen** — the original wallpaper is snapshotted before applying, so no failure path leaves a black screen.
- **BYOK (Bring Your Own Key)** — AI image generation uses the provider account you connect. No API key is hardcoded in this repository.
- **Local-first** — search · history · settings · snapshots are all stored on your PC (`%LOCALAPPDATA%\WallMagic`). There is no backend server.
- **Bilingual** — full Korean / English support. Every user-facing string goes through the dictionary.
- **Seed control** — `random` (default) · `incremental` · `fixed` decide whether repeated prompts stay stable or change.

### Feature Summary

| Area | What it does |
|---|---|
| **Search** | Local library + remote image search, keyword / resolution filters, rotating queries |
| **Generate** | 5 providers (free Pollinations · Cloudflare Workers AI · OpenAI Images · Puter · Search), model selection, credential management |
| **Seed control** | `random` · `incremental` · `fixed` — the UI shows per provider whether seed is supported |
| **Preview** | 3 viewer modes (fit / fill / actual) + original-resolution loading + fullscreen |
| **Apply · Restore** | Per-monitor apply, layout mode, snapshot-based restore, applied-history sync |
| **History** | Manage generation · search history in a separate window (timestamp · newest first · per-item delete · prompt reuse) |
| **File management** | Delete candidate image files (allow-root validated + sidecar `*.geninfo.json` cleaned up together) |
| **Scenario** | Provider priority · auto-run interval · query rotation · On/Off toggles |
| **Bilingual** | Full Korean / English support (every user-facing string goes through the dictionary) |

> **26** IPC commands, **5** screens + 1 history window. See [`docs/VERIFY_ALL_FEATURES.md`](docs/VERIFY_ALL_FEATURES.md) for the full inventory.

## Technology Stack

| Layer | Technology |
|---|---|
| GUI shell | [Tauri v2](https://tauri.app) — `tauri 2` · `tauri-build 2` · `tauri-plugin-opener 2` |
| Core | Rust 1.82+ (edition 2021) — `ureq 2` (TLS) · `image 0.25` (png/jpeg/bmp) · `serde` / `serde_json` · `thiserror 2` · `base64 0.22` · `urlencoding 2` · `tracing 0.1` |
| Windows integration | `windows 0.62` — `Win32_System_Com` · `Win32_UI_Shell` · `Win32_UI_Shell_Common` · `Win32_UI_WindowsAndMessaging` · `Win32_Graphics_Gdi` · `Win32_Foundation` |
| Frontend | [React 19](https://react.dev) · TypeScript 5.7 · Vite 6 · `@tauri-apps/api 2` |
| Test / verification | `cargo test` (2 workspace crates) · 29 contract verification scripts (Node.js, no extra framework) |

- **Build pipeline** — the `dist/` produced by `tsc` → `vite build` is embedded into the bundle by Tauri as static assets.
- **Two windows share one HTML** — the main window and the history window share a single `index.html`, and `src-ui/main.tsx` picks the render target via `getCurrentWindow().label`.
- **Single metadata source** — version · license · author · repository live only in `Cargo.toml` `[workspace.package]` and are inherited by `crates/core` · `src-tauri`. If `package.json` · `tauri.conf.json` · `LICENSE` drift from those values, `node scripts/verify-app-meta.mjs` fails.

## Requirements

| Item | Requirement |
|---|---|
| OS | Windows 10 (1809+) / Windows 11 (x64) |
| Runtime | WebView2 (bundled with Windows 10/11 — no separate install) |
| Build tools | Node.js 20+ / npm, Rust 1.82+ (`rustup`), MSVC build tools (C++ workload) |
| Disk | about 50 MB |

## Quick Start

### Installation

```bash
git clone https://github.com/uptodatelabs/WallMagic.git
cd WallMagic
npm install
```

### Build

```bash
npx tsc --noEmit         # frontend type check
npm run build            # tsc + vite build → dist/
cargo build --workspace  # build the Rust workspace
```

### Run (dev mode)

```bash
npm run tauri dev
```

Starts the Vite dev server together with the Tauri window. To see the frontend only, without a window, use `npm run dev` — that command **frees port 1420 first** and then runs Vite alone.

### Release artifacts

Releases follow one order only: **version alignment → CHANGELOG promotion → bundle build → artifact verification**.

```bash
npm run release:build    # = tauri build (creates NSIS / MSI)
npm run release:check    # = verify-release.mjs --require-artifacts (version alignment + artifacts)
```

See the **release promotion rule** in [`CHANGELOG.md`](CHANGELOG.md) for details. In short:

1. Set the version in all three places — `Cargo.toml` `[workspace.package].version` · `package.json` · `src-tauri/tauri.conf.json` (changing only one makes `release:check` fail)
2. Promote the `[Unreleased]` block in `CHANGELOG.md` to `## [X.Y.Z] — YYYY-MM-DD` and create a new `[Unreleased]` block
3. `node scripts/verify-release.mjs` — contract check (passes without artifacts)
4. `npm run release:build` — produce NSIS / MSI
5. `npm run release:check` — artifact existence + **version in the file name**
6. `git tag -a vX.Y.Z -m "WallMagic X.Y.Z"` → `git push origin vX.Y.Z`
7. Create the GitHub Release and attach `bundle/nsis/*.exe` · `bundle/msi/*.msi`

> Code signing and auto-update are not in place yet, so steps 4–7 are **local artifact creation + manual upload**. Automation (tauri-action) must ship together with signing so unsigned artifacts are never published.

If artifacts from a previous version remain, `release:check` reports them as `warn`. To clean up, empty `target/release/bundle` and `src-tauri/target/release/bundle`.

| Artifact | Path |
|---|---|
| Executable | `target/release/wallmagic-app.exe` |
| NSIS installer | `target/release/bundle/nsis/` |
| MSI installer | `target/release/bundle/msi/` |

### Windows helper scripts

| File | What it does |
|---|---|
| `build-installer.cmd` | Build the installers (NSIS / MSI) |
| `run-app.cmd` | Launch the built app |
| `stop-app.cmd` | Stop a running app |
| `check-app.cmd` | Fast compile check via `cargo check` |
| `test-workspace.cmd` | Workspace tests |

## How It Works

```
 Search (local/remote)            Generate (5 AI providers)
        │                               │
        └───────────────┬───────────────┘
                        ▼
              [ candidate image list ]
              · thumbnail + generation-info sidecar (*.geninfo.json)
              · history (prompt · query) recorded
                        ▼
              [ preview viewer ]
              · fit / fill / actual + original resolution + fullscreen
                        ▼
              [ apply (IDesktopWallpaper COM) ]
              · original snapshot saved before apply   ← Zero-Black-Screen
              · SystemParametersInfoW fallback on failure
                        ▼
              [ desktop changed ] ───▶ [ restore (snapshot) ]
```

The dependency direction is fixed and one-way.

```
src-ui (React)  ── IPC / JSON ──▶  src-tauri (Tauri v2)  ── function call ──▶  wallmagic-core
```

`wallmagic-core` never references UI or IPC types. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## Provider Setup

Choosing a provider on the Generate screen shows only the inputs that provider needs. Credentials are stored in the app settings (`scenario.json`).

#### 1. Pollinations (free · no key)

No input required — generate right away. Images are requested at 1920×1080, and the free tier allows **1 image per 45 seconds per IP**. When the limit is hit, a `402 FREE_LIMIT` notice shows the remaining wait time.

#### 2. Cloudflare Workers AI

Requires `account_id`, `api_token`, and a model name.

**⚠️ seed is only sent when the model name contains `flux`.**

❌ Example where seed is NOT sent:

```
@cf/stabilityai/stable-diffusion-xl-base-1.0
```

→ Non-flux models reject the seed parameter, so the app **does not send** seed to avoid a 400 error.

✅ Example where seed IS sent:

```
@cf/black-forest-labs/flux-1-schnell
```

#### 3. OpenAI Images

Requires `api_key` (`sk-...`). The Images API **does not support the seed parameter** — the app does not send it. Output size is a fixed value set by the API.

#### 4. Puter

Browser-SDK based. After signing in from the app, the model list and **remaining credits** are shown. seed is not supported.

#### 5. Search

Does not generate images. It finds public images and adds them as candidates, so it needs a **query** rather than a prompt.

### Provider summary

| Provider | Key | seed | Note |
|---|---|---|---|
| Pollinations | ❌ | ✅ | free · 1 image per 45 s per IP |
| Cloudflare Workers AI | ✅ | flux models only | non-flux → seed not sent |
| OpenAI Images | ✅ | ❌ | not supported by the API |
| Puter | ❌ (sign-in) | ❌ | browser SDK |
| Search | ❌ | ❌ | not generation |

### The three seed modes

| Mode | Behavior |
|---|---|
| `random` (default) | Draws a fresh seed for every generation, so the same prompt yields different results. |
| `incremental` | Advances a counter by 1. Use it for reproducible variations. |
| `fixed` | Keeps using the single value you specify. Same prompt = same result (cache included). |

## Screens

| Screen | What it does |
|---|---|
| Search | Local/remote search by keyword · resolution filter · rotating queries |
| Generate | Provider selection · prompt · seed mode · model · credentials |
| Results | Candidate card list · per-item delete |
| Preview | fit / fill / actual · original resolution · fullscreen · apply |
| Scenario | Provider priority · interval · query rotation · On/Off · save |
| History window | History with timestamps · newest first · per-item delete · reuse in main |

History opens in a **separate window**, not in the main panel. The fullscreen preview closes with `Esc`.

## Data Locations

| File / folder | Location | Contents |
|---|---|---|
| `state.json` | `%LOCALAPPDATA%\WallMagic\` | Current / previous wallpaper, backend used |
| `scenario.json` | 〃 | Scenario settings (provider priority · interval · credentials) |
| `history.json` | 〃 | Generation / search history |
| `active\` | 〃 | Image staged immediately before apply |
| `online_cache\` | 〃 | Temporary cache for remote images |
| `*.geninfo.json` | next to the image | Generation-info sidecar (provider · model · prompt · seed) |

## Verification

This repository ships **29 contract verification scripts**. They automatically detect when a code change breaks IPC names and argument keys, i18n keys, seed policy, preview modes, the window-creation thread rule, or repository hygiene (secrets · personal paths).

```bash
# full contract suite (29 scripts)
node scripts/run-all-verify.mjs

# run individually
node scripts/verify-ipc-contract.mjs         # IPC names + argument keys ↔ Rust signatures
node scripts/verify-app-meta.mjs             # version · license · author single source
node scripts/verify-persist-i18n-meta.mjs    # i18n keys · metadata contract
node scripts/verify-seed.mjs                 # seed modes · per-provider UI notices
node scripts/verify-window-builder-async.mjs # window-creating commands must be async
node scripts/verify-repo-hygiene.mjs         # secrets · personal paths · build artifacts untracked
```

Rust tests that need real networking or a real OS wallpaper change are separated with `#[ignore]`.

```bash
cargo test --workspace               # default (ignored excluded)
cargo test --workspace -- --ignored  # opt-in: real network / desktop change
```

> ⚠️ Running `--ignored` **changes your actual desktop wallpaper**. Only run it on your own machine.

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) · [`docs/VERIFY_ALL_FEATURES.md`](docs/VERIFY_ALL_FEATURES.md) · [`docs/CLOUDFLARE_SCENARIO.md`](docs/CLOUDFLARE_SCENARIO.md) · [`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md)

## Troubleshooting

**The dev-server port (1420) is reported as already in use**

`npm run dev` frees port 1420 before starting. If it still lingers, stop the leftover process with `stop-app.cmd` and run it again.

**Generation fails with `402`**

That is the Pollinations free-tier limit (1 image per 45 seconds per IP). Wait the time shown in the notice and try again.

**The same prompt keeps producing the same result**

Check whether the seed mode is `fixed`. With `random`, every request carries a new seed. For Cloudflare, seed is not sent when the model name lacks `flux`.

**The history window shows a white screen**

Window creation must be an `async` command. You can check for regressions with `node scripts/verify-window-builder-async.mjs`.

**Tests take a long time**

`cargo test --workspace` excludes `#[ignore]`. If you don't need the real-network tests, use the default run only.

## Security & Known Limitations

This project is at a **development-build stage with no code signing, no auto-update, and no CSP**. It is a public repository, but the following remain before commercial distribution ([`docs/COMMERCIAL_READINESS.md`](docs/COMMERCIAL_READINESS.md) P0):

- Code signing · notarization not configured
- No auto-update path
- CSP `null` (Tauri default)
- Provider API keys are **stored in plaintext** in `scenario.json` — values are masked in IPC responses, but the file itself is not encrypted
- Single instance not guaranteed

For vulnerability reports see [`SECURITY.md`](SECURITY.md).

## Contributing

Bug reports · feature requests · PRs are all welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before starting. **IPC contracts and i18n rules are enforced by the verification scripts**, so run `node scripts/run-all-verify.mjs` before opening a PR.

Change history lives in [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT License](LICENSE) — Copyright (c) 2026 **uptodatelabs**

> MIT is a permissive license that allows free use · modification · distribution · resale, provided the copyright notice and the full license text are kept.
>
> To change the distribution policy, edit `LICENSE` · `Cargo.toml` (`[workspace.package] license`) · `package.json` (`license`) **together**. If the three drift apart, `node scripts/verify-app-meta.mjs` fails.
