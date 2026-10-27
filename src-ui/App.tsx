import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  formatUsage,
  usageUnitLabel,
  puterUsageSummary,
  stringifyUsageRaw,
  type PuterUsageResult,
} from "./puterUsage";
import { parseAppliedSearchQuery } from "./appliedQuery";
import { LANGS, loadLang, saveLang, setActiveLang, t, th, type Lang } from "./i18n";

/* ── Puter.js 전역 선언 (WebView 전용 SDK) ──
   `index.html`이 `https://js.puter.com/v2/`를 로드하므로 브라우저 전역에 `puter`가 생긴다.
   Rust 백엔드에는 서버 측 REST 엔드포인트가 없어 생성은 WebView에서만 수행한다.
   로드 실패(오프라인/차단) 시 `undefined`가 되며, 호출부는 명시적 오류로 실패한다. */
declare global {
  interface Window {
    puter?: {
      ai?: {
        txt2img?: (prompt: string, options?: { model?: string }) => Promise<unknown>;
      };
      auth?: {
        isSignedIn?: () => boolean | Promise<boolean>;
        signIn?: () => Promise<unknown>;
        // 월간 사용량·잔여 allowance 조회 (Puter User-Pays 모델).
        // 근거: https://docs.puter.com/Objects/monthlyusage/
        getMonthlyUsage?: () => Promise<unknown>;
      };
    };
  }
}

/// Puter `txt2img`가 지원하는 이미지 모델 목록 — Puter.js 공식 문서 기준.
/// 근거: https://developer.puter.com/tutorials/free-unlimited-image-generation-api/ (모델 목록)
///       https://docs.puter.com/AI/txt2img/ (options.model, 제공자 기본 모델표)
/// 모델 ID를 생략하면 Puter가 제공자 기본 모델(현재 OpenAI `gpt-image-2`)을 고르므로,
/// UI의 "(기본 모델)" 항목은 options 자체를 넘기지 않는 것과 동일하다.
/// 라벨은 브랜드명(번역 불필요)과 부연(번역 필요)을 구분한다 — 부연이 있는 항목은
/// `labelKey`(i18n 사전)를 쓰고, 렌더에서 `labelKey ? t(lang,labelKey) : label` 로 해석한다.
/// (한국어 부연을 리터럴로 두면 영어 선택 시 한국어가 남는다 — 검수 지적 [medium])
const PUTER_IMAGE_MODELS: { id: string; label?: string; labelKey?: string }[] = [
  { id: "openai/gpt-image-2", labelKey: "puter.model.gptImage2" },
  { id: "openai/gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
  { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
  { id: "google/gemini-3-pro-image", label: "Nano Banana Pro (Gemini 3 Pro Image)" },
  { id: "google/gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
  { id: "google/imagen-4.0", label: "Imagen 4.0" },
  { id: "black-forest-labs/flux-2-pro", label: "FLUX.2 [pro]" },
  { id: "black-forest-labs/flux-2-dev", label: "FLUX.2 [dev]" },
  { id: "black-forest-labs/flux-2-klein-9b-base", label: "FLUX.2 [klein] 9B" },
  { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 [pro]" },
  { id: "black-forest-labs/flux-schnell", labelKey: "puter.model.fluxSchnell" },
  { id: "x-ai/grok-imagine-image-2.0", label: "Grok Imagine Image 2.0" },
  { id: "leonardoai/lucid-origin", label: "Leonardo Lucid Origin" },
  { id: "qwen/qwen-image", label: "Qwen Image" },
  { id: "stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL" },
];

/// Blob → data URL(base64) 변환.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(th("err.puterBase64Failed")));
    reader.readAsDataURL(blob);
  });
}

/// Puter `txt2img` 응답을 백엔드가 요구하는 base64/data URL 문자열로 정규화한다.
/// SDK 버전에 따라 data URL 문자열 / 원격 URL 문자열 / Blob / HTMLImageElement를
/// 돌려주므로 순서대로 처리하고, 해석 불가 시 조용한 폴스루 없이 명시적 오류를 던진다.
async function puterResultToBase64(result: unknown): Promise<string> {
  if (typeof result === "string") {
    const value = result.trim();
    if (value.startsWith("data:")) return value;
    const resp = await fetch(value);
    if (!resp.ok) throw new Error(th("err.puterImageDownload", { status: resp.status }));
    return blobToBase64(await resp.blob());
  }
  if (result instanceof Blob) return blobToBase64(result);
  if (result instanceof HTMLImageElement) {
    // Puter는 원격(https) URL을 src로 가진 <img>를 돌려준다. 그 이미지를 canvas에 그대로
    // 그리면 cross-origin taint로 canvas가 오염되어 data URL 추출이 SecurityError로 실패한다
    // (증상: 생성은 되는데 항상 실패로 보고됨). 그러므로 src를 먼저 fetch → Blob → base64로
    // 처리하고, fetch가 불가능한 경우(동일 출처/data:/blob: 등)에만 canvas로 폴백한다.
    const src = result.currentSrc || result.src;
    if (src) {
      try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(th("err.puterImageDownload", { status: resp.status }));
        return await blobToBase64(await resp.blob());
      } catch (err) {
        // fetch 실패는 치명적이지 않다 — 동일 출처 이미지는 아래 canvas 경로로도 성공한다.
        console.warn("Puter 이미지 fetch 실패 — canvas 폴백 시도:", formatErr(err));
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = result.naturalWidth || result.width;
    canvas.height = result.naturalHeight || result.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(result, 0, 0);
    return canvas.toDataURL("image/png");
  }
  throw new Error(
    th("err.puterResultUnparsable", { kind: Object.prototype.toString.call(result) }),
  );
}

/// `puter.auth.isSignedIn` 안전 호출 래퍼 — SDK 버전에 따라 동기 boolean을
/// 반환할 수도 있어 `.catch()`를 직접 체이닝하면 TypeError가 난다.
/// Promise.resolve로 정규화하고 try/catch로 감싸 동기·비동기 양쪽에 안전하다.
/// Puter 로그인 페이지 주소 — 안내 모달에 표시하고 [바로가기]에서 연다.
const PUTER_LOGIN_URL = "https://puter.com/auth/";

/// 로그인 세션으로 Puter 월간 사용량(남은 크레딧)을 조회한다.
/// 정규화는 `./puterUsage`(순수 모듈)가 담당하고, 여기서는 SDK 호출·세션 확인만 한다.
/// 응답 원본(raw)도 함께 돌려주어 화면에서 실제 스키마를 확인할 수 있게 한다.
/// SDK 미로드/미로그인/API 부재는 조용히 0 으로 표시하지 않고 명시적 오류로 실패한다.
export async function fetchPuterUsage(): Promise<PuterUsageResult> {
  if (!window.puter) {
    throw new Error(th("err.sdkNotLoaded"));
  }
  const auth = window.puter.auth;
  if (!auth) {
    throw new Error(th("err.authUnavailable"));
  }
  if (typeof auth.getMonthlyUsage !== "function") {
    throw new Error(th("err.noMonthlyUsage"));
  }
  const signedIn = await puterIsSignedIn(() => (auth.isSignedIn ? auth.isSignedIn() : false));
  if (!signedIn) {
    throw new Error(th("err.signInRequired"));
  }
  const raw = await auth.getMonthlyUsage();
  return { summary: puterUsageSummary(raw), raw };
}

/// 팝업 차단 안내 모달을 띄우기 위한 컴포넌트 등록 지점.
/// 모듈 스코프 함수(openPuterLoginFallback)는 React 상태에 접근할 수 없으므로,
/// 컴포넌트가 마운트되며 자기 setState를 여기에 등록한다.
let showPuterLoginPrompt: ((url: string) => void) | null = null;

/// 팝업이 차단되면 **브라우저를 즉시 열지 않고** URL + [URL 복사] + [바로가기] 버튼을 가진
/// 안내 모달을 먼저 띄운다. 실제 브라우저 열기는 사용자가 [바로가기]를 눌렀을 때만
/// openPuterLoginInBrowser()로 수행한다 (사용자 선택 우선).
/// 모달 등록 전(비정상 경로)에는 조용히 넘어가지 않고 명시적 오류로 알린다.
function openPuterLoginFallback(): void {
  if (showPuterLoginPrompt) {
    showPuterLoginPrompt(PUTER_LOGIN_URL);
    return;
  }
  throw new Error(th("err.promptModalUnavailable"));
}

/// [바로가기] 버튼 핸들러 — 사용자가 명시적으로 눌렀을 때만 실행된다 (2단계 시도).
/// 1차: Tauri `open_external_url`(rundll32 FileProtocolHandler)로 시스템 기본 브라우저 열기.
/// 2차: WebView 안에서 `<a target="_blank">` 클릭 폴백 — 창이 실제로 열렸는지 반환값으로
///      판정할 수 없는 API(window.open 은 noopener 에서 항상 null)라서 "시도"로만 기록한다.
/// 두 경로 모두 실패하면 예외를 던져 호출부가 "열지 못했다"를 사용자에게 알린다.
/// 참고: 외부 브라우저에서 로그인해도 앱(WebView)의 Puter 세션은 별개이므로,
/// 앱에서는 팝업을 허용한 뒤 다시 로그인해야 한다.
async function openPuterLoginInBrowser(): Promise<void> {
  const errors: string[] = [];
  try {
    await invoke("open_external_url", { url: PUTER_LOGIN_URL });
    return;
  } catch (err) {
    errors.push(th("err.shellOpenFailed", { err: formatErr(err) }));
  }
  try {
    const anchor = document.createElement("a");
    anchor.href = PUTER_LOGIN_URL;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  } catch (err) {
    errors.push(th("err.linkFallbackFailed", { err: formatErr(err) }));
  }
  throw new Error(errors.join(" · "));
}

/// Puter 로그인 팝업 호출. 브라우저/WebView가 팝업을 차단하면 'popup_blocked' 계열 오류가
/// 그대로 올라오므로, 사용자에게 조치 방법을 안내하는 명확한 메시지로 바꿔 던진다.
/// 차단 시 안내에 그치지 않고 openPuterLoginFallback()으로 실제 열기를 시도한다.
async function puterSignIn(auth: any): Promise<void> {
  try {
    await auth.signIn();
  } catch (err) {
    const msg = formatErr(err);
    if (/popup/i.test(msg)) {
      try {
        openPuterLoginFallback();
      } catch (fallbackErr) {
        // 모달 표시마저 실패 — 성공 위장 금지. 원인을 포함해 호출부로 그대로 던진다.
        throw new Error(th("err.popupBlockedNoModal", { err: formatErr(fallbackErr) }));
      }
      // 브라우저는 사용자가 [바로가기]를 눌렀을 때만 열린다 (즉시 열지 않음).
      throw new Error(th("err.popupBlockedAdvice"));
    }
    throw err;
  }
}

async function puterIsSignedIn(
  isSignedIn: (() => boolean | Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!isSignedIn) return false;
  try {
    return !!(await Promise.resolve(isSignedIn()));
  } catch {
    return false;
  }
}

/// 에러 객체를 사람이 읽을 수 있는 문자열로 정규화한다.
/// `String(err)`는 일반 객체에서 "[object Object]"가 되므로
/// `err.message` → `err.error.message` → `err.error` → `JSON.stringify(err)` 순으로 추출한다.
function formatErr(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string" && e.message) return e.message;
    const inner = e.error;
    if (typeof inner === "object" && inner !== null) {
      const m = (inner as Record<string, unknown>).message;
      if (typeof m === "string" && m) return m;
    }
    if (typeof e.error === "string" && e.error) return e.error as string;
    try {
      return JSON.stringify(e);
    } catch {
      // 순환 참조 등으로 stringify가 실패하면 String(err)은 "[object Object]"로
      // 원래 버그가 부분 재발하므로, 키 목록·식별자 기반 대체 요약을 반환한다.
      const keys = Object.keys(e);
      const fallback = e.code ?? e.name;
      if (typeof fallback === "string" && fallback) {
        return keys.length > 0 ? `${fallback} (keys: ${keys.join(", ")})` : fallback;
      }
      if (keys.length > 0) return th("err.unknownWithKeys", { keys: keys.join(", ") });
      return th("err.unknown");
    }
  }
  return String(err);
}

/// Puter 세션을 보장한다 — 미인증이면 `puter.auth.signIn()` 로그인 팝업을 띄워
/// 세션을 연결한 뒤 원래 생성 요청을 이어갈 수 있게 한다. (auth 미제공 SDK는 생성이 응답에서 요구)
async function ensurePuterSession(): Promise<void> {
  const txt2img = window.puter?.ai?.txt2img;
  if (!txt2img) {
    throw new Error(th("err.sdkNotLoaded"));
  }
  const auth = window.puter?.auth;
  if (!auth?.isSignedIn) return;
  // 동기 boolean이면 await 없이 판정해, 사용자 클릭 제스처가 끊긴 뒤 signIn이 호출되어 팝업이 차단되는 것을 막는다.
  let raw: boolean | Promise<boolean> = false;
  try {
    raw = auth.isSignedIn ? auth.isSignedIn() : false;
  } catch {
    raw = false;
  }
  const signedIn =
    typeof raw === "boolean" ? raw : await puterIsSignedIn(() => raw as Promise<boolean>);
  if (signedIn) return;
  if (!auth.signIn) {
    throw new Error(th("err.signInUnavailable"));
  }
  await puterSignIn(auth); // 로그인 팝업 → 세션 연결 후 원래 생성 흐름 재개 (popup_blocked 안내 변환 포함)
}

/// 세션 보장 후 생성 요청. 인증 오류 감지 시 로그인 팝업으로 세션 재연결 후 원래 생성 요청을 1회 재시도한다.
async function puterGenerateWithAuth(produce: string, model?: string): Promise<unknown> {
  const txt2img = window.puter?.ai?.txt2img;
  if (!txt2img) {
    throw new Error(th("err.sdkNotLoaded"));
  }
  // 모델이 비어 있으면 options를 넘기지 않아 Puter 기본 모델을 쓴다.
  // (빈 문자열을 model로 보내면 bad_request가 되므로 undefined로 정규화한다)
  const selected = model && model.trim() ? model.trim() : undefined;
  const call = () => (selected ? txt2img(produce, { model: selected }) : txt2img(produce));
  await ensurePuterSession();
  try {
    return await call();
  } catch (err) {
    const message = formatErr(err);
    if (!/401|403|auth|sign|login|인증|로그인/i.test(message)) throw err;
    await ensurePuterSession();
    return await call();
  }
}

/* ── IPC 응답 타입 (Rust 구조체 snake_case 키와 1:1 대응) ── */

export interface WallpaperCandidate {
  path: string;
  file_name: string;
  width: number;
  height: number;
  size_bytes: number;
  thumb_base64: string;
  /** 이 파일 자체의 생성 정보(사이드카 `.geninfo.json`) — "현재 배경" state.json 과 분리된 귀속 */
  gen_provider?: string | null;
  gen_source?: string | null;
}

export interface SearchResult {
  candidates: WallpaperCandidate[];
  total_matched: number;
  truncated: boolean;
}

export interface WallpaperState {
  previous_wallpaper: string | null;
  current_wallpaper: string | null;
  backend_used: string | null;
  /** 생성 공급자 식별자 — "생성 정보"로 항상 표시한다. */
  provider: string | null;
  /** 생성 경로 상세(모델·SDK 등) — "생성 정보"로 항상 표시한다. */
  source: string | null;
}

/** `get_app_meta` 응답 — 버전/제작자는 Cargo 메타데이터가 단일 소스다. */
export interface AppMeta {
  product: string;
  /** semver 원본(`1.0.0`) — 배포·비교용. */
  version: string;
  /** 화면 표시용(`1.0`) — 백엔드 `display_version()` 파생값(후행 `.0` 생략). */
  version_display: string;
  author: string;
}

/** `get_history` 응답 1건 — 프롬프트/검색어 이력(재시동 후 복원). */
export interface HistoryEntry {
  kind: "prompt" | "search";
  text: string;
  provider?: string | null;
  model?: string | null;
  at: number;
}

export interface MonitorInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
}

export interface AppStatus {
  current_wallpaper: string | null;
  previous_wallpaper: string | null;
  backend_used: string | null;
  /** 생성 공급자 식별자 (state.json 의 provider). */
  provider: string | null;
  /** 생성 경로 상세 (state.json 의 source). */
  source: string | null;
  data_dir: string;
}

export interface ScenarioSettings {
  enabled: boolean;
  interval_minutes: number;
  /** 시나리오 소스: 원격 URL + 로컬 폴더 + 검색 키워드(Search 공급자용). */
  source: {
    urls: string[];
    local_dir: string | null;
    /** 검색(Search) 키워드 목록 — 순환하며 공개 이미지 검색 결과를 사용한다. */
    search_queries?: string[];
  };
  order: "sequential" | "random";
  next_index: number;
  /**
   * seed 정책 — `fixed`(고정값) | `incremental`(순차 증가) | `random`(기본값).
   * seed 를 보내지 않으면 Pollinations 가 같은 URL 을 캐시해 같은 프롬프트가
   * 항상 같은 이미지가 된다. 기본값 random 이 그 문제를 제거한다.
   */
  seed_mode?: "fixed" | "incremental" | "random";
  /** `seed_mode === "fixed"` 일 때 쓸 고정 seed 값. */
  seed_fixed?: number;
  /** `seed_mode !== "fixed"` 카운터 — 백엔드가 생성 성공 시 1씩 전진시켜 저장한다. */
  seed_next?: number;
  last_run_at: number | null;
  position: string;
  provider: "pollinations" | "cloudflare-workers-ai" | "openai" | "search";
  provider_order?: ("pollinations" | "cloudflare-workers-ai" | "openai" | "search")[];
  /** Off(비활성) 공급자 목록 — 생성·폴백·시나리오 자동 실행에서 모두 제외된다. */
  disabled_providers?: string[];
  prompt: string;
  cloudflare: { account_id: string; api_token: string; model: string };
  clear_api_token?: boolean;
  openai: { api_key: string; model: string };
  clear_api_key?: boolean;
}

export type WallpaperPosition =
  | "center"
  | "tile"
  | "stretch"
  | "fit"
  | "fill"
  | "span";

/**
 * 배치 방식 id 목록 — **표시 라벨은 여기 두지 않는다**.
 * 라벨은 i18n 사전(`position.*`)에서만 가져온다. 한국어 리터럴을 여기 남기면
 * 영어를 선택해도 이 값이 그대로 노출되어 "영어인데 한국어가 보인다"가 된다.
 * (순서 = select 표시 순서)
 */
const POSITION_IDS: WallpaperPosition[] = ["fill", "fit", "stretch", "tile", "center", "span"];

/**
 * 미리보기 보기 방식 → CSS.
 * - `fit`(창맞춤): 컨테이너 안에 **전체가 보이도록** 축소/확대 (`object-fit: contain`)
 * - `actual`(원본 크기 100%): 축소 없이 원본 픽셀 그대로, 넘치는 부분은 스크롤
 * - `fill`(채우기): 비율 유지하며 컨테이너를 가득 채움(잘림 허용) (`object-fit: cover`)
 */
export function previewFitStyle(mode: "fit" | "actual" | "fill"): React.CSSProperties {
  if (mode === "actual") {
    return {
      objectFit: "none",
      objectPosition: "top left",
      maxWidth: "none",
      maxHeight: "none",
    };
  }
  if (mode === "fill") return { objectFit: "cover" };
  return { objectFit: "contain" };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function App(): React.ReactElement {
  // 검색/생성 패널
  const [query, setQuery] = useState<string>("");
  const [searchDir, setSearchDir] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("Cyberpunk rainy neon street in Seoul");

  // 결과 그리드
  const [candidates, setCandidates] = useState<WallpaperCandidate[]>([]);
  const [selected, setSelected] = useState<WallpaperCandidate | null>(null);

  // 적용 옵션
  const [position, setPosition] = useState<WallpaperPosition>("fill");
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [monitorId, setMonitorId] = useState<string>("");

  // ⑤ 시나리오(자동 업데이트) — scenario.json 스키마와 1:1 대응
  const [scEnabled, setScEnabled] = useState<boolean>(false);
  const [scInterval, setScInterval] = useState<string>("60");
  const [scUrls, setScUrls] = useState<string>("");
  const [scLocalDir, setScLocalDir] = useState<string>("");
  // 검색(Search) 소스 — 줄바꿈 구분 키워드 목록. 시나리오 자동 실행에서 순환 사용된다.
  const [scSearchQueries, setScSearchQueries] = useState<string>("");
  const [scOrder, setScOrder] = useState<"sequential" | "random">("sequential");
  // seed 정책 — 기본값 random. seed 를 요청에 넣지 않으면 Pollinations 는 같은 URL 을
  // 캐시해 "같은 프롬프트 = 항상 같은 이미지"가 된다(사용자 보고 결함의 원인).
  const [scSeedMode, setScSeedMode] = useState<"fixed" | "incremental" | "random">("random");
  const [scSeedFixed, setScSeedFixed] = useState<number>(0);
  const [scSeedNext, setScSeedNext] = useState<number>(0);
  // `ProviderId`: 이미지 공급자 전체 집합(4종) — select 옵션·우선순위 목록이 같은 PROVIDERS 상수에서 파생된다.
  type ProviderId = "pollinations" | "puter" | "cloudflare-workers-ai" | "openai" | "search";
  // 공급자 라벨도 i18n 사전 키만 보관한다 — 화면 리터럴을 두면 영어 선택 시 한국어가 남는다.
  const PROVIDERS: { id: ProviderId; labelKey: string; backend: boolean }[] = [
    { id: "pollinations", labelKey: "provider.pollinations", backend: true },
    { id: "search", labelKey: "provider.search", backend: true },
    { id: "puter", labelKey: "provider.puter", backend: false },
    { id: "cloudflare-workers-ai", labelKey: "provider.cloudflare", backend: true },
    { id: "openai", labelKey: "provider.openai", backend: true },
  ];
  const FREE_FIRST_ORDER: ProviderId[] = PROVIDERS.map((p) => p.id);
  // `langRef` 는 아래(hooks)에서 선언되지만, 이 함수는 렌더/이벤트 시점에만 호출되므로
  // 선언 시점 문제가 없다. 상태바·메시지는 항상 **현재 언어**로 만든다.
  const providerLabel = (id: ProviderId): string => {
    const found = PROVIDERS.find((p) => p.id === id);
    return found ? t(langRef.current, found.labelKey) : id;
  };
  // Puter는 WebView 전용(Puter.js 브라우저 SDK)이라 Rust 백엔드 `ImageProvider`가 모른다 —
  // 저장 payload와 우선순위 생성(provider_order)에는 backend:true인 공급자만 전달한다.
  const backendOrderIds = (order: ProviderId[]): ProviderId[] =>
    order.filter((id) => PROVIDERS.find((p) => p.id === id)?.backend);
  const [scProvider, setScProvider] = useState<ProviderId>("pollinations");
  const [scProviderOrder, setScProviderOrder] = useState<ProviderId[]>([...FREE_FIRST_ORDER]);
  // 공급자별 On/Off — Off 공급자는 생성·폴백에서 제외하고, 저장 시 backend
  // `disabled_providers` 로 전달되어 시나리오 자동 실행에서도 제외된다.
  const [scProviderEnabled, setScProviderEnabled] = useState<Record<ProviderId, boolean>>({
    pollinations: true,
    search: true,
    puter: true,
    "cloudflare-workers-ai": true,
    openai: true,
  });
  // 엄격 모드(기본 false): 선택한 공급자만 시도하고 실패 시 다른 공급자로 넘어가지 않는다.
  // true 일 때만 우선순위 목록 순서대로 폴백한다.
  const [scAllowFallback, setScAllowFallback] = useState(false);
  const [scCfAccount, setScCfAccount] = useState<string>("");
  const [scCfToken, setScCfToken] = useState<string>("");
  const [scCfModel, setScCfModel] = useState<string>("@cf/black-forest-labs/flux-1-schnell");
  // 백엔드 `cloudflare_accepts_seed`(flux 계열만 허용)와 **같은 규칙**을 UI 에서 재사용한다.
  // 안내 문구와 seed 카운터 노출을 모델 단위로 분기하기 위한 단일 소스다.
  const cloudflareAcceptsSeed = (model: string): boolean =>
    model.toLowerCase().includes("flux");
  // seed 를 실제 요청에 싣는 공급자인가 — 안내 문구·카운터 노출의 단일 조건.
  // Puter 는 브라우저 SDK 가 seed 를 받지 않고, OpenAI Images API 는 파라미터가 없으며,
  // 검색(Search)은 이미지를 생성하지 않는다.
  const providerUsesSeed = (id: ProviderId): boolean =>
    id === "pollinations" ||
    (id === "cloudflare-workers-ai" && cloudflareAcceptsSeed(scCfModel));
  const [scClearToken, setScClearToken] = useState<boolean>(false);
  const [scOpenaiKey, setScOpenaiKey] = useState<string>("");
  const [scOpenaiModel, setScOpenaiModel] = useState<string>("gpt-image-1");
  const [scClearKey, setScClearKey] = useState<boolean>(false);
  // Puter 이미지 모델 — 빈 문자열이면 options를 넘기지 않아 Puter 기본 모델을 쓴다.
  const [scPuterModel, setScPuterModel] = useState<string>("");
  // Puter 남은 크레딧 — null 은 "아직 조회 안 함"(0 크레딧과 구분), err 는 조회 실패 사유.
  // summary(정규화 결과)와 raw(원본 응답)를 함께 보관한다: 응답 스키마가 달라 값이
  // null 로 떨어질 때 "왜 0/모름인지"를 화면에서 바로 확인하기 위함이다.
  const [puterUsage, setPuterUsage] = useState<PuterUsageResult | null>(null);
  const [puterUsageErr, setPuterUsageErr] = useState<string>("");
  const [puterUsageBusy, setPuterUsageBusy] = useState<boolean>(false);
  // 모델별 1회당 크레딧 표시는 제거했다 — 15개 중 14개가 "정보 없음"이어서 유용한 정보가
  // 없었고(사용자 요청), 남은 크레딧 조회(puterUsage)만 유지한다.
  // 프롬프트는 좌측 ②의 단일 #prompt를 모든 AI 공급자에 공통 적용한다(중복 입력 제거).
  // 초기값은 **빈 문자열**이다 — 한국어 리터럴을 초기값으로 두면 영어 선택 시
  // 첫 렌더(조회 전)에만 한국어가 노출된다. 표시 시점에 사전 폴백을 쓴다.
  const [scInfo, setScInfo] = useState<string>("");
  // 자동 틱 연속 실패 횟수 (지적 #4: 에러 은폐 방지용 카운터)
  const [scAutoFail, setScAutoFail] = useState<number>(0);
  // 저장 시 커서·시각 보존용 원본 스냅샷 (지적 #2: 하드코딩 방지)
  const [scPrev, setScPrev] = useState<ScenarioSettings | null>(null);

  // 상태
  const [status, setStatus] = useState<AppStatus | null>(null);
  // 초기값도 빈 문자열 — 표시 시점에 `common.ready` 사전 값으로 폴백한다.
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [statusKind, setStatusKind] = useState<"ok" | "error" | "info">("info");
  const [busy, setBusy] = useState<boolean>(false);
  // ③ 미리보기 전체화면 뷰어 열림 상태
  const [viewerOpen, setViewerOpen] = useState<boolean>(false);

  /* ── 다국어(한국어/영어) ──
     문자열은 `./i18n` 사전 한 곳에만 존재하고, 언어 설정은 localStorage 에 저장해
     재시동 후에도 유지한다. 저장 실패(사생활 보호 모드 등)는 조용히 넘기지 않고
     상태바에 알린다. */
  const [lang, setLang] = useState<Lang>(() => loadLang());
  // `useCallback([])` 로 메모이즈된 조회 함수가 **현재 언어**로 메시지를 내도록 최신 lang 을
  // ref 로 참조한다. lang 을 의존성 배열에 넣으면 언어를 바꿀 때 refreshScenario 가
  // 디스크 값으로 폼을 되돌려(미저장 편집 소실) 버리므로 ref 방식을 쓴다.
  const langRef = useRef<Lang>(lang);
  useEffect(() => {
    langRef.current = lang;
    // 모듈 스코프 헬퍼(Puter SDK 오류·formatErr 폴백)도 현재 언어로 문구를 만들도록
    // 사전 접근자에 현재 언어를 알린다 — 상태를 볼 수 없는 위치의 한국어 잔존 방지.
    setActiveLang(lang);
  }, [lang]);

  /* ── ③ 미리보기 보기 방식 ──
     창맞춤(fit) / 원본 크기(100%) / 채우기(fill). 이전에는 썸네일을 그대로 늘려
     보여줘 "창맞춤" 선택지가 없었다(사용자 요청). */
  const [previewFit, setPreviewFit] = useState<"fit" | "actual" | "fill">("fit");

  /* ── 히스토리(프롬프트/검색어) — 디스크 영속(history.json) ── */
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  /* ── 앱 메타데이터(버전/제작자) — Cargo 메타데이터 단일 소스 ── */
  const [appMeta, setAppMeta] = useState<AppMeta | null>(null);

  // 생성 정보 귀속 판별: "생성 정보"는 현재 배경(state.json) 기준이고,
  // 미리보기 이미지는 검색 후보(selected)이므로 둘은 서로 다른 파일일 수 있다.
  // 비교 결과를 gen-info 에 표시해, 무료 공급자로 만든 이미지를 보면서
  // "Puter" 라벨을 보는 오귀속을 막는다.
  const genPath = status?.current_wallpaper ?? null;
  const selPath = selected?.path ?? null;

  // [검수 지적 medium] 적용 후 경로와 원본 경로는 **문자열이 절대 같을 수 없다**:
  // 백엔드 `validate_and_stage_image`가 원본을 BMP로 재인코딩해
  // `active/active_<원본 stem>_<모니터>.bmp`로 스테이징하므로 확장자·디렉터리·접두어가
  // 모두 달라진다. 경로 문자열 동등 비교(`genPath !== selPath`)로는 적용에 성공해도
  // 항상 불일치 경고가 떠서 "왜 계속 다른 파일이라고 나오지"의 실제 원인이었다.
  // → 스테이징 규칙(`active_` + 원본 stem + `_` + 모니터 접미어)으로 귀속을 판정한다.
  const sameWallpaperSource = (
    activePath: string | null,
    sourcePath: string | null,
  ): boolean => {
    if (!activePath || !sourcePath) return false;
    const baseName = (p: string) => p.split(/[\\/]/).pop() ?? "";
    const stripExt = (n: string) => n.replace(/\.[^.]*$/, "");
    const activeStem = stripExt(baseName(activePath)).toLowerCase();
    const srcStem = stripExt(baseName(sourcePath)).toLowerCase();
    if (!activeStem || !srcStem) return false;
    // 스테이징 파일끼리(같은 stem)면 동일 소스다. 이 단락이 없으면
    // active_X.bmp vs active_X.bmp 도 `active_${active_X}` 비교로 false 가 되어
    // 적용 성공 후에도 불일치 경고가 남는다.
    if (activeStem === srcStem) return true;
    return (
      activeStem === `active_${srcStem}` || activeStem.startsWith(`active_${srcStem}_`)
    );
  };
  const genMatchesSelected = sameWallpaperSource(genPath, selPath);

  // [검수 지적 medium] 적용 성공 후에도 미리보기(selected)가 **생성 전 후보**에 남아
  // "현재 배경과 다른 파일" 경고가 계속 뜨던 순환의 직접 원인을 제거한다.
  // 적용 결과(current_wallpaper)는 스테이징된 `active_*.bmp` 이고 selected 는 검색/생성
  // 후보이므로, 적용 후 selected 를 갱신하지 않으면 두 값은 영원히 다른 파일이 된다.
  // → 백엔드 `candidate_for_path` 로 적용된 파일의 후보(썸네일·해상도)를 받아 교체한다.
  // 실패는 조용히 넘기지 않고 console.warn 으로 남긴다(무음 실패 금지).
  const syncSelectedToApplied = async (
    applied: { current_wallpaper: string | null } | null,
  ): Promise<boolean> => {
    const appliedPath = applied?.current_wallpaper ?? null;
    if (!appliedPath) return false;
    try {
      const candidate = await invoke<WallpaperCandidate>("candidate_for_path", {
        path: appliedPath,
      });
      setCandidates((prev) => [
        candidate,
        ...prev.filter((c) => c.path !== candidate.path),
      ]);
      setSelected(candidate);
      return true;
    } catch (err) {
      console.warn(
        `적용 결과를 미리보기에 반영하지 못했습니다: ${formatErr(err)}`,
      );
      return false;
    }
  };

  // 전체화면 뷰어 닫기 — Esc 키
  useEffect(() => {
    if (!viewerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setViewerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerOpen]);
  /// 팝업 차단 안내 모달 상태 — null 이면 닫힘, 문자열이면 그 URL을 담은 모달이 열린다.
  const [puterPromptUrl, setPuterPromptUrl] = useState<string | null>(null);
  /// 모달 안에 표시되는 복사/열기 결과 피드백(토스트 역할).
  const [puterCopyMsg, setPuterCopyMsg] = useState<string>("");

  const reportOk = (msg: string) => {
    setStatusMsg(msg);
    setStatusKind("ok");
  };
  const reportError = (msg: string) => {
    setStatusMsg(msg);
    setStatusKind("error");
  };

  /** 언어 전환 — localStorage 에 저장하고, 저장 실패는 숨기지 않고 상태바로 알린다. */
  const handleLangChange = (next: Lang) => {
    setLang(next);
    if (!saveLang(next)) {
      // 사전 키를 거친다 — 여기만 한글이 하드코딩되면 영어 사용자에게 한국어 오류가 뜬다.
      reportError(t(lang, "lang.saveFailed"));
    }
  };

  /** 프롬프트/검색어 히스토리 기록 — 실패해도 생성 흐름은 계속하되 콘솔에 남긴다. */
  const noteHistory = async (
    kind: "prompt" | "search",
    text: string,
    provider?: string,
  ) => {
    if (!text.trim()) return;
    try {
      const list = await invoke<HistoryEntry[]>("record_history_entry", {
        kind,
        text: text.trim(),
        provider: provider ?? null,
        model: null,
      });
      setHistory(list);
    } catch (err) {
      console.warn(`히스토리 기록 실패: ${formatErr(err)}`);
    }
  };

  /** 생성 이미지 인덱스 기록 — 재시동 복원(결함 ②)의 근거가 된다. */
  const noteLibrary = async (candidate: WallpaperCandidate) => {
    try {
      await invoke("record_library_entry", {
        path: candidate.path,
        provider: candidate.gen_provider ?? null,
        source: candidate.gen_source ?? null,
      });
    } catch (err) {
      console.warn(`생성 이미지 인덱스 기록 실패: ${formatErr(err)}`);
    }
  };

  /** 히스토리 전용 창 열기 — 목록·생성 일시·삭제는 그 창(라벨 `history`)에서 관리한다.
      메인 좌측 패널(300px)에 중첩하면 폭이 부족해 레이아웃이 깨졌다(사용자 지적). */
  const handleOpenHistoryWindow = async () => {
    try {
      await invoke("open_history_window");
    } catch (err) {
      reportError(t(lang, "history.openFailed", { err: formatErr(err) }));
    }
  };

  /** 히스토리 창에서 "메인에 넣기"를 누르면 `history://reuse` 이벤트로 입력란을 복원한다.
      창이 분리되어도 재사용(요구 ①)이 끊기지 않도록 이벤트로 연결한다. */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<{ kind: "prompt" | "search"; text: string }>(
          "history://reuse",
          (ev) => {
            const h = ev.payload;
            if (!h || !h.text) return;
            if (h.kind === "search") {
              setQuery(h.text);
              setScProvider("search");
              reportOk(t(lang, "history.reusedSearch", { text: h.text }));
            } else {
              setPrompt(h.text);
              if (scProvider === "search") setScProvider("pollinations");
              reportOk(t(lang, "history.reusedPrompt", { text: h.text }));
            }
          },
        );
      } catch (err) {
        console.warn(`히스토리 창 이벤트 등록 실패: ${formatErr(err)}`);
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [lang, scProvider]);

  // 팝업 차단 안내 모달 등록 — 모듈 스코프 openPuterLoginFallback()은 React 상태에 접근할 수
  // 없으므로, 컴포넌트 마운트 시 setState를 여기에 등록하고 언마운트 시 해제한다.
  useEffect(() => {
    showPuterLoginPrompt = (url: string) => {
      setPuterPromptUrl(url);
      setPuterCopyMsg("");
    };
    return () => {
      showPuterLoginPrompt = null;
    };
  }, []);

  // [URL 복사] — 클립보드 복사 결과를 모달 안에 표시한다(실패도 조용히 삼키지 않음).
  // navigator.clipboard가 없는 환경(비보안 컨텍스트)은 textarea + execCommand로 대체한다.
  const handleCopyPuterUrl = async () => {
    const url = puterPromptUrl ?? PUTER_LOGIN_URL;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const area = document.createElement("textarea");
        area.value = url;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const okCopy = document.execCommand("copy");
        area.remove();
        if (!okCopy) throw new Error(th("err.copyCommandFailed"));
      }
      setPuterCopyMsg(t(lang, "modal.copied"));
    } catch (err) {
      setPuterCopyMsg(t(lang, "modal.copyFailed", { err: formatErr(err) }));
    }
  };

  // [바로가기] — 사용자가 명시적으로 눌렀을 때만 실제 브라우저 열기를 시도한다.
  const handleOpenPuterUrl = async () => {
    try {
      await openPuterLoginInBrowser();
      setPuterCopyMsg(t(lang, "modal.opened"));
    } catch (err) {
      setPuterCopyMsg(t(lang, "modal.openFailed", { err: formatErr(err) }));
    }
  };

  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<AppStatus>("get_app_status");
      setStatus(s);
    } catch (err) {
      reportError(t(langRef.current, "common.stateQueryFailed", { err: formatErr(err) }));
    }
  }, []);

  const refreshMonitors = useCallback(async () => {
    try {
      const list = await invoke<MonitorInfo[]>("list_monitors");
      setMonitors(list);
    } catch (err) {
      reportError(t(langRef.current, "common.monitorQueryFailed", { err: formatErr(err) }));
    }
  }, []);

  const refreshScenario = useCallback(async () => {
    try {
      const sc = await invoke<ScenarioSettings>("get_scenario");
      setScEnabled(sc.enabled);
      setScInterval(String(sc.interval_minutes));
      setScUrls(sc.source.urls.join("\n"));
      setScLocalDir(sc.source.local_dir ?? "");
      // 검색(Search) 소스 키워드 복원 — 저장된 키워드가 없으면 빈 문자열.
      setScSearchQueries((sc.source.search_queries ?? []).join("\n"));
      setScOrder(sc.order);
      // seed 정책 복원 — 구 scenario.json(필드 없음)은 기본값 random 으로 해석한다.
      setScSeedMode(sc.seed_mode ?? "random");
      setScSeedFixed(sc.seed_fixed ?? 0);
      setScSeedNext(sc.seed_next ?? 0);
      setScProvider(sc.provider ?? "pollinations");
      const rawOrd = (sc as unknown as { provider_order?: unknown }).provider_order;
      if (Array.isArray(rawOrd) && rawOrd.length > 0) {
        const valid = (rawOrd as string[]).filter((v): v is ProviderId => v === "pollinations" || v === "search" || v === "cloudflare-workers-ai" || v === "openai");
        const dedup = [...new Set(valid)];
        if (dedup.length > 0) {
          // 저장된 순서(백엔드 4종) + 화면 전용(Puter) 누락분을 뒤에 보태 5종 집합을 유지한다.
          const missing = FREE_FIRST_ORDER.filter((id) => !dedup.includes(id));
          setScProviderOrder([...dedup, ...missing]);
        }
      } else {
        // 구 scenario.json(provider_order 없음): 단일 provider 시도로 해석 (하위호환)
        const single = (sc.provider ?? "pollinations") as ProviderId;
        setScProviderOrder([single]);
      }
      // 저장된 On/Off(disabled_providers)를 토글 상태로 복원한다.
      // Puter 도 저장 대상에 포함한다 — 화면에서 Off 로 둔 상태가 재조회 후에도 유지되어야
      // "껐는데 다시 켜져 있다"는 혼동이 없다. 백엔드는 Puter 를 후보로 쓰지 않으므로
      // (provider_is_configured → false) 이 값이 시나리오 실행에 부작용을 주지 않는다.
      const rawOff = (sc as unknown as { disabled_providers?: unknown }).disabled_providers;
      const offList = Array.isArray(rawOff)
        ? (rawOff as string[]).filter(
            (v): v is ProviderId =>
              v === "pollinations" ||
              v === "search" ||
              v === "cloudflare-workers-ai" ||
              v === "openai" ||
              v === "puter",
          )
        : [];
      setScProviderEnabled({
        pollinations: !offList.includes("pollinations"),
        search: !offList.includes("search"),
        puter: !offList.includes("puter"),
        "cloudflare-workers-ai": !offList.includes("cloudflare-workers-ai"),
        openai: !offList.includes("openai"),
      });
      setScCfAccount(sc.cloudflare?.account_id ?? "");
      // 검수 지적 [medium](a): get_scenario 응답의 api_token/api_key는 항상 ""(마스킹).
      // 빈 문자열로 덮어쓰면 사용자가 입력한 토큰이 지워지므로, 비어 있지 않을 때만 반영한다.
      // 저장 시에는 scCfToken/scOpenaiKey를 그대로 전달하고, ""이면 Rust 측에서 기존 저장값을 유지한다.
      if (sc.cloudflare?.api_token) {
        setScCfToken(sc.cloudflare.api_token);
      }
      setScCfModel(sc.cloudflare?.model || "@cf/black-forest-labs/flux-1-schnell");
      if (sc.openai?.api_key) {
        setScOpenaiKey(sc.openai.api_key);
      }
      setScOpenaiModel(sc.openai?.model || "gpt-image-1");
      if (sc.prompt) setPrompt(sc.prompt);
      setScPrev(sc);
      setScInfo(
        t(langRef.current, "scenario.infoLine", {
          next: sc.next_index,
          last: sc.last_run_at ?? t(langRef.current, "scenario.lastNone"),
          onoff: sc.enabled
            ? t(langRef.current, "scenario.onShort")
            : t(langRef.current, "scenario.off"),
        }),
      );
    } catch (err) {
      setScInfo(t(langRef.current, "scenario.loadFailed", { err: formatErr(err) }));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshMonitors();
    void refreshScenario();
  }, [refreshStatus, refreshMonitors, refreshScenario]);

  // 시작 시 복원 — 재시동 후에도 ① 프롬프트/검색 히스토리 ② 앱 메타데이터(버전·제작자)
  // ③ 이전에 생성한 이미지 목록이 보여야 한다. 이전 구현은 셋 다 메모리에만 있어
  // 프로그램을 껐다 켜면 사라졌다(사용자 지적 결함 2).
  useEffect(() => {
    void (async () => {
      try {
        const meta = await invoke<AppMeta>("get_app_meta");
        setAppMeta(meta);
      } catch (err) {
        console.warn(`앱 정보 조회 실패: ${formatErr(err)}`);
      }
      try {
        const list = await invoke<HistoryEntry[]>("get_history");
        setHistory(list);
      } catch (err) {
        console.warn(`히스토리 조회 실패: ${formatErr(err)}`);
      }
      try {
        const restored = await invoke<WallpaperCandidate[]>("restore_library_candidates");
        if (restored.length > 0) {
          setCandidates((prev) => {
            const seen = new Set(prev.map((c) => c.path.toLowerCase()));
            const merged = [...prev, ...restored.filter((c) => !seen.has(c.path.toLowerCase()))];
            return merged;
          });
          setSelected((prev) => prev ?? restored[0]);
          reportOk(t(lang, "results.restored", { count: restored.length }));
        }
      } catch (err) {
        console.warn(`생성 이미지 복원 실패: ${formatErr(err)}`);
      }
    })();
  }, []);

  // 지적 #1: 자동 실행 타이머 — 앱이 켜져 있는 동안 60초마다 주기 도래를 확인한다.
  // tick은 코어 should_run 게이트를 그대로 타므로 OFF/미도래 시 Ok(None)으로 skip된다.
  // 지적 #4: 자동 틱 실패를 삼키지 않고 console.error + 카운터 + 상태 메시지로 노출한다.
  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const applied = await invoke<WallpaperState | null>("tick_scenario_now");
          if (applied) {
            setScAutoFail(0);
            setStatus((prev) =>
              prev
                ? {
                    ...prev,
                    current_wallpaper: applied.current_wallpaper,
                    previous_wallpaper: applied.previous_wallpaper,
                    backend_used: applied.backend_used,
                    provider: applied.provider,
                    source: applied.source,
                  }
                : prev,
            );
            reportOk(
              t(lang, "scenario.autoApplied", {
                backend: applied.backend_used ?? t(lang, "common.unknown"),
              }),
            );
            await refreshScenario();
            await refreshStatus();
          }
        } catch (err) {
          console.error("scenario auto-tick failed:", err);
          setScAutoFail((n) => {
            const next = n + 1;
            setScInfo(
              (prev) =>
                `${t(lang, "scenario.autoTickFail", { n: next, err: formatErr(err) })} · ${prev}`,
            );
            return next;
          });
        }
      })();
    }, 60_000);
    return () => clearInterval(timer);
  }, [refreshScenario, refreshStatus]);

  const handleSearch = async () => {
    setBusy(true);
    try {
      const result = await invoke<SearchResult>("search_wallpapers", {
        query,
        dir: searchDir.trim() ? searchDir.trim() : null,
      });
      setCandidates(result.candidates);
      setSelected(result.candidates.length > 0 ? result.candidates[0] : null);
      // 검색어를 히스토리에 남긴다(요구 ①) — 재시동 후 [이 검색어 사용]으로 재적용한다.
      // 기록 실패는 생성 흐름을 막지 않지만 조용히 삼키지도 않는다(noteHistory 내부 warn).
      if (query.trim()) void noteHistory("search", query, scProvider);
      reportOk(
        result.truncated
          ? t(lang, "search.doneTruncated", {
              total: result.total_matched,
              shown: result.candidates.length,
            })
          : t(lang, "search.done", { shown: result.candidates.length }),
      );
    } catch (err) {
      reportError(t(lang, "search.failed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  // 검색 질의의 **단일 소스**는 ① 검색의 '키워드'다.
  // 시나리오 순환 검색어(textarea)가 채워져 있으면 그 목록을 순환용으로 쓰고,
  // **비어 있으면 키워드로 폴백**한다 — "키워드만 입력했는데 온라인 검색이 안 된다"는
  // 회귀(검색 질의 소스가 별도 필드로 갈라진 결과)를 막는 폴백이다.
  // ② 생성 영역의 프롬프트와는 무관하다(프롬프트→검색어 폴백 없음).
  const searchKeywords = (scSearchQueries.trim() ? scSearchQueries : query)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const handleGenerate = async () => {
    const aiPrompt = prompt.trim();
    // ② 생성은 **이미지 생성 전용**이다. 검색(Search)의 실행 지점은 ① 검색 영역의
    // [검색] 버튼 하나뿐이므로, 생성 영역에서는 검색을 실행하지 않는다(중복 액션 제거).
    if (scProvider === "search") {
      reportError(t(lang, "gen.searchOnly"));
      return;
    }
    if (!aiPrompt) {
      reportError(t(lang, "gen.promptRequired"));
      return;
    }
    // 개별 On/Off: Off 로 둔 공급자는 ② 생성에서도 시도하지 않는다.
    // (우선순위 생성·시나리오 자동 실행과 같은 규칙 — 경로마다 판정이 달라지면 안 된다)
    if (!scProviderEnabled[scProvider]) {
      reportError(t(lang, "gen.providerOff", { provider: providerLabel(scProvider) }));
      return;
    }
    setBusy(true);
    try {
      // ② 생성은 **선택한 공급자(scProvider)로만** 만든다. 이전 구현은 코어의
      // `generate_library_wallpaper`(Pollinations 하드코딩)만 호출해, 공급자를
      // Cloudflare/OpenAI/Puter 로 바꿔도 항상 Pollinations 결과가 나왔다.
      if (scProvider === "puter") {
        // 생성은 WebView 의 Puter.js SDK, 저장·사이드카 기록은 Rust 커맨드가 담당한다.
        const result = await puterGenerateWithAuth(aiPrompt, scPuterModel);
        const dataUrl = await puterResultToBase64(result);
        const candidate = await invoke<WallpaperCandidate>("save_generated_image", {
          imageBase64: dataUrl,
          // 라벨을 생략하면 백엔드가 무라벨을 'puter' 로 둔갑시키던 결함이 있었다.
          // 선택 공급자를 명시 전달해 사이드카·생성 정보가 실제 경로와 일치하게 한다.
          label: scProvider,
          model: scPuterModel.trim() ? scPuterModel.trim() : null,
        });
        setCandidates((prev) => [candidate, ...prev.filter((c) => c.path !== candidate.path)]);
        setSelected(candidate);
        // 프롬프트·생성 이미지 인덱스를 디스크에 남긴다(요구 ①② — 재시동 후 복원 근거).
        void noteHistory("prompt", aiPrompt, scProvider);
        void noteLibrary(candidate);
        reportOk(
          t(lang, "gen.done", {
            provider: providerLabel(scProvider),
            name: candidate.file_name,
          }),
        );
        return;
      }
      // 비-Puter 공급자는 백엔드가 provider 문자열로 정확히 분기한다.
      const cfModel = scCfModel.trim() || "@cf/black-forest-labs/flux-1-schnell";
      const openaiModel = scOpenaiModel.trim() || "gpt-image-1";
      // 공급자별 자격증명을 분리한다 — 이전 구현은 apiToken 에 scCfToken 을 고정 전달해
      // (1) OpenAI 키(scOpenaiKey)가 전달되지 않고 (2) 입력란에 남아 있던 Cloudflare
      // 토큰으로 인증을 시도해 실패했다. 비어 있으면 null 을 보내 백엔드가
      // scenario.json 저장값으로 폴백하게 한다(Rust 분기의 기존 계약 유지).
      const credential =
        scProvider === "openai"
          ? scOpenaiKey.trim()
          : scProvider === "cloudflare-workers-ai"
            ? scCfToken.trim()
            : "";
      const candidate = await invoke<WallpaperCandidate>(
        "generate_library_wallpaper_with_provider",
        {
          prompt: aiPrompt,
          provider: scProvider,
          accountId:
            scProvider === "cloudflare-workers-ai" && scCfAccount.trim()
              ? scCfAccount.trim()
              : null,
          apiToken: credential ? credential : null,
          model:
            scProvider === "cloudflare-workers-ai"
              ? cfModel
              : scProvider === "openai"
                ? openaiModel
                : null,
        },
      );
      setCandidates((prev) => [candidate, ...prev.filter((c) => c.path !== candidate.path)]);
      setSelected(candidate);
      // 프롬프트·생성 이미지 인덱스를 디스크에 남긴다(요구 ①② — 재시동 후 복원 근거).
      void noteHistory("prompt", aiPrompt, scProvider);
      void noteLibrary(candidate);
      reportOk(
        t(lang, "gen.done", {
          provider: providerLabel(scProvider),
          name: candidate.file_name,
        }),
      );
    } catch (err) {
      reportError(
        t(lang, "gen.failed", {
          provider: providerLabel(scProvider),
          err: formatErr(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateAi = async () => {
    // provider=puter일 때: 생성은 WebView의 Puter.js SDK, 검증·스테이징·적용은
    // Rust `apply_generated_image`가 담당한다 (코어 한 곳에서 해상도/스냅샷 처리).
    if (scProvider === "puter") {
      const aiPrompt = prompt.trim();
      if (!aiPrompt) {
        reportError(t(lang, "gen.aiPromptRequired"));
        return;
      }
      setBusy(true);
      try {
        // 세션 보장(auth.isSignedIn → 미인증 시 signIn 로그인 팝업) 후 생성 + 인증 오류 시 1회 재시도
        const result = await puterGenerateWithAuth(aiPrompt, scPuterModel);
        const dataUrl = await puterResultToBase64(result);
        const state = await invoke<WallpaperState>("apply_generated_image", {
          imageBase64: dataUrl,
          label: "puter",
          position,
          monitorId: monitorId.trim() ? monitorId.trim() : null,
          // 선택한 모델을 백엔드로 넘겨 "생성 정보"(provider/source)에 기록한다.
          model: scPuterModel.trim() ? scPuterModel.trim() : null,
        });
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                current_wallpaper: state.current_wallpaper,
                previous_wallpaper: state.previous_wallpaper,
                backend_used: state.backend_used,
                provider: state.provider,
                source: state.source,
              }
            : prev,
        );
        await syncSelectedToApplied(state);
        reportOk(
          t(lang, "gen.puterDone", { backend: state.backend_used ?? t(lang, "common.unknown") }),
        );
        await refreshStatus();
        // 생성은 크레딧을 소모하므로 성공 시 잔여 allowance 를 자동 갱신한다(실패는 표시만).
        void handleRefreshPuterUsage();
      } catch (err) {
        reportError(t(lang, "gen.puterFailed", { err: formatErr(err) }));
      } finally {
        setBusy(false);
      }
      return;
    }
    // provider=search일 때는 생성이 아니라 **키워드 검색** 경로로 분기한다.
    // 검색도 배경을 "적용"해야 하므로 우선순위 커맨드에 공급자 1개([search])만 넘겨
    // 코어의 동일한 폴백·기록 경로(state.json provider=search)를 그대로 사용한다.
    // (이 분기가 없으면 검색 선택 시 Cloudflare 분기로 흘러 Account ID 오류가 났다)
    if (scProvider === "search") {
      const keyword = searchKeywords[0] ?? "";
      if (!keyword) {
        reportError(t(lang, "search.noKeyword"));
        return;
      }
      setBusy(true);
      try {
        const state = await invoke<WallpaperState>("generate_wallpaper_priority", {
          prompt: keyword,
          position,
          monitorId: monitorId.trim() ? monitorId.trim() : null,
          providerOrder: ["search"],
        });
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                current_wallpaper: state.current_wallpaper,
                previous_wallpaper: state.previous_wallpaper,
                backend_used: state.backend_used,
                provider: state.provider,
                source: state.source,
              }
            : prev,
        );
        await syncSelectedToApplied(state);
        // 실제 검색어는 **백엔드가 고른 값**이다 — ⑤ 키워드 목록이 있으면
        // `search_query_for` 가 next_index(순차)/seed(랜덤)로 순환하므로, UI 가 넘긴
        // prompt 를 그대로 표기하면 실제 검색어와 어긋난다(검수 지적 [medium]).
        // 백엔드는 적용 기록(state.source)에 "… · query: <실제 검색어> · priority" 형태로
        // 남긴다. 검색어 자체에 '·' 가 들어갈 수 있으므로 구분자로 잘라내지 않는다
        // (검수 지적 [low]: `[^·]+` 는 첫 '·' 에서 검색어를 절단해 표기≠실제가 된다).
        // "query:" 이후 전체를 취한 뒤 **후행 접미사 ' · priority' 만** 제거한다.
        // 파싱은 순수 모듈(`appliedQuery.ts`)에 위임한다 — 검색어에 '·' 가 들어가도
        // 후행 " · priority" 접미사만 제거하고 내부 '·' 는 보존한다.
        // (소스 정규식 문자열 검사로는 절단 버그를 잡지 못해 실행 가능 모듈로 분리)
        const appliedQuery = parseAppliedSearchQuery(state.source) ?? keyword;
        reportOk(
          t(lang, "gen.searchApplied", {
            query: appliedQuery,
            backend: state.backend_used ?? t(lang, "common.unknown"),
          }),
        );
        await refreshStatus();
      } catch (err) {
        reportError(t(lang, "gen.searchFailed", { err: formatErr(err) }));
      } finally {
        setBusy(false);
      }
      return;
    }
    // provider=openai일 때는 OpenAI 경로로 분기한다 (저장된 api_key 폴백 포함).
    if (scProvider === "openai") {
      const aiPrompt = prompt.trim();
      if (!aiPrompt) {
        reportError(t(lang, "gen.aiPromptRequired"));
        return;
      }
      setBusy(true);
      try {
        const state = await invoke<WallpaperState>("generate_wallpaper_openai", {
          apiKey: scOpenaiKey,
          model: scOpenaiModel.trim() || "gpt-image-1",
          prompt: aiPrompt,
          position,
          monitorId: monitorId.trim() ? monitorId.trim() : null,
        });
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                current_wallpaper: state.current_wallpaper,
                previous_wallpaper: state.previous_wallpaper,
                backend_used: state.backend_used,
                provider: state.provider,
                source: state.source,
              }
            : prev,
        );
        await syncSelectedToApplied(state);
        reportOk(
          t(lang, "gen.openaiDone", {
            backend: state.backend_used ?? t(lang, "common.unknown"),
          }),
        );
        await refreshStatus();
      } catch (err) {
        reportError(t(lang, "gen.openaiFailed", { err: formatErr(err) }));
      } finally {
        setBusy(false);
      }
      return;
    }
    // 검수 지적 [medium](1): 토큰 사전 검사는 account_id만 요구한다.
    // api_token이 비어 있으면 Rust generate_wallpaper_ai_impl이 디스크 저장 토큰으로 폴백한다.
    if (!scCfAccount.trim()) {
      reportError(t(lang, "gen.cloudflareAccountRequired"));
      return;
    }
    const aiPrompt = prompt.trim();
    if (!aiPrompt) {
      reportError(t(lang, "gen.aiPromptRequired"));
      return;
    }
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("generate_wallpaper_ai", {
        accountId: scCfAccount.trim(),
        apiToken: scCfToken,
        model: scCfModel.trim() || "@cf/black-forest-labs/flux-1-schnell",
        prompt: aiPrompt,
        position,
        monitorId: monitorId.trim() ? monitorId.trim() : null,
      });
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              current_wallpaper: state.current_wallpaper,
              previous_wallpaper: state.previous_wallpaper,
              backend_used: state.backend_used,
              provider: state.provider,
              source: state.source,
            }
          : prev,
      );
      await syncSelectedToApplied(state);
      reportOk(
        t(lang, "gen.cloudflareDone", {
          backend: state.backend_used ?? t(lang, "common.unknown"),
        }),
      );
      await refreshStatus();
    } catch (err) {
      reportError(t(lang, "gen.cloudflareFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!selected) {
      reportError(t(lang, "common.selectFirst"));
      return;
    }
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("apply_wallpaper", {
        path: selected.path,
        monitorId: monitorId.trim() ? monitorId.trim() : null,
        position,
      });
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              current_wallpaper: state.current_wallpaper,
              previous_wallpaper: state.previous_wallpaper,
              backend_used: state.backend_used,
              provider: state.provider,
              source: state.source,
            }
          : prev,
      );
      await syncSelectedToApplied(state);
      reportOk(
        t(lang, "common.applyDone", {
          backend: state.backend_used ?? t(lang, "common.unknown"),
        }),
      );
    } catch (err) {
      reportError(t(lang, "common.applyFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  // 파일 삭제 — 검색/생성으로 만들어진 이미지와 그 사이드카(.geninfo.json)를 지운다.
  // 백엔드(delete_image_file)가 (1) 허용 루트(app_data_dir/Pictures) 안인지,
  // (2) 현재 바탕화면으로 적용 중인 파일이 아닌지 검증하고, 위반은 명시적 오류로 거부한다.
  // 목록 갱신은 **삭제 성공 후에만** 한다 — 실패했는데 카드가 사라지면
  // "지워지지도 않았는데 목록에서 사라진" 상태가 되어 파일이 남은 채 추적 불가가 된다.
  // 인자는 경로 문자열(결과 카드) 또는 후보 객체(미리보기) 둘 다 받는다.
  const handleDelete = async (target: string | WallpaperCandidate) => {
    const path = typeof target === "string" ? target : target.path;
    const name = typeof target === "string" ? path : target.file_name;
    if (!path) {
      reportError(t(lang, "common.noPath"));
      return;
    }
    setBusy(true);
    try {
      await invoke("delete_image_file", { path });
      const next = candidates.filter((c) => c.path !== path);
      setCandidates(next);
      // 삭제한 파일이 미리보기 중이면 다음 후보(없으면 빈 상태)로 옮긴다.
      if (selected && selected.path === path) {
        setSelected(next.length > 0 ? next[0] : null);
      }
      reportOk(t(lang, "common.deleteDone", { name }));
    } catch (err) {
      reportError(t(lang, "common.deleteFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("restore_wallpaper", {
        monitorId: monitorId.trim() ? monitorId.trim() : null,
      });
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              current_wallpaper: state.current_wallpaper,
              previous_wallpaper: state.previous_wallpaper,
              backend_used: state.backend_used,
              provider: state.provider,
              source: state.source,
            }
          : prev,
      );
      reportOk(
        t(lang, "common.restoreDone", {
          backend: state.backend_used ?? t(lang, "common.unknown"),
        }),
      );
    } catch (err) {
      reportError(t(lang, "common.restoreFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveScenario = async () => {
    const minutes = Number.parseInt(scInterval, 10);
    if (!Number.isFinite(minutes) || minutes < 5) {
      reportError(t(lang, "scenario.intervalInvalid"));
      return;
    }
    const urls = scUrls
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const localDir = scLocalDir.trim() ? scLocalDir.trim() : null;
    // 검색(Search) 소스 — 줄바꿈 구분 키워드 목록. 빈 줄은 버리고 순서를 유지한다.
    // 이 값이 scenario.json 의 `source.search_queries` 로 저장되어 자동 실행(tick)에서 순환된다.
    // 검색 질의의 단일 소스는 ① 검색의 '키워드'다 — 순환 검색어가 비어 있으면 키워드로 폴백한다.
    // (searchKeywords 가 이미 그 폴백을 담고 있다: scSearchQueries 우선 → query)
    const searchQueries = searchKeywords;
    // Puter는 WebView 전용 SDK라 백엔드 ImageProvider("pollinations"|"cloudflare-workers-ai"|"openai")로
    // 역직렬화할 수 없다 — 그대로 저장하면 scenario.json 로드 시 실패한다. 저장을 명시적으로 차단한다.
    if (scProvider === "puter") {
      reportError(t(lang, "scenario.puterNotSavable"));
      return;
    }
    // 위 puter 가드에서 early return했으므로 Exclude<ProviderId, "puter">로 좁혀진다.
    const provider = scProvider as Exclude<ProviderId, "puter">;
    // Off 공급자를 대표 공급자로 저장하면 시나리오 자동 실행 후보가 비어 버린다 — 명시적으로 막는다.
    if (!scProviderEnabled[provider]) {
      reportError(
        t(lang, "scenario.providerOffNotSavable", { provider: providerLabel(provider) }),
      );
      return;
    }
    const cfAccount = scCfAccount.trim();
    const cfModel = scCfModel.trim() || "@cf/black-forest-labs/flux-1-schnell";
    const openaiModel = scOpenaiModel.trim() || "gpt-image-1";
    const sharedPrompt = prompt.trim();
    // 지적 #2: 커서·시각 보존 — 소스 구성이 바뀌어 항목 수가 달라진 경우에만 커서 리셋.
    const prevUrls = scPrev?.source.urls ?? [];
    const prevLocalDir = scPrev?.source.local_dir ?? null;
    const prevProvider = scPrev?.provider ?? "pollinations";
    const prevOrder = (scPrev as unknown as { provider_order?: string[] } | null)?.provider_order ?? [];
    const orderChanged = prevOrder.length !== scProviderOrder.length || prevOrder.some((v, i) => v !== scProviderOrder[i]);
    const prevCf = scPrev?.cloudflare ?? { account_id: "", api_token: "", model: "" };
    const prevOa = scPrev?.openai ?? { api_key: "", model: "" };
    const prevPrompt = scPrev?.prompt ?? "";
    // 검색 키워드 변경도 소스 변경이다 — 커서를 리셋하지 않으면 키워드가 줄었을 때
    // next_index 가 목록 밖으로 나가 첫 키워드로 되돌아가는 어긋남이 생긴다.
    const prevSearchQueries = scPrev?.source.search_queries ?? [];
    const searchChanged =
      prevSearchQueries.length !== searchQueries.length ||
      prevSearchQueries.some((q, i) => q !== searchQueries[i]);
    const sourceChanged =
      scPrev == null ||
      prevUrls.length !== urls.length ||
      prevUrls.some((u, i) => u !== urls[i]) ||
      (prevLocalDir ?? null) !== localDir ||
      searchChanged ||
      prevProvider !== provider ||
      orderChanged ||
      (prevCf.account_id ?? "") !== cfAccount ||
      (prevCf.model ?? "") !== cfModel ||
      (prevOa.model ?? "") !== openaiModel ||
      prevPrompt !== sharedPrompt;
    const nextIndex = sourceChanged ? 0 : (scPrev?.next_index ?? 0);
    const lastRunAt = sourceChanged ? null : (scPrev?.last_run_at ?? null);
    setBusy(true);
    try {
      const saved = await invoke<ScenarioSettings>("save_scenario", {
        settings: {
          enabled: scEnabled,
          interval_minutes: minutes,
          // 검색(Search) 소스도 함께 저장한다 — 이 필드가 없으면 시나리오 자동 실행(tick)에서
          // 검색 공급자가 "키워드 없음"으로 판정되어 조용히 스킵된다.
          source: { urls, local_dir: localDir, search_queries: searchQueries },
          order: scOrder,
          next_index: nextIndex,
          // seed 정책 — 저장해야 시나리오 자동 실행(tick)과 수동 ② 생성이 같은 규칙을 쓴다.
          seed_mode: scSeedMode,
          seed_fixed: Number.isFinite(scSeedFixed) ? scSeedFixed : 0,
          seed_next: scSeedNext,
          last_run_at: lastRunAt,
          position,
          provider,
          provider_order: backendOrderIds(scProviderOrder),
          // 개별 On/Off: Off 로 둔 공급자를 백엔드(시나리오 자동 실행)에도 알려 제외시킨다.
          // Puter 도 함께 저장한다 — 화면에서 Off 로 둔 상태가 저장·재조회 후에도 유지되어야
          // "껐는데 다시 켜져 있다"는 혼동이 없다. 백엔드는 Puter 를 어차피 시도하지 않으므로
          // (provider_is_configured → false) 이 값이 시나리오 실행에 부작용을 주지 않는다.
          disabled_providers: FREE_FIRST_ORDER.filter((id) => !scProviderEnabled[id]),
          prompt: sharedPrompt,
          cloudflare: { account_id: cfAccount, api_token: scCfToken, model: cfModel },
          clear_api_token: scClearToken,
          openai: { api_key: scOpenaiKey, model: openaiModel },
          clear_api_key: scClearKey,
        },
      });
      setScInfo(
        t(lang, "scenario.savedInfo", {
          next: saved.next_index,
          onoff: saved.enabled ? t(lang, "scenario.onShort") : t(lang, "scenario.off"),
          minutes: saved.interval_minutes,
        }),
      );
      const deletedToken = scClearToken && scCfToken.trim() === "";
      const deletedKey = scClearKey && scOpenaiKey.trim() === "";
      setScClearToken(false);
      setScClearKey(false);
      if (deletedToken || deletedKey) {
        if (deletedToken) setScCfToken("");
        if (deletedKey) setScOpenaiKey("");
        reportOk(t(lang, "scenario.savedCleared"));
      } else {
        // scClearToken 체크 + 새 토큰 동시 입력 시 백엔드는 새 토큰을 저장하므로
        // 입력값을 비우지 않고 일반 저장 메시지를 표시한다.
        reportOk(t(lang, "scenario.savedPlain"));
      }
    } catch (err) {
      reportError(t(lang, "scenario.saveFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  const moveProviderOrder = (idx: number, dir: -1 | 1) => {
    setScProviderOrder((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      const tmp = next[idx];
      next[idx] = next[j];
      next[j] = tmp;
      return next;
    });
  };

  const handleGeneratePriority = async () => {
    const aiPrompt = prompt.trim();
    if (!aiPrompt) {
      reportError(t(lang, "gen.aiPromptRequired"));
      return;
    }
    const monitor = monitorId.trim() ? monitorId.trim() : null;
    setBusy(true);
    try {
      // 화면 1순위 = 선택한 공급자: select 로 고른 공급자를 먼저 시도하고, 나머지는
      // 우선순위 목록 순서대로 폴백한다. (기존 `[...scProviderOrder]` 는 Pollinations 가
      // 키 불필요로 항상 1순위 성공 → Puter 를 선택해도 시도조차 되지 않았다)
      // 백엔드 호출마다 providerOrder: [id]를 전달해 (Tauri v2 camelCase → Rust provider_order)
      // 저장하지 않은 순서 변경도 그대로 반영한다. puter 자리는 프론트 SDK로 시도한다.
      // On/Off 반영: Off 공급자는 1순위 선택이든 폴백이든 시도하지 않는다.
      const enabledOrder = scProviderOrder.filter((id) => scProviderEnabled[id]);
      if (!scProviderEnabled[scProvider]) {
        throw new Error(
          t(lang, "gen.providerOff", { provider: providerLabel(scProvider) }),
        );
      }
      const order = scAllowFallback
        ? [scProvider, ...enabledOrder.filter((id) => id !== scProvider)]
        : [scProvider];
      let state: WallpaperState | null = null;
      let usedProvider: ProviderId | null = null;
      let lastErr: unknown = null;
      // 무음 폴백 금지: 앞선 공급자의 실패 원인을 모아 성공 시에도 함께 표시한다.
      // (Puter 로그인/팝업/생성 실패가 뒤 공급자 성공에 가려 보이지 않던 문제)
      const failedBefore: string[] = [];
      for (const id of order) {
        try {
          if (id === "puter") {
            // 폴백 자리의 puter — 사용자가 Puter 를 1순위로 고르지 않았는데 로그인 팝업이
            // 뜨면 기존 무료 생성 흐름을 방해한다. 로그인 상태가 아니면 팝업 없이 건너뛰고,
            // 건너뛴 사유를 failedBefore 에 남겨 결과 메시지에 표시한다 (무음 스킵 금지).
            if (scProvider !== "puter") {
              const auth = window.puter?.auth;
              if (!auth || !auth.isSignedIn) {
                lastErr = new Error(t(lang, "gen.sdkNotLoaded"));
                failedBefore.push(
                  t(lang, "gen.skippedSdk", { provider: providerLabel(id) }),
                );
                continue;
              }
              const signedIn = await puterIsSignedIn(() =>
                auth.isSignedIn ? auth.isSignedIn() : false,
              );
              if (!signedIn) {
                lastErr = new Error(t(lang, "gen.notSignedIn"));
                failedBefore.push(
                  t(lang, "gen.skippedSignedOut", { provider: providerLabel(id) }),
                );
                continue;
              }
            }
            const result = await puterGenerateWithAuth(aiPrompt, scPuterModel);
            const dataUrl = await puterResultToBase64(result);
            state = await invoke<WallpaperState>("apply_generated_image", {
              imageBase64: dataUrl,
              label: "puter",
              position,
              monitorId: monitor,
              model: scPuterModel.trim() ? scPuterModel.trim() : null,
            });
          } else {
            state = await invoke<WallpaperState>("generate_wallpaper_priority", {
              prompt: aiPrompt,
              position,
              monitorId: monitor,
              providerOrder: [id],
            });
          }
          usedProvider = id;
          break;
        } catch (err) {
          lastErr = err;
          failedBefore.push(
            t(lang, "gen.providerFailed", {
              provider: providerLabel(id),
              err: formatErr(err),
            }),
          );
        }
      }
      if (!state || !usedProvider) {
        if (!scAllowFallback) {
          throw new Error(
            t(lang, "gen.strictFailed", {
              provider: providerLabel(scProvider),
              err: formatErr(lastErr),
            }),
          );
        }
        throw lastErr ?? new Error(t(lang, "gen.noProvider"));
      }
      const applied = state;
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              current_wallpaper: applied.current_wallpaper,
              previous_wallpaper: applied.previous_wallpaper,
              backend_used: applied.backend_used,
              provider: applied.provider,
              source: applied.source,
            }
          : prev,
      );
      // 동적 값(공급자·경로·건너뜀 사유)은 자리표시자로만 전달한다 — 상태 메시지에
      // 한글 리터럴이 남으면 영어 선택 시 한국어가 노출된다(검수 지적 [medium]).
      const skippedNote =
        failedBefore.length > 0
          ? t(lang, "gen.failedBefore", { list: failedBefore.join(" / ") })
          : "";
      // 검수 지적 [low](2): 신규 생성 결과(응답 applied)와 state.json 저장값(fresh)을
      // 같은 메시지에 나란히 노출한다. "생성 정보" 패널은 현재 배경 기준이므로,
      // 둘이 다르면 사용자가 "왜 Puter 로 표시되지?"라고 혼동하던 지점이 즉시 드러난다.
      await refreshStatus();
      const fresh = await invoke<AppStatus>("get_app_status");
      const savedNote = fresh.provider
        ? t(lang, "gen.stateJsonNote", {
            provider: providerLabel(fresh.provider as ProviderId),
            source: fresh.source ? ` — ${fresh.source}` : "",
          })
        : t(lang, "gen.stateJsonNone");
      await syncSelectedToApplied(applied);
      reportOk(
        t(lang, "gen.priorityDoneDetail", {
          selected: providerLabel(scProvider),
          used: providerLabel(usedProvider),
          responseProvider: applied.provider ?? t(lang, "common.none"),
          savedNote,
          backend: applied.backend_used ?? t(lang, "common.unknown"),
          skippedNote,
        }),
      );
    } catch (err) {
      reportError(t(lang, "gen.priorityFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  // Puter 남은 크레딧 조회 — 실패를 0 으로 위장하지 않고 사유를 그대로 표시한다.
  const handleRefreshPuterUsage = async () => {
    setPuterUsageBusy(true);
    setPuterUsageErr("");
    try {
      setPuterUsage(await fetchPuterUsage());
    } catch (err) {
      setPuterUsage(null);
      setPuterUsageErr(formatErr(err));
    } finally {
      setPuterUsageBusy(false);
    }
  };

  const handlePuterSignIn = async () => {
    setBusy(true);
    try {
      await ensurePuterSession();
      reportOk(t(lang, "scenario.puterSignedIn"));
      void handleRefreshPuterUsage();
    } catch (err) {
      console.error("Puter 로그인 원본 에러:", (() => { try { return JSON.stringify(err, Object.getOwnPropertyNames(err as object)); } catch { return String(err); } })());
      reportError(t(lang, "scenario.puterSignInFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleTickScenario = async () => {
    setBusy(true);
    try {
      const applied = await invoke<WallpaperState | null>("tick_scenario_now");
      if (applied) {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                current_wallpaper: applied.current_wallpaper,
                previous_wallpaper: applied.previous_wallpaper,
                backend_used: applied.backend_used,
                provider: applied.provider,
                source: applied.source,
              }
            : prev,
        );
        await syncSelectedToApplied(applied);
        reportOk(
          t(lang, "scenario.runApplied", {
            backend: applied.backend_used ?? t(lang, "common.unknown"),
          }),
        );
      } else {
        reportOk(t(lang, "scenario.tickSkipped"));
      }
      await refreshScenario();
      await refreshStatus();
    } catch (err) {
      reportError(t(lang, "scenario.runFailed", { err: formatErr(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">{t(lang, "app.title")}</h1>
        <span className="app-subtitle">{t(lang, "app.subtitle")}</span>
        <div className="header-spacer" />
        {status?.backend_used && (
          <span className="badge ok">{status.backend_used}</span>
        )}
        {/* 언어 전환 — 선택값은 localStorage 에 저장되어 재시동 후에도 유지된다. */}
        <label className="lang-label" htmlFor="langSelect">
          {t(lang, "lang.label")}
        </label>
        <select
          id="langSelect"
          value={lang}
          onChange={(e) => handleLangChange(e.target.value as Lang)}
          style={{ width: "120px" }}
          aria-label={t(lang, "lang.label")}
        >
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <select
          value={monitorId}
          onChange={(e) => setMonitorId(e.target.value)}
          style={{ width: "220px" }}
          aria-label={t(lang, "header.monitor")}
        >
          <option value="">{t(lang, "header.allMonitors")}</option>
          {monitors.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.width}x{m.height})
              {m.is_primary ? ` · ${t(lang, "header.primary")}` : ""}
            </option>
          ))}
        </select>
      </header>

      <div className="studio">
        {/* ── 좌: 검색 / 생성 ── */}
        <aside className="panel panel-left">
          {/* 공급자에 따라 ① 검색 화면과 ② 생성 화면을 **상호 배타**로 보여준다.
              검색은 검색어(#query / #scSearchQueries)만, 생성은 프롬프트(#prompt)만 쓰므로
              두 입력을 같은 화면에 두면 "검색어와 프롬프트가 공통"이라는 오해를 만든다. */}
          <div className="field">
            <label htmlFor="scProviderQuick">{t(lang, "gen.providerQuick")}</label>
            <select
              id="scProviderQuick"
              value={scProvider}
              onChange={(e) => setScProvider(e.target.value as ProviderId)}
              disabled={busy}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(lang, p.labelKey)}
                </option>
              ))}
            </select>
            <div className="detail">{t(lang, "gen.providerQuickHint")}</div>
          </div>
          {scProvider === "search" ? (
          <section>
            <h2>{t(lang, "search.heading")}</h2>
            {/* 검색 공급자 선택 시 이 화면만 렌더된다 — 생성 입력(#prompt)은 아래 else 분기에만 있다. */}
            <div className="field">
              <label htmlFor="query">{t(lang, "search.keyword")}</label>
              <input
                id="query"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
                placeholder={t(lang, "search.keywordPlaceholder")}
              />
            </div>
            <div className="field">
              <label htmlFor="searchDir">{t(lang, "search.dir")}</label>
              <input
                id="searchDir"
                type="text"
                value={searchDir}
                onChange={(e) => setSearchDir(e.target.value)}
                placeholder={t(lang, "search.dirPlaceholder")}
              />
            </div>
            <div className="field">
              <label htmlFor="scSearchQueries">{t(lang, "search.queries")}</label>
              <textarea
                id="scSearchQueries"
                value={scSearchQueries}
                onChange={(e) => setScSearchQueries(e.target.value)}
                placeholder={"aurora borealis\nneon city night"}
              />
              <div className="detail">{t(lang, "search.queriesHint")}</div>
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleSearch()}
              disabled={busy}
            >
              {t(lang, "search.action")}
            </button>
          </section>
          ) : (
          <section>
            <h2>{t(lang, "gen.heading")}</h2>
            <div className="field">
              <label htmlFor="prompt">{t(lang, "gen.prompt")}</label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t(lang, "gen.promptPlaceholder")}
              />
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleGenerate()}
              disabled={busy}
            >
              {t(lang, "gen.action", { provider: providerLabel(scProvider) })}
            </button>
            {/* 생성 액션은 좌측 이 영역 하나뿐이다 — 우측 시나리오 섹션의 공급자별
                '생성·적용' 버튼은 제거했다(같은 동작이 두 곳에 있으면 일관성이 깨진다). */}
            <button
              type="button"
              className="primary block"
              onClick={() => void handleGenerateAi()}
              disabled={busy}
              style={{ marginTop: "8px" }}
            >
              {t(lang, "gen.actionApply")}
            </button>
          </section>
          )}
        </aside>

        {/* ── 중: 결과 그리드 ── */}
        <main className="panel">
          <h2>{t(lang, "results.heading", { count: candidates.length })}</h2>
          {candidates.length === 0 ? (
            <div className="empty">{t(lang, "results.empty")}</div>
          ) : (
            <div className="grid">
              {candidates.map((c) => (
                <div key={c.path} className="card-wrap">
                  <button
                    type="button"
                    className={`card${selected?.path === c.path ? " selected" : ""}`}
                    onClick={() => setSelected(c)}
                  >
                    <img
                      src={`data:image/jpeg;base64,${c.thumb_base64}`}
                      alt={c.file_name}
                    />
                    <div className="meta">
                      <div className="name">{c.file_name}</div>
                      <div>
                        {c.width}x{c.height} · {formatBytes(c.size_bytes)}
                      </div>
                    </div>
                  </button>
                  {/* 파일 삭제 — 카드 선택 클릭과 분리한다(stopPropagation).
                      삭제는 되돌릴 수 없으므로 결과 카드에서 바로 지우되,
                      백엔드(delete_image_file)가 허용 루트·현재 배경 보호를 검증한다. */}
                  <button
                    type="button"
                    className="card-delete danger"
                    title={`${c.file_name} ${t(lang, "common.delete")}`}
                    aria-label={`${c.file_name} ${t(lang, "common.delete")}`}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(c.path);
                    }}
                  >
                    {t(lang, "common.delete")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </main>

        {/* ── 우: 미리보기 / 적용 ── */}
        <aside className="panel panel-right">
          <h2>{t(lang, "preview.heading")}</h2>
          {selected ? (
            <>
              <div className="preview">
                {/* 보기 방식(창맞춤/원본/채우기)을 썸네일에도 즉시 반영한다.
                    style 을 주지 않으면 CSS 고정값만 적용되어 선택이 화면에 드러나지 않는다. */}
                <img
                  id="previewImage"
                  src={`data:image/jpeg;base64,${selected.thumb_base64}`}
                  alt={selected.file_name}
                  style={previewFitStyle(previewFit)}
                  data-fit={previewFit}
                  onClick={() => setViewerOpen(true)}
                  title={t(lang, "preview.clickFullscreen")}
                />
                <button
                  type="button"
                  id="previewFullscreen"
                  className="preview-fullscreen"
                  onClick={() => setViewerOpen(true)}
                >
                  {t(lang, "common.fullscreen")}
                </button>
              </div>
              <div className="detail">
                <div>
                  <b>{selected.file_name}</b>
                </div>
                <div>
                  {selected.width} x {selected.height} · {formatBytes(selected.size_bytes)}
                </div>
                <div>{selected.path}</div>
              </div>
              {/* 미리보기 창맞춤(fit) 모드 — 요구 ③. 썸네일은 320px 라 원본 비율을
                  유지한 채 컨테이너에 맞추는 `contain` 이 기본값이다. */}
              <div className="field">
                <label htmlFor="previewFit">{t(lang, "preview.fitLabel")}</label>
                <select
                  id="previewFit"
                  value={previewFit}
                  onChange={(e) =>
                    setPreviewFit(e.target.value as "fit" | "actual" | "fill")
                  }
                >
                  <option value="fit">{t(lang, "preview.fitFit")}</option>
                  <option value="actual">{t(lang, "preview.fitActual")}</option>
                  <option value="fill">{t(lang, "preview.fitFill")}</option>
                </select>
              </div>
              {/* 미리보기 중인 파일 삭제 — 결과 카드에서 사라진 파일도 여기서 지울 수 있다. */}
              <button
                type="button"
                id="previewDelete"
                className="danger block"
                disabled={busy}
                onClick={() => void handleDelete(selected)}
                style={{ marginBottom: "8px" }}
              >
                {t(lang, "common.deleteThis")}
              </button>
            </>
          ) : (
            <div className="empty">{t(lang, "preview.empty")}</div>
          )}

          {/* gen-info:start — ③ 미리보기 안에서도 생성 경로를 항상 보여준다
              (상태바(footer)만으로는 생성 직후 어떤 공급자로 만들어졌는지 눈에 띄지 않아
               Puter 결과와 무료 폴백(Pollinations) 결과를 구분할 수 없다는 지적 반영)

              귀속은 두 가지로 분리해 표시한다 (검수 지적: "Pollinations로 생성했는데
              Puter로 표시" 오표시 재발 방지):
              - "생성 정보 (미리보기 파일)": 미리보고 있는 파일 자신의 생성 정보 —
                파일 옆 사이드카(.geninfo.json)에서 읽은 값 (load_candidate → gen_provider/gen_source).
              - "생성 정보 (현재 배경)": OS 배경(state.json) 기록 — 이 파일과 무관할 수 있다. */}
          <div className="gen-info" id="genInfoPreview" title={selected?.gen_source ?? undefined}>
            <div className="gen-info-label">{t(lang, "preview.genFile")}</div>
            <div className="gen-info-value">
              {selected?.gen_provider
                ? `${providerLabel(selected.gen_provider as ProviderId)}${
                    selected.gen_source ? ` · ${selected.gen_source}` : ""
                  }`
                : t(lang, "preview.genUnknownFile")}
            </div>
          </div>
          <div className="gen-info" id="genInfo" title={status?.source ?? undefined}>
            <div className="gen-info-label">{t(lang, "preview.genCurrent")}</div>
            <div className="gen-info-value">
              {status?.provider
                ? `${providerLabel(status.provider as ProviderId)}${
                    status?.source ? ` · ${status?.source}` : ""
                  }`
                : t(lang, "preview.genUnknownCurrent")}
            </div>
            {genPath ? (
              <div className="gen-info-path" title={genPath}>
                {t(lang, "preview.currentWallpaperPath", { path: genPath })}
              </div>
            ) : null}
            {genPath && selPath && !genMatchesSelected && selected ? (
              <div className="gen-info-warn" id="genInfoMismatch">
                {t(lang, "preview.mismatch", { name: selected.file_name })}
              </div>
            ) : null}
          </div>
          {/* gen-info:end */}

          {/* ③ 미리보기 전체화면 뷰어 — 이미지를 화면 전체로 본다(Esc / 닫기 버튼으로 종료). */}
          {viewerOpen && selected ? (
            <div
              className="viewer"
              id="fullscreenViewer"
              role="dialog"
              aria-modal="true"
              aria-label={`${selected.file_name} 전체화면`}
              onClick={() => setViewerOpen(false)}
            >
              <div className="viewer-body" onClick={(e) => e.stopPropagation()}>
                <img
                  src={`data:image/jpeg;base64,${selected.thumb_base64}`}
                  alt={selected.file_name}
                />
              </div>
              <button
                type="button"
                id="viewerClose"
                className="viewer-close"
                onClick={() => setViewerOpen(false)}
              >
                {t(lang, "common.closeEsc")}
              </button>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="position">{t(lang, "position.label")}</label>
            <select
              id="position"
              value={position}
              onChange={(e) => setPosition(e.target.value as WallpaperPosition)}
            >
              {POSITION_IDS.map((p) => (
                <option key={p} value={p}>
                  {t(lang, `position.${p}`)}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="primary block"
            onClick={() => void handleApply()}
            disabled={busy || !selected}
            style={{ marginBottom: "8px" }}
          >
            {t(lang, "common.apply")}
          </button>
          <button
            type="button"
            className="block"
            onClick={() => void handleRestore()}
            disabled={busy}
            style={{ marginBottom: "12px" }}
          >
            {t(lang, "common.restore")}
          </button>

          <section id="scenario-section">
            <h2>{t(lang, "scenario.heading")}</h2>
            <div className="field">
              <label htmlFor="scEnabled">{t(lang, "scenario.autoUpdate")}</label>
              <select
                id="scEnabled"
                value={scEnabled ? "on" : "off"}
                onChange={(e) => setScEnabled(e.target.value === "on")}
              >
                <option value="off">OFF</option>
                <option value="on">ON</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="scInterval">{t(lang, "scenario.interval")}</label>
              <input
                id="scInterval"
                type="number"
                min={5}
                value={scInterval}
                onChange={(e) => setScInterval(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="scUrls">{t(lang, "scenario.urls")}</label>
              <textarea
                id="scUrls"
                value={scUrls}
                onChange={(e) => setScUrls(e.target.value)}
                placeholder="https://cdn.example.com/w1.jpg"
              />
            </div>
            <div className="field">
              <label htmlFor="scLocalDir">{t(lang, "scenario.localDir")}</label>
              <input
                id="scLocalDir"
                type="text"
                value={scLocalDir}
                onChange={(e) => setScLocalDir(e.target.value)}
                placeholder={t(lang, "scenario.localDirPlaceholder")}
              />
            </div>
            <div className="detail">
              {t(lang, "scenario.searchQueriesNote")}
            </div>
            <div className="field">
              <label htmlFor="scOrder">{t(lang, "scenario.order")}</label>
              <select
                id="scOrder"
                value={scOrder}
                onChange={(e) =>
                  setScOrder(e.target.value as "sequential" | "random")
                }
              >
                <option value="sequential">{t(lang, "scenario.orderSeq")}</option>
                <option value="random">{t(lang, "scenario.orderRandom")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="scSeedMode">{t(lang, "scenario.seed")}</label>
              <select
                id="scSeedMode"
                value={scSeedMode}
                onChange={(e) =>
                  setScSeedMode(e.target.value as "fixed" | "incremental" | "random")
                }
              >
                <option value="fixed">{t(lang, "scenario.seedFixed")}</option>
                <option value="incremental">{t(lang, "scenario.seedIncremental")}</option>
                <option value="random">{t(lang, "scenario.seedRandom")}</option>
              </select>
              {scSeedMode === "fixed" ? (
                <input
                  id="scSeedFixed"
                  type="number"
                  min={0}
                  value={scSeedFixed}
                  onChange={(e) => setScSeedFixed(Number(e.target.value))}
                  placeholder={t(lang, "scenario.seedFixedPlaceholder")}
                  style={{ marginTop: "6px" }}
                />
              ) : null}
              <div className="detail">
                {scProvider === "pollinations" && (
                  <>
                    {t(lang, "scenario.seedPollinationsHint")}
                  </>
                )}
                {scProvider === "cloudflare-workers-ai" && (
                  <>
                    {cloudflareAcceptsSeed(scCfModel) ? (
                      <>
                        {t(lang, "scenario.seedCfFluxYes")}
                      </>
                    ) : (
                      <>
                        {t(lang, "scenario.seedCfFluxNo")}
                      </>
                    )}
                  </>
                )}
                {scProvider === "openai" && (
                  <>
                    {t(lang, "scenario.seedOpenaiHint")}
                  </>
                )}
                {scProvider === "puter" && (
                  <>
                    {t(lang, "scenario.seedPuterHint")}
                  </>
                )}
                {scProvider === "search" && (
                  <>
                    {t(lang, "scenario.seedSearchHint")}
                  </>
                )}
                {providerUsesSeed(scProvider) && scSeedMode !== "fixed" ? (
                  <>{t(lang, "scenario.seedCounter", { count: scSeedNext })}</>
                ) : null}
              </div>
            </div>
            <div className="field">
              <label htmlFor="scProvider">{t(lang, "scenario.provider")}</label>
              <select
                id="scProvider"
                value={scProvider}
                onChange={(e) =>
                  setScProvider(
                    e.target.value as "pollinations" | "cloudflare-workers-ai" | "openai" | "puter",
                  )
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(lang, p.labelKey)}
                  </option>
                ))}
              </select>
              <div className="detail">
                {t(lang, "scenario.providerShared")}
              </div>
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={scAllowFallback}
                  onChange={(e) => setScAllowFallback(e.target.checked)}
                  disabled={busy}
                />{" "}
                {t(lang, "scenario.allowFallback")}
              </label>
            </div>
            <div className="field">
              <label>{t(lang, "scenario.priorityLabel")}</label>
              {scProviderOrder.map((p, i) => (
                <div key={p} style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" }}>
                  <label
                    style={{ display: "flex", gap: "4px", alignItems: "center", minWidth: "220px" }}
                    title={t(lang, "scenario.offHint")}
                  >
                    <input
                      type="checkbox"
                      checked={scProviderEnabled[p]}
                      onChange={(e) =>
                        setScProviderEnabled((prev) => ({ ...prev, [p]: e.target.checked }))
                      }
                      disabled={busy}
                    />
                    <span>
                      {i + 1}. {providerLabel(p)}
                      {scProviderEnabled[p] ? ` — ${t(lang, "scenario.on")}` : ` — ${t(lang, "scenario.off")}`}
                      {p === "puter" ? ` · ${t(lang, "scenario.puterBackendExcluded")}` : ""}
                    </span>
                  </label>
                  <button type="button" onClick={() => moveProviderOrder(i, -1)} disabled={busy || i === 0}>▲</button>
                  <button type="button" onClick={() => moveProviderOrder(i, 1)} disabled={busy || i === scProviderOrder.length - 1}>▼</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                <button type="button" onClick={() => setScProviderOrder([...FREE_FIRST_ORDER])} disabled={busy}>{t(lang, "scenario.priorityReset")}</button>
              </div>
              <div className="detail">
                {t(lang, "scenario.priorityDefaultHint")}
              </div>
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleGeneratePriority()}
              disabled={busy}
              style={{ marginBottom: "8px" }}
            >
              {t(lang, "scenario.priorityGenerate")}
            </button>
            {scProvider === "cloudflare-workers-ai" && (
              <>
                <div className="field">
                  <label htmlFor="scCfAccount">{t(lang, "scenario.cfAccount")}</label>
                  <input
                    id="scCfAccount"
                    type="text"
                    value={scCfAccount}
                    onChange={(e) => setScCfAccount(e.target.value)}
                    placeholder={t(lang, "scenario.cfAccountPlaceholder")}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="scCfToken">{t(lang, "scenario.cfToken")}</label>
                  <input
                    id="scCfToken"
                    type="password"
                    value={scCfToken}
                    onChange={(e) => setScCfToken(e.target.value)}
                    placeholder={t(lang, "scenario.cfTokenPlaceholder")}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="scClearToken">
                    <input
                      id="scClearToken"
                      type="checkbox"
                      checked={scClearToken}
                      onChange={(e) => setScClearToken(e.target.checked)}
                    />{" "}
                    {t(lang, "scenario.clearToken")}
                  </label>
                </div>
                <div className="field">
                  <label htmlFor="scCfModel">{t(lang, "scenario.model")}</label>
                  <input
                    id="scCfModel"
                    type="text"
                    value={scCfModel}
                    onChange={(e) => setScCfModel(e.target.value)}
                    placeholder="@cf/black-forest-labs/flux-1-schnell"
                    autoComplete="off"
                  />
                </div>
              </>
            )}
            {scProvider === "openai" && (
              <>
                <div className="field">
                  <label htmlFor="scOpenaiKey">{t(lang, "scenario.openaiKey")}</label>
                  <input
                    id="scOpenaiKey"
                    type="password"
                    value={scOpenaiKey}
                    onChange={(e) => setScOpenaiKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="scClearKey">
                    <input
                      id="scClearKey"
                      type="checkbox"
                      checked={scClearKey}
                      onChange={(e) => setScClearKey(e.target.checked)}
                    />{" "}
                    {t(lang, "scenario.clearKey")}
                  </label>
                </div>
                <div className="field">
                  <label htmlFor="scOpenaiModel">{t(lang, "scenario.model")}</label>
                  <input
                    id="scOpenaiModel"
                    type="text"
                    value={scOpenaiModel}
                    onChange={(e) => setScOpenaiModel(e.target.value)}
                    placeholder="gpt-image-1"
                    autoComplete="off"
                  />
                </div>
              </>
            )}
            {scProvider === "puter" && (
              <>
                <div className="field">
                  <label>{t(lang, "scenario.puterLabel")}</label>
                  <div className="detail">
                    {t(lang, "scenario.puterDesc")}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="scPuterModel">{t(lang, "scenario.puterModel")}</label>
                  <select
                    id="scPuterModel"
                    value={scPuterModel}
                    onChange={(e) => setScPuterModel(e.target.value)}
                  >
                    {PUTER_IMAGE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.labelKey ? t(lang, m.labelKey) : (m.label ?? m.id)}
                      </option>
                    ))}
                  </select>
                  <div className="detail">
                    {t(lang, "scenario.puterModelHint")}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="puterUsageRemaining">{t(lang, "scenario.creditHeading")}</label>
                  <div id="puterUsageRemaining" className="detail">
                    {puterUsageBusy
                      ? t(lang, "scenario.creditBusy")
                      : puterUsage
                        ? `${t(lang, "scenario.creditSummary", {
                            remaining: formatUsage(
                              puterUsage.summary.remaining,
                              puterUsage.summary.unit,
                            ),
                            unit: usageUnitLabel(puterUsage.summary.unit),
                          })}${
                            puterUsage.summary.allowance !== null
                              ? t(lang, "scenario.creditAllowance", {
                                  allowance: formatUsage(
                                    puterUsage.summary.allowance,
                                    puterUsage.summary.unit,
                                  ),
                                })
                              : ""
                          }${
                            puterUsage.summary.spent !== null
                              ? t(lang, "scenario.creditSpent", {
                                  spent: formatUsage(
                                    puterUsage.summary.spent,
                                    puterUsage.summary.unit,
                                  ),
                                })
                              : ""
                          }${t(lang, "scenario.creditUnitPath", {
                            unit:
                              puterUsage.summary.unit ??
                              t(lang, "scenario.creditUnitUnspecified"),
                            path: puterUsage.summary.unitPath ?? "?",
                            remainingPath:
                              puterUsage.summary.remainingPath ?? t(lang, "common.none"),
                            allowancePath:
                              puterUsage.summary.allowancePath ?? t(lang, "common.none"),
                            spentPath: puterUsage.summary.spentPath ?? t(lang, "common.none"),
                          })}`
                        : t(lang, "scenario.creditIdle")}
                  </div>
                  {puterUsage && (
                    <details style={{ marginBottom: "8px" }}>
                      <summary className="detail">
                        {t(lang, "scenario.creditRaw")}
                      </summary>
                      <pre
                        className="detail"
                        style={{
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          maxHeight: "240px",
                          overflow: "auto",
                          marginTop: "6px",
                        }}
                      >
                        {stringifyUsageRaw(puterUsage.raw)}
                      </pre>
                    </details>
                  )}
                  {puterUsageErr && (
                    <div className="detail" style={{ color: "#c0392b" }}>
                      {t(lang, "scenario.creditFailed", { err: puterUsageErr })}
                    </div>
                  )}
                  <button
                    type="button"
                    className="block"
                    onClick={() => void handleRefreshPuterUsage()}
                    disabled={busy || puterUsageBusy}
                    style={{ marginBottom: "8px" }}
                  >
                    {t(lang, "scenario.creditFetch")}
                  </button>
                </div>
                <button
                  type="button"
                  className="block"
                  onClick={() => void handlePuterSignIn()}
                  disabled={busy}
                  style={{ marginBottom: "8px" }}
                >
                  {t(lang, "scenario.puterSignIn")}
                </button>
              </>
            )}
            <div className="detail" style={{ marginBottom: "8px" }}>
              {scInfo || t(lang, "scenario.notLoaded")}
              {scAutoFail > 0 ? ` · ${t(lang, "scenario.autoFail", { n: scAutoFail })}` : ""}
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleSaveScenario()}
              disabled={busy}
              style={{ marginBottom: "8px" }}
            >
              {t(lang, "scenario.save")}
            </button>
            <button
              type="button"
              className="block"
              onClick={() => void handleTickScenario()}
              disabled={busy}
            >
              {t(lang, "scenario.runNow")}
            </button>
          </section>

          {/* ── 히스토리 — 전용 창으로 분리했다.
              이전에는 이 300px 좌측 패널 안에 리스트를 중첩해 폭이 부족했고,
              날짜·텍스트·버튼이 겹쳐 레이아웃이 깨졌다(사용자 지적).
              목록·일시·개별 삭제는 라벨 `history` 창(HistoryWindow.tsx)이 담당하고,
              메인 창에는 **여는 버튼과 요약만** 둔다.
              창에서 "메인에서 사용"을 누르면 `history://reuse` 이벤트로 입력란에 복원된다. */}
          <section id="history-section">
            <h2>{t(lang, "history.heading")}</h2>
            <div className="detail" style={{ marginBottom: "8px" }}>
              {t(lang, "history.summary", { n: history.length })}
            </div>
            <button
              type="button"
              className="primary block"
              disabled={busy}
              onClick={() => void handleOpenHistoryWindow()}
            >
              {t(lang, "history.openWindow")}
            </button>
          </section>

          {/* ── 정보(About) — 버전/제작자는 Cargo 메타데이터가 단일 소스다.
              값을 화면에 하드코딩하지 않고 `get_app_meta` 응답을 그대로 표시한다. ── */}
          <section id="about-section">
            <h2>{t(lang, "about.heading")}</h2>
            <div className="detail" id="appMeta">
              <div>
                {t(lang, "about.version")}:{" "}
                <b>
                  {appMeta?.version_display ??
                    appMeta?.version ??
                    t(lang, "about.notLoaded")}
                </b>
              </div>
              <div>
                {t(lang, "about.author")}:{" "}
                <b>{appMeta?.author ?? t(lang, "about.notLoaded")}</b>
              </div>
            </div>
          </section>
        </aside>
      </div>

      {/* ── 상태 바 ── */}
      <footer className="statusbar">
        <span className="path">
          {t(lang, "footer.current")}: {status?.current_wallpaper || t(lang, "footer.none")}
        </span>
        <span className="path">
          {t(lang, "footer.previous")}: {status?.previous_wallpaper || t(lang, "footer.noSnapshot")}
        </span>
        <span className="path" title={status?.source ?? undefined}>
          {t(lang, "footer.genInfo")}:{" "}
          {status?.provider
            ? `${status.provider}${status?.source ? ` · ${status?.source}` : ""}`
            : t(lang, "footer.noneGenerated")}
        </span>
        <span className={`msg ${statusKind === "error" ? "error" : statusKind === "ok" ? "ok" : ""}`}>
          {busy ? t(lang, "common.busy") : statusMsg || t(lang, "common.ready")}
        </span>
      </footer>

      {/* ── Puter 로그인 안내 모달 (팝업 차단 시) ── */}
      {puterPromptUrl && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setPuterPromptUrl(null)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="puter-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="puter-modal-title">{t(lang, "modal.title")}</h3>
            <p className="modal-desc">{t(lang, "modal.desc")}</p>
            <div className="modal-url">
              <code>{puterPromptUrl}</code>
            </div>
            <div className="modal-actions">
              <button type="button" className="block" onClick={() => void handleCopyPuterUrl()}>
                {t(lang, "modal.copyUrl")}
              </button>
              <button
                type="button"
                className="primary block"
                onClick={() => void handleOpenPuterUrl()}
              >
                {t(lang, "modal.openBrowser")}
              </button>
            </div>
            <p className="modal-note" role="status">
              {puterCopyMsg}
            </p>
            <div className="modal-actions">
              <button type="button" className="block" onClick={() => setPuterPromptUrl(null)}>
                {t(lang, "modal.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
