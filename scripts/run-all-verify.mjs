// 검증 스크립트 일괄 실행 러너 (임시 — 실행 후 삭제).
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
