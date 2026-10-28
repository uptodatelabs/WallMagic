# 개인정보 처리 안내 (Privacy Notice)

> 대상: WallMagic 데스크톱 앱 v1.0.0 (Windows) 및 이 저장소
> 최종 갱신: 2026-10-28
> 함께 볼 문서: [`SECURITY.md`](./SECURITY.md) · [`README.md`](./README.md) · [`docs/USER_MANUAL.md`](./docs/USER_MANUAL.md) §5

---

## 요약

- **자체 서버가 없습니다.** 개발자가 운영하는 수집·분석 서버가 존재하지 않습니다.
- **원격 측정(telemetry)·사용 통계·광고 SDK를 포함하지 않습니다.**
- 설정 · 히스토리 · 이미지 · 스냅샷은 **사용자 PC에만** 저장됩니다.
- 사용자가 **직접 프롬프트를 입력하고 실행한 경우에만** 그 텍스트가 제3자 API로 전송됩니다.
- API 키는 사용자 PC의 설정 파일에 저장되며, **현재 버전은 평문**입니다(§4).

---

## 1. 수집하지 않는 정보

WallMagic은 다음을 수집·전송하지 않습니다.

- 이름 · 이메일 · 전화번호 · 주소 등 식별 정보
- 계정 · 로그인 정보 (앱 자체 계정이 없습니다)
- 사용 기록 · 기능 사용 빈도 · 실행 시간 · 오류 리포트
- 광고 식별자 · 기기 지문
- 설치된 다른 프로그램 목록 · 브라우저 방문 기록

---

## 2. 사용자 PC에 저장되는 정보

앱은 다음 파일을 **로컬에만** 만듭니다. 위치는 `%LOCALAPPDATA%\WallMagic\` 이며, 환경변수 `WALLMAGIC_DATA_DIR` 로 재정의할 수 있습니다.

| 파일 · 폴더 | 내용 |
|---|---|
| `state.json` | 배경 스냅샷(이전 · 현재 경로, 사용한 적용 백엔드) |
| `scenario.json` | 시나리오 설정, 공급자 우선순위, **API 키(§4)**, 프롬프트 |
| `scenario_profiles.json` | 시나리오 프로필 · 자동 전환 규칙 · 전환 이력 |
| `history.json` | 생성 · 검색 히스토리 |
| `library_index.json` | 라이브러리 항목 색인 |
| `ui_prefs.json` | 언어 · 미리보기 보기 방식 등 UI 설정 |
| `library\` | 생성 · 저장된 이미지 |
| `active\` | 적용 직전 스테이징 이미지 |
| `online_cache\` | 원격 검색으로 내려받은 이미지 캐시 |

이 폴더를 삭제하면 저장된 정보가 전부 사라집니다.

---

## 3. 제3자로 전송되는 정보 (사용자가 실행한 경우에만)

이미지 생성 · 원격 검색을 **사용자가 직접 실행하면**, 그 요청 내용이 아래 사업자의 API로 전송됩니다.

| 공급자 | 전송되는 것 | 시점 |
|---|---|---|
| Pollinations | 프롬프트 텍스트 · 이미지 크기 · seed | 생성 실행 시 (키 불필요) |
| Cloudflare Workers AI | 프롬프트 텍스트 · 모델명 · API 토큰 | 생성 실행 시 (사용자가 키를 설정한 경우) |
| OpenAI | 프롬프트 텍스트 · 모델명 · API 키 | 생성 실행 시 (사용자가 키를 설정한 경우) |
| Puter | 프롬프트 텍스트 (브라우저 SDK 경유) | 생성 실행 시 (사용자가 로그인한 경우) |
| 원격 이미지 검색 | 검색어 | 검색 실행 시 |

- 위 목록 외의 목적지로는 전송하지 않습니다.
- 각 사업자의 처리 방침은 해당 사업자 문서를 참조하십시오. WallMagic은 그들의 정책을 통제하지 않습니다.
- **실행하지 않으면 전송되지 않습니다.** 앱은 백그라운드에서 임의로 외부로 요청을 보내지 않습니다. 단, 자동 전환 · 시나리오 자동 실행을 켜 둔 경우 그 시점에 설정된 공급자로 요청이 발생합니다.

---

## 4. API 키 저장 방식 — 현재 한계 (알려진 제약)

- API 키와 토큰은 `scenario.json` 에 **평문 JSON** 으로 저장됩니다.
- Windows DPAPI · 자격증명 관리자(keyring) 암호화는 **아직 적용되지 않았습니다.**
- 따라서 **공용 · 공유 PC 에서는 키를 입력하지 마십시오.**
- UI 는 키를 조회할 때 마스킹해 표시하고, 빈 값으로 저장하면 기존 키를 보존하며, 명시적으로 삭제를 요청할 때만 지웁니다.
- 이 항목은 [`docs/COMMERCIAL_READINESS.md`](./docs/COMMERCIAL_READINESS.md) 의 P0-5 로 추적되고 있습니다.

---

## 5. 삭제 · 이전 방법

| 대상 | 방법 |
|---|---|
| 히스토리 일부 | 히스토리 창에서 항목별 삭제 |
| 히스토리 전체 | 히스토리 창의 전체 삭제 |
| API 키 | 시나리오 설정에서 삭제 플래그 사용 |
| 모든 로컬 데이터 | `%LOCALAPPDATA%\WallMagic\` 폴더 삭제 (앱 종료 후) |

적용한 배경화면 자체는 Windows 설정에 저장되며, 앱을 삭제해도 유지됩니다. 되돌리려면 앱의 **이전 배경으로 복원** 기능을 쓰거나 Windows 설정에서 직접 변경하십시오.

---

## 6. 아동

이 앱은 만 14세 미만 아동을 대상으로 하지 않으며, 아동의 개인정보를 알면서 수집하지 않습니다.

---

## 7. 문의 · 신고

- 기능 문의 · 버그: 저장소의 GitHub Issues
- 보안 신고: [`SECURITY.md`](./SECURITY.md) 의 절차를 따라 주십시오

---

## 8. 변경 고지

이 문서가 바뀌면 [`CHANGELOG.md`](./CHANGELOG.md) 에 기록합니다. 중요한 변경(예: 키 암호화 도입, 텔레메트리 추가)은 릴리스 노트에도 함께 적습니다.

---

## English summary

WallMagic has **no backend server** and includes **no telemetry, analytics, or ad SDK**. All settings, history, images, and snapshots stay on your PC under `%LOCALAPPDATA%\WallMagic\`. Prompt text is sent to a third-party provider **only when you explicitly run a generation or remote search**, using the provider you configured (Pollinations, Cloudflare Workers AI, OpenAI, Puter, or the remote search source). API keys are stored in plaintext JSON in `scenario.json` in this version — **do not enter keys on a shared PC** (tracked as P0-5 in `docs/COMMERCIAL_READINESS.md`). Delete the data folder to remove everything.
