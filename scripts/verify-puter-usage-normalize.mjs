#!/usr/bin/env node
/// 검증: Puter 크레딧 정규화 — **실제 함수 실행** (소스 문자열 정규식 검사 아님)
///
/// 사용법:
///   node --experimental-strip-types scripts/verify-puter-usage-normalize.mjs
///   node --experimental-strip-types scripts/verify-puter-usage-normalize.mjs --git=HEAD
///
/// 이번 결함의 직접 원인(실측):
///   Puter `auth.getMonthlyUsage()` 원본 응답은
///     allowanceInfo: { remaining: 578.6956796329976, monthUsageAllowance: 1000, unit: "credits" }
///     usage: { total: 197.30925900804996, ... }
///   인데, 이전 구현은 **단위(unit)를 무시하고 microcents(1e8)로 나눠** 달러 표기했다.
///     → remaining 578.70 → "$0.0000", allowance 1000 → "$0.0000", 사용 197.31 → "$0.0000"
///   또한 사용량을 `allowance - remaining`(421.30) 으로 계산해 usage.total(197.31) 과 어긋났다.
///   이 스크립트는 위 **실제 응답을 그대로 넣고** 표시 문자열까지 대조한다.
///
/// `--git=<rev>` 모드:
///   그 리비전의 `src-ui/puterUsage.ts`(수정 전 버전)를 꺼내 임시 모듈로 실행한다.
///   즉 **수정 전 실제 코드**를 대상으로 같은 케이스를 돌려 Red 를 증명한다
///   (테스트를 위해 알고리즘을 다시 적은 것이 아니라, git 에서 꺼낸 원본 코드를 실행).
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const gitArg = process.argv.find((a) => a.startsWith("--git="));
const rev = gitArg ? gitArg.slice("--git=".length) : null;

const OLD_TMP = path.resolve("scripts/.tmp-puter-usage-old.ts");

/// 수정 전 버전(HEAD 등)에서 정규화 모듈을 꺼내 실행 가능한 임시 모듈로 만든다.
async function loadOldModule(revision) {
  const src = execFileSync("git", ["show", `${revision}:src-ui/puterUsage.ts`], {
    encoding: "utf8",
  });
  writeFileSync(OLD_TMP, src, "utf8");
  const mod = await import(pathToFileURL(OLD_TMP).href);
  return mod;
}

async function loadCurrentModule() {
  return import(pathToFileURL(path.resolve("src-ui/puterUsage.ts")).href);
}

/// **실측 원본 응답** — Puter getMonthlyUsage() 가 실제로 돌려준 JSON 그대로.
/// 이 객체를 넣고 화면 표시 문자열까지 맞는지 본다.
const REAL_RESPONSE = {
  usage: {
    total: 197.30925900804996,
    "openai:gpt-image-2:low:1024x1024:output": { units: 1960, cost: 188.16, count: 10 },
    "openai:gpt-image-2:low:1024x1024:input": { units: 128, cost: 2.048, count: 10 },
    "egress:bytes": { units: 19059077, cost: 7.10005946457386, count: 70 },
  },
  appTotals: {
    "app-26149f0b-8304-5228-b995-772dadcf410e": { total: 197.30805946457386, count: 90 },
  },
  allowanceInfo: {
    remaining: 578.6956796329976,
    monthUsageAllowance: 1000,
    addons: {},
    unit: "credits",
  },
};

/// 응답 형태별 기대 계약. `fn(mod)` 이 true 를 돌려주면 통과.
const CASES = [
  {
    name: "실측 응답의 남은/한도/사용을 원값 그대로 읽는다 (credits)",
    fn: (m) => {
      const s = m.puterUsageSummary(REAL_RESPONSE);
      return (
        s.remaining === 578.6956796329976 &&
        s.allowance === 1000 &&
        s.unit === "credits" &&
        Math.abs(s.spent - 197.30925900804996) < 1e-9
      );
    },
  },
  {
    name: "실측 응답 표시: 남은 크레딧 578.70 / 월 한도 1,000.00 (0 으로 절삭 금지)",
    fn: (m) => {
      const s = m.puterUsageSummary(REAL_RESPONSE);
      return (
        m.formatUsage(s.remaining, s.unit) === "578.70" &&
        m.formatUsage(s.allowance, s.unit) === "1,000.00"
      );
    },
  },
  {
    name: "실측 응답 표시: 사용 197.31 (allowance-remaining 의 421.30 이 아니다)",
    fn: (m) => {
      const s = m.puterUsageSummary(REAL_RESPONSE);
      return m.formatUsage(s.spent, s.unit) === "197.31" && s.spentPath === "usage.total";
    },
  },
  {
    name: "credits 단위 라벨은 ' credits' 이고 달러 기호를 붙이지 않는다",
    fn: (m) => m.usageUnitLabel("credits") === " credits" && m.usageUnitLabel(null) === "",
  },
  {
    name: "사용량은 usage.total 을 우선한다 (allowance-remaining 역산보다 먼저)",
    fn: (m) => {
      const s = m.puterUsageSummary(REAL_RESPONSE);
      return Math.abs(s.spent - 197.30925900804996) < 1e-9;
    },
  },
  {
    name: "usage.<api>.units 는 단위 표기로 오인하지 않는다",
    fn: (m) => {
      const s = m.puterUsageSummary(REAL_RESPONSE);
      return s.unit === "credits" && s.unitPath === "allowanceInfo.unit";
    },
  },
  {
    name: "단위 표기가 없는 구 응답은 microcents 로 해석한다 (하위 호환)",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1_000_000_000, remaining: 730_000_000 },
      });
      return (
        s.unit === null &&
        m.formatUsage(s.remaining, s.unit) === "$7.30" &&
        m.formatUsage(s.allowance, s.unit) === "$10.00"
      );
    },
  },
  {
    name: "dollars 단위 응답은 microcents 로 환산해 $ 표기한다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { unit: "dollars", monthUsageAllowance: 10, remaining: 5 },
      });
      return s.unit === "dollars" && m.formatUsage(s.remaining, s.unit) === "$5.00";
    },
  },
  {
    name: "result 로 감싼 응답도 읽는다 (SDK 래핑)",
    fn: (m) => {
      const s = m.puterUsageSummary({ result: REAL_RESPONSE });
      return s.remaining === 578.6956796329976 && s.unit === "credits";
    },
  },
  {
    name: "data 로 감싼 snake_case 응답도 읽는다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        data: {
          allowance_info: { month_usage_allowance: 1000, remaining: 578.6956796329976, unit: "credits" },
        },
      });
      return s.remaining === 578.6956796329976 && s.allowance === 1000;
    },
  },
  {
    name: "문자열로 직렬화된 숫자도 읽는다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: "1000", remaining: "578.6956796329976", unit: "credits" },
      });
      return s.allowance === 1000 && s.remaining === 578.6956796329976;
    },
  },
  {
    name: "remaining 이 없고 usage.total 이 있으면 역산한다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1000, unit: "credits" },
        usage: { total: 197.31 },
      });
      return Math.abs(s.remaining - 802.69) < 1e-9 && Math.abs(s.spent - 197.31) < 1e-9;
    },
  },
  {
    name: "빈 객체는 0 이 아니라 null 이다 (모름과 0 구분)",
    fn: (m) => {
      const s = m.puterUsageSummary({});
      return s.remaining === null && s.allowance === null && s.spent === null && s.unit === null;
    },
  },
  {
    name: "null/비객체 응답은 0 이 아니라 null 이다",
    fn: (m) => {
      const a = m.puterUsageSummary(null);
      const b = m.puterUsageSummary("nope");
      return a.remaining === null && b.allowance === null && m.formatUsage(null, null) === "알 수 없음";
    },
  },
  {
    name: "실제 0 크레딧은 null 이 아니라 0 이다",
    fn: (m) => {
      const s = m.puterUsageSummary({
        allowanceInfo: { monthUsageAllowance: 1000, remaining: 0, unit: "credits" },
      });
      return s.remaining === 0 && m.formatUsage(s.remaining, s.unit) === "0.00";
    },
  },
  {
    name: "값을 꺼낸 응답 경로를 남긴다 (진단용)",
    fn: (m) => {
      const s = m.puterUsageSummary(REAL_RESPONSE);
      return (
        s.remainingPath === "allowanceInfo.remaining" &&
        s.allowancePath === "allowanceInfo.monthUsageAllowance" &&
        s.unitPath === "allowanceInfo.unit" &&
        s.spentPath === "usage.total"
      );
    },
  },
  {
    name: "원본 응답은 화면 표시용 문자열로 직렬화된다 (진단)",
    fn: (m) => {
      const text = m.stringifyUsageRaw(REAL_RESPONSE);
      return typeof text === "string" && text.includes("allowanceInfo") && text.includes("credits");
    },
  },
];

let mod;
const warnings = [];
try {
  if (rev) {
    mod = await loadOldModule(rev);
    warnings.push(`대상 소스: git ${rev}:src-ui/puterUsage.ts (수정 전 버전)`);
  } else {
    mod = await loadCurrentModule();
    warnings.push("대상 소스: src-ui/puterUsage.ts (현재 작업 트리)");
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
