// 앱 메타데이터 단일 소스 검증.
//
//   Cargo.toml([workspace.package])  ← 단일 소스
//     ├─ package.json                (version · license · author · repository)
//     ├─ src-tauri/tauri.conf.json   (version)
//     └─ LICENSE                     (연도 · 저작자)
//
// 세 파일의 버전이 어긋나면 About 표시·인스톨러 파일명·릴리스 태그가 서로 달라진다.
// 또한 Cargo.toml 주석이 이 스크립트를 "검증한다"고 참조하므로, 스크립트가 없으면
// 그 주석이 거짓이 된다(상용화 감사 P1-10).
//
// 실행: node scripts/verify-app-meta.mjs
import { readFileSync, existsSync } from "node:fs";

let fail = 0;
const ok = (m) => console.log("ok   " + m);
const bad = (m) => {
  fail += 1;
  console.log("FAIL " + m);
};
const eq = (label, actual, expected) => {
  if (actual === expected) ok(`${label} — ${JSON.stringify(actual)}`);
  else bad(`${label} — 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`);
};
const nonEmpty = (label, value) => {
  if (typeof value === "string" && value.trim() !== "") ok(`${label} — ${value}`);
  else bad(`${label} — 비어 있다 (${JSON.stringify(value)})`);
};

// ── 입력 ──────────────────────────────────────────────────────────────────
const cargo = readFileSync("Cargo.toml", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

const block = cargo.split("[workspace.package]")[1];
if (!block) {
  bad("Cargo.toml 에 [workspace.package] 가 없다");
}
const pick = (re) => {
  const m = block ? block.match(re) : null;
  return m ? m[1] : undefined;
};

const cargoVersion = pick(/^version\s*=\s*"([^"]+)"/m);
const cargoLicense = pick(/^license\s*=\s*"([^"]+)"/m);
const cargoAuthor = pick(/^authors\s*=\s*\[\s*"([^"]+)"/m);
const cargoRepo = pick(/^repository\s*=\s*"([^"]+)"/m);

// ── 1) 버전 단일 소스 ─────────────────────────────────────────────────────
nonEmpty("Cargo workspace version", cargoVersion);
eq("package.json version == Cargo version", pkg.version, cargoVersion);
eq("tauri.conf.json version == Cargo version", conf.version, cargoVersion);

// SemVer 형식 (MAJOR.MINOR.PATCH)
if (typeof cargoVersion === "string" && /^\d+\.\d+\.\d+$/.test(cargoVersion)) {
  ok(`Cargo version 이 SemVer 형식이다 — ${cargoVersion}`);
} else {
  bad(`Cargo version 이 MAJOR.MINOR.PATCH 형식이 아니다 — ${JSON.stringify(cargoVersion)}`);
}

// ── 2) 라이선스 단일 소스 ─────────────────────────────────────────────────
nonEmpty("Cargo license", cargoLicense);
eq("package.json license == Cargo license", pkg.license, cargoLicense);

// ── 3) 제작자 단일 소스 ───────────────────────────────────────────────────
nonEmpty("Cargo authors[0]", cargoAuthor);
eq("package.json author == Cargo authors[0]", pkg.author, cargoAuthor);

// ── 4) 저장소 URL 정합 (git+ prefix / .git suffix 정규화 후 비교) ──────────
const norm = (u) =>
  typeof u === "string"
    ? u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase()
    : undefined;
if (cargoRepo === undefined) {
  bad("Cargo.toml [workspace.package] 에 repository 가 없다");
} else if (!pkg.repository || !pkg.repository.url) {
  bad("package.json 에 repository.url 이 없다");
} else {
  eq("package.json repository.url == Cargo repository", norm(pkg.repository.url), norm(cargoRepo));
}

// ── 5) 멤버 크레이트가 단일 소스를 상속하는가 ─────────────────────────────
for (const member of ["crates/core/Cargo.toml", "src-tauri/Cargo.toml"]) {
  if (!existsSync(member)) {
    bad(`${member} 가 없다`);
    continue;
  }
  const text = readFileSync(member, "utf8");
  for (const field of [
    "version",
    "license",
    "authors",
    "repository",
    "description",
    "readme",
    "homepage",
    "keywords",
  ]) {
    const inherited = new RegExp(`^${field}\\.workspace\\s*=\\s*true`, "m").test(text);
    if (inherited) ok(`${member} — ${field} 상속(workspace)`);
    else bad(`${member} — ${field}.workspace = true 가 없다 (메타데이터가 분기된다)`);
  }
}

// ── 6) LICENSE 실재 + 저작자/연도 일치 ────────────────────────────────────
if (!existsSync("LICENSE")) {
  bad("LICENSE 파일이 없다 (GitHub 가 라이선스를 인식하지 못한다)");
} else {
  const license = readFileSync("LICENSE", "utf8");
  if (/^MIT License/m.test(license)) ok("LICENSE 가 MIT 전문이다");
  else bad("LICENSE 가 'MIT License' 로 시작하지 않는다");
  const copyright = license.match(/Copyright \(c\) (\d{4}) (\S+)/);
  if (!copyright) {
    bad("LICENSE 에 'Copyright (c) <연도> <저작자>' 형식이 없다");
  } else {
    eq("LICENSE 저작자 == Cargo authors[0]", copyright[2], cargoAuthor);
    const year = Number(copyright[1]);
    const nowYear = new Date().getFullYear();
    if (year >= 2020 && year <= nowYear) ok(`LICENSE 연도 — ${year}`);
    else bad(`LICENSE 연도가 비정상이다 — ${year} (현재 ${nowYear})`);
  }
}

// ── 7) 공개 필수 문서 실재 ────────────────────────────────────────────────
for (const doc of ["README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) {
  if (existsSync(doc)) ok(`공개 필수 문서 존재 — ${doc}`);
  else bad(`공개 필수 문서 누락 — ${doc}`);
}

// ── 8) 앱 식별자 ──────────────────────────────────────────────────────────
const ident = conf.identifier;
if (typeof ident === "string" && /^[A-Za-z0-9.-]+$/.test(ident) && ident.includes(".")) {
  ok(`tauri identifier — ${ident}`);
} else {
  bad(`tauri identifier 가 리버스 도메인 형식이 아니다 — ${JSON.stringify(ident)}`);
}

// ── 결과 ──────────────────────────────────────────────────────────────────
if (fail > 0) {
  console.log(`\nFAIL: 앱 메타데이터 계약 위반 ${fail}건`);
  process.exit(1);
}
console.log("\n모든 메타데이터 계약 통과");
process.exit(0);
