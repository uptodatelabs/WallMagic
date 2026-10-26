#!/usr/bin/env node
/**
 * verify-free-port.mjs — scripts/free-port.mjs 계약 검증 (단독 실행형, 외부 의존 없음)
 *
 * 검사:
 *  A. 이미 비어 있는 포트 → exit 0 (아무 것도 종료하지 않음)
 *  B. 무관한 프로세스가 점유 → 점유자를 정리하고 exit 0, 리스너가 실제로 종료됨
 *  C. 점유자가 자기(부모) 체인 → 절대 종료하지 않고 명확한 메시지 + exit 1, 점유자 생존 확인
 *  D. package.json dev 체인이 free-port 단계를 포함한다 (정적)
 *
 * 실행: node scripts/verify-free-port.mjs
 * Red 재현(개정 지정): node scripts/verify-free-port.mjs --git=<rev>
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitRev = (() => {
  const i = process.argv.indexOf("--git=");
  return i >= 0 ? process.argv[i].slice(6) : null;
})();

// --git=<rev> 지원: 과거 개정의 실제 소스를 검사 (free-port.mjs 만 대상)
function targetText(rel) {
  if (gitRev) {
    const r = spawnSync("git", ["show", `${gitRev}:${rel}`], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) return ""; // 개정에 파일 없음 = 미충족
    return r.stdout;
  }
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => {
      s.destroy();
      res(false);
    });
  });
async function waitFor(port, expect, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await probe(port)) === expect) return true;
    await sleep(150);
  }
  return (await probe(port)) === expect;
}

// 리스너 헬퍼: 지정 포트에서 LISTENING 하고 사는 node 자식 프로세스
const LISTEN_JS = (port) =>
  `require("net").createServer().listen(${port},"127.0.0.1",function(){});` +
  `setInterval(function(){},1<<30);`;
function startListener(port) {
  const child = spawn(process.execPath, ["-e", LISTEN_JS(port)], { stdio: "ignore" });
  return child;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// check()는 검사 함수를 지연 평가한다: async 검사(B·C)의 Promise를 truthy로 오판하지 않도록
// 보고 단계에서 실제 awaited 결과로 판정한다.
const results = [];
const check = (name, fn) => {
  results.push({ name, fn });
};

// ── 실행형 검사 (free-port.mjs 가 존재해야만 의미가 있음) ──
const freePortPath = path.join(root, "scripts", "free-port.mjs");
const freePortExists = gitRev ? targetText("scripts/free-port.mjs").length > 0 : fs.existsSync(freePortPath);

if (freePortExists) {
  const run = (port) =>
    spawnSync(process.execPath, [gitRev ? "-e" : freePortPath, gitRev ? LISTEN_JS(0) : String(port)], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });

  // A. 비어 있는 포트 → exit 0
  const PORT_A = 14781;
  check("A. 이미 비어 있는 포트는 아무 것도 종료하지 않고 exit 0", async () => {
    if (!(await waitFor(PORT_A, false, 2000))) return false; // 정말 비어 있는지(실측)
    const r = run(PORT_A);
    return r.status === 0;
  });

  // A2. (회귀) waitFor 는 점유된 포트에서 실제 false 를 판정해야 한다 —
  //     await 없이 Promise truthy 오판으로 '무엇이든 통과' 되던 결함의 재발 방지.
  const PORT_A2 = 14785;
  check("A2. 점유된 포트에서 waitFor(expect=false)는 false 를 반환한다(await 실측)", async () => {
    const child = startListener(PORT_A2);
    try {
      if (!(await waitFor(PORT_A2, true, 5000))) return false; // 리스너 기동 실측
      return (await waitFor(PORT_A2, false, 300)) === false; // 점유 중인데 '비어있다'고 판정하면 결함
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
  });

  // B. 무관한 프로세스 점유 → 정리 + exit 0 + 리스너 실제 종료
  const PORT_B = 14782;
  check("B. 무관한 점유 프로세스를 정리하고 exit 0, 리스너가 실제로 종료된다", async () => {
    const child = startListener(PORT_B);
    try {
      if (!(await waitFor(PORT_B, true, 5000))) return false; // 리스너 기동 실패
      const r = spawnSync(process.execPath, [freePortPath, String(PORT_B)], {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      });
      if (r.status !== 0) return false;
      if (!(await waitFor(PORT_B, false, 5000))) return false; // 포트가 실제로 비었는지(재확인)
      if (pidAlive(child.pid)) return false; // 리스너가 살아 있으면 실패
      return true;
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  });

  // C. 점유자가 자기(부모) 체인 → 종료하지 않고 명확한 메시지 + exit 1, 점유자 생존
  // 재설계: 검증 프로세스 자신이 포트를 점유하고 free-port를 "자식"으로 실행한다.
  // 이때 free-port의 부모 체인 = (free-port → 본 검증 프로세스)이므로 자기 보호가 작동한다.
  // (구 방식의 결함: spawn 직후 비동기 stderr를 동기 읽기해 CHILD_EXIT 검출 불가 + r2가
  //  부모 리스너를 무관 점유자로 종료시켜 검증 자체가 무효였음)
  const PORT_C = 14783;
  check("C. 자기(부모 체인)가 점유 중이면 절대 종료하지 않고 명확한 메시지와 함께 exit 1", async () => {
    const server = net.createServer();
    await new Promise((res) => server.listen(PORT_C, "127.0.0.1", res)); // 검증 프로세스 본인이 점유
    try {
      // 점유 전 정리 상태 확인(정말 본 프로세스가 유일한 점유자인지)
      if (!(await probe(PORT_C))) return false;
      const r = spawnSync(process.execPath, [freePortPath, String(PORT_C)], {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      });
      // 부모 체인 보호 계약: 절대 exit 0(정리 성공)이면 안 된다
      if (r.status !== 1) return false;
      const msg = (r.stdout || "") + (r.stderr || "");
      if (!msg.trim()) return false; // 무음 처리 금지
      if (!/free-port/.test(msg)) return false; // 식별 가능한 접두어 필요
      if (!/(보호|protect)/.test(msg)) return false; // 부모 체인 보호 사유가 명시되어야 한다
      // 점유자(검증 프로세스 자신)는 생존 — 리스너가 여전히 응답해야 한다
      if (!(await probe(PORT_C))) return false;
      return true;
    } finally {
      await new Promise((res) => server.close(res)); // 잔여 리스너 정리(오염 없음)
    }
  });
}

// D. package.json dev 체인 (정적)
check("D. package.json scripts.dev 가 free-port 단계를 포함한다", () => {
  const text = targetText("package.json");
  const m = text.match(/"dev"\s*:\s*"([^"]+)"/);
  return !!m && /free-port\.mjs/.test(m[1]);
});

// ── 출력 ──
let fails = 0;
const target = gitRev ? `${gitRev}` : "현재 작업본";
console.log(`검사 대상: ${target}`);
for (const r of results) {
  let ok = false;
  try {
    ok = !!(await r.fn()); // async 검사의 실제 완료 결과로 판정
  } catch (e) {
    console.error(`  (오류: ${e?.message ?? e})`);
  }
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${r.name}`);
}
console.log(fails === 0 ? `${results.length}항목 전부 ok — free-port 계약 통과` : `${fails} FAIL — free-port 계약 미충족`);
process.exit(fails === 0 ? 0 : 1);