#!/usr/bin/env node
// 검색/생성 이미지 **파일 삭제** 기능 + **생성 액션 단일화(좌측)** 계약 검증.
//
// 배경(사용자 지적):
//  1) "Puter, Cloudflare, OpenAI 공급자를 선택하면 오른쪽 부분에 생성 버튼이 생겨.
//      왼쪽, 오른쪽 두군데 있어서 일관성이 없어."
//     → 좌측 ② 생성 영역에만 생성 트리거를 두고, 우측 ⑤ 시나리오 섹션의 공급자별
//       '생성·적용' 버튼(handleGenerateAi)은 제거한다. 계약: handleGenerateAi 호출부는 1곳.
//  2) "검색/생성 이미지 파일 삭제 기능을 추가해줘."
//     → Rust 커맨드 delete_image_file(경로 검증 + 사이드카 정리 + 현재 배경 보호) +
//       결과 카드/미리보기의 [삭제] 버튼.
//
// 사용: node scripts/verify-delete-file.mjs [--git=<rev>]
//   --git 지정 시 `git show <rev>:<path>` 로 과거 소스를 검사한다(Red 재현용).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const gitArg = process.argv.find((a) => a.startsWith("--git="));
const rev = gitArg ? gitArg.slice("--git=".length) : null;
const target = (p) => (rev ? `${rev}:${p}` : p);

function read(p) {
  if (!rev) return fs.readFileSync(p, "utf8");
  return execFileSync("git", ["show", `${rev}:${p}`], { encoding: "utf8" });
}

let app, rs, css;
try {
  app = read("src-ui/App.tsx");
  rs = read("src-tauri/src/lib.rs");
  css = read("src-ui/styles.css");
} catch (e) {
  console.error(`소스 읽기 실패: ${e.message}`);
  process.exit(1);
}
console.log(`검사 대상: ${rev ? `${rev}:` : ""}{src-ui/App.tsx, src-tauri/src/lib.rs, src-ui/styles.css}`);

const results = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    ok = Boolean(fn());
  } catch (e) {
    detail = e.message;
  }
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ─────────────────────────────────────────────────────────────
// 1. Rust: delete_image_file 커맨드
// ─────────────────────────────────────────────────────────────
check("lib.rs 에 #[tauri::command] fn delete_image_file 이 있다", () =>
  /#\[tauri::command\]\s*\n\s*fn delete_image_file\s*\(/.test(rs));

check("delete_image_file 이 generate_handler! 에 등록되어 있다", () => {
  const m = /generate_handler!\[([\s\S]*?)\]/.exec(rs);
  return Boolean(m) && /(^|\s)delete_image_file\s*,/.test(m[1]);
});

check("삭제는 허용 루트(app_data_dir/Pictures) 안에서만 수행한다", () =>
  /fn allowed_delete_roots\(\)/.test(rs) &&
  /app_data_dir\(\)/.test(rs) &&
  /Pictures/.test(rs) &&
  /fn delete_within_roots\(/.test(rs) &&
  /starts_with\(/.test(rs));

check("허용 루트 밖 경로는 명시적 오류로 거부한다", () =>
  /삭제할 수 없습니다/.test(rs) || /is not allowed|outside/.test(rs));

check("삭제 시 생성 정보 사이드카(.geninfo.json)도 함께 정리한다", () =>
  /generation_sidecar_path\(/.test(rs) && /remove_file\(&sidecar\)/.test(rs));

check("현재 바탕화면으로 적용된 파일 삭제는 거부한다(배경 보호)", () =>
  /get_current_wallpaper\(None\)/.test(rs) && /현재 바탕화면/.test(rs));

check("삭제 로직에 단위 테스트가 있다(사이드카 정리 + 루트 밖 거부)", () => {
  const m = /#\[cfg\(test\)\]\s*\nmod delete_tests\s*\{([\s\S]*?)\n\}/.exec(rs);
  return Boolean(m) && /#\[test\]/.test(m[1]) && /delete_within_roots/.test(m[1]);
});

// ─────────────────────────────────────────────────────────────
// 2. UI: 삭제 버튼 (결과 카드 + 미리보기) + 핸들러
// ─────────────────────────────────────────────────────────────
// 인자 객체의 표기는 두 가지다 — `{ path: p }`(명시) 와 `{ path }`(단축 속성).
// 이전 검사식은 콜론 표기만 인정해, 정상 동작하는 단축 표기 호출을 FAIL 로 오판했다
// (실측: `invoke("delete_image_file", { path })` — tsc/build 통과, 삭제 동작 정상).
// 계약의 본질은 "path 키로 경로를 넘긴다"이므로 두 표기를 모두 인정한다.
check("UI 가 delete_image_file 을 path 인자로 호출한다", () =>
  /invoke(?:<[^>]*>)?\(\s*["']delete_image_file["']\s*,\s*\{\s*path\s*[,:}]/.test(app));

check("handleDelete 핸들러가 후보 목록에서 삭제한 항목을 제거한다", () => {
  const i = app.indexOf("const handleDelete");
  if (i < 0) return false;
  const body = app.slice(i, i + 1600);
  return /filter\(\(c\) => c\.path !== /.test(body) && /setCandidates\(/.test(body);
});

check("결과 카드에 파일 삭제 버튼이 있다(카드 선택 클릭과 분리)", () => {
  const i = app.indexOf('className={`card');
  if (i < 0) return false;
  const body = app.slice(i, i + 1800);
  return /card-delete/.test(body) && /stopPropagation\(\)/.test(body) && /handleDelete\(/.test(body);
});

check("미리보기 패널에 선택 파일 삭제 버튼이 있다", () =>
  /id="previewDelete"/.test(app) && /handleDelete\(selected\)/.test(app));

check("삭제 버튼은 busy 상태에서 비활성화된다", () =>
  /card-delete[\s\S]{0,300}disabled=\{busy\}/.test(app) ||
  /disabled=\{busy\}[\s\S]{0,300}card-delete/.test(app));

check("styles.css 에 위험 액션 버튼 스타일(button.danger)이 있다", () =>
  /button\.danger\s*\{/.test(css));

// ─────────────────────────────────────────────────────────────
// 3. 생성 액션 단일화: 좌측 ② 생성 영역 1곳
// ─────────────────────────────────────────────────────────────
check("handleGenerateAi 호출부는 좌측 1곳뿐이다(우측 공급자별 생성 버튼 제거)", () => {
  const hits = app.match(/void handleGenerateAi\(\)/g) ?? [];
  return hits.length === 1;
});

check("좌측 생성 영역에 '생성 후 적용' 버튼이 있다", () =>
  /onClick=\{\(\) => void handleGenerateAi\(\)\}[\s\S]{0,200}생성 후 적용/.test(app));

check("우측 시나리오 섹션에 공급자별 '생성·적용' 버튼 라벨이 남아 있지 않다", () =>
  !/Cloudflare AI로 생성·적용/.test(app) &&
  !/OpenAI로 생성·적용/.test(app) &&
  !/Puter로 생성·적용/.test(app));

check("우측 공급자 설정 블록은 유지된다(자격증명·모델 입력)", () =>
  /id="scCfToken"/.test(app) && /id="scOpenaiKey"/.test(app) && /id="scPuterModel"/.test(app));

const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `\n${results.length}항목 전부 ok — 파일 삭제 + 생성 액션 단일화 계약 통과`
    : `\n${failed} FAIL / ${results.length - failed} ok — 계약 미충족`,
);
process.exit(failed === 0 ? 0 : 1);
