import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

/* ── IPC 응답 타입 (Rust 구조체 snake_case 키와 1:1 대응) ── */

export interface WallpaperCandidate {
  path: string;
  file_name: string;
  width: number;
  height: number;
  size_bytes: number;
  thumb_base64: string;
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

  useEffect(() => {
    void refreshStatus();
    void refreshMonitors();
  }, [refreshStatus, refreshMonitors]);

  const handleSearch = async () => {
    setBusy(true);
    try {
      const results = await invoke<WallpaperCandidate[]>("search_wallpapers", {
        query,
        dir: searchDir.trim() ? searchDir.trim() : null,
      });
      setCandidates(results);
      setSelected(results.length > 0 ? results[0] : null);
      reportOk(`검색 완료: ${results.length}개 후보`);
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
          >
            이전 배경으로 복원
          </button>
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
