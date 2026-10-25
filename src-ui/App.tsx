import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  source: { urls: string[]; local_dir: string | null };
  order: "sequential" | "random";
  next_index: number;
  last_run_at: number | null;
  position: string;
  provider: "pollinations" | "cloudflare-workers-ai" | "openai";
  provider_order?: ("pollinations" | "cloudflare-workers-ai" | "openai")[];
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
  const [scOrder, setScOrder] = useState<"sequential" | "random">("sequential");
  // `ProviderId`: 이미지 공급자 전체 집합(4종) — select 옵션·우선순위 목록이 같은 PROVIDERS 상수에서 파생된다.
  type ProviderId = "pollinations" | "puter" | "cloudflare-workers-ai" | "openai";
  const PROVIDERS: { id: ProviderId; label: string; backend: boolean }[] = [
    { id: "pollinations", label: "Pollinations (무료·키 불필요)", backend: true },
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
  const [scCfAccount, setScCfAccount] = useState<string>("");
  const [scCfToken, setScCfToken] = useState<string>("");
  const [scCfModel, setScCfModel] = useState<string>("@cf/black-forest-labs/flux-1-schnell");
  const [scClearToken, setScClearToken] = useState<boolean>(false);
  const [scOpenaiKey, setScOpenaiKey] = useState<string>("");
  const [scOpenaiModel, setScOpenaiModel] = useState<string>("gpt-image-1");
  const [scClearKey, setScClearKey] = useState<boolean>(false);
  // Puter 이미지 모델 — 빈 문자열이면 options를 넘기지 않아 Puter 기본 모델을 쓴다.
  const [scPuterModel, setScPuterModel] = useState<string>("");
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
      setScOrder(sc.order);
      setScProvider(sc.provider ?? "pollinations");
      const rawOrd = (sc as unknown as { provider_order?: unknown }).provider_order;
      if (Array.isArray(rawOrd) && rawOrd.length > 0) {
        const valid = (rawOrd as string[]).filter((v): v is ProviderId => v === "pollinations" || v === "cloudflare-workers-ai" || v === "openai");
        const dedup = [...new Set(valid)];
        if (dedup.length > 0) {
          // 저장된 순서(백엔드 3종) + 화면 전용(Puter) 누락분을 뒤에 보태 4종 집합을 유지한다.
          const missing = FREE_FIRST_ORDER.filter((id) => !dedup.includes(id));
          setScProviderOrder([...dedup, ...missing]);
        }
      } else {
        // 구 scenario.json(provider_order 없음): 단일 provider 시도로 해석 (하위호환)
        const single = (sc.provider ?? "pollinations") as ProviderId;
        setScProviderOrder([single]);
      }
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

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      reportError("프롬프트를 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      const candidate = await invoke<WallpaperCandidate>(
        "generate_library_wallpaper",
        { prompt: prompt.trim() },
      );
      setCandidates((prev) => [candidate, ...prev.filter((c) => c.path !== candidate.path)]);
      setSelected(candidate);
      reportOk(`생성 완료: ${candidate.file_name}`);
    } catch (err) {
      reportError(`생성 실패: ${formatErr(err)}`);
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
        reportOk(`Puter 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
        await refreshStatus();
      } catch (err) {
        reportError(`Puter 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
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
    // Puter는 WebView 전용 SDK라 백엔드 ImageProvider("pollinations"|"cloudflare-workers-ai"|"openai")로
    // 역직렬화할 수 없다 — 그대로 저장하면 scenario.json 로드 시 실패한다. 저장을 명시적으로 차단한다.
    if (scProvider === "puter") {
      reportError("Puter는 WebView 전용 생성 경로라 시나리오 공급자로 저장할 수 없습니다. Pollinations/Cloudflare/OpenAI 중 선택 후 저장하세요.");
      return;
    }
    // 위 puter 가드에서 early return했으므로 Exclude<ProviderId, "puter">로 좁혀진다.
    const provider = scProvider as Exclude<ProviderId, "puter">;
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
    const sourceChanged =
      scPrev == null ||
      prevUrls.length !== urls.length ||
      prevUrls.some((u, i) => u !== urls[i]) ||
      (prevLocalDir ?? null) !== localDir ||
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
          source: { urls, local_dir: localDir },
          order: scOrder,
          next_index: nextIndex,
          last_run_at: lastRunAt,
          position,
          provider,
          provider_order: backendOrderIds(scProviderOrder),
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
      const order = [scProvider, ...scProviderOrder.filter((id) => id !== scProvider)];
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
      reportOk(
        `우선순위 생성·적용 완료 — 공급자: ${providerLabel(usedProvider)} · 백엔드: ${
          applied.backend_used ?? "unknown"
        }${skippedNote}`,
      );
      await refreshStatus();
    } catch (err) {
      reportError(`우선순위 생성 실패 (기존 배경 유지): ${formatErr(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePuterSignIn = async () => {
    setBusy(true);
    try {
      await ensurePuterSession();
      reportOk("Puter 세션 연결 완료 — 이제 이미지 생성을 사용할 수 있습니다");
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
          <section>
            <h2>① 검색</h2>
            <div className="field">
              <label htmlFor="query">키워드 (파일명 기준)</label>
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
            <button
              type="button"
              className="primary block"
              onClick={() => void handleSearch()}
              disabled={busy}
            >
              검색
            </button>
          </section>

          <section>
            <h2>② 생성</h2>
            <div className="field">
              <label htmlFor="prompt">프롬프트 (테마 — 모든 AI 이미지 생성에 공통 적용)</label>
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
              생성
            </button>
          </section>
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
               Puter 결과와 무료 폴백(Pollinations) 결과를 구분할 수 없다는 지적 반영) */}
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
            {genPath && selPath && genPath !== selPath && selected ? (
              <div className="gen-info-warn" id="genInfoMismatch">
                현재 배경과 다른 파일 — 위 미리보기({selected.file_name})의 생성 정보가 아닙니다.
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
            </div>
            <div className="field">
              <label>이미지 생성 우선순위 (폴백 순서 — 위부터 시도, 실패 시 다음 공급자)</label>
              {scProviderOrder.map((p, i) => (
                <div key={p} style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" }}>
                  <span style={{ minWidth: "160px" }}>
                    {i + 1}. {providerLabel(p)}
                    {p === "puter" ? " — 백엔드 폴백 제외(WebView 전용)" : ""}
                  </span>
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
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <div className="detail">
                    모델을 선택하지 않으면 Puter 기본 모델(OpenAI gpt-image-2)이 사용됩니다.
                    모델마다 결과 화질·속도·사용 크레딧이 다릅니다.
                  </div>
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
