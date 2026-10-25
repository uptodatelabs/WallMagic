#!/usr/bin/env node
/**
 * verify-applied-sync.mjs — 적용 후 미리보기 동기화 계약 검증
 *
 * 배경(증상): "현재 배경과 다른 파일 — 위 미리보기의 생성 정보가 아닙니다" 경고가
 * 적용 성공 후에도 계속 떴다. 원인은 두 가지였다.
 *
 *  A. 백엔드 `validate_and_stage_image` 가 원본을 BMP로 재인코딩해
 *     `active/active_<원본 stem>_<monitor>.bmp` 로 스테이징하므로,
 *     적용 결과 경로(current_wallpaper)와 미리보기 후보 경로(selected.path)는
 *     **문자열이 절대 같을 수 없다**. 경로 동등 비교만으로는 항상 불일치 경고가 뜬다.
 *  B. 적용 후 selected 를 갱신하지 않아, 미리보기가 생성 전 후보에 그대로 남는다.
 *
 * 이 스크립트는 그 해소책이 실제로 배선되어 있는지를 검사한다(정적 검사).
 *  - 스테이징 규칙 기반 귀속 판정(sameWallpaperSource): 스테이징 파일끼리는 동일로 판정
 *  - 적용 결과 → 후보 변환 커맨드(candidate_for_path)가 백엔드에 존재·등록
 *  - 코어가 load_candidate 를 공개·재export 하는가
 *  - 모든 적용 경로(Puter/OpenAI/Cloudflare/수동 적용/우선순위/시나리오)에서
 *    syncSelectedToApplied 를 호출하는가
 *
 * 사용:
 *   node scripts/verify-applied-sync.mjs            # 작업본 검사
 *   node scripts/verify-applied-sync.mjs --git=HEAD # 실제 커밋 이력 검사(Red 증빙)
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const APP = "src-ui/App.tsx";
const LIB = "src-tauri/src/lib.rs";
const CORE = "crates/core/src/lib.rs";
const SEARCH = "crates/core/src/search.rs";
const CSS = "src-ui/styles.css";

const gitArg = process.argv.find((a) => a.startsWith("--git="));
const rev = gitArg ? gitArg.slice("--git=".length) : null;
const read = (path) =>
  rev ? execSync(`git show ${rev}:${path}`, { encoding: "utf8" }) : readFileSync(path, "utf8");

const app = read(APP);
const lib = read(LIB);
const core = read(CORE);
const search = read(SEARCH);
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

/* ── A. 스테이징 규칙 기반 귀속 판정 ─────────────────────────────── */
check("같은 파일(스테이징 파일끼리)은 동일 소스로 판정한다 (경고 오탐 방지)", () => {
  // sameWallpaperSource 본문에서 동일 stem 단락(short-circuit)이 있어야 한다.
  // 없으면 active_X.bmp vs active_X.bmp 도 `active_${active_X}` 비교로 false 가 된다.
  const body = app.match(/const sameWallpaperSource =[\s\S]*?\n {2}\};/);
  if (!body) return false;
  return /activeStem === srcStem/.test(body[0]);
});

check("스테이징 규칙(active_<stem>_<monitor>)으로 귀속을 판정한다", () => {
  const body = app.match(/const sameWallpaperSource =[\s\S]*?\n {2}\};/);
  if (!body) return false;
  return /active_\$\{srcStem\}_/.test(body[0]);
});

/* ── B. 적용 결과 → 후보 변환 커맨드 ─────────────────────────────── */
check("백엔드에 candidate_for_path 커맨드가 있다", () =>
  /fn candidate_for_path\(/.test(lib) && /candidate_for_path_impl\(/.test(lib),
);

check("candidate_for_path 가 generate_handler 에 등록되어 있다", () => {
  const m = lib.match(/generate_handler!\[([\s\S]*?)\]\)/);
  return !!m && /\bcandidate_for_path\b/.test(m[1]);
});

check("candidate_for_path 는 빈 경로·없는 파일을 명시적 오류로 반환한다", () =>
  /candidate_for_path: path 가 필요합니다/.test(lib) && /candidate_for_path: 파일이 없습니다/.test(lib),
);

check("코어가 load_candidate 를 공개한다 (search.rs)", () =>
  /pub fn load_candidate\(/.test(search),
);

check("코어가 load_candidate 를 재export 한다 (core/lib.rs)", () => {
  const m = core.match(/pub use search::\{([\s\S]*?)\};/);
  return !!m && /\bload_candidate\b/.test(m[1]);
});

/* ── C. 프론트 동기화 배선 ───────────────────────────────────────── */
check("프론트가 적용 결과를 후보로 변환해 selected 를 교체한다", () =>
  /syncSelectedToApplied/.test(app) && /invoke<WallpaperCandidate>\("candidate_for_path"/.test(app),
);

check("동기화 실패를 무음 처리하지 않는다 (console.warn)", () => {
  const body = app.match(/const syncSelectedToApplied =[\s\S]*?\n {2}\};/);
  return !!body && /console\.warn/.test(body[0]);
});

const callSites = [
  ["Puter 생성", /reportOk\(`Puter 생성·적용 완료/],
  ["OpenAI 생성", /reportOk\(`OpenAI 생성·적용 완료/],
  ["Cloudflare 생성", /reportOk\(`Cloudflare AI 생성·적용 완료/],
  ["수동 적용", /reportOk\(`적용 완료 — 백엔드/],
  ["우선순위 생성", /우선순위 생성·적용 완료/],
  ["시나리오 적용", /reportOk\(`시나리오 적용 — 백엔드/],
];
for (const [label, re] of callSites) {
  check(`${label} 경로가 적용 후 미리보기를 동기화한다`, () => {
    const m = app.match(re);
    if (!m) return false;
    // 해당 reportOk 앞 400자 안에 syncSelectedToApplied 호출이 있어야 한다.
    const start = Math.max(0, m.index - 400);
    const window = app.slice(start, m.index);
    return /syncSelectedToApplied\(/.test(window);
  });
}

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
    ? `${results.length}항목 전부 ok — 적용 후 미리보기 동기화 계약 통과`
    : `${failed} FAIL — 적용 후 미리보기 동기화 계약 미충족 (${results.length - failed} ok)`,
);
process.exit(failed === 0 ? 0 : 1);
