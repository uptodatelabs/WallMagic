#!/usr/bin/env node
// [verify] 생성 파일 자체의 생성 정보(사이드카) 기록·표시 계약
//
// 원인: "② 생성"(generate_library_wallpaper)은 이미지 파일만 만들고 배경을 적용하지 않아
//       state.json이 갱신되지 않는다. UI의 "생성 정보 (현재 배경)"은 state.json만 보므로,
//       Pollinations로 방금 생성한 파일을 미리보고 있어도 13:02의 Puter 기록이 그대로 보였다.
// 계약: 생성 파일마다 사이드카(<원본 파일명>.geninfo.json)에 provider/source를 기록하고,
//       미리보기(선택된 후보)는 그 파일 자체의 생성 정보를 표시한다.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const gitArg = args.find((a) => a.startsWith("--git="));
let app, searchRs, wallpaperRs, libRs;
let label = "현재 작업본";
const readGit = (rev, file) =>
  execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" });
if (gitArg) {
  const rev = gitArg.slice("--git=".length);
  app = readGit(rev, "src-ui/App.tsx");
  searchRs = readGit(rev, "crates/core/src/search.rs");
  wallpaperRs = readGit(rev, "crates/core/src/wallpaper.rs");
  libRs = readGit(rev, "src-tauri/src/lib.rs");
  label = `git ${rev}`;
} else {
  app = readFileSync("src-ui/App.tsx", "utf8");
  searchRs = readFileSync("crates/core/src/search.rs", "utf8");
  wallpaperRs = readFileSync("crates/core/src/wallpaper.rs", "utf8");
  libRs = readFileSync("src-tauri/src/lib.rs", "utf8");
}

let fails = 0;
const check = (name, fn) => {
  try {
    if (fn()) console.log("ok   " + name);
    else {
      console.log("FAIL " + name);
      fails++;
    }
  } catch (e) {
    console.log("FAIL " + name + " — " + e.message);
    fails++;
  }
};

console.log(`검사 대상: ${label}`);
check(
  "WallpaperCandidate 에 생성 정보 필드(gen_provider/gen_source)가 있다",
  () => searchRs.includes("pub gen_provider") && searchRs.includes("pub gen_source"),
);
check(
  "load_candidate 가 사이드카 생성 정보를 후보에 넣는다",
  () => {
    const start = searchRs.indexOf("pub fn load_candidate");
    return /read_generation_sidecar/.test(searchRs.slice(start, start + 2600));
  },
);
check(
  "generate_library_wallpaper(Pollinations) 가 생성 파일에 사이드카를 기록한다",
  () => {
    const start = searchRs.indexOf("pub fn generate_library_wallpaper");
    return /write_generation_sidecar/.test(searchRs.slice(start, start + 2200));
  },
);
check(
  "core wallpaper.rs 에 사이드카 경로·쓰기·읽기 함수가 있다",
  () =>
    wallpaperRs.includes("pub fn generation_sidecar_path") &&
    wallpaperRs.includes("pub fn write_generation_sidecar") &&
    wallpaperRs.includes("pub fn read_generation_sidecar"),
);
check(
  "set_wallpaper_with 가 적용(스테이징) 파일에도 사이드카를 남긴다",
  () => {
    const start = wallpaperRs.indexOf("pub fn set_wallpaper_with");
    const end = wallpaperRs.indexOf("pub fn restore_wallpaper");
    return /write_generation_sidecar/.test(wallpaperRs.slice(start, end));
  },
);
check(
  "apply_generated_image(WebView 생성) 도 사이드카를 기록한다",
  () => {
    const start = libRs.indexOf("fn apply_generated_image_impl");
    return /write_generation_sidecar/.test(libRs.slice(start, start + 3200));
  },
);
check(
  "UI 타입에 gen_provider/gen_source 가 반영되어 있다",
  () => app.includes("gen_provider") && app.includes("gen_source"),
);
check(
  "UI 는 미리보기 파일 자체의 생성 정보를 표시한다(현재 배경과 분리)",
  () => app.includes("생성 정보 (미리보기 파일)"),
);

if (fails) {
  console.log(`${fails} FAIL — 생성 파일 귀속(사이드카) 계약 미충족`);
  process.exit(1);
}
console.log(`${8}항목 전부 ok — 생성 파일 귀속(사이드카) 계약 통과`);