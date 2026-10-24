// Puter 로그인 제스처 보존 재현 스크립트 (팝업 없이 동작 검증)
//
// 검증 명제: 사용자 클릭 직후 같은 동기 tick 안에서 puter.auth.signIn()이 호출되어야
// 브라우저/WebView가 팝업을 허용한다. `await` 경유로 signIn이 마이크로태스크 뒤로
// 밀리면 제스처가 끊겨 팝업이 차단될 수 있다.
//
// 사용법:
//   node scripts/test-puter-gesture.mjs              → 현재 src-ui/App.tsx 검사 (GREEN 기대)
//   node scripts/test-puter-gesture.mjs --red        → 수정 전 형태(항상 await 경유)를 메모리에서 재현 (RED 기대)
//
// 원리: App.tsx에서 ensurePuterSession 관련 구간만 잘라 TypeScript로 트랜스파일한 뒤
// 가짜 window.puter를 주입하고, await 없이 호출한 직후 동기적으로 signIn이 불렸는지 단정한다.
// 한계: 실제 WebView 팝업 차단 동작은 재현하지 않는다(JS로 재현 불가 — Tauri/WebView2
// 팝업 차단 정책은 이슈 #14263, #5251 참조). 이 스크립트는 "signIn 호출 시점"만 검증한다.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const red = process.argv.includes("--red");
const file = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? "src-ui/App.tsx";
const src = readFileSync(file, "utf8");

const startMarker = "/// `puter.auth.isSignedIn` 안전";
const endMarker = "/// 세션 보장 후 생성 요청";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: ensurePuterSession 구간 마커를 찾지 못했습니다");
  process.exit(2);
}
let segment = src.slice(start, end);

if (red) {
  // 수정 전 형태: 동기 boolean이어도 항상 await 경유 (제스처 끊김 유발 패턴)
  const fixed = 'typeof raw === "boolean" ? raw : await puterIsSignedIn(() => raw as Promise<boolean>)';
  if (!segment.includes(fixed)) {
    console.error("FAIL: RED 재현용 치환 대상 없음 — 파일 구조가 바뀌었습니다");
    process.exit(2);
  }
  segment = segment.replace(fixed, "await puterIsSignedIn(() => raw as Promise<boolean>)");
}

const js = ts.transpileModule(segment, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;

const seen = [];
const fakeWindow = {
  puter: {
    ai: { txt2img: () => {} },
    auth: {
      isSignedIn: () => false, // 미인증 상태 → signIn 경로 진입
      signIn: () => {
        seen.push("signIn");
      },
    },
  },
};

const { ensurePuterSession } = new Function("window", `${js}\nreturn { ensurePuterSession };`)(fakeWindow);

// await 없이 호출 → 반환 직후(같은 tick)에 seen을 확인
const pending = ensurePuterSession().catch(() => {});
const calledSync = seen.includes("signIn");
await pending;

const mode = red ? "RED-재현(수정 전 형태)" : "현재 코드";
if (calledSync) {
  console.log(`GREEN: signIn called synchronously [${mode}] file=${file}`);
  process.exit(0);
} else {
  console.log(`RED: signIn not called synchronously [${mode}] file=${file}`);
  process.exit(1);
}
