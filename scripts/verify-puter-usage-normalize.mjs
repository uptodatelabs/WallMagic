#!/usr/bin/env node
/// 검증: Puter 크레딧 정규화 — **실제 함수 실행** (소스 문자열 정규식 검사 아님)
///
/// 사용법:
///   node --experimental-strip-types scripts/verify-puter-usage-normalize.mjs
///   node --experimental-strip-types scripts/verify-puter-usage-normalize.mjs --git=HEAD
///
/// 왜 이 스크립트가 필요한가:
///   기존 verify-provider-toggle-credit.mjs 는 App.tsx 의 **소스 문자열**만 검사했다.
///   그래서 "크레딧이 전부 0 으로 표시" 결함(실제 응답이 래핑/문자열/snake_case 로 오면
///   고정 경로 조회가 null 로 떨어짐)을 잡지 못했다. 이 스크립트는 순수 모듈
///   src-ui/puterUsage.ts 를 실제로 import 해 응답 형태별 기대값과 대조한다.
///
/// `--git=<rev>` 모드:
///   그 리비전의 App.tsx 에서 동일 함수 블록을 추출해 임시 .ts 로 만들고 실행한다.
///   즉 **수정 전 실제 코드**를 대상으로 같은 케이스를 돌려 Red 를 증명한다
///   (테스트를 위해 알고리즘을 다시 적은 것이 아니라, git 에서 꺼낸 원본 코드를 실행).
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const gitArg = process.argv.find((a) => a.startsWith("--git="));
const rev = gitArg ? gitArg.slice("--git=".length) : null;

const OLD_TMP = path.resolve("scripts/.tmp-puter-usage-old.ts");

/// 수정 전 코드(HEAD 등)에서 정규화 함수 블록을 추출해 모듈로 만든다.
async function loadOldModule(revision) {
  const src = execFileSync("git", ["show", `${revision}:src-ui/App.tsx`], {
    encoding: "utf8",
  });
  const start = src.indexOf("const PUTER_MICROCENTS_PER_CENT");
  const end = src.indexOf("/// 로그인 세션으로 Puter 월간 사용량");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`${revision}:src-ui/App.tsx 에서 정규화 블록을 찾지 못했습니다`);
  }
  // export 를 제거하면 import 결과가 빈 모듈이 되어 모든 케이스가
  // "is not a function" 으로 실패한다(대조가 아니라 로드 실패). export 를 유지한다.
  const block = src.slice(start, end);
  writeFileSync(OLD_TMP, block, "utf8");
  const mod = await import(pathToFileURL(OLD_TMP).href);
  return mod;
}

async function loadCurrentModule() {
  return import(pathToFileURL(path.resolve("src-ui/puterUsage.ts")).href);
}

/// 응답 형태별 기대 계약. `fn(mod)` 이 true 를 돌려주면 통과.
const CASES = [
  {
    name: "공식 응답(allowanceInfo)에서 남은/한도/사용을 읽는다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1_000_000_000, remaining: 730_000_000 },
      });
      return s.remaining === 730_000_000 && s.allowance === 1_000_000_000 && s.spent === 270_000_000;
    },
  },
  {
    name: "result 로 감싼 응답도 읽는다 (SDK 래핑)",
    fn: (m) => {
      const s = m.puterUsageSummary({
        result: { allowanceInfo: { monthUsageAllowance: 1_000_000_000, remaining: 730_000_000 } },
      });
      return s.remaining === 730_000_000 && s.allowance === 1_000_000_000;
    },
  },
  {
    name: "data 로 감싼 snake_case 응답도 읽는다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        data: { allowance_info: { month_usage_allowance: 1_000_000_000, remaining: 730_000_000 } },
      });
      return s.remaining === 730_000_000 && s.allowance === 1_000_000_000;
    },
  },
  {
    name: "문자열로 직렬화된 숫자도 읽는다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: "100000000", remaining: "73000000" },
      });
      return s.remaining === 73_000_000 && s.allowance === 100_000_000 && s.spent === 27_000_000;
    },
  },
  {
    name: "remaining 이 없고 usage.total 이 있으면 역산한다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1_000_000_000 },
        usage: { total: 250_000_000 },
      });
      return s.remaining === 750_000_000 && s.spent === 250_000_000;
    },
  },
  {
    name: "빈 객체는 0 이 아니라 null 이다 (모름과 0 구분)",
    fn: (m) => {
      const s = m.puterUsageSummary({});
      return s.remaining === null && s.allowance === null && s.spent === null;
    },
  },
  {
    name: "null/비객체 응답은 0 이 아니라 null 이다",
    fn: (m) => {
      const a = m.puterUsageSummary(null);
      const b = m.puterUsageSummary("nope");
      return a.remaining === null && b.allowance === null;
    },
  },
  {
    name: "실제 0 크레딧은 null 이 아니라 0 이다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1_000_000_000, remaining: 0 },
      });
      return s.remaining === 0 && s.spent === 1_000_000_000;
    },
  },
  {
    name: "값을 꺼낸 응답 경로를 남긴다 (진단용)",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1_000_000_000, remaining: 730_000_000 },
      });
      return (
        s.remainingPath === "allowanceInfo.remaining" &&
        s.allowancePath === "allowanceInfo.monthUsageAllowance"
      );
    },
  },
  {
    name: "formatMicrocents 는 $ 표기 + 1센트 미만은 4자리",
    fn: (m) => {
      return (
        m.formatMicrocents(730_000_000) === "$7.30" &&
        m.formatMicrocents(0) === "$0.00" &&
        m.formatMicrocents(null) === "알 수 없음" &&
        m.formatMicrocents(500_000) === "$0.0050"
      );
    },
  },
  {
    name: "원본 응답은 화면 표시용 문자열로 직렬화된다 (진단)",
    fn: (m) => {
      const text = m.stringifyUsageRaw({ allowanceInfo: { remaining: 1 } });
      return typeof text === "string" && text.includes("allowanceInfo") && text.includes("remaining");
    },
  },
];

let mod;
const warnings = [];
try {
  if (rev) {
    mod = await loadOldModule(rev);
    warnings.push(`대상 소스: git ${rev}:src-ui/App.tsx 에서 추출한 실제 함수`);
  } else {
    mod = await loadCurrentModule();
    warnings.push("대상 소스: src-ui/puterUsage.ts (순수 모듈)");
  }
} finally {
  if (rev) rmSync(OLD_TMP, { force: true });
}

console.log("=== Puter 크레딧 정규화 실행 검증 ===");
for (const w of warnings) console.log(`  (${w})`);

let fail = 0;
for (const c of CASES) {
  let ok = false;
  let detail = "";
  try {
    ok = c.fn(mod) === true;
  } catch (err) {
    detail = ` — ${err && err.message ? err.message : String(err)}`;
  }
  if (ok) {
    console.log(`  ok   ${c.name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${c.name}${detail}`);
  }
}

const total = CASES.length;
console.log(`\n${total - fail}/${total} 통과`);
if (fail > 0) {
  console.log(`[FAIL] Puter 크레딧 정규화 계약 ${fail}건 미충족`);
  process.exit(1);
}
console.log("[PASS] Puter 크레딧 정규화 계약 통과 (실제 함수 실행)");
