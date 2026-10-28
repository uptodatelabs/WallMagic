/**
 * 한국어/영어 UI 문자열 사전 + 언어 설정 영속화.
 *
 * 설계
 * - 문자열은 **키 → {ko, en}** 사전 한 곳에만 존재한다(화면에 리터럴 하드코딩 금지).
 * - 언어 설정은 `localStorage`(`wallmagic.lang`)에 저장해 재시동 후에도 유지한다.
 *   저장소를 쓸 수 없는 환경(사생활 보호 모드 등)은 조용히 실패하지 않고
 *   기본 언어(ko)로 동작하며, `saveLang` 은 boolean 으로 성공 여부를 알린다.
 * - 이 모듈은 React/DOM/Tauri 에 의존하지 않는 **순수 모듈**이다 — 검증 스크립트가
 *   함수를 직접 실행해 계약(키 존재·치환·폴백)을 확인할 수 있다.
 *
 * 주의: 같은 키를 두 번 정의하면 두 번째가 첫 번째를 조용히 덮어써 번역이 사라진다.
 * TS 는 `TS1117` 로 막지만, 사전이 길면 놓치기 쉬우므로 키는 **한 번만** 정의한다.
 */

export type Lang = "ko" | "en";

/** 지원 언어 목록(순서 = 선택 UI 순서). */
export const LANGS: { id: Lang; label: string }[] = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
];

/** 언어 설정 저장 키. */
export const LANG_STORAGE_KEY = "wallmagic.lang";

/** 기본 언어 — 저장값이 없거나 손상됐을 때. */
export const DEFAULT_LANG: Lang = "ko";

type Entry = { ko: string; en: string };

/**
 * UI 문자열 사전 (키는 중복 없이 한 번만 정의).
 *
 * `{name}` 형태의 자리표시자는 `t()` 의 vars 로 치환된다.
 * 키를 추가할 때는 반드시 ko/en 을 **둘 다** 채운다(한쪽 누락은 `t()` 가 키를
 * 그대로 노출하므로 화면에서 즉시 드러난다).
 */
export const STRINGS: Record<string, Entry> = {
  /* 공통 */
  "app.title": { ko: "WallMagic Studio", en: "WallMagic Studio" },
  "app.subtitle": { ko: "Windows 배경화면 스튜디오", en: "Windows Wallpaper Studio" },
  "lang.label": { ko: "언어", en: "Language" },
  "common.apply": { ko: "바탕화면에 적용", en: "Apply to desktop" },
  "common.restore": { ko: "이전 배경으로 복원", en: "Restore previous wallpaper" },
  "common.delete": { ko: "삭제", en: "Delete" },
  "common.deleteThis": { ko: "이 파일 삭제", en: "Delete this file" },
  "common.fullscreen": { ko: "전체화면", en: "Fullscreen" },
  "common.closeEsc": { ko: "닫기 (Esc)", en: "Close (Esc)" },
  "common.busy": { ko: "처리 중...", en: "Working..." },
  "common.ready": { ko: "준비됨", en: "Ready" },
  "common.noPath": { ko: "삭제할 파일 경로가 없습니다.", en: "No file path to delete." },
  "common.deleteFailed": { ko: "삭제 실패: {err}", en: "Delete failed: {err}" },
  "common.deleteDone": { ko: "삭제 완료 — {name}", en: "Deleted — {name}" },
  "common.applyFailed": { ko: "적용 실패: {err}", en: "Apply failed: {err}" },
  "common.applyDone": { ko: "적용 완료 — 백엔드: {backend}", en: "Applied — backend: {backend}" },
  "common.restoreFailed": { ko: "복원 실패: {err}", en: "Restore failed: {err}" },
  "common.restoreDone": { ko: "복원 완료 — 백엔드: {backend}", en: "Restored — backend: {backend}" },
  "common.selectFirst": {
    ko: "적용할 이미지를 먼저 선택하세요.",
    en: "Select an image to apply first.",
  },
  "common.unknown": { ko: "알 수 없음", en: "unknown" },
  "common.stateQueryFailed": { ko: "상태 조회 실패: {err}", en: "Failed to read state: {err}" },
  "common.monitorQueryFailed": {
    ko: "모니터 조회 실패: {err}",
    en: "Failed to read monitors: {err}",
  },

  /* 헤더 */
  "header.monitor": { ko: "대상 모니터", en: "Target monitor" },
  "header.allMonitors": { ko: "모든 모니터", en: "All monitors" },
  "header.primary": { ko: "기본", en: "primary" },

  /* 검색 */
  "search.heading": { ko: "검색", en: "Search" },
  "search.keyword": {
    ko: "키워드 (파일명 검색 + 온라인 검색 질의)",
    en: "Keyword (file name + online search query)",
  },
  "search.keywordPlaceholder": {
    ko: "예: sunset (비우면 전체)",
    en: "e.g. sunset (empty = all)",
  },
  "search.dir": { ko: "검색 폴더 (선택)", en: "Search folder (optional)" },
  "search.dirPlaceholder": {
    ko: "C:\\Users\\me\\Pictures (기본: 라이브러리+Pictures)",
    en: "C:\\Users\\me\\Pictures (default: library + Pictures)",
  },
  "search.queries": {
    ko: "시나리오 순환 검색어 (선택 — 비우면 위 키워드 사용)",
    en: "Scenario rotation keywords (optional — empty = use keyword above)",
  },
  "search.queriesHint": {
    ko: "비어 있으면 위 키워드가 그대로 검색 질의로 쓰입니다(키워드 = 검색 질의의 단일 소스). 여러 개를 넣으면 시나리오 자동 실행에서 순차/랜덤으로 순환합니다. 생성의 프롬프트와는 무관합니다.",
    en: "If empty, the keyword above is used as the query (keyword = single source of the query). With several entries the scenario runner rotates them sequentially/randomly. Unrelated to the generation prompt.",
  },
  "search.action": { ko: "검색", en: "Search" },
  "search.failed": { ko: "검색 실패: {err}", en: "Search failed: {err}" },
  "search.done": { ko: "검색 완료: {shown}개 후보", en: "Search done: {shown} candidates" },
  "search.doneTruncated": {
    ko: "검색 완료: {total}건 중 {shown}건 표시",
    en: "Search done: {shown} of {total} shown",
  },
  "search.noKeyword": { ko: "검색 키워드를 입력하세요.", en: "Enter a search keyword." },

  /* 생성 */
  "gen.heading": { ko: "생성", en: "Generate" },
  "gen.providerQuick": {
    ko: "이미지 공급자 (검색/생성 화면 전환)",
    en: "Image provider (switch search/generate)",
  },
  "gen.providerQuickHint": {
    ko: "검색(Search)을 고르면 검색 화면만, 생성 공급자를 고르면 생성 화면만 표시합니다. 검색어와 프롬프트는 서로 다른 입력입니다(자동 대체 없음).",
    en: "Choosing Search shows only the search view; choosing a generator shows only the generation view. Keyword and prompt are separate inputs (no automatic substitution).",
  },
  "gen.prompt": {
    ko: "프롬프트 (생성 전용 — AI 이미지 공급자 공통)",
    en: "Prompt (generation only — shared by AI providers)",
  },
  "gen.promptPlaceholder": {
    ko: "예: aurora over icy mountains",
    en: "e.g. aurora over icy mountains",
  },
  "gen.action": { ko: "생성 ({provider})", en: "Generate ({provider})" },
  "gen.actionApply": { ko: "생성 후 적용", en: "Generate and apply" },
  "gen.promptRequired": { ko: "프롬프트를 입력하세요.", en: "Please enter a prompt." },
  "gen.searchOnly": {
    ko: "검색(Search)은 왼쪽 검색 영역의 [검색] 버튼으로 실행합니다 — 생성 화면은 이미지 생성 전용입니다.",
    en: "Search runs from the [Search] button in the search view — this view is for image generation only.",
  },
  "gen.providerOff": {
    ko: "선택한 공급자({provider})가 Off(비활성)입니다 — 우선순위 목록에서 On 으로 바꾼 뒤 다시 시도하세요.",
    en: "The selected provider ({provider}) is Off — turn it On in the priority list and retry.",
  },
  "gen.puterFailed": {
    ko: "Puter 생성 실패 (기존 배경 유지): {err}",
    en: "Puter generation failed (previous wallpaper kept): {err}",
  },
  "gen.puterDone": {
    ko: "Puter 생성·적용 완료 — 백엔드: {backend}",
    en: "Puter generated and applied — backend: {backend}",
  },
  "gen.searchFailed": {
    ko: "검색 생성 실패 (기존 배경 유지): {err}",
    en: "Search generation failed (previous wallpaper kept): {err}",
  },
  "gen.searchApplied": {
    ko: "검색 생성·적용 완료 — 검색어: \"{query}\" · 백엔드: {backend}",
    en: "Search generated and applied — keyword: \"{query}\" · backend: {backend}",
  },
  "gen.openaiFailed": {
    ko: "OpenAI 생성 실패 (기존 배경 유지): {err}",
    en: "OpenAI generation failed (previous wallpaper kept): {err}",
  },
  "gen.openaiDone": {
    ko: "OpenAI 생성·적용 완료 — 백엔드: {backend}",
    en: "OpenAI generated and applied — backend: {backend}",
  },
  "gen.cloudflareAccountRequired": {
    ko: "Cloudflare Account ID를 입력하세요. (API Token은 저장된 토큰 사용 — 미저장 시 입력 필요)",
    en: "Enter the Cloudflare Account ID (the saved API token is used — enter one if none is saved).",
  },
  "gen.cloudflareFailed": {
    ko: "Cloudflare AI 생성 실패 (기존 배경 유지): {err}",
    en: "Cloudflare AI generation failed (previous wallpaper kept): {err}",
  },
  "gen.cloudflareDone": {
    ko: "Cloudflare AI 생성·적용 완료 — 백엔드: {backend}",
    en: "Cloudflare AI generated and applied — backend: {backend}",
  },
  "gen.failed": { ko: "생성 실패 ({provider}): {err}", en: "Generation failed ({provider}): {err}" },
  "gen.done": {
    ko: "생성 완료 ({provider}): {name}",
    en: "Generated ({provider}): {name}",
  },
  "gen.priorityFailed": {
    ko: "우선순위 생성 실패 (기존 배경 유지): {err}",
    en: "Priority generation failed (previous wallpaper kept): {err}",
  },

  /* 결과 */
  "results.heading": { ko: "결과 ({count})", en: "Results ({count})" },
  "results.empty": {
    ko: "왼쪽에서 검색 또는 생성하면 이곳에 후보가 표시됩니다.",
    en: "Search or generate on the left and candidates will appear here.",
  },
  "results.restored": {
    ko: "이전 생성 이미지 {count}건을 복원했습니다",
    en: "Restored {count} previously generated images",
  },

  /* 미리보기 */
  "preview.heading": { ko: "미리보기", en: "Preview" },
  "preview.empty": { ko: "선택된 이미지가 없습니다.", en: "No image selected." },
  "preview.fitLabel": { ko: "보기 방식", en: "View mode" },
  "preview.fitFit": { ko: "창맞춤 (Fit)", en: "Fit to window" },
  "preview.fitActual": { ko: "원본 크기 (100%)", en: "Actual size (100%)" },
  "preview.fitFill": { ko: "채우기 (Fill)", en: "Fill" },
  // 뷰어가 원본 해상도 로딩에 실패해 썸네일(320px)로 폴백했을 때 사유를 노출한다.
  // 무음 폴백이면 사용자는 "전체화면이 왜 작은지" 알 수 없다.
  "preview.viewerLoadFailed": {
    ko: "원본 해상도를 불러오지 못해 축소 썸네일로 표시합니다 — {reason}",
    en: "Could not load the full-resolution image; showing the downscaled thumbnail — {reason}",
  },
  "preview.clickFullscreen": {
    ko: "클릭하면 전체화면으로 봅니다",
    en: "Click to view fullscreen",
  },
  "preview.genFile": {
    ko: "생성 정보 (미리보기 파일)",
    en: "Generation info (preview file)",
  },
  "preview.genCurrent": {
    ko: "생성 정보 (현재 배경)",
    en: "Generation info (current wallpaper)",
  },
  "preview.genUnknownFile": {
    ko: "(이 파일의 생성 정보 미기록 — 사이드카 없음)",
    en: "(no generation info for this file — no sidecar)",
  },
  "preview.genUnknownCurrent": {
    ko: "(이 앱에서 생성한 배경 아님 / 미기록)",
    en: "(not generated by this app / not recorded)",
  },
  "preview.currentWallpaperPath": {
    ko: "현재 배경: {path}",
    en: "Current wallpaper: {path}",
  },
  "preview.mismatch": {
    ko: "현재 배경과 다른 파일 — \"생성 정보 (현재 배경)\"은 위 미리보기({name})의 정보가 아닙니다. 이 이미지의 정보는 위 \"생성 정보 (미리보기 파일)\"을 보세요.",
    en: "This is a different file from the current wallpaper — \"Generation info (current wallpaper)\" does not describe the preview above ({name}). See \"Generation info (preview file)\" for this image.",
  },

  /* 히스토리 */
  "history.heading": { ko: "히스토리", en: "History" },
  "history.prompt": { ko: "프롬프트", en: "Prompt" },
  "history.search": { ko: "검색어", en: "Keyword" },
  "history.empty": { ko: "아직 기록이 없습니다.", en: "Nothing recorded yet." },
  "history.clear": { ko: "히스토리 지우기", en: "Clear history" },
  "history.summary": {
    ko: "전용 창에서 목록·생성 일시를 확인하고 개별 삭제할 수 있습니다. (현재 {n}건)",
    en: "Open the dedicated window to view entries with timestamps and delete them individually. ({n} now)",
  },
  "history.cleared": { ko: "히스토리를 지웠습니다", en: "History cleared" },
  "history.clearFailed": {
    ko: "히스토리 삭제 실패: {err}",
    en: "Failed to clear history: {err}",
  },
  /* 히스토리 전용 창 — 목록·생성 일시·개별 삭제 */
  "history.openWindow": { ko: "히스토리 창 열기", en: "Open history window" },
  "history.openFailed": {
    ko: "히스토리 창을 열지 못했습니다: {err}",
    en: "Failed to open the history window: {err}",
  },
  "history.count": { ko: "{n}건", en: "{n} entries" },
  "history.createdAt": { ko: "생성 일시", en: "Created" },
  "history.createdAtHint": {
    ko: "최신순으로 정렬됩니다",
    en: "Sorted newest first",
  },
  "history.refresh": { ko: "새로고침", en: "Refresh" },
  "history.loadFailed": {
    ko: "히스토리를 불러오지 못했습니다: {err}",
    en: "Failed to load history: {err}",
  },
  "history.delete": { ko: "삭제", en: "Delete" },
  "history.deleted": { ko: "1건을 삭제했습니다", en: "Deleted one entry" },
  "history.deleteFailed": {
    ko: "삭제하지 못했습니다: {err}",
    en: "Failed to delete: {err}",
  },
  "history.useInMain": { ko: "메인에 넣기", en: "Send to main" },
  "history.sentToMain": {
    ko: "메인 창 입력란으로 보냈습니다: \"{text}\"",
    en: "Sent to the main window: \"{text}\"",
  },
  "history.sendFailed": {
    ko: "메인 창으로 보내지 못했습니다: {err}",
    en: "Failed to send to the main window: {err}",
  },

  /* 시나리오 */
  "scenario.heading": { ko: "시나리오 (자동 업데이트)", en: "Scenario (auto update)" },
  "scenario.autoUpdate": { ko: "자동 업데이트", en: "Auto update" },
  "scenario.interval": { ko: "주기 (분, 최소 5)", en: "Interval (minutes, min 5)" },
  "scenario.urls": {
    ko: "이미지 URL 목록 (줄바꿈 구분, R2 권장)",
    en: "Image URLs (one per line, R2 recommended)",
  },
  "scenario.localDir": {
    ko: "로컬 폴더 (선택 — URL이 비었을 때 순환)",
    en: "Local folder (optional — used when URLs are empty)",
  },
  "scenario.searchQueriesNote": {
    ko: "이미지 검색어는 검색 영역에서 입력합니다(검색 공급자 전용). 저장 시 source.search_queries 로 함께 저장됩니다.",
    en: "Image keywords are entered in the search view (search provider only). They are saved together as source.search_queries.",
  },
  "scenario.order": { ko: "순서", en: "Order" },
  "scenario.orderSeq": { ko: "순차 (sequential)", en: "Sequential" },
  "scenario.orderRandom": { ko: "랜덤 (random)", en: "Random" },
  "scenario.seed": {
    ko: "이미지 seed (같은 이미지 반복 방지)",
    en: "Image seed (avoid repeating the same image)",
  },
  "scenario.seedFixed": {
    ko: "고정 (fixed — 같은 seed = 같은 이미지)",
    en: "Fixed (same seed = same image)",
  },
  "scenario.seedIncremental": {
    ko: "순차 (incremental — 생성마다 +1)",
    en: "Incremental (+1 each time)",
  },
  "scenario.seedRandom": {
    ko: "랜덤 (random — 기본, 매번 다른 이미지)",
    en: "Random (default, different each time)",
  },
  "scenario.seedFixedPlaceholder": {
    ko: "고정 seed 값 (예: 12345)",
    en: "Fixed seed value (e.g. 12345)",
  },
  "scenario.seedPollinationsHint": {
    ko: "Pollinations 는 같은 프롬프트·같은 seed 면 캐시된 동일 이미지를 돌려줍니다. 기본값 랜덤이면 생성마다 seed 가 달라져 결과가 매번 달라집니다.",
    en: "Pollinations returns the cached image when the prompt and seed are the same. With the default random mode the seed changes every run, so results differ each time.",
  },
  "scenario.seedOpenaiHint": {
    ko: "OpenAI Images API 는 seed 파라미터를 지원하지 않아 전송하지 않습니다 — seed 설정은 이 공급자에 적용되지 않습니다.",
    en: "The OpenAI Images API has no seed parameter, so none is sent — the seed setting does not apply to this provider.",
  },
  "scenario.seedPuterHint": {
    ko: "Puter(WebView 브라우저 SDK)는 seed 를 받지 않습니다 — seed 설정은 Puter 생성에 적용되지 않습니다.",
    en: "Puter (WebView browser SDK) does not accept a seed — the seed setting does not apply to Puter generation.",
  },
  "scenario.seedSearchHint": {
    ko: "검색(Search)은 seed 를 쓰지 않습니다 — 이미지를 생성하지 않고 공개 이미지를 찾습니다.",
    en: "Search does not use a seed — it finds public images instead of generating one.",
  },
  "scenario.seedCounter": { ko: "현재 카운터: {count}", en: "Current counter: {count}" },
  "scenario.provider": { ko: "이미지 공급자", en: "Image provider" },
  "scenario.providerShared": {
    ko: "좌측 이미지 공급자(검색/생성 화면 전환)와 같은 값을 공유합니다 — 한쪽을 바꾸면 다른 쪽도 함께 바뀌고, 저장되는 값도 이 공급자 하나입니다(별도 설정이 아닙니다).",
    en: "Shares the same value as the left image provider (search/generate switch) — changing one changes the other, and only this one provider is saved (it is not a separate setting).",
  },
  "scenario.allowFallback": {
    ko: "자동 폴백 허용 (선택 공급자 실패 시 다음 공급자로 넘어감 — 기본은 끔: 선택한 공급자만 사용)",
    en: "Allow automatic fallback (try the next provider if the selected one fails — off by default: use only the selected provider)",
  },
  "scenario.priorityLabel": {
    ko: "이미지 생성 우선순위 (폴백 순서 — 위부터 시도, 실패 시 다음 공급자)",
    en: "Generation priority (fallback order — tried top-down, next provider on failure)",
  },
  "scenario.on": { ko: "On", en: "On" },
  "scenario.offHint": {
    ko: "Off 로 두면 이 공급자는 생성·폴백·시나리오 자동 실행에서 모두 제외됩니다.",
    en: "If set to Off, this provider is excluded from generation, fallback and scenario auto runs.",
  },
  "scenario.priorityReset": { ko: "무료 우선으로 초기화", en: "Reset to free-first" },
  "scenario.creditHeading": {
    ko: "Puter 남은 크레딧 (월간 allowance)",
    en: "Puter remaining credits (monthly allowance)",
  },
  "scenario.puterBackendExcluded": {
    ko: "백엔드 폴백 제외(WebView 전용)",
    en: "excluded from backend fallback (WebView only)",
  },
  "scenario.priorityDefaultHint": {
    ko: "기본값: 무료 우선 = Pollinations → Puter → Cloudflare → OpenAI. 키 없는 공급자는 자동 건너뛰고, Puter는 브라우저 전용이라 백엔드 폴백(시나리오 자동 실행)에서 제외됩니다.",
    en: "Default: free-first = Pollinations → Puter → Cloudflare → OpenAI. Providers without credentials are skipped automatically, and Puter is excluded from backend fallback (scenario runner) because it is browser-only.",
  },
  "scenario.priorityGenerate": {
    ko: "우선순위로 생성·적용",
    en: "Generate & apply by priority",
  },
  "scenario.cfAccount": { ko: "Cloudflare Account ID", en: "Cloudflare Account ID" },
  "scenario.cfAccountPlaceholder": { ko: "예: a1b2c3d4...", en: "e.g. a1b2c3d4..." },
  "scenario.cfToken": {
    ko: "Cloudflare API Token (Workers AI 권한)",
    en: "Cloudflare API Token (Workers AI permission)",
  },
  "scenario.cfTokenPlaceholder": {
    ko: "Workers AI 권한 토큰",
    en: "Token with Workers AI permission",
  },
  "scenario.clearToken": {
    ko: "저장된 API 토큰 삭제 (체크 후 저장 시 삭제)",
    en: "Delete saved API token (removed when saved with this checked)",
  },
  "scenario.model": { ko: "모델", en: "Model" },
  "scenario.openaiKey": { ko: "OpenAI API Key", en: "OpenAI API Key" },
  "scenario.clearKey": {
    ko: "저장된 API 키 삭제 (체크 후 저장 시 삭제)",
    en: "Delete saved API key (removed when saved with this checked)",
  },
  "scenario.puterLabel": { ko: "Puter (무료 · 브라우저 SDK)", en: "Puter (free · browser SDK)" },
  "scenario.puterDesc": {
    ko: "생성은 WebView의 Puter.js(puter.ai.txt2img)가 수행하고, 결과 이미지는 Rust 커맨드 apply_generated_image가 해상도 검증·스테이징·적용합니다. API 키 입력은 필요 없습니다 (Puter 세션 사용). SDK 로드 실패 시 명시적 오류가 표시됩니다.",
    en: "Generation runs in the WebView with Puter.js (puter.ai.txt2img); the resulting image is validated, staged and applied by the Rust command apply_generated_image. No API key is required (the Puter session is used). SDK load failures are reported explicitly.",
  },
  "scenario.puterModel": { ko: "이미지 모델", en: "Image model" },
  "scenario.puterModelHint": {
    ko: "모델을 선택하지 않으면 Puter 기본 모델(OpenAI gpt-image-2)이 사용됩니다. 모델마다 결과 화질·속도·사용 크레딧이 다릅니다.",
    en: "If no model is selected, Puter's default model (OpenAI gpt-image-2) is used. Image quality, speed and credit usage differ per model.",
  },
  "scenario.creditBusy": { ko: "조회 중...", en: "Fetching..." },
  "scenario.creditIdle": {
    ko: "(아직 조회하지 않았습니다 — [크레딧 조회]를 누르세요)",
    en: "(not fetched yet — press [Fetch credits])",
  },
  "scenario.creditFetch": { ko: "크레딧 조회", en: "Fetch credits" },
  "scenario.creditFailed": {
    ko: "크레딧 조회 실패: {err}",
    en: "Failed to fetch credits: {err}",
  },
  "scenario.creditRaw": {
    ko: "원본 응답 보기 (진단 — 실제 스키마 확인용)",
    en: "Show raw response (diagnostics — actual schema)",
  },
  "scenario.creditSummary": {
    ko: "남은 크레딧: {remaining}{unit}",
    en: "Remaining credits: {remaining}{unit}",
  },
  "scenario.creditAllowance": {
    ko: " / 월 한도 {allowance}",
    en: " / monthly allowance {allowance}",
  },
  "scenario.creditSpent": { ko: " · 사용 {spent}", en: " · used {spent}" },
  "scenario.creditUnitUnspecified": { ko: "미표기", en: "unspecified" },
  "scenario.creditUnitPath": {
    ko: " · 단위: {unit}({path}) · 경로: 남음 {remainingPath} / 한도 {allowancePath} / 사용 {spentPath}",
    en: " · unit: {unit}({path}) · paths: remaining {remainingPath} / allowance {allowancePath} / spent {spentPath}",
  },
  "scenario.puterSignIn": {
    ko: "Puter 로그인 (세션 연결)",
    en: "Puter sign-in (connect session)",
  },
  "scenario.autoFail": {
    ko: " · 자동 실패 {n}회 연속",
    en: " · {n} consecutive automatic failures",
  },
  "scenario.autoTickFail": {
    ko: "자동 업데이트 실패({n}회 연속) — 수동 \"지금 실행\"으로 상세 확인: {err}",
    en: "Automatic update failed ({n} in a row) — use \"Run now\" for details: {err}",
  },
  "scenario.autoApplied": {
    ko: "시나리오 자동 적용 — 백엔드: {backend}",
    en: "Scenario applied automatically — backend: {backend}",
  },
  "scenario.saveFailed": {
    ko: "시나리오 저장 실패: {err}",
    en: "Failed to save the scenario: {err}",
  },
  "scenario.intervalInvalid": {
    ko: "주기는 5분 이상 숫자로 입력하세요.",
    en: "Enter the interval as a number of 5 minutes or more.",
  },
  "scenario.puterNotSavable": {
    ko: "Puter는 WebView 전용 생성 경로라 시나리오 공급자로 저장할 수 없습니다. Pollinations/검색(Search)/Cloudflare/OpenAI 중 선택 후 저장하세요.",
    en: "Puter is a WebView-only generation path and cannot be saved as the scenario provider. Choose Pollinations/Search/Cloudflare/OpenAI and save again.",
  },
  "scenario.providerOffNotSavable": {
    ko: "선택한 공급자({provider})가 Off(비활성)입니다 — 우선순위 목록에서 On 으로 바꾼 뒤 저장하세요.",
    en: "The selected provider ({provider}) is Off — turn it On in the priority list before saving.",
  },
  "scenario.loadFailed": {
    ko: "시나리오 조회 실패: {err}",
    en: "Failed to load the scenario: {err}",
  },
  "scenario.infoLine": {
    ko: "다음 #{next} · 마지막 {last} · {onoff}",
    en: "Next #{next} · last {last} · {onoff}",
  },
  "scenario.lastNone": { ko: "없음", en: "none" },
  "scenario.off": { ko: "OFF", en: "OFF" },
  "scenario.onShort": { ko: "ON", en: "ON" },
  "scenario.runFailed": {
    ko: "시나리오 실행 실패: {err}",
    en: "Scenario run failed: {err}",
  },
  "scenario.runApplied": {
    ko: "시나리오 적용 — 백엔드: {backend}",
    en: "Scenario applied — backend: {backend}",
  },
  "scenario.runNow": { ko: "지금 실행", en: "Run now" },
  "scenario.save": { ko: "시나리오 저장", en: "Save scenario" },

  /* 정보(About) */
  "about.heading": { ko: "정보", en: "About" },
  "about.version": { ko: "버전", en: "Version" },
  "about.author": { ko: "제작자", en: "Author" },
  "about.notLoaded": { ko: "(미조회)", en: "(not loaded)" },

  /* 상태바 */
  "footer.current": { ko: "현재 배경: {path}", en: "Current wallpaper: {path}" },
  "footer.previous": { ko: "이전 배경: {path}", en: "Previous wallpaper: {path}" },
  "footer.genInfo": { ko: "생성 정보: {info}", en: "Generation info: {info}" },
  "footer.none": { ko: "(조회 안 됨)", en: "(not loaded)" },
  "footer.noSnapshot": { ko: "(스냅샷 없음)", en: "(no snapshot)" },
  "footer.noneGenerated": {
    ko: "(이 앱에서 생성한 배경 아님 / 미기록)",
    en: "(not generated by this app / not recorded)",
  },

  /* 배치 방식(적용 위치) — Windows IDesktopWallpaper 배치값과 1:1 */
  "position.label": { ko: "배치 방식", en: "Placement" },
  "position.center": { ko: "가운데 (Center)", en: "Center" },
  "position.tile": { ko: "바둑판식 (Tile)", en: "Tile" },
  "position.stretch": { ko: "늘이기 (Stretch)", en: "Stretch" },
  "position.fit": { ko: "맞춤 (Fit)", en: "Fit" },
  "position.fill": { ko: "채우기 (Fill)", en: "Fill" },
  "position.span": { ko: "스팬 (Span)", en: "Span" },

  /* 언어 저장 실패 안내 */
  "lang.saveFailed": {
    ko: "언어 설정을 저장하지 못했습니다 — 이번 실행에만 적용됩니다(localStorage 차단).",
    en: "Could not save the language setting — it only applies to this run (localStorage blocked).",
  },

  /* Puter 로그인 안내 모달 */
  "modal.title": {
    ko: "Puter 로그인 — 팝업이 차단되었습니다",
    en: "Puter sign-in — the popup was blocked",
  },
  "modal.desc": {
    ko: "아래 주소를 복사해 브라우저에서 열거나, [바로가기]를 눌러 기본 브라우저로 이동하세요. 외부 브라우저 로그인은 앱 세션과 별개이므로, 앱에서 생성하려면 이 사이트의 팝업을 허용한 뒤 다시 시도해야 합니다.",
    en: "Copy the address below and open it in a browser, or press [Open] to launch your default browser. A browser login is separate from the app session — allow popups for this site and try again to generate inside the app.",
  },
  "modal.copyUrl": { ko: "URL 복사", en: "Copy URL" },
  "modal.openBrowser": { ko: "바로가기 (브라우저 열기)", en: "Open in browser" },
  "modal.close": { ko: "닫기", en: "Close" },
  "modal.copied": {
    ko: "URL을 클립보드에 복사했습니다",
    en: "Copied the URL to the clipboard",
  },
  "modal.copyFailed": { ko: "URL 복사 실패: {err}", en: "Failed to copy the URL: {err}" },
  "modal.opened": {
    ko: "브라우저에서 로그인 페이지를 열었습니다",
    en: "Opened the sign-in page in your browser",
  },
  "modal.openFailed": { ko: "브라우저 열기 실패: {err}", en: "Failed to open the browser: {err}" },

  /* 공급자 라벨 */
  "provider.pollinations": {
    ko: "Pollinations (무료·키 불필요)",
    en: "Pollinations (free, no key)",
  },
  "provider.search": {
    ko: "검색 (Search — 키워드·키 불필요)",
    en: "Search (keyword, no key)",
  },
  "provider.puter": { ko: "Puter (무료·브라우저 SDK)", en: "Puter (free, browser SDK)" },
  "provider.cloudflare": {
    ko: "Cloudflare Workers AI",
    en: "Cloudflare Workers AI",
  },
  "provider.openai": { ko: "OpenAI", en: "OpenAI" },
  "scenario.localDirPlaceholder": { ko: "C:\\Users\\me\\Pictures\\auto (비우면 사용 안 함)", en: "C:\\Users\\me\\Pictures\\auto (empty = unused)" },
  "scenario.seedCfFluxYes": { ko: "Cloudflare Workers AI 는 flux 계열 모델에서만 seed 를 받습니다 — 현재 모델은 flux 이므로 seed 가 전송됩니다.", en: "Cloudflare Workers AI accepts a seed only for flux-family models — the current model is flux, so the seed is sent." },
  "scenario.seedCfFluxNo": { ko: "현재 모델은 flux 계열이 아니므로 seed 를 전송하지 않습니다 — 비-flux 모델에 seed 를 보내면 400 오류가 납니다.", en: "The current model is not in the flux family, so no seed is sent — sending one to a non-flux model returns HTTP 400." },
  "history.reusedSearch": { ko: "검색어를 되살렸습니다: \"{text}\"", en: "Restored the keyword: \"{text}\"" },
  "history.reusedPrompt": { ko: "프롬프트를 되살렸습니다: \"{text}\"", en: "Restored the prompt: \"{text}\"" },

  /* 상태바/시나리오 상태 메시지 — reportOk/reportError 로 전달되는 모든 문구.
     호출부에 한글 리터럴을 두지 않기 위해 여기 한 곳에만 존재한다. */
  "scenario.notLoaded": { ko: "시나리오 미조회", en: "Scenario not loaded" },
  "scenario.savedInfo": {
    ko: "저장됨 · 다음 #{next} · {onoff} · {minutes}분",
    en: "Saved · next #{next} · {onoff} · {minutes} min",
  },
  "scenario.savedCleared": {
    ko: "시나리오 저장 완료 — 저장된 API 토큰/키를 삭제했습니다",
    en: "Scenario saved — the stored API token/key was deleted",
  },
  "scenario.savedPlain": { ko: "시나리오 저장 완료", en: "Scenario saved" },
  "scenario.puterSignedIn": {
    ko: "Puter 세션 연결 완료 — 이제 이미지 생성을 사용할 수 있습니다",
    en: "Puter session connected — image generation is now available",
  },
  "scenario.puterSignInFailed": {
    ko: "Puter 로그인 실패: {err}",
    en: "Puter sign-in failed: {err}",
  },
  "gen.sdkNotLoaded": { ko: "Puter.js SDK 미로드", en: "Puter.js SDK not loaded" },
  "gen.notSignedIn": { ko: "Puter 로그인 상태 아님", en: "Puter is not signed in" },
  "gen.skippedSdk": {
    ko: "{provider}: SDK 미로드 — 건너뜀",
    en: "{provider}: SDK not loaded — skipped",
  },
  "gen.skippedSignedOut": {
    ko: "{provider}: 로그인 상태 아님 — 건너뜀",
    en: "{provider}: not signed in — skipped",
  },
  "gen.providerFailed": { ko: "{provider}: {err}", en: "{provider}: {err}" },
  "gen.strictFailed": {
    ko: "선택한 공급자({provider}) 실패: {err} — 자동 폴백 비활성",
    en: "Selected provider ({provider}) failed: {err} — automatic fallback is off",
  },
  "gen.noProvider": {
    ko: "시도 가능한 이미지 공급자가 없습니다.",
    en: "No image provider available to try.",
  },
  "gen.failedBefore": { ko: " · 앞선 실패: {list}", en: " · earlier failures: {list}" },
  "gen.stateJsonNote": {
    ko: " · state.json: {provider}{source}",
    en: " · state.json: {provider}{source}",
  },
  "gen.stateJsonNone": {
    ko: " · state.json: 생성 정보 없음",
    en: " · state.json: no generation info",
  },
  "gen.priorityDoneDetail": {
    ko: "우선순위 생성·적용 완료 — 선택: {selected} → 실제: {used} · 응답 provider: {responseProvider}{savedNote} · 백엔드: {backend}{skippedNote}",
    en: "Priority generation applied — selected: {selected} → actual: {used} · response provider: {responseProvider}{savedNote} · backend: {backend}{skippedNote}",
  },
  "gen.aiPromptRequired": {
    ko: "AI 프롬프트를 입력하세요.",
    en: "Please enter an AI prompt.",
  },
  "common.none": { ko: "없음", en: "none" },
  "scenario.tickSkipped": {
    ko: "시나리오: 아직 주기가 안 됐거나 OFF/소스 없음",
    en: "Scenario: interval not reached, or OFF / no source",
  },

  /* Puter 이미지 모델 라벨 — 브랜드명은 그대로, 부연만 번역한다. */
  "puter.model.gptImage2": {
    ko: "GPT Image 2 (Puter 기본값)",
    en: "GPT Image 2 (Puter default)",
  },
  "puter.model.fluxSchnell": {
    ko: "FLUX.1 schnell (빠름)",
    en: "FLUX.1 schnell (fast)",
  },

  /* 모듈 스코프 헬퍼(Puter SDK·브라우저 열기 등)가 만드는 사용자 노출 오류.
     이 문구들은 Error.message 로 상태바에 그대로 표시되므로 사전을 거쳐야
     영어 선택 시 한국어 오류가 남지 않는다. React 상태(lang)에 접근할 수 없는
     위치이므로 아래 `th()`(현재 언어)를 쓴다. */
  "err.puterBase64Failed": {
    ko: "Puter 이미지 base64 변환 실패",
    en: "Failed to convert the Puter image to base64",
  },
  "err.puterImageDownload": {
    ko: "Puter 이미지 다운로드 실패: HTTP {status}",
    en: "Puter image download failed: HTTP {status}",
  },
  "err.puterResultUnparsable": {
    ko: "Puter 응답 형식을 해석할 수 없습니다: {kind}",
    en: "Cannot interpret the Puter response format: {kind}",
  },
  "err.sdkNotLoaded": {
    ko: "Puter.js SDK를 불러오지 못했습니다 (오프라인/스크립트 차단).",
    en: "Failed to load the Puter.js SDK (offline or script blocked).",
  },
  "err.authUnavailable": {
    ko: "Puter 로그인(auth)을 사용할 수 없습니다 — SDK 버전을 확인하세요.",
    en: "Puter auth is unavailable — check the SDK version.",
  },
  "err.signInUnavailable": {
    ko: "Puter 로그인(auth.signIn)을 사용할 수 없습니다 — SDK 버전을 확인하세요.",
    en: "Puter auth.signIn is unavailable — check the SDK version.",
  },
  "err.noMonthlyUsage": {
    ko: "이 Puter.js SDK 버전에는 getMonthlyUsage 가 없습니다 — 잔여 크레딧을 조회할 수 없습니다.",
    en: "This Puter.js SDK version has no getMonthlyUsage — remaining credits cannot be fetched.",
  },
  "err.signInRequired": {
    ko: "Puter 로그인이 필요합니다 — [Puter 로그인] 후 다시 조회하세요.",
    en: "Puter sign-in is required — sign in and fetch again.",
  },
  "err.promptModalUnavailable": {
    ko: "Puter 로그인 안내 창을 표시할 수 없습니다 — 잠시 후 다시 시도하세요.",
    en: "Cannot show the Puter sign-in notice — try again in a moment.",
  },
  "err.shellOpenFailed": { ko: "셸 오픈 실패: {err}", en: "Shell open failed: {err}" },
  "err.linkFallbackFailed": {
    ko: "링크 폴백 실패: {err}",
    en: "Link fallback failed: {err}",
  },
  "err.popupBlockedNoModal": {
    ko: "팝업이 차단되었습니다 — 안내 창을 표시하지 못했습니다 ({err})",
    en: "The popup was blocked and the notice could not be shown ({err})",
  },
  "err.popupBlockedAdvice": {
    ko: "팝업이 차단되었습니다 — 화면에 표시된 안내 창에서 [URL 복사] 또는 [바로가기]를 선택하세요.",
    en: "The popup was blocked — use [Copy URL] or [Open] in the notice on screen.",
  },
  "err.copyCommandFailed": {
    ko: "execCommand('copy') 실패",
    en: "execCommand('copy') failed",
  },
  /* ⑥ 자동 전환 규칙 엔진 (scenario_profiles.json) — 트레이 상주·자동 시작과 한 묶음 */
  "auto.heading": { ko: "자동 전환 규칙", en: "Auto-switch rules" },
  "auto.hint": {
    ko: "시간대·시작 시각·순환 주기로 시나리오 프로필을 자동 전환합니다. 창을 닫아도 트레이에 상주하며 계속 동작합니다.",
    en: "Switch scenario profiles automatically by time window, app start, or rotation. The app stays in the tray after the window closes.",
  },
  "auto.info": {
    ko: "프로필 {profiles}개 · 규칙 {rules}개 · 활성: {active}",
    en: "Profiles {profiles} · Rules {rules} · Active: {active}",
  },
  "auto.none": { ko: "없음", en: "none" },
  "auto.notLoaded": { ko: "아직 불러오지 않음", en: "Not loaded yet" },
  "auto.loadFailed": { ko: "자동 전환 설정 조회 실패: {err}", en: "Failed to load auto-switch settings: {err}" },
  "auto.saved": { ko: "자동 전환 설정을 저장했습니다.", en: "Auto-switch settings saved." },
  "auto.saveFailed": { ko: "자동 전환 설정 저장 실패: {err}", en: "Failed to save auto-switch settings: {err}" },
  "auto.switched": {
    ko: "규칙 {rule} 에 의해 프로필 '{profile}' 로 전환했습니다.",
    en: "Switched to profile '{profile}' by rule {rule}.",
  },
  "auto.noSwitch": { ko: "지금은 전환 조건을 만족하는 규칙이 없습니다.", en: "No rule matched right now." },
  "auto.evaluateFailed": { ko: "규칙 평가 실패: {err}", en: "Rule evaluation failed: {err}" },
  "auto.applied": { ko: "프로필 '{profile}' 을(를) 적용했습니다.", en: "Applied profile '{profile}'." },
  "auto.applyFailed": { ko: "프로필 적용 실패: {err}", en: "Failed to apply profile: {err}" },
  "auto.needProfileName": { ko: "프로필 이름을 입력하세요.", en: "Enter a profile name." },
  "auto.needScenario": {
    ko: "시나리오 설정을 먼저 불러와야 프로필을 만들 수 있습니다.",
    en: "Load the scenario settings first to create a profile.",
  },
  "auto.autostartOn": { ko: "로그인 시 자동 시작을 켰습니다.", en: "Enabled launch at login." },
  "auto.autostartOff": { ko: "로그인 시 자동 시작을 껐습니다.", en: "Disabled launch at login." },
  "auto.autostartFailed": { ko: "자동 시작 설정 실패: {err}", en: "Failed to change auto-start: {err}" },
  "auto.autostart": { ko: "로그인 시 자동 시작", en: "Launch at login" },
  "auto.activeProfile": { ko: "활성 프로필", en: "Active profile" },
  "auto.profiles": { ko: "프로필", en: "Profiles" },
  "auto.applyProfile": { ko: "적용", en: "Apply" },
  "auto.newProfilePlaceholder": { ko: "새 프로필 이름", en: "New profile name" },
  "auto.addProfile": { ko: "현재 설정으로 프로필 추가", en: "Add profile from current settings" },
  "auto.rules": { ko: "규칙", en: "Rules" },
  "auto.ruleKind": { ko: "트리거", en: "Trigger" },
  "auto.kindTimeWindow": { ko: "시간대", en: "Time window" },
  "auto.kindAppStart": { ko: "앱 시작", en: "App start" },
  "auto.kindRotation": { ko: "순환", en: "Rotation" },
  "auto.startHour": { ko: "시작 시(0-23)", en: "Start hour (0-23)" },
  "auto.endHour": { ko: "종료 시(1-24)", en: "End hour (1-24)" },
  "auto.weekdays": { ko: "요일 (0=일 … 6=토)", en: "Weekdays (0=Sun … 6=Sat)" },
  "auto.weekdaysHint": {
    ko: "비우면 요일 무관, 예: 1,2,3,4,5 (평일)",
    en: "Empty = every day, e.g. 1,2,3,4,5 (weekdays)",
  },
  "auto.rotateMinutes": { ko: "순환 주기(분)", en: "Rotation (min)" },
  "auto.targetProfile": { ko: "대상 프로필", en: "Target profile" },
  "auto.debounce": { ko: "디바운스(초)", en: "Debounce (s)" },
  "auto.cooldown": { ko: "쿨다운(초)", en: "Cooldown (s)" },
  "auto.addRule": { ko: "규칙 추가", en: "Add rule" },
  "auto.remove": { ko: "삭제", en: "Remove" },
  "auto.on": { ko: "켜짐", en: "On" },
  "auto.off": { ko: "꺼짐", en: "Off" },
  "auto.evaluate": { ko: "지금 규칙 평가", en: "Evaluate rules now" },
  "auto.save": { ko: "자동 전환 설정 저장", en: "Save auto-switch settings" },
  "err.unknown": { ko: "알 수 없는 오류", en: "Unknown error" },
  "err.unknownWithKeys": {
    ko: "알 수 없는 오류 (keys: {keys})",
    en: "Unknown error (keys: {keys})",
  },
};

/** 사전에 실제로 존재하는 키 목록(검증 스크립트용). */
export function stringKeys(): string[] {
  return Object.keys(STRINGS);
}

/**
 * 자리표시자 치환 — `{name}` 을 vars 값으로 바꾼다.
 * 값이 없으면 치환하지 않고 원문을 유지한다(빈 문자열로 지우지 않는다).
 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * 번역 조회.
 * - 사전에 없는 키는 **키 문자열 그대로** 반환한다(조용한 빈 문자열 금지).
 * - 해당 언어 값이 비어 있으면 다른 언어로 폴백하고, 둘 다 비면 키를 반환한다.
 */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  const primary = entry[lang];
  const fallback = lang === "ko" ? entry.en : entry.ko;
  const text = primary && primary.trim() ? primary : fallback && fallback.trim() ? fallback : key;
  return interpolate(text, vars);
}

/**
 * 현재 언어 보관 — **React 상태에 접근할 수 없는 모듈 스코프 코드**(Puter SDK 오류
 * 문구, formatErr 폴백 등)가 사전을 쓰기 위한 접근자.
 *
 * 왜 필요한가: 이 파일의 `t(lang, …)` 는 호출부가 언어를 넘겨야 하는데, App.tsx 의
 * 모듈 스코프 함수(컴포넌트 밖)는 `lang` 상태를 볼 수 없어 한국어 리터럴을 하드코딩했다.
 * 그 결과 영어를 선택해도 Puter 관련 오류만 한국어로 남았다(검수 지적).
 * `setActiveLang()` 은 App 이 언어를 바꿀 때마다 호출되어 이 값을 갱신한다.
 *
 * 초기값은 `loadLang()` 으로 지연 초기화한다 — 저장된 언어가 영어면 첫 오류부터 영어다.
 */
let activeLang: Lang | null = null;

/** 현재 언어를 등록한다(App 의 언어 상태 변경 시 호출). */
export function setActiveLang(lang: Lang): void {
  activeLang = lang;
}

/** 현재 언어 조회(미등록이면 저장값/기본값으로 초기화). */
export function currentLang(): Lang {
  if (activeLang === null) activeLang = loadLang();
  return activeLang;
}

/** 현재 언어로 번역 — 모듈 스코프 코드용 `t()` 단축. */
export function th(key: string, vars?: Record<string, string | number>): string {
  return t(currentLang(), key, vars);
}

/** 저장된 언어 설정 읽기(없거나 손상되면 기본 언어). */
export function loadLang(): Lang {
  try {
    const raw = localStorage.getItem(LANG_STORAGE_KEY);
    if (raw === "ko" || raw === "en") return raw;
  } catch {
    // 저장소 접근 불가(사생활 보호 모드 등) — 기본 언어로 동작한다.
  }
  return DEFAULT_LANG;
}

/** 언어 설정 저장 — 성공 여부를 반환한다(조용한 실패 방지). */
export function saveLang(lang: Lang): boolean {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
    return true;
  } catch {
    return false;
  }
}

/** 다음 언어(토글용) — ko ↔ en. */
export function nextLang(lang: Lang): Lang {
  return lang === "ko" ? "en" : "ko";
}
