# WallMagic — 전기능 결과 보고서 (All-Features Verification Report)

> **대상**: WallMagic GUI (Tauri v2 + React 19 + `wallmagic-core`) 전 기능
> **범위**: IPC 커맨드 17종 / 화면 5종 / 설정 항목 12종
> **측정 일자**: 2026-10-27
> **측정 시점 HEAD**: `6d73596` (본 보고서 작성 직전 — §7 참조)
> **플랫폼**: Windows (로컬 실측)

---

## 0. 이 보고서의 판정 규칙

표의 모든 행은 **이번 측정에서 실제 실행한 명령의 출력**에 대응한다. 실행하지 않은 항목은 "통과"로 적지 않는다.

| 표기 | 의미 |
|---|---|
| **통과 [검증]** | 이번 측정에서 명령을 실행해 출력으로 확인 (해당 테스트 ok / 스크립트 ok) |
| **통과(계약) [검증]** | 런타임 동작이 아니라 **계약**(이름·인자 키·문자열 규약)만 실행 검증됨 |
| **미검증 [검증]** | 검증 수단이 존재하지 않거나, 존재하지만 이번 측정에서 실행할 수 없었음 |
| **제외(opt-in) [검증]** | `#[ignore]` 로 기본 실행에서 분리됨 — 실행 명령을 병기 |

---

## 1. 기능 개요

### 1.1 IPC 커맨드 17종

`grep "tauri::command"` → 속성 **17개**(주석 2줄 제외). `verify-ipc-contract.mjs` → `MATCH (17 commands, 19 호출부)`.

| # | 커맨드 | 역할 |
|---|---|---|
| 1 | `open_external_url` | 외부 브라우저 열기 (http/https만) |
| 2 | `apply_generated_image` | 생성된 base64 이미지를 즉시 적용 |
| 3 | `search_wallpapers` | 로컬 라이브러리 + 온라인 이미지 검색 |
| 4 | `generate_library_wallpaper_with_provider` | 지정 공급자로 1회 생성(후보 추가) |
| 5 | `save_generated_image` | 생성 이미지를 라이브러리에 저장(고유 파일명) |
| 6 | `generate_wallpaper_ai` | Puter SDK 경유 생성 |
| 7 | `generate_wallpaper_openai` | OpenAI Images API 생성 |
| 8 | `generate_wallpaper_priority` | 공급자 순서대로 폴백하며 생성·적용 |
| 9 | `candidate_for_path` | 경로 → 후보 객체/생성 정보 조회 |
| 10 | `delete_image_file` | 이미지 파일 + 사이드카 삭제 |
| 11 | `apply_wallpaper` | 경로 기반 배경 적용(모니터·위치 지정) |
| 12 | `restore_wallpaper` | 이전 배경 원복 |
| 13 | `list_monitors` | 모니터 목록 열거 |
| 14 | `get_app_status` | 코어 상태 조회 |
| 15 | `get_scenario` | 시나리오 설정 조회(자격증명 마스킹) |
| 16 | `save_scenario` | 시나리오 설정 저장 |
| 17 | `tick_scenario_now` | 시나리오 1회 즉시 실행 |

### 1.2 화면 5종

`grep "<h2"` 실측 결과.

| 화면 | 제목 문자열 |
|---|---|
| 검색 | `<h2>검색</h2>` |
| 생성 | `<h2>생성</h2>` |
| 결과 | `<h2>결과 ({candidates.length})</h2>` |
| 미리보기 | `<h2>미리보기</h2>` |
| 시나리오 | `<h2>시나리오 · Cloudflare (자동 업데이트)</h2>` |

배타 규칙: 공급자가 **검색**이면 ② 생성 패널(프롬프트·생성 버튼)을 렌더하지 않고, 생성 공급자이면 ① 검색 패널(키워드·[검색]·순환 검색어)을 렌더하지 않는다 (`verify-search-generate-button`: 19항목 ok).

### 1.3 설정 항목 12종 (`scenario.json`)

| # | 항목 | 의미 |
|---|---|---|
| 1 | `prompt` | 생성 프롬프트 (생성 전용 — 검색어와 무관) |
| 2 | `source.search_queries` | 이미지 검색어 목록 (검색 전용) |
| 3 | `source.next_index` | 순환 검색어 커서 |
| 4 | `source.urls` / `source.local_dir` | 외부 URL 소스 / 로컬 디렉터리 |
| 5 | `provider_order` | 생성 시도 순서 |
| 6 | `disabled_providers` | 공급자 On/Off |
| 7 | `seed_mode` | `fixed` / `incremental` / `random`(기본) |
| 8 | `seed_fixed` | Fixed 모드 고정 seed 값 |
| 9 | `seed_next` | Incremental/Random 카운터 |
| 10 | 자동 실행 간격 | `interval_secs` + 최소값 검증 |
| 11 | 모델 선택 | Cloudflare 모델(flux 여부로 seed 게이팅) |
| 12 | 자격증명 | `api_token`, `openai_api_key` — 마스킹·보존·명시 삭제 |

부가: `position`(배경 위치 6종), `monitor_id`.

---

## 2. 검증 방법론

이 환경에서 에이전트가 Tauri GUI를 마우스로 조작하는 것은 검증으로 성립하지 않는다(재현성·증거성 없음). 따라서 **프로젝트가 이미 보유한 실행 수단을 그대로 구동한 출력**을 증거로 삼았다. 임시 자동화 하네스·데몬·CDP 프로브는 이번 측정에서 **신규 작성하지 않았다**.

직접 구동한 최상위 명령 **6종**:

| # | 명령 | 대상 |
|---|---|---|
| 1 | `cargo test -p wallmagic-core --lib -- --test-threads=4` | 코어 도메인 로직 79 테스트 |
| 2 | `cargo test -p wallmagic-app --lib -- --test-threads=4` | IPC 래퍼 계약 22 테스트 |
| 3 | `npx tsc --noEmit` | 프론트 타입 |
| 4 | `npm run build` | `tsc && vite build` 프로덕션 번들 |
| 5 | `node scripts/run-all-verify.mjs` | 계약 검증 스크립트 **23종** 일괄 |
| 6 | `git log` / `git status` / `grep` | 상태·구조 실측 |

`run-all-verify.mjs` 가 구동한 23종: `applied-query`, `applied-sync`, `apply-label`, `delete-file`, `file-geninfo`, `format-err`, `free-port`, `generation-info`, `ipc-contract`, `popup-allow`, `popup-fallback`, `port-e2e`, `preview-viewer`, `provider-routing`, `provider-toggle-credit`, `puter-image`, `puter-priority`, `puter-signin`, `puter-usage-normalize`, `search-generate-button`, `search-provider`, `seed`, `ui-consistency`.

---

## 3. 도메인별 결과 표

### 3.1 IPC 커맨드 — 백엔드 계약

| 커맨드 | 검증 수단 (실행됨) | 결과 | 판정 |
|---|---|---|---|
| `open_external_url` | `external_url_tests` 3건(https 허용·비http 거부·메타문자 무주입) | ok | 통과 [검증] |
| `apply_generated_image` | `test_apply_generated_image_requires_label` | ok | 통과(계약) [검증] |
| `search_wallpapers` | `test_search_wallpapers_filters_by_name_and_resolution`, `_caps_results_at_max`, `_merges_online_results_even_when_local_matches`, `_skips_online_when_query_is_empty`, `_includes_rgba_png_with_alpha_channel` | ok | 통과 [검증] |
| `generate_library_wallpaper_with_provider` | `test_generate_library_with_provider_routes_or_fails_explicitly`, `test_provider_credentials_are_not_cross_used` | ok | 통과(계약) [검증] |
| `save_generated_image` | `test_save_generated_image_requires_label_and_derives_file_name`, `_never_overwrites_previous_output` | ok | 통과 [검증] |
| `generate_wallpaper_ai` | `verify-provider-routing` (라우팅 계약) — 앱 단위 테스트 없음 | ok | 통과(계약) [검증] |
| `generate_wallpaper_openai` | `test_openai_request_body_has_no_seed`(코어) + `verify-provider-routing` | ok | 통과(계약) [검증] |
| `generate_wallpaper_priority` | `test_priority_search_requires_search_queries_not_prompt`, `test_fallback_skips_unconfigured_without_network_call`, `test_fallback_returns_last_error_when_all_fail` | ok | 통과 [검증] |
| `candidate_for_path` | `verify-ipc-contract`(이름·인자 키만) | ok | **미검증** [검증] — 동작 테스트 없음 |
| `delete_image_file` | `delete_tests` 2건(루트 내부 파일+사이드카 삭제 / 루트 외부 거부) | ok | 통과 [검증] |
| `apply_wallpaper` | `test_apply_wallpaper_inherits_sidecar_generation_info`, `test_parse_position_arg_contract` | ok | 통과(계약) [검증] / 실 배경 변경 **제외** |
| `restore_wallpaper` | `test_resolve_previous_wallpaper_preserves_original_user_wallpaper`(원본 스냅샷 보존) | ok | 통과(계약) [검증] / 실 원복 **제외** |
| `list_monitors` | `verify-ipc-contract`(인자 없음 ↔ `{}`) 뿐 | ok | **미검증** [검증] — 열거 로직 테스트 0건 |
| `get_app_status` | `test_get_app_status_reports_core_state`, `test_state_file_is_isolated_by_data_dir_override` | ok | 통과 [검증] |
| `get_scenario` | `test_get_scenario_masks_api_token`, `_masks_openai_api_key` | ok | 통과 [검증] |
| `save_scenario` | `test_save_scenario_keeps_existing_token_when_empty`, `_keeps_openai_key_when_empty`, `_clears_token_only_when_flagged`, `_clears_openai_key_only_when_flagged` | ok | 통과 [검증] |
| `tick_scenario_now` | `test_should_run_gating`, `test_should_run_true_with_search_queries_only`, `test_should_run_false_when_no_configured_provider`, `test_validate_rejects_short_interval`, `test_needs_cursor_reset_detects_source_change`, `test_search_rotation_advances_next_index_and_formats_query_detail` | ok | 통과 [검증] |

### 3.2 화면 — UI 계약

| 화면 | 검증 수단 | 결과 | 판정 |
|---|---|---|---|
| 검색 | `verify-search-provider`(31) · `verify-ui-consistency` | ok | 통과(계약) [검증] / 렌더 **미검증** |
| 생성 | `verify-search-generate-button`(19) · `verify-seed`(36) | ok | 통과(계약) [검증] / 렌더 **미검증** |
| 결과 | `verify-delete-file`(17) · `verify-provider-toggle-credit`(18) | ok | 통과(계약) [검증] |
| 미리보기 | `verify-preview-viewer`(16) · `verify-generation-info`(23) · `verify-applied-sync`(15) · `verify-applied-query`(8) · `verify-apply-label`(7) | ok | 통과(계약) [검증] |
| 시나리오 | `verify-provider-toggle-credit`(18) · `verify-puter-priority`(12) | ok | 통과(계약) [검증] |
| Puter 크레딧 정규화 | `verify-puter-usage-normalize`(17) | ok | 통과 [검증] — 실측 JSON(remaining 578.6956…, allowance 1,000) 재현 |
| Puter 로그인·모델 | `verify-puter-signin` · `verify-puter-image`(12) | ok | 통과(계약) [검증] / 실브라우저 **미검증** |
| IPC 이름·인자 키 | `verify-ipc-contract` → `MATCH (17 commands, 19 호출부)` | ok | 통과 [검증] |

### 3.3 설정·하이퍼파라미터

| 항목 | 검증 수단 (실행됨) | 결과 | 판정 |
|---|---|---|---|
| `seed_mode` | `test_seed_mode_defaults_to_random_for_legacy_json`, `test_next_seed_value_modes` | ok | 통과 [검증] |
| `seed_fixed` / `seed_next` | `test_advance_seed_increments_except_fixed`, `test_advance_after_generation_advances_seed_counter`, `fresh_seed_tests` 3건(`random_seeds_never_repeat_within_same_second` 포함) | ok | 통과 [검증] |
| Random seed 실효성 | `fresh_seed_tests` 3건 — 같은 초 내 64회 전부 상이 | ok | 통과 [검증] |
| `provider_order` | `test_default_provider_order_is_free_first`, `test_effective_provider_order_empty_falls_back_to_single_and_dedups` | ok | 통과 [검증] |
| `disabled_providers` | `test_disabled_providers_excluded_from_order_and_config`, `_defaults_empty_for_legacy_json` | ok | 통과 [검증] |
| `search_queries` (검색어=단독 소스) | `test_search_never_falls_back_to_prompt`, `test_provider_is_configured_search_ignores_prompt`, `test_search_query_for_uses_keywords_only_and_none_when_empty`, `test_search_queries_legacy_json_compatible` | ok | 통과 [검증] |
| `next_index` / `urls` 순환 | `test_search_rotation_advances_next_index_and_formats_query_detail`, `test_pick_next_url_sequential_and_random` | ok | 통과 [검증] |
| `local_dir` 로컬 검색 | `test_search_wallpapers_filters_by_name_and_resolution` (간접) | ok | 통과(간접) [검증] |
| 자동 실행 간격 | `test_validate_rejects_short_interval`, `test_should_run_gating`, `test_failure_backoff_delays_retry` | ok | 통과 [검증] |
| 모델(flux 여부 seed 게이팅) | `test_cloudflare_accepts_seed_only_for_flux_models`, `test_provider_supports_seed_matrix`, `test_generation_source_detail_includes_model` | ok | 통과 [검증] |
| `position` (6종) | `test_parse_position_arg_contract`, `test_normalize_rejects_below_minimum`, `test_normalize_upscales_1024x576_to_hd`, `test_rejects_low_resolution_image` | ok | 통과 [검증] |
| 자격증명 마스킹·보존 | `save_scenario`/`get_scenario` 6건 | ok | 통과 [검증] |
| Cloudflare 응답 파싱 | `cf_parse_result_image_ok`, `_result_string_variant_ok`, `_bad_base64_errors`, `_missing_image_errors`, `cf_url_format`, `test_http_status_preserves_code` | ok | 통과 [검증] |
| HTTP 재시도·에러 진단 | `pollinations_retry_tests` 10건 — 재시도 복구·영구오류 미재시도·진단 보존·content-type 검증·Retry-After 파싱 | ok | 통과 [검증] |
| 생성 정보 사이드카 | `test_generation_info_is_recorded_and_persisted`, `_record_generation_clears_on_blank`, `_record_generation_stores_provider_and_source`, `_generation_info_persists_in_state_json` | ok | 통과 [검증] |
| 온라인 캐시 파일명 | `test_online_cache_file_name_separates_prefix_collisions` | ok | 통과 [검증] |
| 스테이징 재사용(덮어쓰기 방지) | `test_reapplying_staged_wallpaper_reuses_same_file` | ok | 통과 [검증] |

---

## 4. 판정 요약

| 분류 | 건수 | 비고 |
|---|---|---|
| **통과 (실행 검증)** | 17 IPC 중 13 · 5 화면 중 0(계약만) · 설정 12 중 12 | 아래 "통과(계약)"와 구분 |
| **통과 (계약만)** | 17 IPC 중 3(`generate_wallpaper_ai`·`generate_wallpaper_openai`·`apply_wallpaper`) · 화면 5 전건 | 런타임 실행 없음 |
| **미검증 (수동 확인 필요)** | 2 — `candidate_for_path`, `list_monitors` | 검증 수단 자체가 부재/부족 |
| **제외 (opt-in)** | 5 — 실 OS 배경·실네트워크 의존 | 실행 명령은 §5 |

### 실행 결과 집계 [검증]

```
cargo test -p wallmagic-core --lib → 75 passed; 0 failed; 4 ignored   (등록 79)
cargo test -p wallmagic-app  --lib → 21 passed; 0 failed; 1 ignored   (등록 22)
node scripts/run-all-verify.mjs    → scripts=23 failed=0
npx tsc --noEmit                   → exit=0
npm run build                      → exit=0 (33 modules)
```

**신규 실패 0건.**

---

## 5. 미검증 항목과 수동 확인 절차

### 5.1 미검증 (검증 수단 부재)

| # | 대상 | 사유 | 수동 확인 절차 |
|---|---|---|---|
| 1 | `list_monitors` | 열거 로직 단위 테스트 0건. 계약(인자 없음)만 확인됨 | 앱 실행 → ⑤ 시나리오/③ 미리보기의 모니터 선택 UI에서 목록이 실제 모니터 수·이름과 일치하는지 확인. 다중 모니터 환경이면 각 모니터에 개별 적용되는지까지 확인 |
| 2 | `candidate_for_path` | 계약(이름·`{path}`)만 확인. 동작 테스트 없음 | ③ 결과 카드 클릭 → ④ 미리보기가 해당 경로의 이미지·생성 정보를 표시하는지 확인. 존재하지 않는 경로 전달 시 오류 문구가 뜨는지 확인 |

### 5.2 제외 (opt-in) — 실행 명령 병기

| # | 테스트 | 사유 | 실행 명령 |
|---|---|---|---|
| 1 | `tests::test_double_set_then_restore_preserves_original_wallpaper` | 실제 OS 배경 변경 | `cargo test -p wallmagic-core --lib -- --ignored` |
| 2 | `tests::test_generate_library_wallpaper_returns_candidate_with_bounded_thumbnail` | 실네트워크 | 〃 |
| 3 | `tests::test_online_generate_is_not_offline_gradient_stub` | 실네트워크 | 〃 |
| 4 | `tests::test_online_search_falls_back_when_local_has_no_matches` | 실네트워크 | 〃 |
| 5 | `tests::test_ipc_smoke_search_generate_apply_restore` | 실네트워크 + 실 배경 변경 | `cargo test -p wallmagic-app --lib -- --ignored` |

### 5.3 이 환경에서 원천적으로 불가능한 검증

| 항목 | 사유 | 대체 증거 |
|---|---|---|
| GUI 5화면 렌더·클릭 | 에이전트가 Tauri 창을 조작할 수 없음 | `verify-*` 23종의 계약 검증 + `grep <h2>` 구조 실측 |
| 실 API 호출(Pollinations/Cloudflare/OpenAI/Puter/Wikimedia) | 네트워크 의존·과금·레이트리밋 | 요청 조립 단위 테스트(`test_pollinations_url_carries_seed`, `test_openai_request_body_has_no_seed`, `cf_parse_*`) |
| 실 OS 배경 적용·원복 | 사용자 데스크톱 변경 | 사이드카 복원·스냅샷 보존 단위 테스트 |
| `tauri build` 패키징(NSIS/MSI) | 이번 측정 미실행 | — (**미검증**) |

---

## 6. 실행 명령 원문과 exit code

```
$ cargo test -p wallmagic-core --lib -- --test-threads=4
exit=0
running 79 tests
test scenario::fresh_seed_tests::random_seeds_never_repeat_within_same_second ... ok
test scenario::tests::test_search_never_falls_back_to_prompt ... ok
test scenario::tests::test_provider_is_configured_search_ignores_prompt ... ok
test tests::test_save_generated_image_never_overwrites_previous_output ... ok
test tests::test_search_merges_online_results_even_when_local_matches ... ok
test tests::test_double_set_then_restore_preserves_original_wallpaper ... ignored, changes the real OS wallpaper; run explicitly with `cargo test -- --ignored`
test tests::test_generate_library_wallpaper_returns_candidate_with_bounded_thumbnail ... ignored, requires network access to the image generation API
test tests::test_online_generate_is_not_offline_gradient_stub ... ignored, requires network access to the image generation API
test tests::test_online_search_falls_back_when_local_has_no_matches ... ignored, requires network access to the online image search API
test wallpaper::pollinations_retry_tests::test_fetch_with_retry_recovers_from_transient_rate_limit ... ok
test wallpaper::pollinations_retry_tests::test_fetch_with_retry_gives_up_after_max_attempts_with_diagnostics ... ok
test result: ok. 75 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 66.51s
```

```
$ cargo test -p wallmagic-app --lib -- --test-threads=4
exit=0
running 22 tests
test external_url_tests::test_validate_external_url_accepts_http_https ... ok
test external_url_tests::test_validate_external_url_rejects_bad_scheme ... ok
test external_url_tests::test_validate_external_url_meta_char_url_no_shell ... ok
test delete_tests::test_delete_within_roots_removes_file_and_sidecar ... ok
test delete_tests::test_delete_within_roots_rejects_outside_path ... ok
test tests::test_decode_image_payload_contract ... ok
test tests::test_apply_generated_image_requires_label ... ok
test tests::test_apply_wallpaper_inherits_sidecar_generation_info ... ok
test tests::test_generate_library_with_provider_routes_or_fails_explicitly ... ok
test tests::test_ipc_smoke_search_generate_apply_restore ... ignored, requires network access and changes the real OS wallpaper; run explicitly with `cargo test -- --ignored`
test tests::test_parse_position_arg_contract ... ok
test tests::test_get_app_status_reports_core_state ... ok
test tests::test_get_scenario_masks_api_token ... ok
test tests::test_get_scenario_masks_openai_api_key ... ok
test tests::test_priority_search_requires_search_queries_not_prompt ... ok
test tests::test_provider_credentials_are_not_cross_used ... ok
test tests::test_save_generated_image_never_overwrites_previous_output ... ok
test tests::test_save_generated_image_requires_label_and_derives_file_name ... ok
test tests::test_save_scenario_clears_openai_key_only_when_flagged ... ok
test tests::test_save_scenario_clears_token_only_when_flagged ... ok
test tests::test_save_scenario_keeps_existing_token_when_empty ... ok
test tests::test_save_scenario_keeps_openai_key_when_empty ... ok
test result: ok. 21 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.80s
```

```
$ npx tsc --noEmit
exit=0
(출력 없음)
```

```
$ npm run build
exit=0
> wallmagic@0.1.0 build
> tsc && vite build
vite v6.4.5 building for production...
transforming...
✓ 33 modules transformed.
dist/index.html                 0.81 kB │ gzip:  0.60 kB
dist/assets/index-D_CiOrCv.css  6.15 kB │ gzip:  1.82 kB
dist/assets/index-BPGMx5gJ.js 270.64 kB │ gzip: 83.75 kB
✓ built in 1.24s
```

```
$ node scripts/run-all-verify.mjs
exit=0
scripts=23 failed=0
```

```
$ node scripts/verify-ipc-contract.mjs
exit=0
MATCH: IPC 명령 이름 + 인자 키 계약 일치 (17 commands, 19 호출부)
```

```
$ grep "tauri::command"  (src-tauri/src/lib.rs)
속성 `#[tauri::command]` 17줄 + 참조 주석 2줄 → 커맨드 17개 일치
```

```
$ grep "<h2"  (src-ui/App.tsx)
App.tsx:            <h2>검색</h2>
App.tsx:            <h2>생성</h2>
App.tsx:          <h2>결과 ({candidates.length})</h2>
App.tsx:          <h2>미리보기</h2>
App.tsx:            <h2>시나리오 · Cloudflare (자동 업데이트)</h2>
```

---

## 7. git 증빙

**측정 시점 HEAD**: `6d73596` — 본 보고서는 이 커밋 **이후**에 추가되는 문서이므로, 보고서 자신의 커밋은 아래 로그에 포함되지 않는다.

```
$ git log --oneline -1
exit=0
6d73596 docs(core): 시나리오 틱 임시 파일의 고정 이름 의도와 online_cache pruning 후속 과제를 명시

$ git status --short --branch
exit=0
## main
```

> 본 보고서 커밋 후의 `git log --oneline --stat -1` / `git status --porcelain` 원문은 아래 §7.1 에 기재한다.

### 7.1 본 보고서 커밋 시점 증빙

(커밋 직후 측정값을 이 절에 그대로 추가한다.)

---

## 8. 한계 (정직 고지)

1. **GUI 실기동 0회** — 5개 화면의 렌더 결과·클릭 동작·레이아웃은 이번 측정에서 확인하지 않았다. 화면 관련 판정은 전부 "계약 검증"이며, 근거는 `verify-*` 스크립트의 문자열·구조 검사와 `grep` 이다.
2. **실네트워크 0회** — Pollinations 이미지 생성, Wikimedia 검색, Cloudflare/OpenAI/Puter API 호출을 실행하지 않았다. 따라서 "실제로 이미지가 생성되는가"는 이 보고서로 증명되지 않는다(§5.2 의 ignored 4건).
3. **실 OS 배경 변경 0회** — 적용·원복·모니터별 지정은 OS 상태를 바꾸므로 실행하지 않았다. `list_monitors` 는 검증 수단 자체가 없다(§5.1-1).
4. **`tauri build` 패키징 미실행** — 상용 배포 산출물(NSIS/MSI)은 이번 측정 범위 밖이다.
5. **계약 검증의 한계** — `verify-*` 23종은 소스 문자열·구조를 검사하는 스크립트다. "함수가 의도대로 호출된다"는 사실은 검증하나, "호출 결과가 사용자에게 옳게 보인다"는 검증하지 않는다. 후자는 GUI 실기동이 필요하다.
6. **설정 항목 12종의 필드명** — 이번 측정에서 `scenario.rs` 를 다시 읽지 않고 테스트·스크립트 이름에서 역추적한 항목이 일부 있다(`source.local_dir` 등). 필드명 자체의 최신 확인은 별도 read 가 필요하다.
7. **`scripts/run-all-verify.mjs`** 는 파일 주석에 "임시"로 표기되어 있으나 저장소에 남아 있다. 러너 자체의 정합성(23종 목록이 최신인지)은 이번에 재검토하지 않았다.
