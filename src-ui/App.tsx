import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WallpaperState {
  previous_wallpaper: string | null;
  current_wallpaper: string | null;
  backend_used: string | null;
}

export type WallpaperPosition =
  | "center"
  | "tile"
  | "stretch"
  | "fit"
  | "fill"
  | "span";

export function App(): React.ReactElement {
  const [currentWallpaper, setCurrentWallpaper] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("Cyberpunk rainy neon street in Seoul");
  const [customPath, setCustomPath] = useState<string>("");
  const [position, setPosition] = useState<WallpaperPosition>("fill");
  const [statusMsg, setStatusMsg] = useState<string>("Ready");
  const [backendUsed, setBackendUsed] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const refreshCurrentWallpaper = useCallback(async () => {
    try {
      const path = await invoke<string>("get_current_wallpaper", {
        monitorId: null,
      });
      setCurrentWallpaper(path);
    } catch (err) {
      setStatusMsg(`조회 실패: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refreshCurrentWallpaper();
  }, [refreshCurrentWallpaper]);

  const handleSetWallpaper = async () => {
    if (!customPath.trim()) {
      setStatusMsg("배경화면 파일 경로를 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("set_wallpaper", {
        path: customPath.trim(),
        monitorId: null,
        position,
      });
      setCurrentWallpaper(state.current_wallpaper ?? "");
      setBackendUsed(state.backend_used ?? "");
      setStatusMsg("배경화면이 성공적으로 적용되었습니다.");
    } catch (err) {
      setStatusMsg(`적용 실패: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateAndApply = async () => {
    if (!prompt.trim()) {
      setStatusMsg("프롬프트를 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("generate_and_apply_wallpaper", {
        prompt: prompt.trim(),
        monitorId: null,
        position,
      });
      setCurrentWallpaper(state.current_wallpaper ?? "");
      setBackendUsed(state.backend_used ?? "");
      setStatusMsg("프롬프트 기반 배경화면 생성 및 적용 완료.");
    } catch (err) {
      setStatusMsg(`생성 실패: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreWallpaper = async () => {
    setBusy(true);
    try {
      const state = await invoke<WallpaperState>("restore_wallpaper", {
        monitorId: null,
      });
      setCurrentWallpaper(state.current_wallpaper ?? "");
      setBackendUsed(state.backend_used ?? "");
      setStatusMsg("이전 배경화면으로 복원되었습니다.");
    } catch (err) {
      setStatusMsg(`복원 실패: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "24px", maxWidth: "720px", margin: "0 auto" }}>
      <h1>WallMagic — M1 Win32 Core Engine</h1>
      <p>
        현재 적용된 배경화면: <code>{currentWallpaper || "(없음)"}</code>
      </p>
      {backendUsed && (
        <p>
          적용 백엔드: <strong>{backendUsed}</strong>
        </p>
      )}

      <section style={{ marginTop: "20px", padding: "16px", border: "1px solid #ccc", borderRadius: "8px" }}>
        <h2>1. 프롬프트 기반 샘플 배경 생성 및 즉시 적용</h2>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="테마 또는 프롬프트 입력"
            style={{ flex: 1, padding: "8px" }}
          />
          <button type="button" onClick={() => void handleGenerateAndApply()} disabled={busy}>
            생성 및 적용
          </button>
        </div>
      </section>

      <section style={{ marginTop: "20px", padding: "16px", border: "1px solid #ccc", borderRadius: "8px" }}>
        <h2>2. 로컬 이미지 경로 직접 지정 (`set_wallpaper`)</h2>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <input
            type="text"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="C:\path\to\wallpaper.jpg"
            style={{ flex: 1, padding: "8px" }}
          />
          <select
            value={position}
            onChange={(e) => setPosition(e.target.value as WallpaperPosition)}
          >
            <option value="fill">Fill (채우기)</option>
            <option value="fit">Fit (맞춤)</option>
            <option value="stretch">Stretch (늘이기)</option>
            <option value="tile">Tile (바둑판식)</option>
            <option value="center">Center (가운데)</option>
            <option value="span">Span (스팬)</option>
          </select>
          <button type="button" onClick={() => void handleSetWallpaper()} disabled={busy}>
            배경 적용
          </button>
        </div>
      </section>

      <section style={{ marginTop: "20px", display: "flex", gap: "12px", alignItems: "center" }}>
        <button type="button" onClick={() => void handleRestoreWallpaper()} disabled={busy}>
          이전 배경으로 원복 (`restore_wallpaper`)
        </button>
        <button type="button" onClick={() => void refreshCurrentWallpaper()} disabled={busy}>
          현재 배경 새로고침 (`get_current_wallpaper`)
        </button>
      </section>

      <footer style={{ marginTop: "24px", color: "#444" }}>
        상태: {statusMsg}
      </footer>
    </main>
  );
}

export default App;
