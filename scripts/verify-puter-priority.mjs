#!/usr/bin/env node
/// "Puter 도달 가능성" 계약 검증.
///
/// 배경(사용자 신고: "Puter 로그인했는데 기존 무료 방식으로 생성되는 것 같다"):
///   기본 순서 `FREE_FIRST_ORDER = PROVIDERS.map(...)` 는
///   `[pollinations, puter, cloudflare-workers-ai, openai]` 이고,
///   Pollinations 는 키가 필요 없어 `provider_is_configured` 가 항상 true 다.
///   따라서 기존 구현(`const order = [...scProviderOrder]`)은
///   '우선순위로 생성·적용'에서 Pollinations 가 먼저 성공 → `break` 되어
///   Puter 가 시도조차 되지 않았다(사용자에게는 "무료 방식으로 생성됨"으로 보인다).
///
/// 검증 항목:
///  1) 시도 순서가 '선택한 공급자(scProvider) 우선'으로 구성된다.
///  2) 폴백 자리의 puter 는 로그인 상태가 아니면 팝업을 띄우지 않고 건너뛴다.
///  3) 건너뛴 사유가 failedBefore 에 누적되어 사용자 메시지에 표시된다(무음 스킵 금지).
///  4) 성공 시에도 앞선 실패/스킵 사유가 메시지에 포함된다.
///
/// 사용: node scripts/verify-puter-priority.mjs [--red]
///   --red: 수정 이전 형태(주문 그대로 + puter 로그인 가드 없음)를 메모리에서 재구성해 FAIL 재현.
import fs from "node:fs";
import path from "node:path";

const RED = process.argv.includes("--red");
const file = path.join(process.cwd(), "src-ui", "App.tsx");
let ui = fs.readFileSync(file, "utf8");

if (RED) {
  // 수정 이전 형태 재구성 — ① 순서는 저장된 배열 그대로 ② puter 로그인 가드 없음.
  ui = ui.replace(
    /const order = \[scProvider, \.\.\.scProviderOrder\.filter\(\(id\) => id !== scProvider\)\];/,
    "const order = [...scProviderOrder];",
  );
  // puter 로그인 가드 블록 제거 — 실제 코드는 `if (scProvider !== "puter") { ... }` 형태라
  // 정규식 한 줄 매칭이 어긋나므로, 들여쓰기 기준으로 블록 경계를 찾아 통째로 제거한다.
  const lines = ui.split("\n");
  const guardStart = lines.findIndex((l) => l.includes('if (scProvider !== "puter") {'));
  if (guardStart >= 0) {
    const indent = lines[guardStart].match(/^\s*/)[0];
    let guardEnd = guardStart + 1;
    while (guardEnd < lines.length && lines[guardEnd] !== `${indent}}`) guardEnd += 1;
    lines.splice(guardStart, guardEnd - guardStart + 1);
    ui = lines.join("\n");
  }
}

// handleGeneratePriority 본문만 잘라 검사한다(다른 핸들러의 유사 코드 오탐 방지).
const start = ui.indexOf("const handleGeneratePriority");
const end = ui.indexOf("const handlePuterSignIn", start + 1);
const body = start >= 0 && end > start ? ui.slice(start, end) : "";

let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL ${name}`);
  }
};

ok(
  "handleGeneratePriority 본문 추출 (핸들러 경계 확인)",
  body.length > 0 && body.includes('id === "puter"'),
);

ok(
  "시도 순서가 선택한 공급자(scProvider) 우선으로 구성된다",
  /const order = \[scProvider, \.\.\.scProviderOrder\.filter\(\(id\) => id !== scProvider\)\]/.test(
    body,
  ),
);

ok(
  "폴백 자리 puter 는 로그인 상태가 아니면 팝업 없이 건너뛴다",
  body.includes('scProvider !== "puter"') &&
    /await puterIsSignedIn\(\(\) =>/.test(body) &&
    /auth\.isSignedIn \? auth\.isSignedIn\(\) : false/.test(body),
);

ok(
  "건너뛴 사유가 failedBefore 에 누적된다 (무음 스킵 금지)",
  /failedBefore\.push\(`\$\{providerLabel\(id\)\}: 로그인 상태 아님 — 건너뜀`\)/.test(body),
);

ok(
  "건너뛸 때 다음 공급자로 진행한다 (continue)",
  /failedBefore\.push[\s\S]{0,200}?continue;/.test(body),
);

ok(
  "성공 시에도 앞선 실패·스킵 사유를 메시지에 포함한다",
  /failedBefore\.length > 0 \? ` · 앞선 실패: \$\{failedBefore\.join\(" \/ "\)\}`/.test(body),
);

console.log("");
if (fails.length > 0) {
  console.log(`${fails.length} FAIL — Puter 도달 가능성 계약 미충족 (${pass} ok)`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass}항목 전부 ok — Puter 도달 가능성 계약 통과`);
