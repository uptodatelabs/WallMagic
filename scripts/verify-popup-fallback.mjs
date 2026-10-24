#!/usr/bin/env node
/**
 * Puter 로그인 팝업 차단 시 "대체 오픈 경로" 계약 검증 (정적)
 *
 * 계약:
 *  1) puterSignIn의 팝업 차단 분기가 단순 에러 메시지로 끝나지 않고
 *     openPuterLoginFallback() 호출로 실제 열기 동작을 시도한다.
 *  2) 폴백 실패를 빈 catch로 삼키지 않는다 — catch(fallbackErr)로 받아 사유를
 *     사용자 메시지에 포함한다 (실패해도 "열었습니다"라고 안내하던 회귀 차단).
 *  3) 폴백 성공 안내와 폴백 실패 안내가 분리되어 있고, 실패 안내는
 *     "폴백마저 실패"한 경우에만 노출된다.
 *  4) 폴백은 2단계 — 1차 Tauri open_external_url, 2차 <a target="_blank"> 클릭.
 *  5) 백엔드 open_external_url은 셸(cmd /c start)을 거치지 않고
 *     rundll32 FileProtocolHandler(또는 ShellExecuteW)로 argv 1개 전달한다 —
 *     URL의 `&`, `|` 등 메타문자가 cmd.exe 재파싱으로 추가 명령이 되지 않는다.
 *  6) 열기 URL은 홈이 아닌 실제 로그인 경로(puter.com/auth)이며,
 *     외부 브라우저 로그인이 앱 세션과 별개임이 안내에 명시된다.
 *
 * 사용법:
 *   node scripts/verify-popup-fallback.mjs [App.tsx] [lib.rs]
 *   node scripts/verify-popup-fallback.mjs --red      # 수정 전 형태를 메모리에서 재구성해 FAIL 확인
 */
import { readFileSync } from "node:fs";

const redMode = process.argv.includes("--red");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const appPath = positional[0] ?? "src-ui/App.tsx";
const libPath = positional[1] ?? "src-tauri/src/lib.rs";
let app = readFileSync(appPath, "utf8");
const lib = readFileSync(libPath, "utf8");

/// `--red`: 이번 수정으로 없앤 "조용한 삼킴 + 단일 경로" 형태를 되살려
/// 아래 계약 검사가 실제로 FAIL 하는지(=회귀를 잡아내는지) 확인한다.
function redVariant(src) {
  return src
    .replace(
      /\} catch \(fallbackErr\) \{[\s\S]*?\n    \}/,
      "} catch {\n      // 폴백 실패 — 삼킴(수정 전 동작)\n    }",
    )
    .replace(/\n\s*const anchor = document\.createElement\("a"\);/, "");
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

// ── 프론트: 대체 오픈 래퍼 ─────────────────────────────────────────────
const fallbackIdx = app.indexOf("async function openPuterLoginFallback");
ok(fallbackIdx >= 0, "openPuterLoginFallback 래퍼 정의 존재");
const fallbackBody = fallbackIdx >= 0 ? app.slice(fallbackIdx, fallbackIdx + 800) : "";
ok(
  !/window\.open\(/.test(fallbackBody),
  "fallback이 window.open 을 쓰지 않는다 (noopener 는 반환값이 null 이라 판정 불가)",
);
const openInvokeCount = (fallbackBody.match(/invoke\("open_external_url"/g) ?? []).length;
ok(
  openInvokeCount === 1,
  `차단 시 open_external_url 호출 1건 (현재 ${openInvokeCount})`,
);
ok(
  /puter\.com\/auth/.test(fallbackBody),
  "열기 URL이 홈이 아닌 실제 로그인 경로(puter.com/auth)",
);
ok(
  /catch\s*\(err\)\s*\{[\s\S]{0,200}errors\.push/.test(fallbackBody),
  "1차 폴백 실패 사유를 errors 에 수집 (삼킴 없음)",
);
ok(
  /throw new Error\(errors\.join/.test(fallbackBody),
  "2차까지 실패하면 예외로 호출부에 전달 (조용한 성공 위장 금지)",
);

// ── 프론트: 2차 폴백 (앵커 클릭) ───────────────────────────────────────
ok(
  /createElement\("a"\)/.test(fallbackBody) && /target = "_blank"/.test(fallbackBody),
  "2차 폴백: <a target=_blank> 클릭 경로 존재",
);

// ── 프론트: 외부 로그인 = 앱 세션 별개 안내 ────────────────────────────
ok(/별개/.test(app), "외부 브라우저 로그인이 앱 세션과 별개임이 안내/주석에 명시");

// ── 프론트: puterSignIn 차단 분기 ──────────────────────────────────────
const signInIdx = app.indexOf("async function puterSignIn");
const signInBody = signInIdx >= 0 ? app.slice(signInIdx, signInIdx + 1200) : "";
ok(/\/popup\/i/.test(signInBody), "puterSignIn이 팝업 차단(/popup/i)을 판별");
ok(
  /\/popup\/i[\s\S]{0,320}openPuterLoginFallback\(/.test(signInBody),
  "차단 판별 시 openPuterLoginFallback 호출 (에러 메시지에 그치지 않음)",
);
ok(
  /catch \(fallbackErr\)/.test(signInBody),
  "폴백 실패를 catch(fallbackErr)로 받는다 (빈 catch 삼킴 금지)",
);
ok(
  !/\}\s*catch\s*\{\s*(\/\/[^\n]*\n)?\s*\}/.test(signInBody),
  "팝업 분기에 빈 catch 블록 없음",
);
ok(
  /자동 열기에도 실패/.test(signInBody),
  "폴백마저 실패했을 때만 노출되는 실패 안내 존재",
);
ok(
  /열었습니다/.test(signInBody),
  "폴백 성공 안내가 실패 안내와 분리되어 존재",
);
ok(/팝업/.test(signInBody), "팝업 허용 안내 메시지 유지 (사용자 조치 안내)");

// ── 백엔드: open_external_url 커맨드 ───────────────────────────────────
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

// ── 백엔드: 셸 미경유 (보안) ───────────────────────────────────────────
ok(
  !/Command::new\("cmd"\)/.test(lib) && !/"\/c",\s*"start"/.test(lib),
  "cmd /c start 셸 호출 제거 (cmd.exe 명령줄 재파싱 경로 차단)",
);
ok(
  /FileProtocolHandler|ShellExecute/.test(lib),
  "rundll32 FileProtocolHandler(또는 ShellExecuteW) 기반 오프너 사용",
);
// ── 백엔드: 메타문자 계약 — 문자열 존재가 아닌 "단정문 형태" 검증 ──
// 계약: 메타문자(& | ^ 등)는 검증에서 거부하지 않는다 — 정당한 URL에 &가 포함될 수 있다.
// 안전성은 rundll32 FileProtocolHandler에 argv 1개를 직접 전달해 cmd.exe 재파싱 경로가
// 없다는 데서 나온다. 따라서 테스트는 '거부(is_err)'가 아니라 '수용(unwrap + 동등 비교)'을
// 고정해야 한다 — 이 검사는 lib.rs의 실제 단정문 형태까지 확인한다.
const metaTestIdx = lib.indexOf("test_validate_external_url_meta_char_url_no_shell");
ok(metaTestIdx >= 0, "메타문자 계약 테스트 존재 (https://a&calc)");
const metaTestBody = metaTestIdx >= 0 ? lib.slice(metaTestIdx, metaTestIdx + 700) : "";
ok(
  /validate_external_url\("https:\/\/a&calc"\)\.unwrap\(\)/.test(metaTestBody),
  "메타문자 URL 단정이 '수용(.unwrap())' 형태 — 거부(.is_err()) 아님 (보고서 오기 차단)",
);
ok(
  /validate_external_url\("https:\/\/a&calc"\)\.unwrap\(\)[\s\S]{0,120}"https:\/\/a&calc"/.test(
    metaTestBody,
  ),
  "수용 결과가 원문 그대로임을 동등 비교로 고정 (검열·정규화 없음)",
);
ok(
  !/is_err\(\)/.test(metaTestBody),
  "메타문자 테스트 본문에 is_err() 단정 없음 (거부 계약 아님)",
);

if (redMode) {
  console.log(
    failed > 0
      ? `RED 재현 성공 — 수정 전 형태에서 ${failed}건 FAIL (회귀 검출력 확인)`
      : "RED 재현 실패 — 수정 전 형태인데도 전부 통과 (검사가 회귀를 못 잡는다)",
  );
} else {
  console.log(
    failed === 0
      ? "팝업 차단 대체 오픈 계약 통과"
      : `팝업 차단 대체 오픈 계약 위반 (${failed}건)`,
  );
}
process.exit(failed === 0 ? 0 : 1);
