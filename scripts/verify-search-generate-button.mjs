#!/usr/bin/env node
// ① 검색 / ② 생성 영역의 액션 분리 계약 검증.
//
// 배경(요구사항): "검색과 생성시에 검색어와 프롬프트는 내용이 전혀 달라. 따라서 검색은
//   검색 창에서 설정하도록 하고 생성은 생성 창에서 설정하도록 해줘. 공통성이 없어."
//
// 이전 결함: ② 생성 영역에도 "검색 실행 (Search)" 버튼이 있어 검색 액션이 두 곳에
//   중복 배치되었고, 그 버튼의 disabled 가 '이미지 검색어'(#scSearchQueries)에 반응해
//   "왜 이미지 검색어를 입력하니까 생성 창의 검색 실행 버튼이 활성화되는가" 라는
//   모순을 만들었다(사용자 지적 3).
//
// 새 계약:
//   ① 검색 영역 = 키워드 + [검색] 버튼 **단일** 액션 (로컬 + 온라인).
//   ② 생성 영역 = 프롬프트 + [생성] 버튼. 검색 공급자일 때는 검색 실행 버튼을 두지 않는다.
//   ③ 검색 질의 소스는 ① 검색의 키워드다 — 이미지 검색어(순환 목록)가 비어 있으면
//      키워드로 폴백해 "키워드만 넣어도 인터넷 검색이 된다"(사용자 지적 1)를 보장한다.
//
// 사용: node scripts/verify-search-generate-button.mjs [--git=<rev>]
//   --git 지정 시 `git show <rev>:<path>` 로 과거 소스를 검사한다(Red 재현용).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "src-ui/App.tsx";
const gitArg = process.argv.find((a) => a.startsWith("--git="));
const gitRev = gitArg ? gitArg.slice("--git=".length) : null;
const app = gitRev
  ? execFileSync("git", ["show", `${gitRev}:${APP}`], { encoding: "utf8" })
  : fs.readFileSync(APP, "utf8");

console.log(`검사 대상: ${gitRev ? `${gitRev}:` : ""}${APP}`);

/** `const name = async () => { ... }` 또는 `const name = (...) => ...;` 본문을 추출한다. */
function sliceFn(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(?:async\\s*)?`);
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index;
  // 화살표(`=>`) 뒤에 블록이 오는지 먼저 본다 — 블록이 없으면 세미콜론까지가 본문이다.
  // (이전 구현은 파일 전체에서 첫 `{` 를 잡아, 블록 없는 화살표 정의에서 **다음 함수의
  //  본문**까지 포함했다. 그래서 searchKeywords 본문에 handleGenerate 의 `prompt` 가
  //  딸려 들어와 "프롬프트를 검색어로 쓴다"는 오탐 FAIL 이 났다 — 계측 버그.)
  const arrow = src.indexOf("=>", start);
  let bodyStart = src.indexOf("{", start);
  if (arrow >= 0 && (bodyStart < 0 || bodyStart > arrow)) {
    const rest = src.slice(arrow + 2);
    const firstNonSpace = rest.search(/\S/);
    const first = firstNonSpace < 0 ? -1 : arrow + 2 + firstNonSpace;
    if (first < 0 || src[first] !== "{") {
      const semi = src.indexOf(";", arrow);
      return semi < 0 ? src.slice(start) : src.slice(start, semi + 1);
    }
    bodyStart = first;
  }
  if (bodyStart < 0) return src.slice(start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

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

// ── 영역별 섹션 분리 (① 검색 / ② 생성) ──
// 제목 앞 번호(①②③⑤)는 UI 정리 요청으로 제거되었다 — 단언도 번호 없는 제목을 검사한다.
const searchStart = app.indexOf("<h2>검색</h2>");
const createStart = app.indexOf("<h2>생성</h2>");
const createEnd = createStart >= 0 ? app.indexOf("</section>", createStart) : -1;
const searchSection =
  searchStart >= 0 && createStart > searchStart ? app.slice(searchStart, createStart) : "";
const createSection =
  createStart >= 0 && createEnd > createStart ? app.slice(createStart, createEnd) : "";

check("① 검색 / ② 생성 섹션을 모두 찾는다", () => searchSection.length > 0 && createSection.length > 0);

// ── ① 검색 영역: 단일 [검색] 액션 ──
check("① 검색 영역에 [검색] 버튼이 하나 있다(handleSearch 호출)", () => {
  const hits = searchSection.match(/onClick=\{\(\) => void handleSearch\(\)\}/g) ?? [];
  return hits.length === 1;
});

check("① 검색 영역 [검색] 버튼 라벨은 '검색' 이다", () => {
  const m = searchSection.match(/onClick=\{\(\) => void handleSearch\(\)\}[\s\S]{0,200}?<\/button>/);
  return Boolean(m) && />\s*검색\s*</.test(m[0]);
});

check("① 검색의 키워드 입력(#query)이 검색 섹션 안에 있다", () =>
  /id="query"/.test(searchSection));

// ── ② 생성 영역: 검색 액션 부재 ──
check("② 생성 영역에 '검색 실행 (Search)' 버튼이 없다(중복 액션 제거)", () => {
  if (!createSection) return false;
  return (
    !/검색 실행 \(Search\)/.test(createSection) &&
    !/handleSearch/.test(createSection)
  );
});

check("② 생성 영역에는 생성 액션(handleGenerate)만 있다", () =>
  /onClick=\{\(\) => void handleGenerate\(\)\}/.test(createSection));

// ── 공급자 ↔ 영역 상호 배타 ──
// 요구사항: "공급자가 검색인 경우에는 아예 생성 부분은 안보이게 하고, 공급자가 생성 공급자인
//   경우 검색 부분을 안보이게" — 이전에는 ② 생성 영역이 항상 렌더되고, 검색 공급자일 때
//   버튼만 안내문으로 바꿨다. 그래서 검색 공급자인데도 '프롬프트' 입력이 화면에 남아
//   "검색어와 프롬프트가 공통"처럼 보이는 불일치가 있었다.
const panelStart = app.indexOf('<aside className="panel panel-left">');
const panelEnd = panelStart >= 0 ? app.indexOf('<main className="panel">', panelStart) : -1;
const panel = panelStart >= 0 && panelEnd > panelStart ? app.slice(panelStart, panelEnd) : "";
const elseMarker = panel.indexOf(") : (");
const elseRegion = elseMarker >= 0 ? panel.slice(elseMarker) : "";

check("좌측 패널에 공급자 전환 select(#scProviderQuick)가 있다(숨김 전환의 조작 지점)", () =>
  /id="scProviderQuick"/.test(panel) && /setScProvider\(/.test(panel));

check("검색 공급자일 때 ② 생성 UI(프롬프트·생성 버튼)는 렌더되지 않는다", () => {
  if (!searchSection) return false;
  return !/id="prompt"/.test(searchSection) && !/handleGenerate/.test(searchSection);
});

check("생성 공급자일 때 ① 검색 UI(키워드·[검색]·순환 검색어)는 렌더되지 않는다", () => {
  if (!elseRegion) return false;
  return (
    /id="prompt"/.test(elseRegion) &&
    /handleGenerate/.test(elseRegion) &&
    !/id="query"/.test(elseRegion) &&
    !/handleSearch/.test(elseRegion) &&
    !/scSearchQueries/.test(elseRegion)
  );
});

check("② 생성 버튼의 disabled 는 검색어(searchNeedsInput)에 반응하지 않는다", () => {
  const m = createSection.match(/onClick=\{\(\) => void handleGenerate\(\)\}[\s\S]{0,200}?<\/button>/);
  return Boolean(m) && !/searchNeedsInput/.test(m[0]);
});

check("searchNeedsInput 심볼이 제거되었다(이미지 검색어↔생성 버튼 바인딩 해소)", () => {
  const decl = /const\s+searchNeedsInput\b/.test(app);
  const used = /searchNeedsInput/.test(app);
  return !decl && !used;
});

// ── 검색 질의 소스: 키워드 단일 소스 + 폴백 (지적 1) ──
const searchKeywordsFn = sliceFn(app, "searchKeywords");
check("searchKeywords 정의를 추출한다", () => searchKeywordsFn.length > 0);

check("이미지 검색어가 비면 ① 검색의 키워드(query)로 폴백한다(키워드만으로 온라인 검색)", () =>
  /scSearchQueries\.trim\(\)/.test(searchKeywordsFn) &&
  /\?\s*scSearchQueries\s*:\s*query/.test(searchKeywordsFn));

check("searchKeywords 는 ② 생성의 프롬프트를 검색어로 쓰지 않는다", () =>
  !/\bprompt\b/.test(searchKeywordsFn));

check("① 검색 [검색] 핸들러는 키워드(query)를 그대로 백엔드에 넘긴다(회전 없음)", () => {
  const body = sliceFn(app, "handleSearch");
  return /invoke<SearchResult>\("search_wallpapers"/.test(body) && /\bquery,/.test(body);
});

// ── ② 생성: 검색 공급자에서 검색을 실행하지 않는다(가드 유지) ──
// 안내 문구의 번호 접두어(①/②)는 UI 제목에서 제거되었다(사용자 지시: 좌측 패널 제목 앞
// 숫자 삭제). 계약은 "검색 영역의 [검색] 버튼으로 안내"라는 의미이므로 번호 없이 매칭한다.
check("handleGenerate 는 검색 공급자에서 검색 영역으로 안내하고 종료한다", () => {
  const body = sliceFn(app, "handleGenerate");
  return (
    /scProvider === "search"/.test(body) &&
    /검색 영역의 \[검색\] 버튼/.test(body) &&
    !/generate_library_wallpaper_with_provider[\s\S]{0,200}provider:\s*"search"/.test(body)
  );
});

// ── 다른 공급자 회귀 없음 ──
check("Puter 분기(puterGenerateWithAuth)는 그대로 유지된다", () => {
  const body = sliceFn(app, "handleGenerate");
  return /scProvider === "puter"/.test(body) && /puterGenerateWithAuth/.test(body);
});

check("비-Puter 공급자는 백엔드로 선택 공급자를 전달한다(provider: scProvider)", () => {
  const body = sliceFn(app, "handleGenerate");
  return /provider:\s*scProvider/.test(body);
});

check("OpenAI/Cloudflare 자격증명 분기가 그대로 유지된다", () => {
  const body = sliceFn(app, "handleGenerate");
  return /scOpenaiKey\.trim\(\)/.test(body) && /scCfToken\.trim\(\)/.test(body);
});

const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `\n${results.length}항목 전부 ok — 검색/생성 액션 분리 계약 통과`
    : `\n${failed} FAIL / ${results.length - failed} ok — 검색/생성 액션 분리 계약 미충족`,
);
process.exit(failed === 0 ? 0 : 1);
