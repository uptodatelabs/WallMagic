/**
 * 히스토리 전용 창 — 프롬프트·검색어 이력을 **넓은 리스트**로 관리한다.
 *
 * 배경(사용자 지적): 히스토리가 메인 화면의 300px 좌측 패널 안에 중첩되어
 * 폭이 부족해 레이아웃이 깨졌다. 히스토리는 별도 창(라벨 `history`)에서 보여주고,
 * 메인 창에는 [히스토리 창 열기] 버튼만 둔다.
 *
 * 요구 충족:
 *  - 생성 일시를 항목마다 표시(`formatCreatedAt` — 창 안에서 초 단위 `at` → 로컬 시각)
 *  - 최신순 정렬(`sortNewestFirst`; 백엔드도 최신순으로 반환하지만 창에서도 보정)
 *  - 개별 삭제(`delete_history_entry`) / 전체 삭제(`clear_history`)
 *  - 메인 창 재사용(`history://reuse` 이벤트 → 메인 창 입력란 복원)
 *
 * 신규 문자열은 전부 `i18n.ts` 사전을 거친다(ko/en).
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { loadLang, setActiveLang, t, type Lang } from "./i18n";

/** `get_history` 응답 1건 — 메인 창의 `HistoryEntry` 와 같은 스키마. */
export interface HistoryEntry {
  kind: "prompt" | "search";
  text: string;
  provider?: string | null;
  model?: string | null;
  at: number;
}

/** 오류를 한 줄로 만든다 — 이 창은 App.tsx 의 formatErr 에 의존하지 않는다(별도 화면). */
export function formatHistoryError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 최신순 정렬(순수) — `at` 내림차순, 같으면 기존 순서 유지(stable sort). */
export function sortNewestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** 생성 일시 표시 — 로캘 비의존 고정 포맷(`YYYY-MM-DD HH:MM`). */
export function formatCreatedAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "-";
  const d = new Date(at * 1000);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function HistoryWindow() {
  const [lang] = useState<Lang>(() => loadLang());
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [okMsg, setOkMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  // 모듈 스코프 접근자에도 현재 언어를 알린다(메인 창과 같은 정책).
  useEffect(() => {
    setActiveLang(lang);
  }, [lang]);

  const load = useCallback(async () => {
    setErrMsg("");
    try {
      const list = await invoke<HistoryEntry[]>("get_history");
      setEntries(sortNewestFirst(list));
    } catch (err) {
      setErrMsg(t(lang, "history.loadFailed", { err: formatHistoryError(err) }));
    }
  }, [lang]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 개별 삭제 — 성공하면 백엔드가 돌려준 최신 목록으로 교체한다(즉시 반영). */
  const handleDelete = async (entry: HistoryEntry) => {
    setBusy(true);
    setOkMsg("");
    setErrMsg("");
    try {
      const list = await invoke<HistoryEntry[]>("delete_history_entry", {
        kind: entry.kind,
        text: entry.text,
      });
      setEntries(sortNewestFirst(list));
      setOkMsg(t(lang, "history.deleted"));
    } catch (err) {
      setErrMsg(t(lang, "history.deleteFailed", { err: formatHistoryError(err) }));
    } finally {
      setBusy(false);
    }
  };

  /** 전체 삭제 — 파괴적 동작이므로 실패는 상태로 남긴다. */
  const handleClearAll = async () => {
    setBusy(true);
    setOkMsg("");
    setErrMsg("");
    try {
      const list = await invoke<HistoryEntry[]>("clear_history");
      setEntries(sortNewestFirst(list));
      setOkMsg(t(lang, "history.cleared"));
    } catch (err) {
      setErrMsg(t(lang, "history.clearFailed", { err: formatHistoryError(err) }));
    } finally {
      setBusy(false);
    }
  };

  /** 메인 창 입력란에 되살린다 — 창이 분리되어도 재사용 기능이 끊기지 않게 이벤트로 연결. */
  const handleReuse = async (entry: HistoryEntry) => {
    setOkMsg("");
    setErrMsg("");
    try {
      await emitTo("main", "history://reuse", { kind: entry.kind, text: entry.text });
      setOkMsg(t(lang, "history.sentToMain", { text: entry.text }));
    } catch (err) {
      setErrMsg(t(lang, "history.sendFailed", { err: formatHistoryError(err) }));
    }
  };

  return (
    <div className="history-window">
      <header className="history-window-header">
        <h1>{t(lang, "history.heading")}</h1>
        <span className="badge">{t(lang, "history.count", { n: entries.length })}</span>
        <span className="header-spacer" />
        <span className="detail" style={{ margin: 0 }}>
          {t(lang, "history.createdAtHint")}
        </span>
      </header>

      {errMsg ? <div className="statusbar-inline error">{errMsg}</div> : null}
      {okMsg ? <div className="statusbar-inline ok">{okMsg}</div> : null}

      <div className="history-toolbar">
        <button type="button" onClick={() => void load()} disabled={busy}>
          {t(lang, "history.refresh")}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void handleClearAll()}
          disabled={busy || entries.length === 0}
        >
          {t(lang, "history.clear")}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="empty">{t(lang, "history.empty")}</div>
      ) : (
        <ul className="history-list wide">
          {entries.map((h) => (
            <li key={`${h.kind}:${h.text}`} className="history-item wide">
              <span className={`history-kind ${h.kind}`}>
                {h.kind === "search"
                  ? t(lang, "history.search")
                  : t(lang, "history.prompt")}
              </span>
              <span className="history-text" title={h.text}>
                {h.text}
              </span>
              <span className="history-at" title={t(lang, "history.createdAt")}>
                {formatCreatedAt(h.at)}
              </span>
              <button
                type="button"
                className="history-reuse"
                disabled={busy}
                onClick={() => void handleReuse(h)}
              >
                {t(lang, "history.useInMain")}
              </button>
              <button
                type="button"
                className="danger history-delete"
                disabled={busy}
                onClick={() => void handleDelete(h)}
              >
                {t(lang, "history.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
