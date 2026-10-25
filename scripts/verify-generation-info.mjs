#!/usr/bin/env node
/// "생성 정보 표시" 계약 검증 (요구: 이미지가 생성되면 어떤 경로로 생성됐는지 표시).
///
/// 검증 대상:
///  1) 코어 state.json 에 provider/source 를 기록하는 순수 함수가 존재한다.
///  2) 수동 생성 IPC 3경로(Cloudflare/OpenAI/Puter)가 provider/source 를 기록한다.
///  3) 우선순위 생성 IPC 도 성공한 공급자를 기록한다 (기존 `_used` 폐기 금지).
///  4) app_get_status 가 provider/source 를 UI 로 전달한다.
///  5) UI 타입(WallpaperState/AppStatus)에 provider/source 가 있고 상태바에 "생성 정보"가 표시된다.
///  6) UI 의 setStatus 갱신이 provider/source 를 복사한다 (backend_used 만 갱신하면 표시가 stale).
///
/// 사용: node scripts/verify-generation-info.mjs [--red]
///   --red: 이번 수정 이전 형태(provider/source 미배선)를 메모리에서 재구성해 FAIL 을 재현한다.
import fs from "node:fs";
import path from "node:path";

const RED = process.argv.includes("--red");
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

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

// ── 파일 로드 ──
let wallpaper = read("crates/core/src/wallpaper.rs");
let scenario = read("crates/core/src/scenario.rs");
let tauri = read("src-tauri/src/lib.rs");
let ui = read("src-ui/App.tsx");

if (RED) {
  // 수정 이전 형태 재구성: 생성 정보 기록/표시 배선이 하나도 없던 상태.
  wallpaper = wallpaper
    .replace(/pub provider: Option<String>,[\s\S]*?pub source: Option<String>,/, "")
    .replace(/pub fn record_generation[\s\S]*?\n}\n/, "")
    .replace(/pub fn set_wallpaper_with\([\s\S]*?\n}\n/, "");
  scenario = scenario.replace(/pub fn generation_source_detail[\s\S]*?\n}\n/, "");
  scenario = scenario.replace(/pub fn as_id\(self\)[\s\S]*?\n    }\n/, "");
  tauri = tauri
    .replace(/\n\s*pub provider: Option<String>,[\s\S]*?pub source: Option<String>,\n/, "\n")
    .replace(/wallmagic_core::set_wallpaper_with\([\s\S]*?\.map_err\(err_to_string\)/g, "wallmagic_core::set_wallpaper(&path, monitor_id, pos).map_err(err_to_string)");
  ui = ui
    .replace(/\n\s*provider: string \| null;[\s\S]*?\n\s*source: string \| null;/, "")
    .replace(/\n\s*provider: string \| null;/, "")
    .replace(/\n\s*source: string \| null;/, "")
    .replace(/\n\s*provider: \w+\.provider,/, "")
    .replace(/\n\s*source: \w+\.source,/, "")
    .replace(/생성 정보:[^\n]*/g, "")
    // 5b(미리보기 패널 생성 정보) 역시 수정 이전 형태에는 없었다 —
    // 마커 주석으로 감싼 블록을 제거해 5b 두 항목이 Red 에서 FAIL 하도록 재구성한다.
    .replace(/\{\/\* gen-info:start[\s\S]*?\{\/\* gen-info:end \*\/\}\n?/g, "");
}

// ── 1) 코어: state 필드 + 순수 함수 ──
ok(
  "wallpaper.rs WallpaperState 에 provider/source 필드(serde default)",
  /pub provider: Option<String>/.test(wallpaper) &&
    /pub source: Option<String>/.test(wallpaper) &&
    /#\[serde\(default\)\]\s*\n\s*pub provider: Option<String>/.test(wallpaper) &&
    /#\[serde\(default\)\]\s*\n\s*pub source: Option<String>/.test(wallpaper),
);
ok(
  "wallpaper.rs 에 record_generation 순수 함수(공백 정규화 포함)",
  /pub fn record_generation\(/.test(wallpaper) && /filter\(\|s\| !s\.is_empty\(\)\)/.test(wallpaper),
);
ok(
  "wallpaper.rs set_wallpaper_with 가 record_generation 을 호출한다",
  /pub fn set_wallpaper_with\(/.test(wallpaper) &&
    /set_wallpaper_with\([\s\S]*?record_generation\(&mut state, provider, source\)/.test(wallpaper),
);
ok(
  "wallpaper.rs set_wallpaper 는 set_wallpaper_with(.., None, None) 로 위임",
  /pub fn set_wallpaper\([\s\S]*?set_wallpaper_with\(candidate_path, monitor_id, position, None, None\)/.test(
    wallpaper,
  ),
);
ok(
  "restore_wallpaper 는 복원 시 생성 정보를 지운다(오표시 방지)",
  /record_generation\(&mut state, None, None\);/.test(wallpaper),
);

// ── 2) 코어 시나리오: 공급자 id + 상세 설명 ──
ok(
  "scenario.rs ImageProvider::as_id 가 4종 식별자를 반환",
  /pub fn as_id\(self\)/.test(scenario) &&
    scenario.includes('"pollinations"') &&
    scenario.includes('"puter"') &&
    scenario.includes('"cloudflare-workers-ai"') &&
    scenario.includes('"openai"'),
);
ok(
  "scenario.rs generation_source_detail 이 모델명을 포함한다",
  /pub fn generation_source_detail\(/.test(scenario) && /model=\{\}/.test(scenario),
);
ok(
  "tick_scenario(시나리오 자동) 경로가 set_wallpaper_with 로 공급자를 기록",
  /let provider_id = used\.as_id\(\);/.test(scenario) &&
    /let detail = generation_source_detail\(&settings, used\);/.test(scenario) &&
    /set_wallpaper_with\(/.test(scenario),
);
ok(
  "tick_scenario 에서 `_used` 폐기(정보 유실) 흔적이 없다",
  !/_used, path\)/.test(scenario),
);

// ── 3) 수동 생성 IPC 3경로 ──
ok(
  'Cloudflare 수동 생성이 provider "cloudflare-workers-ai" 기록',
  /set_wallpaper_with\([\s\S]*?Some\("cloudflare-workers-ai"\)/.test(tauri),
);
ok(
  'OpenAI 수동 생성이 provider "openai" 기록',
  /set_wallpaper_with\([\s\S]*?Some\("openai"\)/.test(tauri),
);
ok(
  "Puter 수동 생성(apply_generated_image)이 label + 모델 상세를 기록",
  /label: Option<String>/.test(tauri) &&
    /model: Option<String>/.test(tauri) &&
    /Puter\.js txt2img/.test(tauri) &&
    /set_wallpaper_with\(&path, monitor_id, pos, Some\(label\), Some\(&detail\)\)/.test(tauri),
);
ok(
  "우선순위 생성 IPC 가 성공 공급자를 기록 (used 폐기 금지)",
  /generate_wallpaper_priority_impl[\s\S]{0,900}?let \(used, path\)/.test(tauri) &&
    /generate_wallpaper_priority_impl[\s\S]{0,1800}?set_wallpaper_with\(/.test(tauri),
);

// ── 4) 상태 조회 IPC ──
ok(
  "AppStatus 가 provider/source 를 직렬화한다",
  /pub struct AppStatus \{[\s\S]*?pub provider: Option<String>,[\s\S]*?pub source: Option<String>,/.test(
    tauri,
  ),
);
ok(
  "get_app_status 가 state.provider/source 를 전달한다",
  /provider: state\.provider,/.test(tauri) && /source: state\.source,/.test(tauri),
);

// ── 5) UI 타입 + 표시 ──
ok(
  "App.tsx WallpaperState 타입에 provider/source",
  /export interface WallpaperState \{[\s\S]*?provider: string \| null;[\s\S]*?source: string \| null;/.test(
    ui,
  ),
);
ok(
  "App.tsx AppStatus 타입에 provider/source",
  /export interface AppStatus \{[\s\S]*?provider: string \| null;[\s\S]*?source: string \| null;/.test(
    ui,
  ),
);
ok(
  "상태바에 생성 정보(공급자 + 경로 상세) 표시",
  /생성 정보:/.test(ui) && /\{providerLabel|status\?\.source/.test(ui),
);
ok(
  "Puter 생성 호출이 선택 모델을 백엔드로 전달(생성 정보에 모델 기록)",
  /apply_generated_image",\s*\{[\s\S]{0,400}?model:/.test(ui),
);

// ── 5b) 미리보기 패널(③)에도 생성 정보를 표시 ──
// 요구("미리보기에 생성 정보가 없어 Puter 로 생성됐는지 알 수 없다"): 상태바(footer)
// 하단만으로는 생성 직후 눈에 띄지 않으므로, ③ 미리보기 패널 안에서도
// 공급자 라벨 + 경로 상세를 항상 볼 수 있어야 한다.
const previewStart = ui.indexOf("<h2>③ 미리보기</h2>");
const previewEnd = previewStart >= 0 ? ui.indexOf("</aside>", previewStart) : -1;
const previewBlock =
  previewStart >= 0 && previewEnd > previewStart
    ? ui.slice(previewStart, previewEnd)
    : "";
ok(
  "미리보기 패널(③ 미리보기)에 생성 정보 블록이 있다",
  previewBlock.length > 0 && /생성 정보/.test(previewBlock),
);
ok(
  "미리보기 생성 정보가 공급자 라벨 + 경로 상세를 렌더한다",
  /생성 정보[\s\S]{0,900}?providerLabel\(/.test(previewBlock) &&
    /생성 정보[\s\S]{0,900}?status\?\.source/.test(previewBlock),
);

// ── 6) 상태 갱신이 provider/source 를 복사 ──
const statusCopies = ui.match(/backend_used: (\w+)\.backend_used,/g) ?? [];
const providerCopies = ui.match(/provider: (\w+)\.provider,/g) ?? [];
const sourceCopies = ui.match(/source: (\w+)\.source,/g) ?? [];
ok(
  `setStatus 갱신이 provider/source 도 복사한다 (backend_used ${statusCopies.length}회 / provider ${providerCopies.length}회)`,
  statusCopies.length > 0 &&
    providerCopies.length === statusCopies.length &&
    sourceCopies.length === statusCopies.length,
);

// ── 결과 ──
console.log("");
if (fails.length > 0) {
  console.log(`${fails.length} FAIL — 생성 정보 계약 미충족 (${pass} ok)`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass}항목 전부 ok — 생성 정보 표시 계약 통과`);
