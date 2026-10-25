#!/usr/bin/env node
/**
 * verify-preview-viewer.mjs — ③ 미리보기 전체화면 뷰어 + 생성 정보 귀속 계약 검증
 *
 * 검증 대상(관측 가능한 계약):
 *  A. 미리보기 전체화면: 버튼(id="previewFullscreen") · 오버레이(id="fullscreenViewer")
 *     · role="dialog"/aria-modal · Esc 닫기 · 닫기 버튼(id="viewerClose") · 썸네일 클릭 열기
 *     · styles.css 의 .viewer 고정 오버레이(position: fixed; inset: 0)
 *  B. 생성 정보 귀속: gen-info 가 "현재 배경(current_wallpaper)" 기준임을 명시하고,
 *     미리보기 이미지(selected)가 현재 배경과 다른 파일이면 그 사실을 안내한다
 *     → 무료 공급자로 만든 이미지를 보면서 "Puter" 라벨을 보는 오귀속을 막는다.
 *  C. 백엔드 기록 경로: 우선순위 생성은 실제 사용 공급자(used)로 기록한다.
 *
 * 정적 문자열 검사 스크립트다(런타임 렌더·클릭은 미검증).
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const APP = "src-ui/App.tsx";
const CSS = "src-ui/styles.css";
const LIB = "src-tauri/src/lib.rs";

/// `--git=<rev>` 를 주면 해당 커밋의 **실제 소스**를 검사한다(작업본 대신).
/// 회귀(Red) 증빙을 메모리 재구성 없이 실제 이력으로 확보하기 위한 모드다.
/// 사용: node scripts/verify-preview-viewer.mjs --git=0968877
const gitArg = process.argv.find((a) => a.startsWith("--git="));
const rev = gitArg ? gitArg.slice("--git=".length) : null;
const read = (path) =>
  rev
    ? execSync(`git show ${rev}:${path}`, { encoding: "utf8" })
    : readFileSync(path, "utf8");

const app = read(APP);
const css = read(CSS);
const lib = read(LIB);
if (rev) console.log(`검사 대상: ${rev} 커밋의 실제 소스 (작업본 아님)`);

const results = [];
const check = (name, fn) => {
  let ok = false;
  let err = null;
  try {
    ok = !!fn();
  } catch (e) {
    err = String(e);
  }
  results.push({ name, ok, err });
};

/* ── A. 전체화면 뷰어 ─────────────────────────────────────────── */
check('③ 미리보기에 전체화면 버튼(id="previewFullscreen")이 있다', () =>
  /id="previewFullscreen"/.test(app) && /전체화면/.test(app),
);

check('전체화면 뷰어 오버레이(id="fullscreenViewer")가 viewerOpen 상태로 조건부 렌더된다', () =>
  /viewerOpen && selected/.test(app) && /id="fullscreenViewer"/.test(app),
);

check('뷰어가 role="dialog" + aria-modal 로 접근성 계약을 지킨다', () =>
  /role="dialog"/.test(app) && /aria-modal="true"/.test(app),
);

check('썸네일 클릭으로 뷰어를 연다 (setViewerOpen(true))', () =>
  /setViewerOpen\(true\)/.test(app) && /onClick=\{\(\) => setViewerOpen\(true\)\}/.test(app),
);

check('Esc 키로 뷰어를 닫는다 (keydown + Escape → setViewerOpen(false))', () =>
  /addEventListener\("keydown"/.test(app) && /e\.key === "Escape"/.test(app) &&
  /setViewerOpen\(false\)/.test(app),
);

check('닫기 버튼(id="viewerClose")이 있다', () => /id="viewerClose"/.test(app));

check("styles.css 의 .viewer 가 고정 전체화면 오버레이이다", () =>
  /\.viewer\s*\{[^}]*position:\s*fixed/.test(css) && /\.viewer\s*\{[^}]*inset:\s*0/.test(css),
);

check(".preview 가 position: relative (전체화면 버튼 배치 기준)", () =>
  /\.preview\s*\{[^}]*position:\s*relative/.test(css),
);

// 교차 검사: JSX 가 쓰는 클래스명이 styles.css 에 실제로 존재해야 한다.
// (className="preview-fullscreen" 인데 CSS 에는 .preview-fs 만 있던 불일치 회귀 방지)
check("전체화면 버튼 className 이 styles.css 에 정의되어 있다", () => {
  const m = app.match(/id="previewFullscreen"[^>]*className="([^"]+)"/) ||
            app.match(/className="([^"]+)"[^>]*id="previewFullscreen"/);
  if (!m) return false;
  const cls = m[1].trim().split(/\s+/).join("\\.");
  return new RegExp(`\\.${cls}`).test(css);
});

check("styles.css 에 .viewer-body 래퍼 규칙(최대 크기 + 중앙 정렬)이 있다", () =>
  /\.viewer-body\s*\{[^}]*max-height:\s*100%/.test(css) &&
  /\.viewer-body\s*\{[^}]*display:\s*flex/.test(css) &&
  /\.viewer-body\s*\{[^}]*justify-content:\s*center/.test(css),
);

/* ── B. 생성 정보 귀속(현재 배경 기준) ────────────────────────── */
check('생성 정보 라벨이 "현재 배경" 기준임을 명시한다', () =>
  /생성 정보 \(현재 배경\)/.test(app),
);

check('gen-info 가 현재 배경 파일 경로(current_wallpaper)를 함께 표시한다', () =>
  /status\?\.current_wallpaper/.test(app),
);

check('미리보기 이미지와 현재 배경이 다르면 안내 문구를 표시한다', () =>
  /현재 배경과 다른 파일/.test(app) && /selected\.file_name/.test(app),
);

check('gen-info 가 selected.path 와 current_wallpaper 를 비교해 판별한다', () =>
  /selected\?\.path/.test(app) && /genPath/.test(app) && /selPath/.test(app),
);

/* ── C. 백엔드 기록 경로(실제 사용 공급자) ─────────────────────── */
check('우선순위 생성은 실제 사용 공급자(used)로 생성 정보를 기록한다', () =>
  /generation_source_detail\(&settings, used\)/.test(lib),
);

check('Puter 적용은 label 을 provider 로 기록한다(apply_generated_image → set_wallpaper_with)', () =>
  /set_wallpaper_with\(&path, monitor_id, pos, Some\(label\), Some\(&detail\)\)/.test(lib),
);

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`ok   ${r.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${r.name}${r.err ? ` — ${r.err}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `${results.length}항목 전부 ok — 미리보기 전체화면·생성 정보 귀속 계약 통과`
    : `${failed} FAIL — 미리보기 전체화면·생성 정보 귀속 계약 미충족 (${results.length - failed} ok)`,
);
process.exit(failed === 0 ? 0 : 1);
