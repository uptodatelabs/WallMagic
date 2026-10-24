// Puter 로그인 경로 검증: ensurePuterSession이 auth.signIn()을 직접 호출하지 않고
// puterSignIn(auth) 래퍼(popup_blocked 변환)를 경유하는지 확인한다.
// 사용:  node scripts/verify-puter-signin.mjs [대상파일]   (기본: src-ui/App.tsx)
// Red:   node scripts/verify-puter-signin.mjs .multicode-backups/src-ui/App.tsx.20261024163621031.bak
// Green: node scripts/verify-puter-signin.mjs src-ui/App.tsx
import fs from "node:fs";

const f = process.argv[2] || "src-ui/App.tsx";
const src = fs.readFileSync(f, "utf8");
const m = src.match(/async function ensurePuterSession\(\)[\s\S]*?\n}\n/);
if (!m) {
  console.log(`RED: ensurePuterSession 정의를 찾지 못함 file=${f}`);
  process.exit(1);
}
const body = m[0];
const wrapper = /await puterSignIn\(auth\)/.test(body);
const direct = /await auth\.signIn\(\)/.test(body);
const ok = wrapper && !direct;
console.log(`${ok ? "GREEN" : "RED"}: wrapper=${wrapper} direct=${direct} file=${f}`);
process.exit(ok ? 0 : 1);
