/**
 * 적용 기록(`state.source`)에서 **백엔드가 실제로 사용한 검색어**를 추출하는 순수 모듈.
 *
 * 배경 (검수 지적 [medium]/[low]):
 * - 백엔드 `generate_wallpaper_priority_impl` 는 Search 성공 시 적용 기록을
 *   `"<detail> · query: <used_query> · priority"` 형태로 남긴다.
 * - UI 가 넘긴 prompt 를 그대로 표기하면 ⑤ 시나리오 키워드 순환이
 *   `search_query_for` 의 `next_index`(순차) / `seed`(랜덤)에 따라 다른 검색어를 고르므로
 *   "표기 = 실제 검색어" 계약이 깨진다 → 기록에서 읽어야 한다.
 * - 검색어 자체에 `·` 가 들어갈 수 있으므로 `·` 로 절단하면 앞부분만 표기된다.
 *   구분자 `· query:` 이후 **전체**를 취하고, 후행 접미사 ` · priority` 만 제거한다.
 *
 * 이 모듈은 React/DOM/Tauri 에 의존하지 않는다 — `scripts/verify-applied-query.mjs` 가
 * 소스 문자열 정규식이 아니라 **함수를 직접 실행**해 계약을 검증한다.
 */

/** 백엔드가 검색어 앞에 붙이는 구분자 (`<detail> · query: <used_query>`). */
const QUERY_MARKER = "· query:";
/** 구 기록 형식 하위호환용 마커 (`·` 없이 "query:" 만 있는 경우). */
const BARE_QUERY_MARKER = "query:";
/** 후행 접미사만 제거한다 — 검색어 내부의 `·` 는 보존. */
const TRAILING_PRIORITY_SUFFIX = /\s*·\s*priority\s*$/;

/**
 * 적용 기록에서 실제 사용된 검색어를 돌려준다.
 *
 * @param source `WallpaperState.source` (없을 수 있음)
 * @returns 검색어, 또는 기록에 검색어가 없으면 `null`
 */
export function parseAppliedSearchQuery(source?: string | null): string | null {
  if (!source) return null;

  const marked = source.indexOf(QUERY_MARKER);
  const start =
    marked >= 0
      ? marked + QUERY_MARKER.length
      : source.indexOf(BARE_QUERY_MARKER) >= 0
        ? source.indexOf(BARE_QUERY_MARKER) + BARE_QUERY_MARKER.length
        : -1;
  if (start < 0) return null;

  const query = source.slice(start).replace(TRAILING_PRIORITY_SUFFIX, "").trim();
  return query.length > 0 ? query : null;
}

export const APPLIED_QUERY_MARKER = QUERY_MARKER;
