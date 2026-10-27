// 릴리스 준비 상태 검증 (npm run release:check 본체).
//
// 릴리스는 세 파일의 버전이 어긋나는 순간 조용히 깨진다 — About 표시 · 인스톨러 파일명 ·
// 릴리스 태그가 서로 달라지고, 사용자는 "1.0.0 인데 파일명은 1.0.1" 인 산출물을 받는다.
// 이 스크립트는 릴리스 직전에 그 정합과 산출물을 한 번에 확인한다.
//
// 검사 항목
//   ① 버전 단일 소스  Cargo.toml [workspace.package] · package.json · src-tauri/tauri.conf.json
//   ② CHANGELOG       현재 버전의 릴리스 섹션 + [Unreleased] + 승격 규칙
//   ③ 릴리스 스크립트 package.json scripts.release:build / release:check
//   ④ 번들 설정       tauri.conf.json bundle.active=true, targets 비어있지 않음
//   ⑤ 산출물          (--require-artifacts) NSIS/MSI 실재 + 파일명에 버전 포함
//
// 실행
//   node scripts/verify-release.mjs                    → 계약만 검사 (빌드 전에도 통과)
//   node scripts/verify-release.mjs --require-artifacts → 산출물까지 요구 (release:check)
//
// 종료: 실패 0건이면 exit 0, 하나라도 실패하면 exit 1.
import { readFileSync, existsSync, readdirSync } from "node:fs";

let fail = 0;
const ok = (m) => console.log("ok   " + m);
const bad = (m) => {
  fail += 1;
  console.log("FAIL " + m);
};

const requireArtifacts = process.argv.includes("--require-artifacts");

// ── ① 버전 단일 소스 ──────────────────────────────────────────────────────
const cargo = readFileSync("Cargo.toml", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

const block = cargo.split("[workspace.package]")[1] || "";
const versionMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
const cargoVersion = versionMatch ? versionMatch[1] : undefined;

if (cargoVersion === undefined) {
  bad("Cargo.toml [workspace.package] 에 version 이 없다");
} else {
  ok(`Cargo version — ${cargoVersion}`);
  if (/^\d+\.\d+\.\d+$/.test(cargoVersion)) ok(`SemVer 형식(MAJOR.MINOR.PATCH) — ${cargoVersion}`);
  else bad(`SemVer 형식이 아니다 — ${JSON.stringify(cargoVersion)}`);

  for (const [file, value] of [
    ["package.json", pkg.version],
    ["src-tauri/tauri.conf.json", conf.version],
  ]) {
    if (value === cargoVersion) ok(`${file} version == Cargo — ${value}`);
    else bad(`${file} version 불일치 — Cargo ${cargoVersion} / 실제 ${value}`);
  }
}

const version = cargoVersion || "0.0.0";

// ── ② CHANGELOG ───────────────────────────────────────────────────────────
const changelog = readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replace(/\./g, "\\.");

if (new RegExp(`^## \\[${escaped}\\]`, "m").test(changelog)) {
  ok(`CHANGELOG 에 [${version}] 릴리스 섹션이 있다`);
} else {
  bad(`CHANGELOG 에 [${version}] 릴리스 섹션이 없다 (Unreleased 를 승격해야 한다)`);
}

if (/^## \[Unreleased\]/m.test(changelog)) ok("CHANGELOG 에 [Unreleased] 블록이 있다");
else bad("CHANGELOG 에 [Unreleased] 블록이 없다");

if (/승격 규칙|Release promotion rule/.test(changelog)) {
  ok("CHANGELOG 에 릴리스 승격 규칙이 명시되어 있다");
} else {
  bad("CHANGELOG 에 릴리스 승격 규칙이 없다");
}

// ── ③ 릴리스 스크립트 ─────────────────────────────────────────────────────
const scripts = pkg.scripts || {};

const builder = scripts["release:build"];
if (typeof builder === "string" && builder.trim() !== "") ok(`package.json scripts.release:build — ${builder}`);
else bad("package.json scripts.release:build 가 없다");

if (typeof builder === "string" && /tauri build/.test(builder)) {
  ok("release:build 가 `tauri build` 를 호출한다");
} else {
  bad("release:build 가 `tauri build` 를 호출하지 않는다");
}

const checker = scripts["release:check"];
if (typeof checker === "string" && checker.trim() !== "") ok(`package.json scripts.release:check — ${checker}`);
else bad("package.json scripts.release:check 가 없다");

if (typeof checker === "string" && /verify-release\.mjs/.test(checker)) {
  ok("release:check 가 verify-release.mjs 를 호출한다");
} else {
  bad("release:check 가 verify-release.mjs 를 호출하지 않는다");
}

if (typeof checker === "string" && /--require-artifacts/.test(checker)) {
  ok("release:check 가 산출물 검증(--require-artifacts)을 포함한다");
} else {
  bad("release:check 가 --require-artifacts 없이 호출된다 (산출물 미확인)");
}

// ── ④ 번들 설정 ───────────────────────────────────────────────────────────
const bundle = conf.bundle || {};

if (bundle.active === true) ok("tauri bundle.active = true");
else bad(`tauri bundle.active 가 true 가 아니다 — ${JSON.stringify(bundle.active)}`);

const targets = bundle.targets;
const targetsOk =
  (typeof targets === "string" && targets.trim() !== "") ||
  (Array.isArray(targets) && targets.length > 0);
if (targetsOk) ok(`tauri bundle.targets — ${JSON.stringify(targets)}`);
else bad(`tauri bundle.targets 가 비어 있다 — ${JSON.stringify(targets)}`);

if (bundle.icon && bundle.icon.length > 0) ok(`bundle.icon ${bundle.icon.length}개`);
else bad("bundle.icon 이 비어 있다");

// ── ⑤ 산출물 ──────────────────────────────────────────────────────────────
// cargo target 디렉터리는 워크스페이스 루트와 크레이트 디렉터리 양쪽에 생길 수 있다.
// **두 곳 모두** 스캔한다 — 첫 발견 한 곳만 보면 다른 위치에 남은 이전 버전 산출물을
// 이번 릴리스로 오인하거나, 반대로 방금 만든 산출물을 놓친다.
const roots = ["target/release/bundle", "src-tauri/target/release/bundle"];

// 파일명에서 버전을 읽는다 (예: WallMagic_1.0.0_x64-setup.exe → "1.0.0").
// 접미 구분자를 **요구하지 않는다** — `_(x.y.z)` 뒤에 구분자가 오거나 문자열이 끝나면 매칭이다.
// 구분자를 필수로 두면 `WallMagic_1.0.0.exe` 처럼 버전으로 끝나는 파일명을 읽지 못해
// 현재 버전 산출물을 stale 로 오판하고, 계약 모드에서 "산출물 없음"으로 잘못 보고한다.
const versionInName = (file) => {
  const m = file.match(/_(\d+\.\d+\.\d+)(?:[_.-]|$)/);
  return m ? m[1] : undefined;
};

const all = [];
for (const root of roots) {
  for (const kind of ["nsis", "msi"]) {
    const dir = `${root}/${kind}`;
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const isInstaller =
        (kind === "nsis" && file.endsWith(".exe")) || (kind === "msi" && file.endsWith(".msi"));
      if (!isInstaller) continue;
      all.push({ kind, path: `${kind}/${file}`, fileVersion: versionInName(file) });
    }
  }
}

// "이번 릴리스의 산출물"과 "이전 버전 잔재"를 분리한다.
// 잔재는 실패 사유가 아니다 — 예전 빌드가 남긴 파일이지 이번 빌드의 결함이 아니기 때문이다.
// 대신 warn 으로 드러내 정리 대상을 알린다.
const currentArtifacts = all.filter((a) => a.fileVersion === version);
const staleArtifacts = all.filter((a) => a.fileVersion !== version);

for (const a of staleArtifacts) {
  console.log(
    `warn 이전 버전 산출물이 남아 있다 — ${a.path} (파일명 ${a.fileVersion ?? "버전 불명"} ≠ 현재 ${version})`
  );
}

if (currentArtifacts.length === 0) {
  const message = `현재 버전(${version}) 산출물이 없다 — \`npm run release:build\` 로 생성해야 한다`;
  if (requireArtifacts) bad(message);
  else console.log("info " + message + " (계약 검사만 수행)");
} else {
  ok(
    `현재 버전(${version}) 산출물 ${currentArtifacts.length}건 — ${currentArtifacts
      .map((a) => a.path)
      .join(", ")}`
  );

  for (const a of currentArtifacts) {
    if (a.fileVersion === undefined) bad(`산출물 파일명에서 버전을 읽지 못했다 — ${a.path}`);
    else ok(`산출물 파일명 버전 일치 — ${a.path}`);
  }

  // 현재 버전 산출물이 일부만 있을 때(예: MSI 만) 누락된 종류가 어디에도 출력되지 않으면
  // "통과했는데 인스톨러가 하나뿐" 인 상태를 알 수 없다. 계약 모드(비-require)에서도
  // info 로 드러내 릴리스 전에 정리 대상을 볼 수 있게 한다.
  const hasNsis = currentArtifacts.some((a) => a.kind === "nsis");
  const hasMsi = currentArtifacts.some((a) => a.kind === "msi");
  if (hasNsis) ok("NSIS 인스톨러가 있다");
  else if (requireArtifacts) bad("NSIS 인스톨러가 없다");
  else console.log(`info NSIS 인스톨러가 없다 — 현재 버전(${version}) 은 MSI 만 존재한다`);
  if (hasMsi) ok("MSI 인스톨러가 있다");
  else if (requireArtifacts) bad("MSI 인스톨러가 없다");
  else console.log(`info MSI 인스톨러가 없다 — 현재 버전(${version}) 은 NSIS 만 존재한다`);
}

if (staleArtifacts.length > 0) {
  console.log(
    `info 이전 버전 산출물 ${staleArtifacts.length}건은 릴리스 대상이 아니다 — 정리하려면 target 아래 bundle 디렉터리를 비운다`
  );
}

// ── 결과 ──────────────────────────────────────────────────────────────────
if (fail > 0) {
  console.log(`\nFAIL: 릴리스 계약 위반 ${fail}건`);
  process.exit(1);
}
console.log(
  requireArtifacts
    ? "\n릴리스 준비 완료 — 버전 정합 · CHANGELOG · 스크립트 · 번들 설정 · 산출물 전부 통과"
    : "\n릴리스 계약 통과 (산출물은 빌드 후 `npm run release:check` 로 확인)"
);
process.exit(0);
