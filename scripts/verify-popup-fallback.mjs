#!/usr/bin/env node
/**
 * Puter 로그인 팝업 차단 시 "안내 모달 + 사용자 선택" 계약 검증 (정적)
 *
 * 변경된 요구(이전 계약 대체):
 *  - 팝업이 차단되면 **브라우저를 즉시 열지 않는다.** URL이 표시된 안내 모달을 먼저 띄운다.
 *  - 모달에는 [URL 복사] 와 [바로가기(브라우저 열기)] 두 버튼이 있어 사용자가 선택한다.
 *  - 실제 브라우저 열기는 [바로가기] 클릭 시에만 수행된다 (openPuterLoginInBrowser).
 *
 * 계약:
 *  1) PUTER_LOGIN_URL 은 홈이 아닌 실제 로그인 경로(puter.com/auth).
 *  2) openPuterLoginFallback() 은 브라우저를 열지 않는다 —
 *     invoke("open_external_url"/"a" 클릭/window.open 어느 것도 포함하지 않고,
 *     showPuterLoginPrompt(모달 상태 setter) 만 호출한다.
 *  3) 모달 등록 지점(showPuterLoginPrompt)은 컴포넌트 useEffect 에서 setState 로 연결되고,
 *     언마운트 시 null 로 해제된다 (누수·유령 참조 방지).
 *  4) puterSignIn 은 팝업 차단 판별 시 openPuterLoginFallback() 만 호출하고
 *     openPuterLoginInBrowser() 를 호출하지 않는다 (즉시 열기 금지 = 핵심 요구).
 *     폴백(모달 표시)마저 실패하면 catch(fallbackErr) 로 원인을 담아 던진다 (삼킴 금지).
 *  5) 열기 함수 openPuterLoginInBrowser 는 2단계 — 1차 Tauri open_external_url,
 *     2차 <a target="_blank"> 클릭. 각 단계 실패 사유를 errors 에 수집하고
 *     모두 실패하면 예외로 호출부에 전달한다 (조용한 성공 위장 금지).
 *  6) 전체 파일에서 invoke("open_external_url"...) 호출은 openPuterLoginInBrowser 내 1건뿐이다
 *     (모달 경로에서 브라우저가 열리는 우회로가 없다는 증거).
 *  7) 모달 JSX: {puterPromptUrl && (...)} 가드, role="dialog", URL 표시(<code>{puterPromptUrl}</code>),
 *     [URL 복사] → handleCopyPuterUrl, [바로가기] → handleOpenPuterUrl,
 *     피드백 영역(role="status") + 닫기 버튼.
 *  8) 복사: navigator.clipboard.writeText 사용 + 비보안 컨텍스트용 execCommand 대체 +
 *     성공/실패 피드백 모두 setPuterCopyMsg 로 노출 (조용한 실패 금지).
 *  9) 열기 핸들러: openPuterLoginInBrowser 호출 후 성공/실패 피드백을 모달 안에 표시.
 * 10) 스타일: .modal-backdrop / .modal / .modal-url / .modal-actions / .modal-note 정의.
 * 11) 백엔드 open_external_url: 셸(cmd /c start) 미경유 + rundll32 FileProtocolHandler
 *     + http/https 스킴 검증 + generate_handler 등록 + 메타문자 URL 수용(셸 재파싱 없음).
 *
 * 사용법:
 *   node scripts/verify-popup-fallback.mjs [App.tsx] [lib.rs] [styles.css]
 *   node scripts/verify-popup-fallback.mjs --red   # 예전 "즉시 열기" 형태를 재구성해 FAIL 확인
 */
import { readFileSync } from "node:fs";

const redMode = process.argv.includes("--red");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const appPath = positional[0] ?? "src-ui/App.tsx";
const libPath = positional[1] ?? "src-tauri/src/lib.rs";
const cssPath = positional[2] ?? "src-ui/styles.css";
let app = readFileSync(appPath, "utf8");
const lib = readFileSync(libPath, "utf8");
const css = readFileSync(cssPath, "utf8");

/// `--red`: 이번 수정으로 없앤 형태를 되살려 아래 검사가 실제 FAIL 하는지 확인한다.
///  (a) 모달 JSX 제거  (b) fallback 이 브라우저를 즉시 여는 형태
///  (c) puterSignIn 이 안내 없이 바로 열기 함수 호출
function redVariant(src) {
  let out = src;
  out = out.replace(/\{puterPromptUrl && \([\s\S]*?\n      \)\}\n/, "");
  out = out.replace(
    /    showPuterLoginPrompt\(PUTER_LOGIN_URL\);\n/,
    "    void openPuterLoginInBrowser();\n",
  );
  out = out.replace(
    /        openPuterLoginFallback\(\);\n/,
    "        void openPuterLoginInBrowser();\n",
  );
  return out;
}
if (redMode) app = redVariant(app);

let failed = 0;
const ok = (cond, label) => {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    console.log(`FAIL ${label}`);
    failed += 1;
  }
};
/// 함수 본문만 정확히 잘라낸다 — 고정 길이 슬라이스는 다음 함수까지 포함해
/// 오탐(예: fallback 본문에 open_external_url 이 있다고 잘못 판정)을 만든다.
/// marker 뒤 첫 `{`부터 중괄호 깊이를 세어 짝이 맞는 `}`까지 반환한다.
/// (템플릿 리터럴의 `${...}`는 여닫힘이 짝을 이뤄 깊이 계산에 영향을 주지 않는다.)
const bodyFrom = (src, marker, _len) => {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  const start = src.indexOf("{", i);
  if (start < 0) return "";
  let depth = 0;
  for (let j = start; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return src.slice(start);
};
const countOf = (src, needle) => (src.match(new RegExp(needle, "g")) ?? []).length;

// ── 1) 로그인 URL ─────────────────────────────────────────────────────
ok(
  /const PUTER_LOGIN_URL = "https:\/\/puter\.com\/auth\/"/.test(app),
  "PUTER_LOGIN_URL 이 실제 로그인 경로(https://puter.com/auth/)",
);

// ── 2) openPuterLoginFallback: 브라우저를 열지 않고 모달만 띄운다 ──────
const fallbackIdx = app.indexOf("function openPuterLoginFallback");
ok(fallbackIdx >= 0, "openPuterLoginFallback 함수 정의 존재");
const fallbackBody = bodyFrom(app, "function openPuterLoginFallback", 900);
ok(
  /showPuterLoginPrompt\(PUTER_LOGIN_URL\)/.test(fallbackBody),
  "fallback이 showPuterLoginPrompt(URL)로 안내 모달 상태를 설정",
);
ok(
  !/invoke\("open_external_url"/.test(fallbackBody),
  "fallback 본문에 open_external_url 호출 없음 (즉시 브라우저 열기 금지)",
);
ok(
  !/createElement\("a"\)/.test(fallbackBody) && !/window\.open\(/.test(fallbackBody),
  "fallback 본문에 <a> 클릭·window.open 경로 없음",
);
ok(
  /await\s+openPuterLoginFallback/.test(app) === false,
  "fallback은 동기(void) — await openPuterLoginFallback 형태가 아니다",
);
ok(
  /throw new Error\("Puter 로그인 안내 창을 표시할 수 없습니다/.test(app),
  "모달 등록 전(비정상 경로)에 조용히 넘어가지 않고 명시적 오류",
);

// ── 3) 모달 등록 지점 (모듈 스코프 → 컴포넌트 setState) ────────────────
ok(
  /let showPuterLoginPrompt: \(\(url: string\) => void\) \| null = null;/.test(app),
  "모듈 스코프 showPuterLoginPrompt 등록 지점 선언",
);
ok(
  /showPuterLoginPrompt = \(url: string\) => \{[\s\S]{0,120}setPuterPromptUrl\(url\)/.test(app),
  "컴포넌트가 setPuterPromptUrl로 등록 (모달 상태 연결)",
);
ok(
  /showPuterLoginPrompt = null;/.test(app),
  "언마운트 시 등록 해제 (showPuterLoginPrompt = null)",
);

// ── 4) puterSignIn: 안내 모달 우선, 즉시 열기 금지 ────────────────────
const signInBody = bodyFrom(app, "async function puterSignIn", 1400);
ok(/\/popup\/i/.test(signInBody), "puterSignIn이 팝업 차단(/popup/i)을 판별");
ok(
  /\/popup\/i[\s\S]{0,320}openPuterLoginFallback\(\)/.test(signInBody),
  "차단 판별 시 openPuterLoginFallback() 호출 (안내 모달 표시)",
);
ok(
  !/openPuterLoginInBrowser/.test(signInBody),
  "puterSignIn은 openPuterLoginInBrowser를 호출하지 않는다 (즉시 열기 금지)",
);
ok(
  /catch \(fallbackErr\)/.test(signInBody),
  "모달 표시 실패를 catch(fallbackErr)로 받는다 (빈 catch 삼킴 금지)",
);
ok(
  /안내 창을 표시하지 못했습니다/.test(signInBody),
  "모달 표시마저 실패했을 때만 노출되는 실패 안내 존재",
);
ok(
  /\[바로가기\]/.test(signInBody) && /\[URL 복사\]/.test(signInBody),
  "차단 안내 메시지가 사용자 선택지([URL 복사]/[바로가기])를 명시",
);
ok(
  !/\}\s*catch\s*\{\s*(\/\/[^\n]*\n)?\s*\}/.test(signInBody),
  "팝업 분기에 빈 catch 블록 없음",
);

// ── 5) 열기 함수: 사용자 클릭 시에만, 2단계 시도 ──────────────────────
const openIdx = app.indexOf("async function openPuterLoginInBrowser");
ok(openIdx >= 0, "openPuterLoginInBrowser 함수 정의 존재 ([바로가기] 전용)");
const openBody = bodyFrom(app, "async function openPuterLoginInBrowser", 1200);
ok(
  countOf(openBody, 'invoke\\("open_external_url"') === 1,
  `열기 함수에서 open_external_url 호출 1건 (현재 ${countOf(openBody, 'invoke\\("open_external_url"')})`,
);
ok(
  /createElement\("a"\)/.test(openBody) && /target = "_blank"/.test(openBody),
  "2차 폴백: <a target=_blank> 클릭 경로 존재",
);
ok(
  /catch\s*\(err\)\s*\{[\s\S]{0,200}errors\.push/.test(openBody),
  "각 단계 실패 사유를 errors 에 수집 (삼킴 없음)",
);
ok(
  /throw new Error\(errors\.join/.test(openBody),
  "2차까지 실패하면 예외로 호출부에 전달 (조용한 성공 위장 금지)",
);
ok(
  countOf(app, 'invoke\\("open_external_url"') === 1,
  `전체 파일에서 open_external_url invoke는 1건뿐 — 모달 경로 우회로 없음 (현재 ${countOf(app, 'invoke\\("open_external_url"')})`,
);

// ── 7) 모달 JSX 계약 ─────────────────────────────────────────────────
ok(/\{puterPromptUrl && \(/.test(app), "모달 렌더 가드 {puterPromptUrl && ( ... )} 존재");
ok(
  /className="modal-backdrop"/.test(app) &&
    /role="dialog"/.test(app) &&
    /aria-modal="true"/.test(app) &&
    /aria-labelledby="puter-modal-title"/.test(app),
  "모달 접근성 속성(backdrop/dialog/aria-modal/aria-labelledby)",
);
ok(
  /<div className="modal-url">\s*<code>\{puterPromptUrl\}<\/code>/.test(app),
  "모달에 URL이 그대로 표시된다 (<code>{puterPromptUrl}</code>)",
);
// 다국어(i18n) 적용 후 버튼 라벨은 리터럴이 아니라 `t(lang, "modal.copyUrl")` 등으로
// 렌더된다. 계약의 본질은 "핸들러 연결"이므로 라벨은 리터럴 또는 t() 키 둘 다 인정한다.
ok(
  /onClick=\{\(\) => void handleCopyPuterUrl\(\)\}[\s\S]{0,120}?(URL 복사|t\(lang, "modal\.copyUrl"\))/.test(
    app,
  ),
  "[URL 복사] 버튼 → handleCopyPuterUrl 연결",
);
ok(
  /onClick=\{\(\) => void handleOpenPuterUrl\(\)\}[\s\S]{0,160}?(바로가기 \(브라우저 열기\)|t\(lang, "modal\.openBrowser"\))/.test(
    app,
  ),
  "[바로가기(브라우저 열기)] 버튼 → handleOpenPuterUrl 연결",
);
ok(
  /className="modal-note" role="status"/.test(app) && /\{puterCopyMsg\}/.test(app),
  "복사/열기 결과 피드백 영역(role=status + puterCopyMsg) 존재",
);
ok(
  /onClick=\{\(\) => setPuterPromptUrl\(null\)\}[\s\S]{0,40}닫기/.test(app),
  "모달 닫기 버튼 존재",
);
ok(
  /onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(app),
  "모달 내부 클릭이 backdrop 닫힘으로 전파되지 않음",
);

// ── 8) 복사 핸들러 계약 ──────────────────────────────────────────────
const copyBody = bodyFrom(app, "const handleCopyPuterUrl = async", 900);
ok(
  /navigator\.clipboard\?\.writeText/.test(copyBody),
  "handleCopyPuterUrl이 navigator.clipboard.writeText 사용",
);
ok(
  /document\.execCommand\("copy"\)/.test(copyBody),
  "비보안 컨텍스트 대체 경로(execCommand copy) 존재",
);
ok(
  /setPuterCopyMsg\("URL을 클립보드에 복사했습니다"\)/.test(copyBody),
  "복사 성공 피드백 표시",
);
ok(
  /setPuterCopyMsg\(`URL 복사 실패: \$\{formatErr\(err\)\}`\)/.test(copyBody),
  "복사 실패 피드백 표시 (조용한 실패 금지)",
);

// ── 9) 열기 핸들러 계약 ──────────────────────────────────────────────
const openHBody = bodyFrom(app, "const handleOpenPuterUrl = async", 700);
ok(
  /await openPuterLoginInBrowser\(\)/.test(openHBody),
  "handleOpenPuterUrl이 openPuterLoginInBrowser를 호출",
);
ok(
  /브라우저에서 로그인 페이지를 열었습니다|브라우저 열기 실패/.test(openHBody),
  "열기 핸들러가 성공/실패 피드백을 모두 노출",
);

// ── 10) 스타일 ───────────────────────────────────────────────────────
for (const cls of [".modal-backdrop", ".modal", ".modal-url", ".modal-actions", ".modal-note"]) {
  ok(css.includes(cls), `styles.css 에 ${cls} 정의`);
}

// ── 11) 백엔드: open_external_url 커맨드 + 셸 미경유 ──────────────────
ok(
  /#\[tauri::command\][\s\S]{0,160}fn open_external_url\s*\(/.test(lib),
  "lib.rs에 #[tauri::command] fn open_external_url 정의",
);
const handlerIdx = lib.indexOf("generate_handler![");
const handlerEnd = lib.indexOf("])", handlerIdx);
const handlerBody = lib.slice(
  handlerIdx,
  handlerEnd > handlerIdx ? handlerEnd : handlerIdx + 1200,
);
ok(
  handlerIdx >= 0 && handlerBody.includes("open_external_url"),
  "invoke_handler(generate_handler)에 open_external_url 등록",
);
ok(/fn validate_external_url/.test(lib), "validate_external_url 스킴 검증 함수 존재");
ok(
  /https?:\/\//.test(lib) && /invalid url scheme/i.test(lib),
  "http/https 스킴 허용 + 그 외 거부",
);
ok(
  !/Command::new\("cmd"\)/.test(lib) && !/"\/c",\s*"start"/.test(lib),
  "cmd /c start 셸 호출 제거 (cmd.exe 명령줄 재파싱 경로 차단)",
);
ok(
  /FileProtocolHandler|ShellExecute/.test(lib),
  "rundll32 FileProtocolHandler(또는 ShellExecuteW) 기반 오프너 사용",
);

// ── 메타문자 계약: '수용(unwrap + 동등 비교)' 형태 고정 ──
const metaTestIdx = lib.indexOf("test_validate_external_url_meta_char_url_no_shell");
ok(metaTestIdx >= 0, "메타문자 계약 테스트 존재 (https://a&calc)");
const metaTestBody = metaTestIdx >= 0 ? lib.slice(metaTestIdx, metaTestIdx + 700) : "";
ok(
  /validate_external_url\("https:\/\/a&calc"\)\.unwrap\(\)/.test(metaTestBody),
  "메타문자 URL 단정이 '수용(.unwrap())' 형태 — 거부(.is_err()) 아님",
);
ok(
  /validate_external_url\("https:\/\/a&calc"\)\.unwrap\(\)[\s\S]{0,120}"https:\/\/a&calc"/.test(
    metaTestBody,
  ),
  "수용 결과가 원문 그대로임을 동등 비교로 고정 (검열·정규화 없음)",
);
ok(!/is_err\(\)/.test(metaTestBody), "메타문자 테스트 본문에 is_err() 단정 없음");

if (redMode) {
  console.log(
    failed > 0
      ? `RED 재현 성공 — 수정 전 형태에서 ${failed}건 FAIL (회귀 검출력 확인)`
      : "RED 재현 실패 — 수정 전 형태인데도 전부 통과 (검사가 회귀를 못 잡는다)",
  );
} else {
  console.log(
    failed === 0
      ? "팝업 차단 안내 모달 계약 통과"
      : `팝업 차단 안내 모달 계약 위반 (${failed}건)`,
  );
}
process.exit(failed === 0 ? 0 : 1);
