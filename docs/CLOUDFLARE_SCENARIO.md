# Cloudflare 도입안 확정 + 시나리오 설정(배경 자동 업데이트) 설계

## 1. Cloudflare 역할 결정 — 단일안: Pages(프론트 정적 배포) + R2(이미지 CDN)

Tauri 프로덕션은 `src-tauri/tauri.conf.json`의 `frontendDist: "../dist"` 로컬 로드로 동작한다
(`build.beforeBuildCommand: "npm run build"` 산출물을 WebView2가 파일로 읽음).
따라서 Cloudflare는 **앱 실행 경로에 들어가지 않는다**. 쓸 곳은 두 가지다:

| 후보 | 판정 | 근거 |
|---|---|---|
| ① 프론트 배포/업데이트 채널 (Cloudflare Pages) | ✅ 채택 | `dist/`는 순수 정적 산출물(`vite build`)이라 Pages에 그대로 올릴 수 있다. 원격 미리보기·베타 채널·업데이트 공지 페이지 용도로만 쓴다. 앱 본체는 Tauri 번들(`target/release/bundle/`)로 배포한다. |
| ② 배경화면 이미지 배포 (R2 + CDN) | ✅ 채택 | 시나리오 자동 업데이트의 `source.urls`가 가리키는 원격 이미지 호스트. R2 공개 버킷 + `https://cdn.example.com/*.jpg` 형태의 CDN URL을 권장한다. 코어 `scenario.rs::download_to_temp`는 일반 HTTPS GET이므로 R2 외의 https 호스트도 동작한다. |
| ③ 원격 접속 (Cloudflare Tunnel) | ❌ 제외 | WallMagic은 로컬 Win32 엔진(`IDesktopWallpaper` COM 1차 → `SystemParametersInfoW` 폴백)이 데스크톱을 직접 제어하는 윈도우 전용 앱이다. 외부에서 PC로 들어오는 인바운드 접속이 제품 기능이 아니므로 Tunnel은 불필요하다. |

## 2. dev `localhost:1420` 문제와 무관함 명시

`npm run tauri dev` 실행 시 "localhost 연결 거부"는 `tauri.conf.json → build.devUrl:
"http://localhost:1420"` + `vite.config.ts → server: { port: 1420, strictPort: true }` 조합에서
dev 서버(`npm run dev`)가 안 떴을 때 생기는 로컬 현상이다. Cloudflare(Pages/R2/Tunnel 중
어느 것도)는 dev 바인딩·HMR·WebView2 로드 경로에 개입하지 않으므로 이 문제와 무관하다.
해결은 `npm run tauri dev`로 dev 서버+앱을 함께 띄우거나, 프로덕션 확인은 `npm run build`
후 `target/release/bundle/` 산출물을 쓰는 것이다.

## 3. 시나리오 설정 = 배경화면 자동 업데이트 스케줄

### 3.1 스키마 (JSON, `app_data_dir()/scenario.json`)

```json
{
  "enabled": false,
  "interval_minutes": 60,
  "source": { "urls": ["https://cdn.example.com/w1.jpg"], "local_dir": null },
  "order": "sequential",
  "next_index": 0,
  "last_run_at": null,
  "position": "fill"
}
```

- `enabled`: 자동 업데이트 ON/OFF (UI 토글, 기본 false).
- `interval_minutes`: 실행 주기(분, 최소 5, 기본 60).
- `source.urls`: 원격 이미지 URL 목록 — **Cloudflare R2 공개 URL 권장**, 일반 https도 가능.
- `source.local_dir`: urls가 비었을 때 대신 순환할 로컬 폴더(선택).
- `order`: `sequential`(순차) | `random`(랜덤).
- `next_index`: 순차 모드 커서(적용 후 +1, 저장·복원됨).
- `last_run_at`: 마지막 적용 UNIX 초(null = 아직 실행 없음).
- `position`: 적용 배치 방식(`fill` 기본, `center|tile|stretch|fit|fill|span`).

### 3.2 동작 (코어 `crates/core/src/scenario.rs`)

- `should_run(settings, now)`: `enabled && 소스 존재 && (last_run_at 없음 || 주기 경과)` — 순수 함수.
- `pick_next_url(settings, seed)`: 순차 커서 / 랜덤 선택 — 순수 함수.
- `tick_scenario(now)`: 주기 도래 시 다음 1건을 다운로드→`set_wallpaper` 적용→`next_index`/`last_run_at` 저장 후 `Ok(Some(state))`, 미도래·OFF·소스없음이면 `Ok(None)`.
- 저장·복원: `scenario.json`은 `app_data_dir()`(`WALLMAGIC_DATA_DIR` 오버라이드 가능) 아래에 pretty JSON으로 저장. 앱 재시작 후에도 커서·시각이 복원된다.

### 3.3 IPC + UI

- IPC(`src-tauri/src/lib.rs`): `get_scenario` / `save_scenario` / `tick_scenario_now` 3종. 기존 6종(검색·생성·적용·복원·모니터·상태)과 같은 문자열-에러 계약.
- UI(`src-ui/App.tsx`): 우측 패널 하단 "⑤ 시나리오(자동 업데이트)" 섹션 — ON/OFF 토글, 주기(분), URL 목록(줄바꿈 구분), 순서(select), "지금 실행" 버튼, 상태 메시지. 저장 시 `scenario.json` 예시와 동일 형태로 반영된다.

### 3.4 설정 예시 (R2)

```json
{
  "enabled": true,
  "interval_minutes": 30,
  "source": {
    "urls": [
      "https://cdn.example.com/wallpapers/aurora01.jpg",
      "https://cdn.example.com/wallpapers/aurora02.jpg",
      "https://cdn.example.com/wallpapers/harbor03.jpg"
    ],
    "local_dir": null
  },
  "order": "sequential",
  "next_index": 0,
  "last_run_at": null,
  "position": "fill"
}
```

### 3.5 실행 확인 방법

1. `cargo build --workspace` (exit 0) — 코어+IPC 컴파일 확인.
2. `npm run build` (exit 0) — 프론트(`dist/`) 빌드 확인.
3. 앱에서 ⑤ 시나리오 섹션 → URL 1건+주기 5분 입력 → 저장 → "지금 실행" 클릭 → 상태바에 적용 결과·백엔드 표시.
4. `%LOCALAPPDATA%\WallMagic\scenario.json` (또는 `WALLMAGIC_DATA_DIR` 지정 시 그 아래) 파일 내용으로 저장·복원 확인.
