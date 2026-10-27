import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  formatUsage,
  usageUnitLabel,
  puterUsageSummary,
  stringifyUsageRaw,
  type PuterUsageResult,
} from "./puterUsage";
import { parseAppliedSearchQuery } from "./appliedQuery";
// 모델별 1회당 크레딧 — 계산·표시는 순수 모듈(./puterModelCredits)이 담당하고
// App 은 배선(모델 select·단가 표)만 한다. 단가 미확인 모델은 null(→ "정보 없음")로
// 두어 추정치를 실측처럼 표시하지 않는다.
import {
  creditForModel,
  estimateImagesForCredits,
  formatCreditsPerImage,
  mergeModelCredits,
  parseModelCatalogCredits,
  PUTER_DEFAULT_MODEL_ID,
  PUTER_MODEL_CREDITS,
  type PuterModelCredit,
} from "./puterModelCredits";

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
      // 드라이버 직접 호출 — 이미지 모델 카탈로그(단가 포함) 조회에 쓴다.
      // 근거: https://docs.puter.com/AI/txt2img/
      //   "await puter.drivers.call('puter-image-generation', 'models', {})"
      drivers?: {
        call?: (driver: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }
}

/// Puter `txt2img`가 지원하는 이미지 모델 목록 — Puter.js 공식 문서 기준.
/// 근거: https://developer.puter.com/tutorials/free-unlimited-image-generation-api/ (모델 목록)
///       https://docs.puter.com/AI/txt2img/ (options.model, 제공자 기본 모델표)
/// 모델 ID를 생략하면 Puter가 제공자 기본 모델(현재 OpenAI `gpt-image-2`)을 고르므로,
/// UI의 "(기본 모델)" 항목은 options 자체를 넘기지 않는 것과 동일하다.
const PUTER_IMAGE_MODELS: { id: string; label: string }[] = [
  { id: "openai/gpt-image-2", label: "GPT Image 2 (Puter 기본값)" },
  { id: "openai/gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
  { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
  { id: "google/gemini-3-pro-image", label: "Nano Banana Pro (Gemini 3 Pro Image)" },
  { id: "google/gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
  { id: "google/imagen-4.0", label: "Imagen 4.0" },
  { id: "black-forest-labs/flux-2-pro", label: "FLUX.2 [pro]" },
  { id: "black-forest-labs/flux-2-dev", label: "FLUX.2 [dev]" },
  { id: "black-forest-labs/flux-2-klein-9b-base", label: "FLUX.2 [klein] 9B" },
  { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 [pro]" },
  { id: "black-forest-labs/flux-schnell", label: "FLUX.1 schnell (빠름)" },
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
    reader.onerror = () => reject(new Error("Puter 이미지 base64 변환 실패"));
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
    if (!resp.ok) throw new Error(`Puter 이미지 다운로드 실패: HTTP ${resp.status}`);
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
        if (!resp.ok) throw new Error(`Puter 이미지 다운로드 실패: HTTP ${resp.status}`);
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
    `Puter 응답 형식을 해석할 수 없습니다: ${Object.prototype.toString.call(result)}`,
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
    throw new Error("Puter.js SDK를 불러오지 못했습니다 (오프라인/스크립트 차단).");
  }
  const auth = window.puter.auth;
  if (!auth) {
    throw new Error("Puter 로그인(auth)을 사용할 수 없습니다 — SDK 버전을 확인하세요.");
  }
  if (typeof auth.getMonthlyUsage !== "function") {
    throw new Error(
      "이 Puter.js SDK 버전에는 getMonthlyUsage 가 없습니다 — 잔여 크레딧을 조회할 수 없습니다.",
    );
  }
  const signedIn = await puterIsSignedIn(() => (auth.isSignedIn ? auth.isSignedIn() : false));
  if (!signedIn) {
    throw new Error("Puter 로그인이 필요합니다 — [Puter 로그인] 후 다시 조회하세요.");
  }
  const raw = await auth.getMonthlyUsage();
  return { summary: puterUsageSummary(raw), raw };
}

/// Puter 이미지 모델 카탈로그(단가 포함)를 조회한다.
///
/// 진입점: `puter.drivers.call('puter-image-generation','models',{})`
/// 근거: https://docs.puter.com/AI/txt2img/ — "including model IDs, aliases, provider names,
///       and pricing metadata"
///
/// 응답 정규화는 순수 모듈(`parseModelCatalogCredits`)이 담당하고, 여기서는 SDK 호출·세션
/// 확인만 한다. `pricing.unit` 이 credits 가 아닌 항목(달러/센트)은 채택하지 않는다 —
/// `$0.04` 를 "0.04 credits" 로 표시하면 실제 소모를 1/475 로 오해하게 된다.
/// 세션 미확립·SDK 부재는 0/null 로 위장하지 않고 명시적 오류로 실패한다.
export async function fetchPuterModelCredits(): Promise<{
  live: { id: string; creditsPerImage: number }[];
  raw: unknown;
}> {
  if (!window.puter) {
    throw new Error("Puter.js SDK를 불러오지 못했습니다 (오프라인/스크립트 차단).");
  }
  const drivers = window.puter.drivers;
  if (!drivers || typeof drivers.call !== "function") {
    throw new Error(
      "이 Puter.js SDK 버전에는 drivers.call 이 없습니다 — 모델 단가를 조회할 수 없습니다.",
    );
  }
  const auth = window.puter.auth;
  const signedIn = await puterIsSignedIn(() => (auth && auth.isSignedIn ? auth.isSignedIn() : false));
  if (!signedIn) {
    throw new Error(
      "Puter 로그인이 필요합니다 — [Puter 로그인] 후 [모델 단가 조회]를 다시 누르세요.",
    );
  }
  const raw = await drivers.call("puter-image-generation", "models", {});
  return { live: parseModelCatalogCredits(raw), raw };
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
  throw new Error("Puter 로그인 안내 창을 표시할 수 없습니다 — 잠시 후 다시 시도하세요.");
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
    errors.push(`셸 오픈 실패: ${formatErr(err)}`);
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
    errors.push(`링크 폴백 실패: ${formatErr(err)}`);
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
        throw new Error(
          `팝업이 차단되었습니다 — 안내 창을 표시하지 못했습니다 (${formatErr(fallbackErr)})`
        );
      }
      // 브라우저는 사용자가 [바로가기]를 눌렀을 때만 열린다 (즉시 열지 않음).
      throw new Error(
        "팝업이 차단되었습니다 — 화면에 표시된 안내 창에서 [URL 복사] 또는 [바로가기]를 선택하세요."
      );
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
      if (keys.length > 0) return `알 수 없는 오류 (keys: ${keys.join(", ")})`;
      return "알 수 없는 오류";
    }
  }
  return String(err);
}

/// Puter 세션을 보장한다 — 미인증이면 `puter.auth.signIn()` 로그인 팝업을 띄워
/// 세션을 연결한 뒤 원래 생성 요청을 이어갈 수 있게 한다. (auth 미제공 SDK는 생성이 응답에서 요구)
async function ensurePuterSession(): Promise<void> {
  const txt2img = window.puter?.ai?.txt2img;
  if (!txt2img) {
    throw new Error("Puter.js SDK를 불러오지 못했습니다 (오프라인/스크립트 차단).");
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
    throw new Error("Puter 로그인(auth.signIn)을 사용할 수 없습니다 — SDK 버전을 확인하세요.");
  }
  await puterSignIn(auth); // 로그인 팝업 → 세션 연결 후 원래 생성 흐름 재개 (popup_blocked 안내 변환 포함)
}

/// 세션 보장 후 생성 요청. 인증 오류 감지 시 로그인 팝업으로 세션 재연결 후 원래 생성 요청을 1회 재시도한다.
async function puterGenerateWithAuth(produce: string, model?: string): Promise<unknown> {
  const txt2img = window.puter?.ai?.txt2img;
  if (!txt2img) {
    throw new Error("Puter.js SDK를 불러오지 못했습니다 (오프라인/스크립트 차단).");
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

const POSITION_LABELS: Record<WallpaperPosition, string> = {
  fill: "채우기 (Fill)",
  fit: "맞춤 (Fit)",
  stretch: "늘이기 (Stretch)",
  tile: "바둑판식 (Tile)",
  center: "가운데 (Center)",
  span: "스팬 (Span)",
};

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
  // `ProviderId`: 이미지 공급자 전체 집합(4종) — select 옵션·우선순위 목록이 같은 PROVIDERS 상수에서 파생된다.
  type ProviderId = "pollinations" | "puter" | "cloudflare-workers-ai" | "openai" | "search";
  const PROVIDERS: { id: ProviderId; label: string; backend: boolean }[] = [
    { id: "pollinations", label: "Pollinations (무료·키 불필요)", backend: true },
    { id: "search", label: "검색 (Search — 키워드·키 불필요)", backend: true },
    { id: "puter", label: "Puter (무료·브라우저 SDK)", backend: false },
    { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI", backend: true },
    { id: "openai", label: "OpenAI", backend: true },
  ];
  const FREE_FIRST_ORDER: ProviderId[] = PROVIDERS.map((p) => p.id);
  const providerLabel = (id: ProviderId): string => PROVIDERS.find((p) => p.id === id)?.label ?? id;
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
  // 모델 단가 목록 — 정적 표(PUTER_MODEL_CREDITS)를 기반으로 두고, Puter 카탈로그
  // (`drivers.call('puter-image-generation','models')`)를 조회하면 그 값으로 병합한다.
  // 병합 전에는 실측 1건 외 14개가 "정보 없음"이며, 이는 위장이 아니라 미확인 상태다.
  const [puterModelCredits, setPuterModelCredits] =
    useState<PuterModelCredit[]>(PUTER_MODEL_CREDITS);
  const [puterCatalogErr, setPuterCatalogErr] = useState<string>("");
  const [puterCatalogBusy, setPuterCatalogBusy] = useState<boolean>(false);
  // 모델 미선택 시 실제로 쓰이는 모델은 Puter 기본값이므로, 단가도 그 기본 모델 기준으로 보여준다.
  // (빈 값을 "정보 없음"으로 두면 기본 모델로 생성하면서 단가를 모르는 것처럼 보인다.)
  const selectedPuterModelId = scPuterModel.trim() ? scPuterModel.trim() : PUTER_DEFAULT_MODEL_ID;
  const selectedPuterCredit = creditForModel(selectedPuterModelId, puterModelCredits);
  // 남은 크레딧으로 이 모델을 몇 회 만들 수 있는지 — 잔액 미조회/단가 미확인이면 null(표시 안 함).
  const puterImagesPossible = estimateImagesForCredits(
    puterUsage ? puterUsage.summary.remaining : null,
    selectedPuterCredit ? selectedPuterCredit.creditsPerImage : null,
  );
  // 프롬프트는 좌측 ②의 단일 #prompt를 모든 AI 공급자에 공통 적용한다(중복 입력 제거).
  const [scInfo, setScInfo] = useState<string>("시나리오 미조회");
  // 자동 틱 연속 실패 횟수 (지적 #4: 에러 은폐 방지용 카운터)
  const [scAutoFail, setScAutoFail] = useState<number>(0);
  // 저장 시 커서·시각 보존용 원본 스냅샷 (지적 #2: 하드코딩 방지)
  const [scPrev, setScPrev] = useState<ScenarioSettings | null>(null);

  // 상태
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("준비됨");
  const [statusKind, setStatusKind] = useState<"ok" | "error" | "info">("info");
  const [busy, setBusy] = useState<boolean>(false);
  // ③ 미리보기 전체화면 뷰어 열림 상태
  const [viewerOpen, setViewerOpen] = useState<boolean>(false);

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
        if (!okCopy) throw new Error("execCommand('copy') 실패");
      }
      setPuterCopyMsg("URL을 클립보드에 복사했습니다");
    } catch (err) {
      setPuterCopyMsg(`URL 복사 실패: ${formatErr(err)}`);
    }
  };

  // [바로가기] — 사용자가 명시적으로 눌렀을 때만 실제 브라우저 열기를 시도한다.
  const handleOpenPuterUrl = async () => {
    try {
      await openPuterLoginInBrowser();
      setPuterCopyMsg("브라우저에서 로그인 페이지를 열었습니다");
    } catch (err) {
      setPuterCopyMsg(`브라우저 열기 실패: ${formatErr(err)}`);
    }
  };

  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<AppStatus>("get_app_status");
      setStatus(s);
    } catch (err) {
      reportError(`상태 조회 실패: ${formatErr(err)}`);
    }
  }, []);

  const refreshMonitors = useCallback(async () => {
    try {
      const list = await invoke<MonitorInfo[]>("list_monitors");
      setMonitors(list);
    } catch (err) {
      reportError(`모니터 조회 실패: ${formatErr(err)}`);
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
        `다음 #${sc.next_index} · 마지막 ${sc.last_run_at ?? "없음"} · ${sc.enabled ? "ON" : "OFF"}`,
      );
    } catch (err) {
      setScInfo(`시나리오 조회 실패: ${formatErr(err)}`);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshMonitors();
    void refreshScenario();
  }, [refreshStatus, refreshMonitors, refreshScenario]);

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
            reportOk(`시나리오 자동 적용 — 백엔드: ${applied.backend_used ?? "unknown"}`);
            await refreshScenario();
            await refreshStatus();
          }
        } catch (err) {
          console.error("scenario auto-tick failed:", err);
          setScAutoFail((n) => {
            const next = n + 1;
            setScInfo(
              (prev) =>
                `자동 업데이트 실패(${next}회 연속) — 수동 "지금 실행"으로 상세 확인: ${formatErr(err)} · ${prev}`,
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
      reportOk(
        result.truncated
          ? `검색 완료: ${result.total_matched}건 중 ${result.candidates.length}건 표시`
          : `검색 완료: ${result.candidates.length}개 후보`,
      );
    } catch (err) {
      reportError(`검색 실패: ${formatErr(err)}`);
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
      reportError(
        "검색(Search)은 ① 검색 영역의 [검색] 버튼으로 실행합니다 — ② 생성은 이미지 생성 전용입니다.",
      );
      return;
    }
    if (!aiPrompt) {
      reportError("프롬프트를 입력하세요.");
      return;
    }
    // 개별 On/Off: Off 로 둔 공급자는 ② 생성에서도 시도하지 않는다.
    // (우선순위 생성·시나리오 자동 실행과 같은 규칙 — 경로마다 판정이 달라지면 안 된다)
    if (!scProviderEnabled[scProvider]) {
      reportError(
        `선택한 공급자(${providerLabel(scProvider)})가 Off(비활성)입니다 — 우선순위 목록에서 On 으로 바꾼 뒤 다시 시도하세요.`,
      );
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
        reportOk(`생성 완료 (${providerLabel(scProvider)}): ${candidate.file_name}`);
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
      reportOk(`생성 완료 (${providerLabel(scProvider)}): ${candidate.file_name}`);
    } catch (err) {
      reportError(`생성 실패 (${providerLabel(scProvider)}): ${formatErr(err)}`);
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
        reportError("AI 프롬프트를 입력하세요.");
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
        reportOk(`Puter 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
        await refreshStatus();
        // 생성은 크레딧을 소모하므로 성공 시 잔여 allowance 를 자동 갱신한다(실패는 표시만).
        void handleRefreshPuterUsage();
      } catch (err) {
        reportError(`Puter 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
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
        reportError("검색 키워드를 입력하세요.");
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
          `검색 생성·적용 완료 — 검색어: "${appliedQuery}" · 백엔드: ${state.backend_used ?? "unknown"}`,
        );
        await refreshStatus();
      } catch (err) {
        reportError(`검색 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    // provider=openai일 때는 OpenAI 경로로 분기한다 (저장된 api_key 폴백 포함).
    if (scProvider === "openai") {
      const aiPrompt = prompt.trim();
      if (!aiPrompt) {
        reportError("AI 프롬프트를 입력하세요.");
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
        reportOk(`OpenAI 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
        await refreshStatus();
      } catch (err) {
        reportError(`OpenAI 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    // 검수 지적 [medium](1): 토큰 사전 검사는 account_id만 요구한다.
    // api_token이 비어 있으면 Rust generate_wallpaper_ai_impl이 디스크 저장 토큰으로 폴백한다.
    if (!scCfAccount.trim()) {
      reportError("Cloudflare Account ID를 입력하세요. (API Token은 저장된 토큰 사용 — 미저장 시 입력 필요)");
      return;
    }
    const aiPrompt = prompt.trim();
    if (!aiPrompt) {
      reportError("AI 프롬프트를 입력하세요.");
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
      reportOk(`Cloudflare AI 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
      await refreshStatus();
    } catch (err) {
      reportError(`Cloudflare AI 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!selected) {
      reportError("적용할 이미지를 먼저 선택하세요.");
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
      reportOk(`적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
    } catch (err) {
      reportError(`적용 실패: ${formatErr(err)}`);
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
      reportOk(`복원 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
    } catch (err) {
      reportError(`복원 실패: ${formatErr(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveScenario = async () => {
    const minutes = Number.parseInt(scInterval, 10);
    if (!Number.isFinite(minutes) || minutes < 5) {
      reportError("주기는 5분 이상 숫자로 입력하세요.");
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
      reportError("Puter는 WebView 전용 생성 경로라 시나리오 공급자로 저장할 수 없습니다. Pollinations/검색(Search)/Cloudflare/OpenAI 중 선택 후 저장하세요.");
      return;
    }
    // 위 puter 가드에서 early return했으므로 Exclude<ProviderId, "puter">로 좁혀진다.
    const provider = scProvider as Exclude<ProviderId, "puter">;
    // Off 공급자를 대표 공급자로 저장하면 시나리오 자동 실행 후보가 비어 버린다 — 명시적으로 막는다.
    if (!scProviderEnabled[provider]) {
      reportError(
        `선택한 공급자(${providerLabel(provider)})가 Off(비활성)입니다 — 우선순위 목록에서 On 으로 바꾼 뒤 저장하세요.`,
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
        `저장됨 · 다음 #${saved.next_index} · ${saved.enabled ? "ON" : "OFF"} · ${saved.interval_minutes}분`,
      );
      const deletedToken = scClearToken && scCfToken.trim() === "";
      const deletedKey = scClearKey && scOpenaiKey.trim() === "";
      setScClearToken(false);
      setScClearKey(false);
      if (deletedToken || deletedKey) {
        if (deletedToken) setScCfToken("");
        if (deletedKey) setScOpenaiKey("");
        reportOk("시나리오 저장 완료 — 저장된 API 토큰/키를 삭제했습니다");
      } else {
        // scClearToken 체크 + 새 토큰 동시 입력 시 백엔드는 새 토큰을 저장하므로
        // 입력값을 비우지 않고 일반 저장 메시지를 표시한다.
        reportOk("시나리오 저장 완료");
      }
    } catch (err) {
      reportError(`시나리오 저장 실패: ${formatErr(err)}`);
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
      reportError("AI 프롬프트를 입력하세요.");
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
          `선택한 공급자(${providerLabel(scProvider)})가 Off(비활성)입니다 — 우선순위 목록에서 On 으로 바꾸거나 다른 공급자를 선택하세요.`,
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
                lastErr = new Error("Puter.js SDK 미로드");
                failedBefore.push(`${providerLabel(id)}: SDK 미로드 — 건너뜀`);
                continue;
              }
              const signedIn = await puterIsSignedIn(() =>
                auth.isSignedIn ? auth.isSignedIn() : false,
              );
              if (!signedIn) {
                lastErr = new Error("Puter 로그인 상태 아님");
                failedBefore.push(`${providerLabel(id)}: 로그인 상태 아님 — 건너뜀`);
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
          failedBefore.push(`${providerLabel(id)}: ${formatErr(err)}`);
        }
      }
      if (!state || !usedProvider) {
        if (!scAllowFallback) {
          throw new Error(
            `선택한 공급자(${providerLabel(scProvider)}) 실패: ${formatErr(lastErr)} — 자동 폴백 비활성`,
          );
        }
        throw lastErr ?? new Error("시도 가능한 이미지 공급자가 없습니다.");
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
      const skippedNote =
        failedBefore.length > 0 ? ` · 앞선 실패: ${failedBefore.join(" / ")}` : "";
      // 검수 지적 [low](2): 신규 생성 결과(응답 applied)와 state.json 저장값(fresh)을
      // 같은 메시지에 나란히 노출한다. "생성 정보" 패널은 현재 배경 기준이므로,
      // 둘이 다르면 사용자가 "왜 Puter 로 표시되지?"라고 혼동하던 지점이 즉시 드러난다.
      await refreshStatus();
      const fresh = await invoke<AppStatus>("get_app_status");
      const savedNote = fresh.provider
        ? ` · state.json: ${providerLabel(fresh.provider as ProviderId)}${fresh.source ? ` — ${fresh.source}` : ""}`
        : " · state.json: 생성 정보 없음";
      await syncSelectedToApplied(applied);
      reportOk(
        `우선순위 생성·적용 완료 — 선택: ${providerLabel(scProvider)} → 실제: ${providerLabel(usedProvider)} · 응답 provider: ${
          applied.provider ?? "없음"
        }${savedNote} · 백엔드: ${applied.backend_used ?? "unknown"}${skippedNote}`,
      );
    } catch (err) {
      reportError(`우선순위 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
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

  // Puter 모델 카탈로그(단가) 조회 — 실패를 '정보 없음'으로 위장하지 않고 사유를 남긴다.
  // 성공 시 정적 표(PUTER_MODEL_CREDITS)에 병합해 14개 모델의 미확인 단가를 런타임 값으로 채운다.
  const handleRefreshPuterModelCredits = async () => {
    setPuterCatalogBusy(true);
    setPuterCatalogErr("");
    try {
      const { live } = await fetchPuterModelCredits();
      if (live.length === 0) {
        // 카탈로그가 왔지만 credits 단가 항목이 없으면(달러 단가 등) 병합하지 않고 사유를 남긴다.
        setPuterCatalogErr(
          "카탈로그에서 credits 단가 항목을 찾지 못했습니다 — pricing.unit 이 credits 인 항목이 없습니다(달러/센트 단가는 채택하지 않습니다).",
        );
        return;
      }
      setPuterModelCredits((prev) => mergeModelCredits(prev, live));
    } catch (err) {
      setPuterCatalogErr(formatErr(err));
    } finally {
      setPuterCatalogBusy(false);
    }
  };

  const handlePuterSignIn = async () => {
    setBusy(true);
    try {
      await ensurePuterSession();
      reportOk("Puter 세션 연결 완료 — 이제 이미지 생성을 사용할 수 있습니다");
      void handleRefreshPuterUsage();
    } catch (err) {
      console.error("Puter 로그인 원본 에러:", (() => { try { return JSON.stringify(err, Object.getOwnPropertyNames(err as object)); } catch { return String(err); } })());
      reportError(`Puter 로그인 실패: ${formatErr(err)}`);
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
        reportOk(`시나리오 적용 — 백엔드: ${applied.backend_used ?? "unknown"}`);
      } else {
        reportOk("시나리오: 아직 주기가 안 됐거나 OFF/소스 없음");
      }
      await refreshScenario();
      await refreshStatus();
    } catch (err) {
      reportError(`시나리오 실행 실패: ${formatErr(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">WallMagic Studio</h1>
        <span className="app-subtitle">Windows Wallpaper Studio</span>
        <div className="header-spacer" />
        {status?.backend_used && (
          <span className="badge ok">{status.backend_used}</span>
        )}
        <select
          value={monitorId}
          onChange={(e) => setMonitorId(e.target.value)}
          style={{ width: "220px" }}
          aria-label="대상 모니터"
        >
          <option value="">모든 모니터</option>
          {monitors.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.width}x{m.height}){m.is_primary ? " · 기본" : ""}
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
            <label htmlFor="scProviderQuick">이미지 공급자 (검색/생성 화면 전환)</label>
            <select
              id="scProviderQuick"
              value={scProvider}
              onChange={(e) => setScProvider(e.target.value as ProviderId)}
              disabled={busy}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="detail">
              <b>검색(Search)</b> 을 고르면 ① 검색 화면만, 생성 공급자를 고르면 ② 생성 화면만
              표시합니다. 검색어와 프롬프트는 서로 다른 입력입니다(자동 대체 없음).
            </div>
          </div>
          {scProvider === "search" ? (
          <section>
            <h2>① 검색</h2>
            {/* 검색 공급자 선택 시 이 화면만 렌더된다 — 생성 입력(#prompt)은 아래 else 분기에만 있다. */}
            <div className="field">
              <label htmlFor="query">키워드 (파일명 검색 + 온라인 검색 질의)</label>
              <input
                id="query"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
                placeholder="예: sunset (비우면 전체)"
              />
            </div>
            <div className="field">
              <label htmlFor="searchDir">검색 폴더 (선택)</label>
              <input
                id="searchDir"
                type="text"
                value={searchDir}
                onChange={(e) => setSearchDir(e.target.value)}
                placeholder="C:\Users\me\Pictures (기본: 라이브러리+Pictures)"
              />
            </div>
            <div className="field">
              <label htmlFor="scSearchQueries">
                시나리오 순환 검색어 (선택 — 비우면 위 키워드 사용)
              </label>
              <textarea
                id="scSearchQueries"
                value={scSearchQueries}
                onChange={(e) => setScSearchQueries(e.target.value)}
                placeholder={"aurora borealis\nneon city night"}
              />
              <div className="detail">
                비어 있으면 위 <b>키워드</b>가 그대로 검색 질의로 쓰입니다(키워드 = 검색 질의의
                단일 소스). 여러 개를 넣으면 시나리오 자동 실행에서 순차/랜덤으로 순환합니다.
                ② 생성의 프롬프트와는 무관합니다.
              </div>
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleSearch()}
              disabled={busy}
            >
              검색
            </button>
          </section>
          ) : (
          <section>
            <h2>② 생성</h2>
            <div className="field">
              <label htmlFor="prompt">프롬프트 (생성 전용 — AI 이미지 공급자 공통)</label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="예: aurora over icy mountains"
              />
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleGenerate()}
              disabled={busy}
            >
              생성 ({providerLabel(scProvider)})
            </button>
          </section>
          )}
        </aside>

        {/* ── 중: 결과 그리드 ── */}
        <main className="panel">
          <h2>결과 ({candidates.length})</h2>
          {candidates.length === 0 ? (
            <div className="empty">
              왼쪽에서 <b>검색</b> 또는 <b>생성</b>하면 이곳에 후보가 표시됩니다.
            </div>
          ) : (
            <div className="grid">
              {candidates.map((c) => (
                <button
                  type="button"
                  key={c.path}
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
              ))}
            </div>
          )}
        </main>

        {/* ── 우: 미리보기 / 적용 ── */}
        <aside className="panel panel-right">
          <h2>③ 미리보기</h2>
          {selected ? (
            <>
              <div className="preview">
                <img
                  src={`data:image/jpeg;base64,${selected.thumb_base64}`}
                  alt={selected.file_name}
                  onClick={() => setViewerOpen(true)}
                  title="클릭하면 전체화면으로 봅니다"
                />
                <button
                  type="button"
                  id="previewFullscreen"
                  className="preview-fullscreen"
                  onClick={() => setViewerOpen(true)}
                >
                  전체화면
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
            </>
          ) : (
            <div className="empty">선택된 이미지가 없습니다.</div>
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
            <div className="gen-info-label">생성 정보 (미리보기 파일)</div>
            <div className="gen-info-value">
              {selected?.gen_provider
                ? `${providerLabel(selected.gen_provider as ProviderId)}${
                    selected.gen_source ? ` · ${selected.gen_source}` : ""
                  }`
                : "(이 파일의 생성 정보 미기록 — 사이드카 없음)"}
            </div>
          </div>
          <div className="gen-info" id="genInfo" title={status?.source ?? undefined}>
            <div className="gen-info-label">생성 정보 (현재 배경)</div>
            <div className="gen-info-value">
              {status?.provider
                ? `${providerLabel(status.provider as ProviderId)}${
                    status?.source ? ` · ${status?.source}` : ""
                  }`
                : "(이 앱에서 생성한 배경 아님 / 미기록)"}
            </div>
            {genPath ? (
              <div className="gen-info-path" title={genPath}>
                현재 배경: {genPath}
              </div>
            ) : null}
            {genPath && selPath && !genMatchesSelected && selected ? (
              <div className="gen-info-warn" id="genInfoMismatch">
                현재 배경과 다른 파일 — "생성 정보 (현재 배경)"은 위 미리보기({selected.file_name})의 정보가 아닙니다. 이 이미지의 정보는 위 "생성 정보 (미리보기 파일)"을 보세요.
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
                닫기 (Esc)
              </button>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="position">배치 방식</label>
            <select
              id="position"
              value={position}
              onChange={(e) => setPosition(e.target.value as WallpaperPosition)}
            >
              {(Object.keys(POSITION_LABELS) as WallpaperPosition[]).map((p) => (
                <option key={p} value={p}>
                  {POSITION_LABELS[p]}
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
            ④ 바탕화면에 적용
          </button>
          <button
            type="button"
            className="block"
            onClick={() => void handleRestore()}
            disabled={busy}
            style={{ marginBottom: "12px" }}
          >
            이전 배경으로 복원
          </button>

          <section id="scenario-section">
            <h2>⑤ 시나리오 · Cloudflare (자동 업데이트)</h2>
            <div className="field">
              <label htmlFor="scEnabled">자동 업데이트</label>
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
              <label htmlFor="scInterval">주기 (분, 최소 5)</label>
              <input
                id="scInterval"
                type="number"
                min={5}
                value={scInterval}
                onChange={(e) => setScInterval(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="scUrls">이미지 URL 목록 (줄바꿈 구분, R2 권장)</label>
              <textarea
                id="scUrls"
                value={scUrls}
                onChange={(e) => setScUrls(e.target.value)}
                placeholder="https://cdn.example.com/w1.jpg"
              />
            </div>
            <div className="field">
              <label htmlFor="scLocalDir">로컬 폴더 (선택 — URL이 비었을 때 순환)</label>
              <input
                id="scLocalDir"
                type="text"
                value={scLocalDir}
                onChange={(e) => setScLocalDir(e.target.value)}
                placeholder="C:\Users\me\Pictures\auto (비우면 사용 안 함)"
              />
            </div>
            <div className="detail">
              이미지 검색어는 ① 검색 영역에서 입력합니다(검색 공급자 전용). 저장 시
              <code> source.search_queries</code> 로 함께 저장됩니다.
            </div>
            <div className="field">
              <label htmlFor="scOrder">순서</label>
              <select
                id="scOrder"
                value={scOrder}
                onChange={(e) =>
                  setScOrder(e.target.value as "sequential" | "random")
                }
              >
                <option value="sequential">순차 (sequential)</option>
                <option value="random">랜덤 (random)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="scProvider">이미지 공급자</label>
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
                    {p.label}
                  </option>
                ))}
              </select>
              <div className="detail">
                좌측 <b>이미지 공급자 (검색/생성 화면 전환)</b> 과 <b>같은 값</b>을 공유합니다 —
                한쪽을 바꾸면 다른 쪽도 함께 바뀌고, 저장되는 값도 이 공급자 하나입니다
                (별도 설정이 아닙니다).
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
                자동 폴백 허용 (선택 공급자 실패 시 다음 공급자로 넘어감 — 기본은 끔: 선택한 공급자만 사용)
              </label>
            </div>
            <div className="field">
              <label>이미지 생성 우선순위 (폴백 순서 — 위부터 시도, 실패 시 다음 공급자)</label>
              {scProviderOrder.map((p, i) => (
                <div key={p} style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" }}>
                  <label
                    style={{ display: "flex", gap: "4px", alignItems: "center", minWidth: "220px" }}
                    title="Off 로 두면 이 공급자는 생성·폴백·시나리오 자동 실행에서 모두 제외됩니다."
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
                      {scProviderEnabled[p] ? " — On" : " — Off (제외)"}
                      {p === "puter" ? " · 백엔드 폴백 제외(WebView 전용)" : ""}
                    </span>
                  </label>
                  <button type="button" onClick={() => moveProviderOrder(i, -1)} disabled={busy || i === 0}>▲</button>
                  <button type="button" onClick={() => moveProviderOrder(i, 1)} disabled={busy || i === scProviderOrder.length - 1}>▼</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                <button type="button" onClick={() => setScProviderOrder([...FREE_FIRST_ORDER])} disabled={busy}>무료 우선으로 초기화</button>
              </div>
              <div className="detail">
                기본값: 무료 우선 = Pollinations → Puter → Cloudflare → OpenAI.
                키 없는 공급자는 자동 건너뛰고, Puter는 브라우저 전용이라 백엔드 폴백(시나리오 자동 실행)에서 제외됩니다.
              </div>
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleGeneratePriority()}
              disabled={busy}
              style={{ marginBottom: "8px" }}
            >
              우선순위로 생성·적용
            </button>
            {scProvider === "cloudflare-workers-ai" && (
              <>
                <div className="field">
                  <label htmlFor="scCfAccount">Cloudflare Account ID</label>
                  <input
                    id="scCfAccount"
                    type="text"
                    value={scCfAccount}
                    onChange={(e) => setScCfAccount(e.target.value)}
                    placeholder="예: a1b2c3d4..."
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="scCfToken">Cloudflare API Token (Workers AI 권한)</label>
                  <input
                    id="scCfToken"
                    type="password"
                    value={scCfToken}
                    onChange={(e) => setScCfToken(e.target.value)}
                    placeholder="Workers AI 권한 토큰"
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
                    저장된 API 토큰 삭제 (체크 후 저장 시 삭제)
                  </label>
                </div>
                <div className="field">
                  <label htmlFor="scCfModel">모델</label>
                  <input
                    id="scCfModel"
                    type="text"
                    value={scCfModel}
                    onChange={(e) => setScCfModel(e.target.value)}
                    placeholder="@cf/black-forest-labs/flux-1-schnell"
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  className="primary block"
                  onClick={() => void handleGenerateAi()}
                  disabled={busy}
                  style={{ marginBottom: "8px" }}
                >
                  Cloudflare AI로 생성·적용
                </button>
              </>
            )}
            {scProvider === "openai" && (
              <>
                <div className="field">
                  <label htmlFor="scOpenaiKey">OpenAI API Key</label>
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
                    저장된 API 키 삭제 (체크 후 저장 시 삭제)
                  </label>
                </div>
                <div className="field">
                  <label htmlFor="scOpenaiModel">모델</label>
                  <input
                    id="scOpenaiModel"
                    type="text"
                    value={scOpenaiModel}
                    onChange={(e) => setScOpenaiModel(e.target.value)}
                    placeholder="gpt-image-1"
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  className="primary block"
                  onClick={() => void handleGenerateAi()}
                  disabled={busy}
                  style={{ marginBottom: "8px" }}
                >
                  OpenAI로 생성·적용
                </button>
              </>
            )}
            {scProvider === "puter" && (
              <>
                <div className="field">
                  <label>Puter (무료 · 브라우저 SDK)</label>
                  <div className="detail">
                    생성은 WebView의 <b>Puter.js</b>(<code>puter.ai.txt2img</code>)가 수행하고,
                    결과 이미지는 Rust 커맨드 <code>apply_generated_image</code>가 해상도 검증·스테이징·적용합니다.
                    API 키 입력은 필요 없습니다 (Puter 세션 사용). SDK 로드 실패 시 명시적 오류가 표시됩니다.
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="scPuterModel">이미지 모델</label>
                  <select
                    id="scPuterModel"
                    value={scPuterModel}
                    onChange={(e) => setScPuterModel(e.target.value)}
                  >
                    {PUTER_IMAGE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {formatCreditsPerImage(creditForModel(m.id, puterModelCredits))}
                      </option>
                    ))}
                  </select>
                  <div className="detail">
                    모델을 선택하지 않으면 Puter 기본 모델(OpenAI gpt-image-2)이 사용됩니다.
                    모델마다 결과 화질·속도·사용 크레딧이 다릅니다.
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="puterModelCredits">모델별 1회당 크레딧</label>
                  <div id="puterModelCredits" className="detail">
                    <div>
                      선택 모델(<code>{selectedPuterModelId}</code>):{" "}
                      <b>{formatCreditsPerImage(selectedPuterCredit)}</b>
                      {puterImagesPossible !== null ? ` · 남은 크레딧으로 약 ${puterImagesPossible}회 생성 가능` : ""}
                    </div>
                    <div>근거: {selectedPuterCredit ? selectedPuterCredit.basis : "정보 없음"}</div>
                    {!puterUsage && (
                      <div>
                        남은 크레딧을 조회하면 생성 가능 횟수도 함께 표시됩니다 — [크레딧 조회].
                      </div>
                    )}
                    {puterCatalogErr && (
                      <div style={{ color: "#c0392b" }}>
                        모델 단가 조회 실패: {puterCatalogErr}
                      </div>
                    )}
                    {!puterCatalogErr && !puterCatalogBusy && (
                      <div>
                        단가는 실측 1건 외에는 미확인입니다 — [모델 단가 조회]로 Puter 카탈로그
                        (<code>drivers.call('puter-image-generation','models')</code>)의 credits
                        단가를 병합합니다. 달러/센트 단가는 채택하지 않습니다.
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="block"
                    onClick={() => void handleRefreshPuterModelCredits()}
                    disabled={busy || puterCatalogBusy}
                    style={{ marginBottom: "8px" }}
                  >
                    모델 단가 조회
                  </button>
                  <details style={{ marginBottom: "8px" }}>
                    <summary className="detail">모델 전체 단가 표 (15개)</summary>
                    <div className="detail" style={{ marginTop: "6px" }}>
                      {puterModelCredits.map((c) => (
                        <div key={c.id}>
                          <code>{c.id}</code> — {formatCreditsPerImage(c)}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="field">
                  <label htmlFor="puterUsageRemaining">Puter 남은 크레딧 (월간 allowance)</label>
                  <div id="puterUsageRemaining" className="detail">
                    {puterUsageBusy
                      ? "조회 중..."
                      : puterUsage
                        ? `남은 크레딧: ${formatUsage(puterUsage.summary.remaining, puterUsage.summary.unit)}${usageUnitLabel(puterUsage.summary.unit)}${
                            puterUsage.summary.allowance !== null
                              ? ` / 월 한도 ${formatUsage(puterUsage.summary.allowance, puterUsage.summary.unit)}`
                              : ""
                          }${
                            puterUsage.summary.spent !== null
                              ? ` · 사용 ${formatUsage(puterUsage.summary.spent, puterUsage.summary.unit)}`
                              : ""
                          } · 단위: ${puterUsage.summary.unit ?? "미표기"}(${puterUsage.summary.unitPath ?? "?"}) · 경로: 남음 ${puterUsage.summary.remainingPath ?? "없음"} / 한도 ${puterUsage.summary.allowancePath ?? "없음"} / 사용 ${puterUsage.summary.spentPath ?? "없음"}`
                        : "(아직 조회하지 않았습니다 — [크레딧 조회]를 누르세요)"}
                  </div>
                  {puterUsage && (
                    <details style={{ marginBottom: "8px" }}>
                      <summary className="detail">
                        원본 응답 보기 (진단 — 실제 스키마 확인용)
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
                      크레딧 조회 실패: {puterUsageErr}
                    </div>
                  )}
                  <button
                    type="button"
                    className="block"
                    onClick={() => void handleRefreshPuterUsage()}
                    disabled={busy || puterUsageBusy}
                    style={{ marginBottom: "8px" }}
                  >
                    크레딧 조회
                  </button>
                </div>
                <button
                  type="button"
                  className="block"
                  onClick={() => void handlePuterSignIn()}
                  disabled={busy}
                  style={{ marginBottom: "8px" }}
                >
                  Puter 로그인 (세션 연결)
                </button>
                <button
                  type="button"
                  className="primary block"
                  onClick={() => void handleGenerateAi()}
                  disabled={busy}
                  style={{ marginBottom: "8px" }}
                >
                  Puter로 생성·적용
                </button>
              </>
            )}
            <div className="detail" style={{ marginBottom: "8px" }}>
              {scInfo}
              {scAutoFail > 0 ? ` · 자동 실패 ${scAutoFail}회 연속` : ""}
            </div>
            <button
              type="button"
              className="primary block"
              onClick={() => void handleSaveScenario()}
              disabled={busy}
              style={{ marginBottom: "8px" }}
            >
              시나리오 저장
            </button>
            <button
              type="button"
              className="block"
              onClick={() => void handleTickScenario()}
              disabled={busy}
            >
              지금 실행
            </button>
          </section>
        </aside>
      </div>

      {/* ── 상태 바 ── */}
      <footer className="statusbar">
        <span className="path">
          현재 배경: {status?.current_wallpaper || "(조회 안 됨)"}
        </span>
        <span className="path">
          이전 배경: {status?.previous_wallpaper || "(스냅샷 없음)"}
        </span>
        <span className="path" title={status?.source ?? undefined}>
          생성 정보:{" "}
          {status?.provider
            ? `${status.provider}${status?.source ? ` · ${status?.source}` : ""}`
            : "(이 앱에서 생성한 배경 아님 / 미기록)"}
        </span>
        <span className={`msg ${statusKind === "error" ? "error" : statusKind === "ok" ? "ok" : ""}`}>
          {busy ? "처리 중..." : statusMsg}
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
            <h3 id="puter-modal-title">Puter 로그인 — 팝업이 차단되었습니다</h3>
            <p className="modal-desc">
              아래 주소를 복사해 브라우저에서 열거나, [바로가기]를 눌러 기본 브라우저로
              이동하세요. 외부 브라우저 로그인은 앱 세션과 별개이므로, 앱에서 생성하려면
              이 사이트의 팝업을 허용한 뒤 다시 시도해야 합니다.
            </p>
            <div className="modal-url">
              <code>{puterPromptUrl}</code>
            </div>
            <div className="modal-actions">
              <button type="button" className="block" onClick={() => void handleCopyPuterUrl()}>
                URL 복사
              </button>
              <button
                type="button"
                className="primary block"
                onClick={() => void handleOpenPuterUrl()}
              >
                바로가기 (브라우저 열기)
              </button>
            </div>
            <p className="modal-note" role="status">
              {puterCopyMsg}
            </p>
            <div className="modal-actions">
              <button type="button" className="block" onClick={() => setPuterPromptUrl(null)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
