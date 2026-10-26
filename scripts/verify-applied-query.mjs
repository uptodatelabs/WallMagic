#!/usr/bin/env node
// 검증: 적용 기록(state.source) → **실제 사용된 검색어** 추출 계약.
//
// 배경 (검수 지적 [low]):
//   이전 구현은 `·\s*query:\s*([^·]+)` 정규식으로 검색어를 뽑았다. `[^·]+` 는 첫 '·'
//   에서 절단되므로, 검색어에 '·' 가 들어가면 UI 표기가 실제 검색어의 앞부분만 된다
//   (= "표기 = 실제" 계약 위반).
//
//   소스 문자열 정규식 검사는 이 결함을 잡지 못한다(정규식이 그대로 있으면 통과).
//   그래서 파싱을 `src-ui/appliedQuery.ts` 순수 모듈로 분리하고, 이 스크립트가
//   **함수를 실제로 실행**해 계약을 검증한다.
//
// 실행:
//   node --experimental-strip-types scripts/verify-applied-query.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = path.resolve("src-ui/appliedQuery.ts");
if (!fs.existsSync(modulePath)) {
  console.error(`  FAIL 모듈이 없습니다 — ${modulePath}`);
  process.exit(1);
}

const { parseAppliedSearchQuery } = await import(pathToFileURL(modulePath).href);

let pass = 0;
let fail = 0;
function check(name, fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name} — throw: ${err && err.message}`);
    return;
  }
  if (result === true) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${typeof result === "string" ? ` — ${result}` : ""}`);
  }
}

/** 이전 구현(구 정규식) 그대로 — Red 대조용. */
function legacyParse(source) {
  return /·\s*query:\s*([^·]+)/.exec(source ?? "")?.[1]?.trim() || null;
}

check("적용 기록에서 검색어를 추출한다 (후행 ' · priority' 접미사 제거)", () => {
  const got = parseAppliedSearchQuery(
    "Search · online image search · query: sunset over mountains · priority",
  );
  return got === "sunset over mountains" ? true : `got=${JSON.stringify(got)}`;
});

check("검색어 내부의 '·' 를 보존한다 (첫 '·' 에서 절단하지 않는다)", () => {
  const source = "Search · online image search · query: neon · rain · city · priority";
  const got = parseAppliedSearchQuery(source);
  if (got !== "neon · rain · city") return `got=${JSON.stringify(got)}`;
  // 같은 입력에서 구 정규식은 앞부분만 돌려준다 = 표기≠실제 (Red 근거).
  const old = legacyParse(source);
  if (old === got) return `구 정규식도 동일 값을 반환함(대조 실패) — old=${JSON.stringify(old)}`;
  return true;
});

check("후행 접미사가 없어도 검색어 전체를 반환한다", () => {
  const got = parseAppliedSearchQuery("Search · online · query: aurora borealis");
  return got === "aurora borealis" ? true : `got=${JSON.stringify(got)}`;
});

check("검색어 앞뒤 공백을 정리한다", () => {
  const got = parseAppliedSearchQuery("Search · online · query:   misty harbor   · priority");
  return got === "misty harbor" ? true : `got=${JSON.stringify(got)}`;
});

check("검색어가 없으면 null (호출부가 기본값으로 폴백)", () => {
  const got = parseAppliedSearchQuery("Pollinations · free image generation");
  return got === null ? true : `got=${JSON.stringify(got)}`;
});

check("source 가 비어 있거나 없으면 null", () => {
  const a = parseAppliedSearchQuery("");
  const b = parseAppliedSearchQuery(undefined);
  const c = parseAppliedSearchQuery(null);
  return a === null && b === null && c === null
    ? true
    : `got=${JSON.stringify([a, b, c])}`;
});

check("구 기록 형식('·' 없이 'query:')도 읽는다", () => {
  const got = parseAppliedSearchQuery("Search · query: legacy keyword · priority");
  return got === "legacy keyword" ? true : `got=${JSON.stringify(got)}`;
});

check("'query:' 마커만 있고 값이 없으면 null (빈 문자열 표기 금지)", () => {
  const got = parseAppliedSearchQuery("Search · online · query:   ");
  return got === null ? true : `got=${JSON.stringify(got)}`;
});

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
