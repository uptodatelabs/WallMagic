import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { HistoryWindow } from "./HistoryWindow";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found in index.html");
}

/**
 * 같은 `index.html` 을 두 창이 공유한다 — 어느 화면을 그릴지는 **창 라벨**로 결정한다.
 *
 * 히스토리는 메인 좌측 패널(300px)에 중첩되어 폭이 부족해 UI 가 깨졌다(사용자 지적).
 * 백엔드 `open_history_window` 가 라벨 `history` 로 창을 만들고, 이 파일이 그 라벨을 보고
 * `HistoryWindow` 를 렌더한다. 쿼리스트링(`?view=`)을 쓰지 않는 이유: Tauri 의
 * `WebviewUrl::App(PathBuf)` 는 경로를 자산 경로로 해석하므로 쿼리가 붙으면 자산을 못 찾는다.
 */
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // 브라우저(vite 단독 실행)에는 Tauri 런타임이 없다 — 메인 화면으로 폴백한다.
    return "main";
  }
}

const isHistoryWindow = currentWindowLabel() === "history";

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    {isHistoryWindow ? <HistoryWindow /> : <App />}
  </React.StrictMode>
);
