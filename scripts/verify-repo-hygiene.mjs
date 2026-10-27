// 공개 저장소 위생 검증 — 추적 파일 목록과 내용에 비밀정보·빌드 산출물·
// 로컬 절대경로(개인 계정명)가 남아 있지 않은지 확인한다.
//
// 실행: node scripts/verify-repo-hygiene.mjs [추가로-내용검사할-파일]
//
// 배경: 2026-10-27 공개 준비 중 docs/VERIFY_M1.md 에 실제 Windows 계정명이 들어간
//       사용자 프로필 경로가 남아 있었다. 사람이 grep 으로 매번 확인하는 방식은
//       빠뜨리기 쉬우므로, 추적 파일 전체를 기계적으로 검사해 재발을 막는다.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

let fail = 0;
const ok = (m) => console.log("ok   " + m);
const bad = (m) => {
  fail += 1;
  console.log("FAIL " + m);
};

// ── 검사 패턴 ─────────────────────────────────────────────────────────────
// 리터럴을 문자열 결합으로 조립한다. 이 파일 자신도 스캔 대상이므로, 완성된
// 패턴이 파일 안에 그대로 들어 있으면 자기 자신을 검출해 버린다.
const SECRET_PATTERNS = [
  ["Google API 키", new RegExp("AI" + "za[0-9A-Za-z_-]{35}")],
  ["GitHub 토큰(classic)", new RegExp("gh" + "p_[A-Za-z0-9]{36}")],
  ["GitHub 토큰(fine-grained)", new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}")],
  ["AWS 액세스 키", new RegExp("AK" + "IA[0-9A-Z]{16}")],
  ["PEM 개인키", new RegExp("-{5}BEGIN " + "[A-Z ]*PRIVATE KEY-{5}")],
  ["OpenAI 키 형태", new RegExp("s" + "k-[A-Za-z0-9]{32,}")],
];

// `<user>` 처럼 마스킹된 표기는 허용하고, 실제 계정명이 남은 경우만 잡는다.
const LOCAL_PATH_PATTERNS = [
  ["Windows 사용자 프로필 경로", /[A-Za-z]:\\Users\\(?!<)[A-Za-z0-9._$-]/],
  ["로컬 체크아웃 경로", /[A-Za-z]:\\Github\\/i],
  ["POSIX 홈 디렉터리 경로", /\/(?:home|Users)\/(?!<)[a-z][a-z0-9._-]*\//],
];

const TRACKED_PATH_RULES = [
  ["Rust 빌드 산출물(target/)", /(?:^|\/)target\//],
  ["프론트 빌드 산출물(dist/, dist-ssr/)", /(?:^|\/)dist(?:-ssr)?\//],
  ["node_modules", /(?:^|\/)node_modules\//],
  ["도구 자동 백업(.multicode-backups/)", /(?:^|\/)\.multicode-backups\//],
  ["로그 파일(*.log)", /\.log$/i],
  ["환경변수 파일(.env)", /(?:^|\/)\.env(?:\.[^/]+)?$/],
];

// ── 1) 추적 파일 목록 ─────────────────────────────────────────────────────
let tracked = [];
try {
  tracked = execSync("git ls-files", { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (e) {
  bad(`git ls-files 실행 실패 — ${e.message}`);
}

if (tracked.length === 0) {
  bad("추적 파일이 0개다 — git 저장소가 아니거나 ls-files 가 실패했다(검사 무효)");
} else {
  ok(`추적 파일 ${tracked.length}개`);
}

// ── 2) 추적 경로 규칙 ─────────────────────────────────────────────────────
let pathViolations = 0;
for (const file of tracked) {
  if (file === ".env.example") continue; // 예시 파일은 커밋 허용
  for (const [name, re] of TRACKED_PATH_RULES) {
    if (re.test(file)) {
      bad(`추적 경로 위반 — ${name}: ${file}`);
      pathViolations += 1;
    }
  }
}
if (pathViolations === 0) {
  ok("빌드 산출물·자동 백업·로그·.env 가 추적되지 않는다");
}

// ── 3) 내용 검사 ──────────────────────────────────────────────────────────
// 두 번째 인자는 "Red 재현용" 추가 검사 파일이다. 저장소를 건드리지 않고
// 검사기가 실제로 잡아내는지 확인할 때 쓴다.
const extra = process.argv[2];
const scanList = [...tracked];
if (extra) {
  if (existsSync(extra)) scanList.push(extra);
  else bad(`추가 검사 파일이 없다 — ${extra}`);
}

let scanned = 0;
let secretHits = 0;
let pathHits = 0;

for (const file of scanList) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // 추적 목록에 있으나 작업 트리에 없는 파일(삭제 예정 등)
  }
  if (text.includes("\u0000")) continue; // 바이너리(아이콘·이미지)는 대상 아님
  scanned += 1;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(line)) {
        bad(`비밀정보 의심(${name}) — ${file}:${i + 1}`);
        secretHits += 1;
      }
    }
    for (const [name, re] of LOCAL_PATH_PATTERNS) {
      if (re.test(line)) {
        bad(`로컬 경로·개인 계정명 노출(${name}) — ${file}:${i + 1}`);
        pathHits += 1;
      }
    }
  }
}

if (secretHits === 0) ok(`비밀정보 패턴 0건 (${SECRET_PATTERNS.length}종 검사)`);
if (pathHits === 0) ok(`로컬 절대경로·개인 계정명 0건 (${LOCAL_PATH_PATTERNS.length}종 검사)`);

console.log(
  `TRACKED=${tracked.length} SCANNED=${scanned} SECRET_HITS=${secretHits} PATH_HITS=${pathHits}`,
);

if (fail === 0) {
  console.log("모든 저장소 위생 계약 통과");
  process.exit(0);
}
console.log(`실패 ${fail}건`);
process.exit(1);
