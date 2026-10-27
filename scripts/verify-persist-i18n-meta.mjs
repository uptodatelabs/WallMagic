#!/usr/bin/env node
// 요구 ①~⑤(영속성·히스토리·미리보기 fit·버전/제작자·다국어) 계약 검증.
//
// 배경(사용자 요구):
//   ① 프롬프트·검색 히스토리를 남기고 선택할 수 있게
//   ② 프로그램을 껐다 켜면 기존에 생성했던 이미지가 안 보임
//   ③ 미리보기에 창맞춤(fit) 기능
//   ④ 프로그램 버전(1.0)과 제작자(uptodatelabs) 관리
//   ⑤ 한국어 / 영어 동시 지원(다국어 완벽 추가)
//
// 이 스크립트는 **정적 계약 + 순수 모듈 직접 실행**을 함께 수행한다:
//  - i18n 사전은 `t()` 를 실제로 import 해 실행한다(문자열 검사만으로는 폴백·치환을 증명 못함).
//  - 히스토리/인덱스는 core store.rs 의 순수 함수 계약(중복 제거·상한·prune)을 소스로 고정하고,
//    Rust 단위 테스트(`store::tests`)가 실행 검증을 담당한다.
//
// 사용: node scripts/verify-persist-i18n-meta.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const results = [];
const check = (name, fn) => {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === "object" && r.detail) detail = r.detail;
  } catch (e) {
    detail = e && e.message ? e.message : String(e);
  }
  results.push({ name, ok });
  console.log((ok ? "ok  " : "FAIL") + " " + name + (detail ? " — " + detail : ""));
};

const store = read("crates/core/src/store.rs");
const coreLib = read("crates/core/src/lib.rs");
const appLib = read("src-tauri/src/lib.rs");
const ui = read("src-ui/App.tsx");
// 히스토리는 메인 패널에서 **전용 창**(HistoryWindow.tsx)으로 분리됐다 — 삭제·일시 표시·
// 개별 삭제는 그 창이 담당하므로, 계약 검사도 두 파일을 함께 본다(App.tsx 만 보면
// "전체 삭제 경로가 없다"고 오판한다 — 실측).
const historyWin = read("src-ui/HistoryWindow.tsx");
const uiAndHistory = ui + "\n" + historyWin;
const i18n = read("src-ui/i18n.ts");
const wsCargo = read("Cargo.toml");
const tauriConf = read("src-tauri/tauri.conf.json");
const pkg = JSON.parse(read("package.json"));

// ─────────────────────────────────────────────────────────────
// ① 프롬프트/검색 히스토리 — 디스크 영속 + 선택(재사용)
// ─────────────────────────────────────────────────────────────
check("core store 모듈이 공개된다(pub mod store)", () => /pub mod store;/.test(coreLib));
check("히스토리 파일 경로는 app_data_dir()/history.json", () =>
  /history_file_path\(\)[\s\S]{0,120}app_data_dir\(\)\.join\("history\.json"\)/.test(store));
check("히스토리 저장은 원자적(임시 파일 → rename)", () =>
  /fn write_atomic\(/.test(store) &&
  /with_extension\("json\.tmp"\)/.test(store) &&
  /rename\(&tmp, path\)/.test(store));
check("히스토리 종류는 prompt/search 로 분리된다", () =>
  /enum HistoryKind/.test(store) && /Prompt,/.test(store) && /Search,/.test(store));

// 중복 판정은 "이동 전에 보관한 키"로 비교한다 — text 를 entry 로 이동시킨 뒤 비교하면
// Rust 에서 E0382(borrow of moved value) 컴파일 오류가 나서 실제로 빌드가 깨졌다.
// 계약은 "같은 종류 + 같은 텍스트는 중복 저장하지 않고 맨 앞으로 이동"이다.
check("같은 텍스트는 중복 저장하지 않고 맨 앞으로 이동", () => {
  const body = (() => {
    const i = store.indexOf("pub fn push_history");
    if (i < 0) return "";
    return store.slice(i, i + 900);
  })();
  return (
    /pub fn push_history\(/.test(store) &&
    /let dedupe_key = text\.clone\(\);/.test(body) &&
    /e\.kind == kind && e\.text\.trim\(\) == dedupe_key/.test(body)
  );
});
check("히스토리 상한(HISTORY_CAP)으로 무한 증가를 막는다", () =>
  /pub const HISTORY_CAP:\s*usize\s*=\s*50/.test(store) &&
  /truncate\(cap\.max\(1\)\)/.test(store));
check("빈 텍스트는 히스토리에 저장하지 않는다", () =>
  /if text\.is_empty\(\)\s*\{\s*return entries\.to_vec\(\)/.test(store));
check("store 단위 테스트가 있다(중복·종류분리·상한·prune)", () => {
  // 파일 끝 개행 유무에 의존하지 않도록 `mod tests {` 이후 전체를 본다.
  const i = store.indexOf("mod tests {");
  if (i < 0) return false;
  const body = store.slice(i);
  return (
    /test_push_history_moves_duplicate_to_front/.test(body) &&
    /test_push_history_keeps_kinds_separate/.test(body) &&
    /test_push_history_ignores_blank_and_caps/.test(body) &&
    /test_prune_missing_drops_vanished_files/.test(body)
  );
});

check("IPC: get_history / record_history_entry / clear_history 가 등록된다", () => {
  const m = /generate_handler!\[([\s\S]*?)\]/.exec(appLib);
  if (!m) return false;
  return (
    /(^|\s)get_history\s*,/.test(m[1]) &&
    /(^|\s)record_history_entry\s*,/.test(m[1]) &&
    /(^|\s)clear_history\s*,/.test(m[1])
  );
});
check("record_history_entry 는 알 수 없는 kind 를 조용히 프롬프트로 바꾸지 않는다", () =>
  /unknown kind/.test(appLib));
check("UI 가 시작 시 히스토리를 조회해 복원한다", () =>
  /invoke<HistoryEntry\[\]>\("get_history"\)/.test(ui) && /setHistory\(list\)/.test(ui));
check(
  "UI 가 생성/검색 시 히스토리를 기록한다",
  () => /noteHistory\("prompt"/.test(ui) && /noteHistory\("search"/.test(ui),
);
check("히스토리 항목을 눌러 입력란에 되살릴 수 있다(재사용)", () =>
  /setPrompt\(h\.text\)/.test(ui) && /setQuery\(h\.text\)/.test(ui));
// 히스토리 목록·삭제는 메인 패널에서 **전용 창**(`HistoryWindow.tsx`)으로 분리됐다.
// App.tsx 만 검사하면 "전체 삭제 경로 없음"으로 오판한다(실측: 이동 후 FAIL).
check("히스토리 전체 삭제 경로가 있다", () =>
  /invoke<HistoryEntry\[\]>\("clear_history"\)/.test(historyWin));
check("히스토리 개별 삭제 경로가 있다(창)", () =>
  /invoke<HistoryEntry\[\]>\("delete_history_entry"/.test(historyWin) &&
  /kind: entry\.kind/.test(historyWin) &&
  /text: entry\.text/.test(historyWin));
check("히스토리 창은 생성 일시를 표시한다", () =>
  /formatCreatedAt\(h\.at\)/.test(historyWin) && /history\.createdAt/.test(i18n));
check("히스토리 창은 최신순 정렬을 보장한다(창·백엔드 양쪽)", () =>
  /sortNewestFirst\(list\)/.test(historyWin) &&
  /sort_history_newest_first/.test(store) &&
  /delete_history\(/.test(store));
check("메인 창은 히스토리 창 열기 버튼만 둔다(중첩 리스트 제거)", () => {
  const i = ui.indexOf('id="history-section"');
  if (i < 0) return false;
  const body = ui.slice(i, i + 900);
  return (
    /handleOpenHistoryWindow/.test(body) &&
    !/history-item/.test(body) &&
    !/history-list/.test(body)
  );
});
check("IPC open_history_window 가 등록되고 UI 가 호출한다", () => {
  const m = /generate_handler!\[([\s\S]*?)\]/.exec(appLib);
  return (
    Boolean(m) &&
    /(^|\s)open_history_window\s*,/.test(m[1]) &&
    /invoke\("open_history_window"\)/.test(ui) &&
    /get_webview_window\("history"\)/.test(appLib)
  );
});
check("히스토리 창 라벨이 main.tsx 라우팅과 일치한다", () => {
  const mainTsx = read("src-ui/main.tsx");
  return (
    /getCurrentWindow\(\)\.label/.test(mainTsx) &&
    /=== "history"/.test(mainTsx) &&
    /<HistoryWindow \/>/.test(mainTsx)
  );
});
check("히스토리 창 라벨이 capabilities 에 허용된다", () => {
  const caps = JSON.parse(read("src-tauri/capabilities/default.json"));
  return Array.isArray(caps.windows) && caps.windows.includes("main") && caps.windows.includes("history");
});
check("메인 창은 history://reuse 이벤트로 입력란을 복원한다", () =>
  /listen<\{ kind: "prompt" \| "search"; text: string \}>/.test(ui) &&
  /"history:\/\/reuse"/.test(ui) &&
  /setQuery\(h\.text\)/.test(ui) &&
  /setPrompt\(h\.text\)/.test(ui));
check("히스토리 창은 메인에 이벤트를 보낸다(emitTo main)", () =>
  /emitTo\("main", "history:\/\/reuse"/.test(historyWin));

// ─────────────────────────────────────────────────────────────
// ② 재시동 후 생성 이미지 목록 복원
// ─────────────────────────────────────────────────────────────
check("생성 이미지 인덱스 파일은 app_data_dir()/library_index.json", () =>
  /library_index_file_path\(\)[\s\S]{0,120}app_data_dir\(\)\.join\("library_index\.json"\)/.test(
    store,
  ));
check("인덱스 기록은 경로 중복을 대소문자 무시로 제거한다", () =>
  /pub fn push_library\(/.test(store) && /to_lowercase\(\)/.test(store));
check("복원 시 디스크에 없는 항목은 제외한다(prune_missing)", () =>
  /pub fn prune_missing\(/.test(store) && /is_file\(\)/.test(store));
check("restore_library 가 정리된 목록을 반환하고 디스크에 반영한다", () =>
  /pub fn restore_library\(/.test(store) && /save_library_index\(&LibraryIndex/.test(store));
check("IPC: record_library_entry / restore_library_candidates 가 등록된다", () => {
  const m = /generate_handler!\[([\s\S]*?)\]/.exec(appLib);
  if (!m) return false;
  return (
    /(^|\s)record_library_entry\s*,/.test(m[1]) &&
    /(^|\s)restore_library_candidates\s*,/.test(m[1])
  );
});
check("복원은 인덱스 + library 디렉터리 스캔을 합친다(과거 파일 포함)", () => {
  const i = appLib.indexOf("fn restore_library_candidates_impl");
  if (i < 0) return false;
  const body = appLib.slice(i, i + 2400);
  return /store::restore_library\(\)/.test(body) && /read_dir\(&library\)/.test(body);
});
check("복원 상한(RESTORE_LIMIT)으로 IPC 페이로드를 보호한다", () =>
  /const RESTORE_LIMIT:\s*usize\s*=\s*\d+/.test(appLib));
check("UI 가 시작 시 생성 이미지 목록을 복원한다", () =>
  /invoke<WallpaperCandidate\[\]>\("restore_library_candidates"\)/.test(ui) &&
  /setCandidates\(/.test(ui));
check("UI 가 생성 후 인덱스를 기록한다(복원 근거)", () => /noteLibrary\(candidate\)/.test(ui));

// ─────────────────────────────────────────────────────────────
// ③ 미리보기 창맞춤(fit)
// ─────────────────────────────────────────────────────────────
check("previewFitStyle 순수 함수가 있다(React 비의존 export)", () =>
  /export function previewFitStyle\(mode: "fit" \| "actual" \| "fill"\)/.test(ui));
check("fit 은 object-fit: contain (창 안에 전체가 보임)", () =>
  /return \{ objectFit: "contain" \}/.test(ui));
check("actual 은 원본 크기(object-fit: none)", () => /objectFit: "none"/.test(ui));
check("fill 은 object-fit: cover", () => /objectFit: "cover"/.test(ui));
check("미리보기 이미지에 fit 스타일이 실제로 적용된다", () =>
  /style=\{previewFitStyle\(previewFit\)\}/.test(ui));
check("보기 방식 select(#previewFit)가 3택을 제공한다", () => {
  const i = ui.indexOf('id="previewFit"');
  if (i < 0) return false;
  const body = ui.slice(i, i + 900);
  return /value="fit"/.test(body) && /value="actual"/.test(body) && /value="fill"/.test(body);
});
check("fit 상태 기본값은 fit 이다", () =>
  /useState<"fit" \| "actual" \| "fill">\("fit"\)/.test(ui));

// ─────────────────────────────────────────────────────────────
// ④ 버전/제작자 — 단일 소스 + 표시
// ─────────────────────────────────────────────────────────────
check("workspace Cargo.toml 버전이 1.0.x 이다", () => /^version = "1\.0\.\d+"$/m.test(wsCargo));
check("workspace Cargo.toml 제작자가 uptodatelabs", () =>
  /^authors = \["uptodatelabs"\]$/m.test(wsCargo));
check("tauri.conf.json 버전이 Cargo 버전과 같다", () => {
  const m = /"version":\s*"([^"]+)"/.exec(tauriConf);
  const c = /^version = "([^"]+)"$/m.exec(wsCargo);
  return Boolean(m && c) && m[1] === c[1];
});
check("package.json 버전/제작자가 메타데이터와 같다", () => {
  const c = /^version = "([^"]+)"$/m.exec(wsCargo);
  const a = /^authors = \["([^"]+)"\]$/m.exec(wsCargo);
  return Boolean(c && a) && pkg.version === c[1] && pkg.author === a[1];
});
check("store::app_meta 가 Cargo 메타데이터에서 읽는다(하드코딩 금지)", () =>
  /pub fn app_meta\(\)/.test(store) &&
  /env!\("CARGO_PKG_VERSION"\)/.test(store) &&
  /env!\("CARGO_PKG_AUTHORS"\)/.test(store));
check("IPC get_app_meta 가 등록된다", () => {
  const m = /generate_handler!\[([\s\S]*?)\]/.exec(appLib);
  return Boolean(m) && /(^|\s)get_app_meta\s*,/.test(m[1]);
});
check("UI 가 버전/제작자를 화면에 표시한다(하드코딩 아님)", () =>
  /invoke<AppMeta>\("get_app_meta"\)/.test(ui) &&
  /about\.version/.test(ui) &&
  /about\.author/.test(ui) &&
  /appMeta\?\.version/.test(ui) &&
  /appMeta\?\.author/.test(ui));

// ─────────────────────────────────────────────────────────────
// ⑤ 다국어 — 사전 완전성 + 실행 검증(import)
// ─────────────────────────────────────────────────────────────
const dictKeys = [...i18n.matchAll(/^  "([A-Za-z0-9_.]+)":/gm)].map((m) => m[1]);
const dupKeys = dictKeys.filter((k, i) => dictKeys.indexOf(k) !== i);
check("사전 키가 중복 없이 정의된다 (" + dictKeys.length + "개)", () => dupKeys.length === 0);

// ko/en 두 값을 모두 채운 항목만 "완전"으로 본다. 한 줄 표기와 여러 줄 표기를 모두 인정한다
// (이전 식은 한 줄 표기만 인정해, 여러 줄로 쓴 정상 항목을 누락으로 오판했다).
check("사전의 모든 항목이 ko/en 을 둘 다 채운다", () => {
  const re = /^  "([A-Za-z0-9_.]+)":\s*\{\s*ko:\s*"((?:[^"\\]|\\.)*)"\s*,\s*en:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\}/gm;
  const filled = new Set([...i18n.matchAll(re)].map((m) => m[1]));
  const missing = dictKeys.filter((k) => !filled.has(k));
  return { ok: missing.length === 0, detail: missing.length ? "누락 " + missing.join(",") : "" };
});
check("UI 가 쓰는 모든 t() 키가 사전에 존재한다", () => {
  const defined = new Set(dictKeys);
  const used = [...new Set([...ui.matchAll(/t\(lang, "([A-Za-z0-9_.]+)"/g)].map((m) => m[1]))];
  const missing = used.filter((k) => !defined.has(k));
  return {
    ok: missing.length === 0,
    detail: missing.length ? "미정의 " + missing.join(",") : "사용 " + used.length + "개",
  };
});
check("템플릿 키(position.${p})가 사전에 존재한다", () => {
  const defined = new Set(dictKeys);
  const prefixes = [
    ...new Set([...ui.matchAll(/t\(lang, `([A-Za-z0-9_.]+)\.\$\{/g)].map((m) => m[1])),
  ];
  const missing = prefixes.filter((p) => ![...defined].some((k) => k.startsWith(p + ".")));
  return {
    ok: missing.length === 0,
    detail: missing.length ? "미정의 " + missing.join(",") : prefixes.join(","),
  };
});
check("t(): 미정의 키는 키 문자열 그대로 반환(조용한 빈 문자열 금지)", () =>
  /if \(!entry\) return key;/.test(i18n));
check("t(): 한 언어가 비면 다른 언어로 폴백한다", () =>
  /const fallback = lang === "ko" \? entry\.en : entry\.ko;/.test(i18n));
check("interpolate(): {name} 자리표시자를 치환한다", () =>
  /export function interpolate\(/.test(i18n) && /replace\(\/\\\{\(\[A-Za-z0-9_\]\+\)\\\}\/g/.test(i18n));
check("언어 설정은 localStorage 에 저장되고 재시동 후 복원된다", () =>
  /LANG_STORAGE_KEY/.test(i18n) &&
  /localStorage\.setItem\(LANG_STORAGE_KEY, lang\)/.test(i18n) &&
  /localStorage\.getItem\(LANG_STORAGE_KEY\)/.test(i18n));
// 저장 실패는 조용히 삼키지 않는다 — saveLang 이 boolean 을 돌려주고, UI 가 그 값을 보고
// 안내 문구를 낸다. 문구는 i18n 사전(lang.saveFailed)을 거친다.
check("언어 저장 실패는 조용히 삼키지 않는다(saveLang → false + UI 안내)", () =>
  /export function saveLang\(lang: Lang\): boolean/.test(i18n) &&
  /if \(!saveLang\(next\)\)/.test(ui) &&
  /t\(lang, "lang\.saveFailed"\)/.test(ui) &&
  /"lang\.saveFailed":/.test(i18n));
check("UI 가 언어 전환 select(#langSelect)를 제공한다", () =>
  /id="langSelect"/.test(ui) && /handleLangChange/.test(ui) && /LANGS\.map/.test(ui));
check("섹션 제목이 모두 t() 를 거친다(하드코딩 한글 제목 0)", () => {
  const hard = [...ui.matchAll(/<h2>([^<{]+)<\/h2>/g)]
    .map((m) => m[1])
    .filter((s) => /[가-힣]/.test(s));
  return { ok: hard.length === 0, detail: hard.length ? hard.join(",") : "" };
});

// ── 검수 지적 [medium] 1: 동적 상태 메시지 전량 i18n 이관 고정 ──────────
// reportOk/reportError/setScInfo/setPuterCopyMsg 로 전달되는 인자에 한글 리터럴이 남으면
// 영어를 선택해도 상태바·모달에 한국어가 노출된다. 호출식의 괄호 깊이를 따라 인자 전체를
// 모아 검사한다(여러 줄 템플릿 리터럴도 포함).
check("동적 상태 메시지(reportOk/reportError/setScInfo/setPuterCopyMsg) 인자에 한글 리터럴 0건", () => {
  const lines = ui.split("\n");
  const bad = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(reportOk|reportError|reportInfo|setScInfo|setPuterCopyMsg)\(/.test(lines[i].trim())) {
      continue;
    }
    let depth = 0;
    let seg = "";
    for (let j = i; j < lines.length; j += 1) {
      seg += lines[j] + "\n";
      for (const ch of lines[j]) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
      }
      if (depth <= 0) break;
    }
    if (/[가-힣]/.test(seg)) bad.push(i + 1);
  }
  return { ok: bad.length === 0, detail: bad.length ? "한글 리터럴 호출 라인: " + bad.join(",") : "" };
});

// 모듈 스코프(컴포넌트 밖) 헬퍼가 던지는 사용자 노출 오류도 사전을 거쳐야 한다.
check("throw new Error(...) 인자에 한글 리터럴 0건 (모듈 스코프 오류도 i18n)", () => {
  const lines = ui.split("\n");
  const bad = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/throw new Error\(/.test(lines[i])) continue;
    let depth = 0;
    let seg = "";
    for (let j = i; j < lines.length; j += 1) {
      seg += lines[j] + "\n";
      for (const ch of lines[j]) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
      }
      if (depth <= 0) break;
    }
    if (/[가-힣]/.test(seg)) bad.push(i + 1);
  }
  return { ok: bad.length === 0, detail: bad.length ? "한글 리터럴 throw 라인: " + bad.join(",") : "" };
});

// ── 검수 지적 [low] 2: 화면 표시 버전은 semver 원본에서 파생(1.0.0 → 1.0) ──
check("표시용 버전은 후행 패치 .0 을 생략한다(store::display_version)", () =>
  /pub fn display_version\(/.test(store) &&
  /version_display: display_version\(&version\)/.test(store),
);
check("UI 가 version_display 를 표시한다(원본 version 은 폴백)", () =>
  /version_display/.test(ui) && /appMeta\?\.version_display/.test(ui),
);

// ── i18n 순수 모듈 실행 검증(문자열 검사가 아니라 실제 호출) ──
const failed = results.filter((r) => !r.ok).length;

if (failed === 0) {
  try {
    const mod = await import(
      "file:///" + path.join(root, "src-ui/i18n.ts").replace(/\\/g, "/")
    );
    const ko = mod.t("ko", "common.apply");
    const en = mod.t("en", "common.apply");
    const interp = mod.t("en", "gen.action", { provider: "X" });
    const unknown = mod.t("ko", "no.such.key");
    const fallback = mod.t("en", "lang.label");
    const toggled = mod.nextLang("ko");
    const keys = mod.stringKeys();
    const assertions = [
      ["ko/en 이 서로 다르다", ko !== en],
      ["interpolate 가 {provider} 를 치환한다", interp.includes("X") && !interp.includes("{provider}")],
      ["미정의 키는 키 그대로", unknown === "no.such.key"],
      ["다른 언어 값이 채워져 있다(en)", typeof fallback === "string" && fallback.length > 0],
      ["nextLang(ko) === en", toggled === "en"],
      ["stringKeys() 가 비어 있지 않다", keys.length > 50],
    ];
    let runtimeFail = 0;
    for (const [name, ok] of assertions) {
      console.log((ok ? "ok  " : "FAIL") + " [실행] " + name);
      if (!ok) runtimeFail += 1;
    }
    console.log(
      "\n실행 검증: ko=" + ko + " en=" + en + " interp=" + interp + " keys=" + keys.length,
    );
    if (runtimeFail > 0) {
      console.log("\n[FAIL] i18n 실행 검증 " + runtimeFail + "건 실패");
      process.exit(1);
    }
  } catch (e) {
    console.log("\n[FAIL] i18n 모듈 실행 실패: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

console.log(
  failed === 0
    ? "\n" + results.length + "항목 + 실행검증 전부 ok — 영속성·히스토리·fit·메타·다국어 계약 통과"
    : "\n" + failed + " FAIL / " + (results.length - failed) + " ok — 계약 미충족",
);
process.exit(failed === 0 ? 0 : 1);
