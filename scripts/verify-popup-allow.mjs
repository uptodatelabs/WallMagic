// Puter 로그인 팝업이 WebView2에서 실제로 열릴 수 있는지 검사하는 정적 계약 스크립트.
//
// 근거: wry 0.57.1/src/webview2/mod.rs:861-863 —
//   let Some(new_window_req_handler) = &new_window_req_handler else 相当 분기에서
//   args.SetHandled(true)? 로 새 창 요청을 즉시 차단한다.
// 즉 on_new_window 핸들러를 등록하지 않은 창은 window.open/popup 이
// 설정·권한과 무관하게 항상 차단된다. tauri.conf.json 의 app.windows 로
// 자동 생성한 창은 이 핸들러를 등록할 수단이 없으므로, 메인 창을 코드로
// 생성하며 .on_new_window(...) 로 Allow 를 반환해야 팝업이 열린다.
//
// 사용:  node scripts/verify-popup-allow.mjs
// Red:   수정 전 lib.rs (on_new_window 미등록 + conf windows 비어있지 않음)
// Green: 수정 후
import fs from "node:fs";

const libPath = "src-tauri/src/lib.rs";
const confPath = "src-tauri/tauri.conf.json";
const lib = fs.readFileSync(libPath, "utf8");
const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));

/// `pub fn run()` 본문을 중괄호 깊이로 잘라낸다 (고정 길이 슬라이스는 다음 함수를 포함해 오탐을 만든다).
function blockOf(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  let depth = 0;
  let started = false;
  let out = "";
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    out += c;
    if (c === "{") {
      depth++;
      started = true;
    } else if (c === "}") {
      depth--;
      if (started && depth === 0) break;
    }
  }
  return out;
}

const runBody = blockOf(lib, "pub fn run()");

const checks = [];
const check = (name, ok) => checks.push({ name, ok });

check(
  "run()의 setup 훅에서 메인 창을 코드로 생성 (WebviewWindowBuilder::new)",
  /\.setup\(\s*\|app\|/.test(runBody) && /WebviewWindowBuilder::new/.test(runBody),
);
check("메인 창 빌더에 on_new_window 핸들러 등록", /\.on_new_window\(/.test(runBody));
check(
  "https 요청에 NewWindowResponse::Allow 반환 (팝업 실제 오픈)",
  /NewWindowResponse::Allow/.test(runBody),
);
check(
  "비-https(로컬 파일·커스텀 스킴) 요청은 NewWindowResponse::Deny",
  /NewWindowResponse::Deny/.test(runBody),
);
check(
  "메인 창 URL이 WebviewUrl::App(index.html)로 지정",
  /WebviewUrl::App\(\s*"index\.html"/.test(runBody),
);
check(
  "tauri.conf.json app.windows 가 비어 있음 (자동 생성 창과 라벨 'main' 중복 방지)",
  Array.isArray(conf?.app?.windows) && conf.app.windows.length === 0,
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}`);
if (failed.length > 0) {
  console.log(`\n${failed.length}건 실패 — WebView2 팝업 허용 계약 미충족(popup 은 항상 차단됨)`);
  process.exit(1);
}
console.log(`\n팝업 허용 계약 통과 (${checks.length}/${checks.length})`);
