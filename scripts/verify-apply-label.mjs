#!/usr/bin/env node
/// "apply_generated_image 라벨 계약" 검증 — 무라벨 호출이 조용히 provider="puter" 로
/// 기록되어 "Pollinations 로 생성했는데 Puter 로 표시"되는 오표시를 차단한다.
///
/// 검증 항목:
///  1) Rust: label 기본값("puter")이 제거되고, 없으면 명시적 오류가 된다.
///  2) Rust: 공백 라벨도 오류로 처리한다(trim → 비면 오류).
///  3) Rust: 저장 파일명이 'puter_' 고정 접두어가 아니다(경로만 보고 오판 금지).
///  4) Rust: detail 문구가 라벨에 종속된다(라벨이 puter 가 아니면 Puter 문구를 쓰지 않는다).
///  5) UI: apply_generated_image 호출부 전부가 label 을 명시한다(생략 0건).
///
/// 사용:
///   node scripts/verify-apply-label.mjs                 # 현재 작업본 검사
///   node scripts/verify-apply-label.mjs --git=HEAD      # 실제 커밋 이력 검사(Red 증거)
///   node scripts/verify-apply-label.mjs --file=<path>   # 특정 스냅샷 검사
///
/// 증거 강도: --git/--file 은 저장소에 실제로 존재했던 소스를 그대로 읽으므로
/// 메모리 재구성보다 강하다. 모드 미지정 시에만 현재 작업본을 본다.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const gitArg = args.find((a) => a.startsWith("--git="));
const fileArg = args.find((a) => a.startsWith("--file="));

let lib;
let target;
if (gitArg) {
  const rev = gitArg.slice("--git=".length);
  target = `${rev}:src-tauri/src/lib.rs`;
  lib = execFileSync("git", ["show", target], { encoding: "utf8" });
} else if (fileArg) {
  target = fileArg.slice("--file=".length);
  lib = fs.readFileSync(target, "utf8");
} else {
  target = "src-tauri/src/lib.rs (작업본)";
  lib = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
}
const ui = fs.readFileSync("src-ui/App.tsx", "utf8");

console.log(`검사 대상: ${target}`);

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

// apply_generated_image_impl 본문만 잘라서 검사한다(다른 커맨드의 문자열 오탐 방지).
const implStart = lib.indexOf("pub fn apply_generated_image_impl");
const implEnd = implStart >= 0 ? lib.indexOf("\n}\n", implStart) : -1;
const impl = implStart >= 0 && implEnd > implStart ? lib.slice(implStart, implEnd) : "";

ok("apply_generated_image_impl 본문 추출", impl.length > 0);

// 1) 라벨 필수화 — 기본값("puter") 제거 + 명시적 오류
ok(
  "label 기본값(\"puter\")이 제거되어 무라벨을 조용히 통과시키지 않는다",
  impl.length > 0 && !/unwrap_or\("puter"\)/.test(impl),
);
ok(
  "label 이 없거나 비면 명시적 오류를 반환한다(무음 puter 둔갑 금지)",
  /\.ok_or_else\(\|\|\s*"apply_generated_image: label/.test(impl),
);

// 2) 공백 라벨 → 오류 (trim + is_empty 필터가 ok_or_else 앞에 있어야 한다)
ok(
  "공백 라벨도 오류로 처리한다 (trim → 비면 오류)",
  /\.map\(str::trim\)[\s\S]{0,80}?\.filter\(\|s\| !s\.is_empty\(\)\)[\s\S]{0,120}?\.ok_or_else\(/.test(
    impl,
  ),
);

// 3) 파일명 접두어 — 공급자와 무관한 'puter_' 고정 금지
ok(
  "저장 파일명이 'puter_' 고정 접두어가 아니다 (경로만 보고 공급자 오판 금지)",
  /format!\("generated_\{safe\}\.png"\)/.test(impl) && !/format!\("puter_\{safe\}\.png"\)/.test(impl),
);

// 4) detail 문구가 라벨에 종속
ok(
  "detail 문구가 라벨에 종속된다 (puter 아닌 라벨에 'Puter.js txt2img' 기록 금지)",
  /if label == "puter"/.test(impl) && /provider=\{label\}/.test(impl),
);

// 5) UI 호출부 전부 label 명시 (생략 0건)
const callRe = /invoke<WallpaperState>\("apply_generated_image",\s*\{([\s\S]{0,600}?)\}\)/g;
const calls = [...ui.matchAll(callRe)].map((m) => m[1]);
const labeled = calls.filter((body) => /label\s*:/.test(body));
ok(
  `UI의 apply_generated_image 호출부가 전부 label 을 명시한다 (호출 ${calls.length}건 / label ${labeled.length}건)`,
  calls.length > 0 && labeled.length === calls.length,
);

console.log("");
if (fails.length > 0) {
  console.log(`${fails.length} FAIL — apply_generated_image 라벨 계약 미충족 (${pass} ok)`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass}항목 전부 ok — apply_generated_image 라벨 계약 통과`);
