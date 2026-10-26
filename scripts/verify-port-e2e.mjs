#!/usr/bin/env node
/**
 * verify-port-e2e.mjs — E2E: 1420 점유 상태에서 `npm run dev` 체인(free-port && vite)이
 * 자동으로 정리·기동되는지 검증한다. (구 verify-port-auto.cmd 배치를 대체 —
 * start /b 기반 배치는 실행 환경의 타임아웃 게이트와 맞지 않아 폐기)
 *
 * 절차:
 *  0. 사전 정리: free-port 로 1420 베이스라인 확보 + 베이스라인 리스너 PID 기록
 *  1. 가짜 stale 서버가 1420 점유 → STEP1 기록 (netstat)
 *  2. `npm run dev` 체인 실행 → **fake 와 다른 PID** 가 리스닝하면 STEP2 성공
 *  3. HTTP 응답 확인 (vite 는 localhost/::1 에 바인드할 수 있어 두 호스트를 모두 확인)
 *
 * 과거 결함(회귀 방지):
 *  - `probe(127.0.0.1)` 만으로 기동을 판정하면 0.0.0.0 에 바인드한 **가짜 점유 서버**를
 *    vite 로 오인한다 → 반드시 "fake 와 다른 PID" 조건을 함께 본다.
 *  - `fetch("http://127.0.0.1")` 만으로 확인하면 ::1/localhost 에 바인드한 vite 를 실패로
 *    오판한다 → 127.0.0.1 과 ::1 을 모두 시도한다.
 *
 * 산출물: e2e-verify.txt / e2e-dev.log (작업 디렉토리 루트)
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 1420;
const logPath = path.join(root, "e2e-verify.txt");
const devLogPath = path.join(root, "e2e-dev.log");
const lines = [];
const emit = (s) => {
  lines.push(s);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 한 호스트에 TCP 연결을 시도한다 (수락 여부만 확인). */
const probeHost = (port, host) =>
  new Promise((res) => {
    const s = net.connect({ port, host }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => {
      s.destroy();
      res(false);
    });
  });

/** 127.0.0.1 또는 ::1 중 하나라도 수락하면 true (vite 바인드 호스트 차이 흡수). */
const probe = async (port) =>
  (await probeHost(port, "127.0.0.1")) || (await probeHost(port, "::1"));

async function waitFor(port, expect, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await probe(port)) === expect) return true;
    await sleep(200);
  }
  return (await probe(port)) === expect;
}

// `-p tcp` 는 IPv4 행만 보여준다. vite 는 `::1`(IPv6)에 바인드할 수 있으므로
// 그 경우 IPv6 리스너가 조회에서 빠져 "vite 미기동"으로 오판한다(실측: ::1 LISTENING).
// 따라서 `-p` 필터 없이 TCP/TCPv6 행을 모두 읽고 LISTENING + 로컬 포트 일치로 거른다.
const netstatLine = () => {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split(/\r?\n/)
    .filter((l) => /^\s*TCP/.test(l) && new RegExp(`:${PORT}\\s`).test(l) && /LISTENING/i.test(l))
    .map((l) => l.trim());
};

/** 현재 1420 을 LISTENING 중인 PID 목록 */
const listenPids = () =>
  netstatLine()
    .map((l) => Number.parseInt(l.split(/\s+/).pop(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

const killTree = (pid) => {
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
};

/** HTTP 응답 확인 — 500 미만이면 기동 성공으로 본다 (두 호스트 시도). */
async function httpOk() {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    try {
      const r = await fetch(`http://${host}:${PORT}/`);
      if (r.status < 500) return true;
    } catch {
      // 다음 호스트 시도
    }
  }
  return false;
}

let exitCode = 1;
let fake = null;
let dev = null;
let baselinePids = [];
try {
  // 0) 베이스라인 정리 — 정리 전에 기존 리스너 PID 를 기록해 두고, 종료 시 복구 대상에서 제외한다.
  baselinePids = listenPids();
  const pre = spawnSync(process.execPath, [path.join(root, "scripts", "free-port.mjs"), String(PORT)], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  emit(`[STEP0 - baseline] free-port exit=${pre.status}`);
  emit(...netstatLine().map((l) => "  " + l));
  if (pre.status !== 0) throw new Error(`베이스라인 정리 실패: ${pre.status}`);
  if (!(await waitFor(PORT, false, 3000))) throw new Error("베이스라인에서 1420 이 비지 않음");

  // 1) 가짜 stale 서버 점유 (0.0.0.0 바인드 — probe 만으로는 vite 와 구분되지 않는다)
  fake = spawn(
    process.execPath,
    ["-e", `require("net").createServer().listen(${PORT},"0.0.0.0",function(){});setInterval(function(){},1e9);`],
    { stdio: "ignore" },
  );
  if (!(await waitFor(PORT, true, 5000))) throw new Error("가짜 점유 서버 기동 실패");
  const fakePids = listenPids();
  if (!fakePids.includes(fake.pid)) {
    throw new Error(`가짜 서버 PID(${fake.pid})가 리스너 목록에 없음: [${fakePids.join(", ")}]`);
  }
  emit(`[STEP1 - before: stale listener on 1420] fakePid=${fake.pid}`);
  emit(...netstatLine().map((l) => "  " + l));

  // 2) npm run dev 체인 (free-port && vite)
  const out = fs.openSync(devLogPath, "w");
  dev = spawn("cmd", ["/c", "npm", "run", "dev"], { cwd: root, stdio: ["ignore", out, out], detached: false });
  fs.closeSync(out);

  // 성공 조건: fake 가 아닌 PID 가 1420 을 LISTENING 한다 (= free-port 가 fake 를 정리하고
  // vite 가 바인드했다). probe 만 보면 fake 를 vite 로 오인하므로 PID 로 판정한다.
  let vitePid = null;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const pids = listenPids().filter((p) => p !== fake.pid);
      if (pids.length > 0) {
        vitePid = pids[0];
        break;
      }
      await sleep(300);
    }
  }
  emit(
    `[STEP2 - after: npm run dev (free-port && vite)] vitePid=${vitePid ?? "?"} fakePid=${fake.pid} devPid=${dev?.pid ?? "?"}`,
  );
  emit(...netstatLine().map((l) => "  " + l));

  // 3) HTTP 응답 확인 (localhost / 127.0.0.1 / ::1)
  const http = vitePid !== null ? await httpOk() : false;
  emit(`[STEP3 - vite HTTP 응답] ok=${http}`);

  exitCode = vitePid !== null && http ? 0 : 1;
  emit(
    exitCode === 0
      ? `[PASS] stale 점유를 자동 정리하고 dev 서버가 기동되었다 (fake ${fake.pid} 정리 → vite ${vitePid})`
      : "[FAIL] dev 서버 기동 실패",
  );
} catch (e) {
  emit(`[FAIL] ${e?.message ?? e}`);
  exitCode = 1;
} finally {
  // 4) 환경 오염 방지: 검증이 만든 프로세스(dev 트리·fake)와, 이 검증이 새로 띄운 리스너만 정리한다.
  killTree(dev?.pid);
  killTree(fake?.pid);
  for (const pid of listenPids()) {
    if (!baselinePids.includes(pid)) killTree(pid);
  }
  emit("[DONE]");
  try {
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  } catch {}
}
console.log(lines.join("\n"));
process.exit(exitCode);
