# WallMagic 문서 인덱스

> 이 디렉터리의 문서 목록과 **읽는 순서**를 정리한다. 저장소 개요는 루트 [`README.md`](../README.md)를 참조.

---

## 1. 문서 목록

| 문서 | 목적 | 주요 독자 | 성격 |
|---|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | GUI 아키텍처와 **모듈 구조·결정 근거** | 개발자·기여자 | 설계 기준서 |
| [development-plan.md](./development-plan.md) | 상용화 **개발 계획서** — 플랫폼 선정, 아키텍처, 수익화·배포, WBS, 리스크 | 의사결정자·개발자 | 계획서(원안) |
| [market-competitor-analysis.md](./market-competitor-analysis.md) | **시장 판정** — 대중 매력도·경쟁 포화도·가격 경쟁력, 경쟁 제품 19종 가격표, $0.99~$2.99 정량 비교, GO/NO-GO | 의사결정자 | 분석 보고서 |
| [market-verdict-summary.md](./market-verdict-summary.md) | 위 보고서의 **1페이지 의사결정 카드** | 의사결정자 | 요약 |
| [market/04-open-source-donation-feasibility.md](./market/04-open-source-donation-feasibility.md) | **"GitHub 공개 + 기부" 경로 타당성** — 기부 기저율·전환율 근거, 제품 적합도 스코어카드(34/100), 시나리오별 월 수익 × 확률 매트릭스, 4안 비교(A·B·C·D), GO/NO-GO | 의사결정자 | 분석 보고서 |
| [RELEASE_NOTES_v1.0.0.md](./RELEASE_NOTES_v1.0.0.md) | **v1.0.0 릴리스 노트** — 한국어 원문 + English 번역을 1:1 구조로 병기 (GitHub Release 본문과 동일) | 최종 사용자·기여자 | 릴리스 문서 |
| [COMMERCIAL_READINESS.md](./COMMERCIAL_READINESS.md) | **상용화 준비도 감사** — P0/P1/P2 22건, 각 항목 근거(file:line)와 권장 조치 | 개발자·릴리스 담당 | 감사 보고서 |
| [CLOUDFLARE_SCENARIO.md](./CLOUDFLARE_SCENARIO.md) | Cloudflare Workers AI 도입안 + **시나리오(자동 업데이트) 설정** 설계 | 개발자 | 설계 문서 |
| [USER_MANUAL.md](./USER_MANUAL.md) | **사용 매뉴얼** — 설치, 화면별 사용법, FAQ, 문제 해결 | 최종 사용자 | 사용자 문서 |
| [VERIFY_ALL_FEATURES.md](./VERIFY_ALL_FEATURES.md) | **전기능 검증 결과** — 기능별 구현·검증 상태 | 개발자·QA | 검증 보고서 |
| [VERIFY_M1.md](./VERIFY_M1.md) | M1 마일스톤 **검증 보고서** | 개발자·QA | 검증 보고서 |

---

## 2. 읽는 순서 (목적별)

### 처음 이 프로젝트를 보는 사람
1. [`../README.md`](../README.md) — 제품이 무엇인지 5분 안에
2. [USER_MANUAL.md](./USER_MANUAL.md) — 실제로 무엇을 할 수 있는지
3. [ARCHITECTURE.md](./ARCHITECTURE.md) — 어떻게 만들어졌는지
4. [VERIFY_ALL_FEATURES.md](./VERIFY_ALL_FEATURES.md) — 어디까지 검증됐는지

### **팔 것인지 결정해야 하는 사람**
1. [market-verdict-summary.md](./market-verdict-summary.md) — **1페이지 판정 카드 (여기서 시작)**
2. [market-competitor-analysis.md](./market-competitor-analysis.md) — 근거·가격표·정량 비교
3. [COMMERCIAL_READINESS.md](./COMMERCIAL_READINESS.md) — 팔기 전에 남은 P0 5건
4. [development-plan.md](./development-plan.md) — 원안 수익 모델($14.99)과 KPI

### 릴리스·배포를 준비하는 사람
1. [COMMERCIAL_READINESS.md](./COMMERCIAL_READINESS.md) — P0/P1 우선순위
2. [VERIFY_ALL_FEATURES.md](./VERIFY_ALL_FEATURES.md) — 검증 커버리지
3. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — 계약 검증 스크립트 규칙

> ⚠️ **문서 간 충돌 주의**: [USER_MANUAL.md](./USER_MANUAL.md)는 "외부 API·구독·인앱 결제가 없습니다"라고 안내하고, [development-plan.md](./development-plan.md)는 "$14.99 평생 라이선스"를 주력 수익원으로 계획한다. **유료화를 실행할 경우 사용자 매뉴얼을 반드시 갱신해야 한다.**

---

## 3. 판정 요약 (2026-10-28)

| 전략 | 판정 | 상세 |
|---|---|---|
| 대중 저가 판매 ($0.99~$2.99) | **NO-GO** | [market-competitor-analysis.md §7](./market-competitor-analysis.md#7-최종-go--no-go) |
| 파워유저 영구 라이선스 ($9.99~$14.99) | **조건부 GO** (선행 4건) | 동일 |
| 무료 배포 + 후원 | **GO** | 동일 |

**핵심 수치**: $0.99의 Lemon Squeezy 실수취 **$0.421(42.6%)** · $500/년 필요량 **1,187건** (vs $14.99로 **38건**) · $1.99 대비 물량 배수 **3.20배**.

---

## 4. 문서 갱신 규칙

- **판정이 바뀌면** `market-verdict-summary.md`를 먼저 고치고, `market-competitor-analysis.md`에 근거를 추가한다. (요약 → 본문 순서)
- **P0가 해소되면** `COMMERCIAL_READINESS.md`의 해당 행에 해소일과 근거를 남긴다.
- **새 문서를 추가하면** 이 인덱스의 §1 표에 한 줄을 반드시 추가한다.
- 증거 등급 표기(`[실측]` `[검색]` `[추정]` `[필요 확인]`)를 유지한다 — 검증되지 않은 서술을 사실로 읽히게 하지 않기 위함이다.
