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
    };
  }
}

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
  // `scProvider`: 수동 생성에 쓸 공급자. "puter"는 WebView 전용(Puter.js 브라우저 SDK)이라
  // 백엔드 우선순위(`provider_order`)에는 넣지 않는다 — Rust는 브라우저 SDK를 호출할 수 없다.
  const [scProvider, setScProvider] = useState<"pollinations" | "cloudflare-workers-ai" | "openai" | "puter">("pollinations");
  // `ProviderId`: 백엔드 `ImageProvider` enum과 1:1 대응하는 3종만 — 우선순위 목록·저장 payload 전용.
  type ProviderId = "pollinations" | "cloudflare-workers-ai" | "openai";
  const FREE_FIRST_ORDER: ProviderId[] = ["pollinations", "cloudflare-workers-ai", "openai"];
  const [scProviderOrder, setScProviderOrder] = useState<ProviderId[]>([...FREE_FIRST_ORDER]);
  const [scCfAccount, setScCfAccount] = useState<string>("");
  const [scCfToken, setScCfToken] = useState<string>("");
  const [scCfModel, setScCfModel] = useState<string>("@cf/black-forest-labs/flux-1-schnell");
  const [scClearToken, setScClearToken] = useState<boolean>(false);
  const [scOpenaiKey, setScOpenaiKey] = useState<string>("");
  const [scOpenaiModel, setScOpenaiModel] = useState<string>("gpt-image-1");
  const [scClearKey, setScClearKey] = useState<boolean>(false);
  const [scPrompt, setScPrompt] = useState<string>("");
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

  const reportOk = (msg: string) => {
    setStatusMsg(msg);
    setStatusKind("ok");
  };
  const reportError = (msg: string) => {
    setStatusMsg(msg);
    setStatusKind("error");
  };

  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<AppStatus>("get_app_status");
      setStatus(s);
    } catch (err) {
      reportError(`상태 조회 실패: ${String(err)}`);
    }
  }, []);

  const refreshMonitors = useCallback(async () => {
    try {
      const list = await invoke<MonitorInfo[]>("list_monitors");
      setMonitors(list);
    } catch (err) {
      reportError(`모니터 조회 실패: ${String(err)}`);
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
        if (dedup.length > 0) setScProviderOrder(dedup);
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
      setScPrompt(sc.prompt ?? "");
      setScPrev(sc);
      setScInfo(
        `다음 #${sc.next_index} · 마지막 ${sc.last_run_at ?? "없음"} · ${sc.enabled ? "ON" : "OFF"}`,
      );
    } catch (err) {
      setScInfo(`시나리오 조회 실패: ${String(err)}`);
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
                `자동 업데이트 실패(${next}회 연속) — 수동 "지금 실행"으로 상세 확인: ${String(err)} · ${prev}`,
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
      reportError(`검색 실패: ${String(err)}`);
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
      reportError(`생성 실패: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateAi = async () => {
    // provider=puter일 때: 생성은 WebView의 Puter.js SDK, 검증·스테이징·적용은
    // Rust `apply_generated_image`가 담당한다 (코어 한 곳에서 해상도/스냅샷 처리).
    if (scProvider === "puter") {
      const aiPrompt = (scPrompt.trim() || prompt).trim();
      if (!aiPrompt) {
        reportError("AI 프롬프트를 입력하세요.");
        return;
      }
      const txt2img = window.puter?.ai?.txt2img;
      if (!txt2img) {
        reportError(
          "Puter.js SDK를 불러오지 못했습니다 (오프라인/스크립트 차단). 네트워크 확인 후 새로고침하세요.",
        );
        return;
      }
      setBusy(true);
      try {
        const result = await txt2img(aiPrompt);
        const dataUrl = await puterResultToBase64(result);
        const state = await invoke<WallpaperState>("apply_generated_image", {
          imageBase64: dataUrl,
          label: "puter",
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
              }
            : prev,
        );
        reportOk(`Puter 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
        await refreshStatus();
      } catch (err) {
        reportError(`Puter 생성 실패 (기존 배경 유지): ${String(err)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    // provider=openai일 때는 OpenAI 경로로 분기한다 (저장된 api_key 폴백 포함).
    if (scProvider === "openai") {
      const aiPrompt = (scPrompt.trim() || prompt).trim();
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
              }
            : prev,
        );
        reportOk(`OpenAI 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
        await refreshStatus();
      } catch (err) {
        reportError(`OpenAI 생성 실패 (기존 배경 유지): ${String(err)}`);
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
    const aiPrompt = (scPrompt.trim() || prompt).trim();
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
            }
          : prev,
      );
      reportOk(`Cloudflare AI 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
      await refreshStatus();
    } catch (err) {
      reportError(`Cloudflare AI 생성 실패 (기존 배경 유지): ${String(err)}`);
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
            }
          : prev,
      );
      reportOk(`적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
    } catch (err) {
      reportError(`적용 실패: ${String(err)}`);
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
            }
          : prev,
      );
      reportOk(`복원 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
    } catch (err) {
      reportError(`복원 실패: ${String(err)}`);
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
    const provider = scProvider;
    const cfAccount = scCfAccount.trim();
    const cfModel = scCfModel.trim() || "@cf/black-forest-labs/flux-1-schnell";
    const openaiModel = scOpenaiModel.trim() || "gpt-image-1";
    const sharedPrompt = scPrompt.trim();
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
          provider_order: scProviderOrder,
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
      reportError(`시나리오 저장 실패: ${String(err)}`);
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
    const aiPrompt = (scPrompt.trim() || prompt).trim();
    if (!aiPrompt) {
      reportError("AI 프롬프트를 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("generate_wallpaper_priority", {
        prompt: aiPrompt,
        position,
        monitorId: monitorId.trim() ? monitorId.trim() : null,
        providerOrder: scProviderOrder,
      });
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              current_wallpaper: state.current_wallpaper,
              previous_wallpaper: state.previous_wallpaper,
              backend_used: state.backend_used,
            }
          : prev,
      );
      reportOk(`우선순위 생성·적용 완료 — 백엔드: ${state.backend_used ?? "unknown"}`);
      await refreshStatus();
    } catch (err) {
      reportError(`우선순위 생성 실패 (기존 배경 유지): ${String(err)}`);
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
      reportError(`시나리오 실행 실패: ${String(err)}`);
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
              <label htmlFor="prompt">프롬프트 (테마)</label>
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
                />
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
                <option value="pollinations">Pollinations (무료·키 불필요)</option>
                <option value="cloudflare-workers-ai">Cloudflare Workers AI</option>
                <option value="openai">OpenAI</option>
                <option value="puter">Puter (무료·브라우저 SDK)</option>
              </select>
            </div>
            <div className="field">
              <label>이미지 생성 우선순위 (폴백 순서 — 위부터 시도, 실패 시 다음 공급자)</label>
              {scProviderOrder.map((p, i) => (
                <div key={p} style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" }}>
                  <span style={{ minWidth: "160px" }}>{i + 1}. {p === "pollinations" ? "Pollinations (무료)" : p === "cloudflare-workers-ai" ? "Cloudflare Workers AI" : "OpenAI"}</span>
                  <button type="button" onClick={() => moveProviderOrder(i, -1)} disabled={busy || i === 0}>▲</button>
                  <button type="button" onClick={() => moveProviderOrder(i, 1)} disabled={busy || i === scProviderOrder.length - 1}>▼</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                <button type="button" onClick={() => setScProviderOrder([...FREE_FIRST_ORDER])} disabled={busy}>무료 우선으로 초기화</button>
              </div>
              <div className="detail">기본값: 무료 우선 = Pollinations → Cloudflare → OpenAI (키 없는 공급자는 자동 건너뜀)</div>
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
            <div className="field">
              <label htmlFor="scPrompt">프롬프트 (모든 AI 공급자 공통)</label>
              <textarea
                id="scPrompt"
                value={scPrompt}
                onChange={(e) => setScPrompt(e.target.value)}
                placeholder="예: aurora over icy mountains, ultra detailed"
              />
            </div>
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
        <span className={`msg ${statusKind === "error" ? "error" : statusKind === "ok" ? "ok" : ""}`}>
          {busy ? "처리 중..." : statusMsg}
        </span>
      </footer>
    </div>
  );
}

export default App;
