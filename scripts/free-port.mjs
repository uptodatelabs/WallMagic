#!/usr/bin/env node
// free-port.mjs — 개발 서버 기동 전 지정 포트의 점유 프로세스를 정리한다.
// 사용: node scripts/free-port.mjs [port]  (기본 1420)
//
// 동작:
//   1. 점유자 탐지:   win = netstat -ano (LISTENING 라인), posix = lsof -ti tcp:<port>
//   2. 자기 보호:     자기 자신 PID와 부모 체인(ancestors)에 속한 PID는 절대 종료하지 않는다.
//   3. 종료:          win = taskkill /PID <pid> /T /F , posix = kill <pid>
//   4. 재확인:        종료 후 다시 조회해 여전히 점유 중이면 non-zero로 종료(폴백 실패 명시).
//
// 종료 코드: 0 = 포트 비어 있음(처음부터 비었거나 정리 성공), 1 = 정리 실패·명령 실패.

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const IS_WIN = process.platform === "win32";
// 인자 계약: 숫자 포트 1개만 허용 — 그 외 인자/옵션은 stderr로 알리고 실패 종료.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !/^\d+$/.test(args[0]))) {
  console.error(
    `[free-port] 알 수 없는 인자: ${args.join(" ")} — 사용법: node scripts/free-port.mjs [port]`,
  );
  process.exit(1);
}
const PORT = Number.parseInt(args[0] ?? "1420", 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[free-port] 잘못된 포트 인자: ${args[0] ?? "(없음)"}`);
  process.exit(1);
}

/** win: netstat에서 LISTENING 중인 <port> 소유 PID 목록 */
function pidsFromNetstat(output) {
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    // 예: TCP    0.0.0.0:1420    0.0.0.0:0    LISTENING    54096
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c) => c.endsWith(`:${PORT}`));
    if (!local) continue;
    const pid = Number.parseInt(cols[cols.length - 1], 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** posix: lsof -ti tcp:<port> 결과 */
function pidsFromLsof(output) {
  return output
    .split(/\r?\n/)
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 점유 PID 목록 조회 (없으면 빈 배열, 조회 실패 시 null) */
function findPids() {
  try {
    if (IS_WIN) {
      const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
      if (out.status !== 0 || typeof out.stdout !== "string") return null;
      return pidsFromNetstat(out.stdout);
    }
    const out = spawnSync("lsof", ["-ti", `tcp:${PORT}`], { encoding: "utf8" });
    // lsof는 점유가 없으면 status 1 + 빈 출력 → 빈 배열이 정상
    return typeof out.stdout === "string" ? pidsFromLsof(out.stdout) : null;
  } catch {
    return null;
  }
}

/** 현재 PID부터 위로 올라가는 부모 체인 전체 (보호 대상) */
function selfProtectionSet() {
  const guarded = new Set([process.pid]);
  try {
    if (IS_WIN) {
      let pid = process.pid;
      for (let depth = 0; depth < 32 && pid > 0; depth++) {
        const out = spawnSync(
          "powershell",
          ["-NoProfile", "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
          { encoding: "utf8" },
        );
        const parent = Number.parseInt((out.stdout ?? "").trim(), 10);
        if (!Number.isInteger(parent) || parent <= 0 || guarded.has(parent)) break;
        guarded.add(parent);
        pid = parent;
      }
    } else {
      // posix: /proc/<pid>/stat 4번째 필드 = 부모 PID
      let pid = process.pid;
      for (let depth = 0; depth < 32 && pid > 0; depth++) {
        const stat = execFileSync("cat", ["/proc", String(pid), "stat"].join("/"), {
          encoding: "utf8",
        });
        // comm 필드가 공백을 포함할 수 있어 마지막 ')' 이후를 파싱
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
        const parent = Number.parseInt(rest[1], 10);
        if (!Number.isInteger(parent) || parent <= 0 || guarded.has(parent)) break;
        guarded.add(parent);
        pid = parent;
      }
    }
  } catch {
    // 부모 탐색 실패 시 최소한 자기 자신만 보호
  }
  return guarded;
}

/** PID 종료 (win: /T 로 자식 트리까지, posix: kill) */
function killPid(pid) {
  try {
    if (IS_WIN) {
      const out = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
      });
      return out.status === 0;
    }
    return spawnSync("kill", [String(pid)], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const guarded = selfProtectionSet();
let pids = findPids();

if (pids === null) {
  console.error(`[free-port] 포트 ${PORT} 점유 조회 실패 — 정리를 건너뜁니다(기존 동작 유지).`);
  process.exit(1);
}

if (pids.length === 0) {
  console.log(`[free-port] 포트 ${PORT} 비어 있음`);
  process.exit(0);
}

let failed = false;
for (const pid of pids) {
  if (guarded.has(pid)) {
    console.log(`[free-port] PID ${pid} 는 실행 프로세스 본인/부모 체인이라 보호합니다.`);
    continue;
  }
  const ok = killPid(pid);
  console.log(`[free-port] PID ${pid} 종료 ${ok ? "성공" : "실패"}`);
  if (!ok) failed = true;
}

// 재확인: 정리 후에도 점유가 남아 있으면 실패로 보고
pids = findPids();
if (pids && pids.length > 0) {
  console.error(`[free-port] 포트 ${PORT} 가 여전히 점유 중: PID ${pids.join(", ")}`);
  process.exit(1);
}
console.log(`[free-port] 포트 ${PORT} 확보 완료`);
if (failed) {
  console.log(
    `[free-port] 일부 종료 명령이 실패했지만 최종 재확인에서 포트 ${PORT} 는 확보됨 — 성공으로 처리`,
  );
}
// 최종 종료 코드는 '최종 재확인 결과'에만 근거한다(계약: 0 = 포트 비어 있음).
// taskkill 비정상 종료·점유자 자발적 종료 레이스에서도 && 체인이 실패하지 않게 하기 위함.
process.exit(0);