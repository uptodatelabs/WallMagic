// 검증 스크립트 일괄 실행 러너.
//
// `scripts/verify-*.mjs` 를 **디렉터리에서 자동 발견**해 전부 실행한다.
// 따라서 새 검증 스크립트를 추가하면 이 파일을 고치지 않아도 자동 포함되며,
// 목록이 stale 해질 수 없다(과거 "임시 — 실행 후 삭제" 주석은 공개 준비 시점에 정정).
//
// 실행: node scripts/run-all-verify.mjs
// 종료: 실패 0건이면 exit 0, 하나라도 실패하면 exit 1.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dir = "scripts";
const files = readdirSync(dir).filter((f) => f.startsWith("verify-") && f.endsWith(".mjs"));
let fail = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [`${dir}/${f}`], { encoding: "utf8" });
  if (r.status !== 0) {
    fail += 1;
    console.log("FAIL " + f + " exit=" + r.status);
    const lines = (r.stdout || "").split("\n");
    for (const line of lines) {
      if (line.indexOf("FAIL") !== -1) console.log("   " + line);
    }
    console.log("   stderr: " + (r.stderr || "").slice(-400));
  }
}
console.log("scripts=" + files.length + " failed=" + fail);
process.exit(fail === 0 ? 0 : 1);
