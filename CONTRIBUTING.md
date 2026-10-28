# 기여 가이드 (CONTRIBUTING)

WallMagic에 관심을 가져 주셔서 감사합니다. 이 문서는 **PR이 바로 리뷰 가능한 상태**가 되기 위한 최소 조건을 정리한 것입니다.

---

## 1. 개발 환경 준비

| 도구 | 버전 | 확인 명령 |
|---|---|---|
| Node.js | 20+ | `node -v` |
| npm | 10+ | `npm -v` |
| Rust | 1.82+ | `rustc -V` |
| MSVC 빌드 도구 | C++ 워크로드 | `cargo build --workspace` 로 확인 |

```bash
npm install
npm run build            # tsc + vite build
cargo build --workspace
```

**OS 제약**: 이 프로젝트는 Windows 전용입니다. `IDesktopWallpaper` COM / `SystemParametersInfoW` 호출이 코어에 직접 들어 있어 macOS·Linux에서는 빌드되지 않습니다.

---

## 2. 변경 전후 필수 검증

PR을 올리기 전에 아래 4개를 **모두** 통과시켜 주세요. CI가 없으므로 이 실행이 유일한 회귀 방지선입니다.

```bash
npx tsc --noEmit                      # 타입 체크
npm run build                         # 프론트엔드 번들
cargo test --workspace                # Rust 테스트 (ignored 제외)
node scripts/run-all-verify.mjs       # 계약 검증 30종
```

`run-all-verify` 가 실패하면 PR은 리뷰 이전에 반려됩니다. 스크립트가 실패하면 대부분 **계약이 실제로 깨진 것**이니, 통과를 위해 검사를 느슨하게 고치는 대신 코드를 고쳐 주세요. 검사 자체가 틀렸다고 판단되면 근거(실행 출력)와 함께 스크립트를 수정해 주세요.

> `cargo test --workspace -- --ignored` 는 **실제 네트워크 호출과 실제 바탕화면 변경**을 수행합니다. CI용이 아니며 본인 환경에서만 opt-in으로 실행하세요.

---

## 3. 반드시 지켜야 하는 계약

### 3.1 IPC 계약 (이름 + 인자 키)

프론트엔드의 `invoke("cmd", { ... })` 와 Rust의 `#[tauri::command] fn cmd(...)` 는 **이름과 인자 키가 정확히 일치**해야 합니다.

```ts
invoke("apply_wallpaper", { path, monitorId, position })   // camelCase
```
```rust
fn apply_wallpaper(path: String, monitor_id: Option<String>, position: Option<String>)
```
- 새 커맨드는 반드시 `generate_handler!` 에 등록합니다(등록 누락은 `verify-ipc-contract` 가 잡습니다).
- 커맨드를 추가·삭제하면 `verify-ipc-contract.mjs` 를 그대로 통과하는지 확인하세요.

### 3.2 창 생성은 `async fn` 커맨드에서만

`WebviewWindowBuilder::build()` 를 호출하는 커맨드가 **동기 `fn`** 이면 메인 스레드 메시지 루프 재진입으로 창이 흰 화면이 되고 닫히지 않습니다.

```rust
#[tauri::command]
async fn open_something_window(app: tauri::AppHandle) -> Result<(), String> { ... }
```

`verify-window-builder-async.mjs` 가 커맨드 → 헬퍼 호출 그래프를 따라 이 규칙을 강제합니다.

### 3.3 사용자 노출 문자열은 100% i18n 경유

`statusMsg` / `scInfo` / 오류 토스트에 **리터럴 문자열을 직접 넣지 마세요.**

```ts
// ❌ 금지
reportError(`삭제 실패: ${formatErr(err)}`);

// ✅ 사전에 ko/en 키를 먼저 추가하고 t() 로 렌더
reportError(t(lang, "history.deleteFailed", { err: formatErr(err) }));
```

- 사전: [`src-ui/i18n.ts`](src-ui/i18n.ts). 모든 키는 `{ ko, en }` 쌍을 함께 가져야 합니다.
- React 밖 모듈 스코프(예: `puterUsage.ts`)에서는 `th()` / `setActiveLang()` 접근자를 사용합니다.
- 신규 키를 추가했으면 미사용 키가 쌓이지 않게 dead key 검사를 함께 돌려 주세요.

### 3.4 사용자 산출물은 절대 덮어쓰지 않는다

새 이미지를 저장할 때는 반드시 `search::unique_output_path` 를 거칩니다. `library_output_path` 는 베이스 경로 생성용이며 **저장에 직접 쓰지 않습니다**.

### 3.5 비밀정보를 커밋하지 않는다

- API 키 · 토큰 · 실제 사용자 경로(`C:\Users\<실명>`)를 코드·문서·테스트 픽스처에 넣지 마세요.
- 테스트 픽스처는 `"secret-123"` / `"sk-test-abc"` 처럼 **명백히 가짜인 값**만 사용합니다.
- 개인 경로가 필요한 문서는 `<user>` / `<repo>` 로 마스킹합니다.

---

## 4. 코드 스타일

- **주변 코드의 스타일을 따릅니다.** 새 포맷터·린터를 도입하지 마세요(현재 저장소에 설정된 것이 없습니다).
- Rust: `cargo fmt` 기본 포맷, 오류는 `thiserror` 기반. IPC 경계에서는 `Result<T, String>`.
- TypeScript: 함수 컴포넌트 + hooks. 상태는 `App.tsx` 상단에 모아 두는 기존 구조를 유지합니다.
- 주석은 **왜(why)** 를 적습니다. 무엇을 하는지는 코드가 말합니다.
- 요청받지 않은 추상화·설정 항목·의존성을 도입하지 않습니다.

---

## 5. 테스트

- **결함 수정** → 재현 테스트를 먼저 작성하고, 수정 전 실패(Red)를 확인한 뒤 고칩니다.
- **기능 추가** → 수용 조건을 테스트로 먼저 적습니다.
- 테스트는 **관측 가능한 행동**(출력·응답·영속 상태·IPC 계약)을 검증합니다. 내부 호출 순서를 그대로 옮겨 적은 테스트는 리팩터링에서 죽습니다.
- GUI/시각적 변경처럼 단위 테스트가 불가능한 경우 PR 본문에 **재현 절차 + 확인한 결과**를 적어 주세요(스크린샷 환영).
- 실네트워크·실 바탕화면 변경이 필요한 테스트는 `#[ignore]` 로 분리합니다.

---

## 6. 커밋과 PR

### 커밋 메시지 (Conventional Commits)

```
<type>(<scope>): <요약>

<본문 — 왜 바꿨는지>
```

| type | 용도 | 예시 |
|---|---|---|
| `feat` | 새 기능 | `feat(ui): 생성 액션 좌측 단일화` |
| `fix` | 결함 수정 | `fix(preview): 보기 형식이 실제 크기를 바꾸게 수정` |
| `docs` | 문서 | `docs(audit): 상용화 준비도 감사 보고서` |
| `refactor` | 동작 불변 구조 변경 | `refactor(core): seed 결정 경로 단일화` |
| `test` | 테스트만 | `test(core): 삭제 루트 검증 추가` |
| `chore` | 빌드·설정 | `chore: gitignore 보강` |

### PR 체크리스트

- [ ] `npx tsc --noEmit` 통과
- [ ] `npm run build` 통과
- [ ] `cargo test --workspace` 통과
- [ ] `node scripts/run-all-verify.mjs` 통과 (30종)
- [ ] 사용자 노출 문자열을 모두 i18n 사전에 등록 (ko/en 쌍)
- [ ] 새 IPC 커맨드를 추가했다면 `generate_handler!` 등록 + `verify-ipc-contract` 통과
- [ ] 비밀정보·실제 개인 경로가 포함되지 않음
- [ ] GUI 변경이라면 확인 절차와 결과를 본문에 기재

---

## 7. 문의

- 버그·기능 제안: GitHub Issues
- 보안 취약점: [`SECURITY.md`](SECURITY.md) 의 비공개 제보 절차를 사용해 주세요. **공개 이슈로 올리지 마세요.**
