// 미리보기 "보기 형식 → 실제 렌더 크기" 계약 검증.
//
// 배경(사용자 보고): 미리보기가 너무 작게 보이고, 보기 형식(fit/actual/fill)을 바꿔도
// 크기가 그대로였다. 직접 원인은 두 가지였다.
//   ① `.preview` 컨테이너에 높이가 없고 (내용 높이 = 이미지 높이)
//   ② `.preview img { height: 180px }` 로 이미지 높이가 고정
// → 세 모드가 모두 180px 상자 안의 object-fit 차이로만 보였다.
//
// 이 스크립트는 그 회귀를 정적으로 차단한다:
//   - 이미지 높이가 고정 px(180px)로 되돌아가면 FAIL
//   - 컨테이너가 모드별로 다른 높이를 갖지 않으면 FAIL (fit/fill 이 같은 높이면 체감 차이 없음)
//   - actual 모드가 "원본 픽셀 + 스크롤" 계약을 잃으면 FAIL
//
// 사용법: node scripts/verify-preview-fit-size.mjs [styles.css 경로]
//   경로 인자를 받는 이유 — 수정 전 스냅샷(.multicode-backups/*)에 대해 실행해
//   Red(FAIL)를 재현할 수 있게 하기 위함이다.
import { readFileSync } from 'node:fs';

const cssPath = process.argv[2] || 'src-ui/styles.css';
const appPath = 'src-ui/App.tsx';

// 주석은 파서를 방해한다(선택자 그룹 사이에 낀 주석·쉼표). 주석을 **같은 길이의 공백**으로
// 치환해 줄 번호와 오프셋을 보존한 채 파싱한다. (주석을 지우면 뒤따르는 선택자가 앞 줄과 붙는다)
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) =>
  m.replace(/[^\n]/g, ' '),
);
const app = readFileSync(appPath, 'utf8');

let pass = 0;
let fail = 0;
const ok = (msg) => {
  console.log(`ok   ${msg}`);
  pass += 1;
};
const bad = (msg, detail) => {
  console.log(`FAIL ${msg}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
};

/**
 * 선택자에 해당하는 CSS 블록 본문을 모두 반환(없으면 null).
 *
 * `,` 로 묶인 **선택자 그룹**(`.a,\n.b { ... }`)도 인식한다 — 이 스크립트가 검사하는
 * `.preview.preview-fill` 은 `.preview:has(...)` 와 그룹으로 묶여 있어서, "선택자 + `{`" 만
 * 기대하는 단순 정규식으로는 매칭되지 않는다(그 오탐으로 1회 실패한 이력이 있다).
 */
function blocks(selector) {
  const target = selector.replace(/\s+/g, ' ').trim();
  const re = /(^|\n)[ \t]*([^{}]*?)\{([^{}]*)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(css)) !== null) {
    const list = m[2]
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (list.includes(target)) out.push(m[3]);
  }
  return out.length ? out : null;
}

/** 블록에서 `prop: value` 를 찾아 값만 반환. */
function decl(body, prop) {
  const re = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

// 1) 이미지 높이 고정 회귀 차단 — 180px 고정이 되살아나면 모드 차이가 사라진다.
const imgBlocks = blocks('.preview img');
if (!imgBlocks) {
  bad('.preview img 규칙이 있다');
} else {
  const fixed = imgBlocks
    .map((b) => decl(b, 'height'))
    .filter((v) => v && /^\d+px$/.test(v) && v !== '100%');
  if (fixed.length > 0) {
    bad(
      '미리보기 이미지 높이가 고정 px 이 아니다',
      `.preview img { height: ${fixed.join(', ')} } — 모드별 크기 차이가 사라진다`,
    );
  } else {
    const has100 = imgBlocks.some((b) => decl(b, 'height') === '100%');
    if (has100) ok('미리보기 이미지 높이가 컨테이너를 따른다 (height: 100%)');
    else bad('미리보기 이미지가 컨테이너 높이를 채운다', 'height: 100% 없음');
  }
}

// 2) 컨테이너가 뷰포트 비례 높이를 갖는다 (고정 px 만이면 창을 키워도 그대로).
const base = blocks('.preview');
if (!base) {
  bad('.preview 컨테이너 규칙이 있다');
} else {
  const heights = base.map((b) => decl(b, 'height')).filter(Boolean);
  const viewportScaled = heights.some((v) => /clamp\(|vh|%/.test(v));
  if (viewportScaled) ok(`.preview 기본 높이가 뷰포트 비례 (height: ${heights.join(', ')})`);
  else bad('.preview 높이가 뷰포트/비율에 반응한다', `height: ${heights.join(', ') || '없음'}`);
}

// 3) fit / fill 이 **서로 다른** 컨테이너 높이를 가져야 체감 차이가 생긴다.
//
// 1차 선택자는 **클래스**(`.preview.preview-fill` / `.preview.preview-actual`)다.
// `:has()` 는 Chromium 105+ 에서만 동작하므로, WebView2 버전이 낮은 환경에서는
// `:has` 단독 계약이면 보기 형식을 바꿔도 크기가 그대로가 된다(회귀 위험).
// `:has()` 는 폴백으로만 허용하고, 클래스 선택자가 없으면 FAIL 로 차단한다.
const fillBlock =
  blocks('.preview.preview-fill') || blocks('.preview:has(img[data-fit="fill"])');
const actualBlock =
  blocks('.preview.preview-actual') || blocks('.preview:has(img[data-fit="actual"])');

if (!blocks('.preview.preview-fill')) {
  bad(
    'fill 모드 컨테이너 높이가 클래스 선택자로 분기된다',
    '.preview.preview-fill 없음 — :has() 는 WebView2 105+ 에서만 동작하므로 1차 계약이 될 수 없다',
  );
} else if (!fillBlock) {
  bad('fill 모드 전용 컨테이너 높이 분기가 있다', 'fill 분기 규칙 없음');
} else {
  const fillH = fillBlock.map((b) => decl(b, 'height')).filter(Boolean)[0] || '';
  const baseH = (base || []).map((b) => decl(b, 'height')).filter(Boolean)[0] || '';
  if (fillH && fillH !== baseH) ok(`fill 모드가 fit 과 다른 높이를 쓴다 (fit=${baseH} / fill=${fillH})`);
  else bad('fill 모드 높이가 fit 과 다르다', `둘 다 ${fillH || '없음'} — 형식을 바꿔도 크기가 같아 보인다`);
}

if (!blocks('.preview.preview-actual')) {
  bad(
    'actual 모드 컨테이너 분기가 클래스 선택자로 있다',
    '.preview.preview-actual 없음 — :has() 단독 의존은 WebView2 버전에 취약하다',
  );
} else if (!actualBlock) {
  bad('actual 모드 전용 분기가 있다', 'actual 분기 규칙 없음');
} else {
  const body = actualBlock.join(';');
  const overflow = decl(body, 'overflow');
  if (overflow === 'auto' || overflow === 'scroll') ok('actual 모드 컨테이너가 스크롤을 허용한다');
  else bad('actual 모드가 스크롤로 원본을 보여준다', `overflow: ${overflow || '없음'}`);
}

// 4) 각 모드의 object-fit 계약.
const fillImg = blocks('.preview img[data-fit="fill"]');
if (fillImg && fillImg.some((b) => decl(b, 'object-fit') === 'cover')) {
  ok('fill 모드는 cover (잘림 허용)');
} else {
  bad('fill 모드가 object-fit: cover 를 쓴다');
}
const actualImg = blocks('.preview img[data-fit="actual"]');
if (actualImg) {
  const body = actualImg.join(';');
  const noClamp =
    decl(body, 'max-width') === 'none' && decl(body, 'max-height') === 'none';
  const natural = decl(body, 'width') === 'auto' && decl(body, 'height') === 'auto';
  if (noClamp && natural) ok('actual 모드는 원본 픽셀 그대로 (width/height auto, max 제한 없음)');
  else bad('actual 모드가 축소 없이 원본 크기로 그린다', body.replace(/\s+/g, ' ').trim());
} else {
  bad('actual 모드 이미지 규칙이 있다', '.preview img[data-fit="actual"] 없음');
}

// 5) UI 배선 — 선택값이 실제로 이미지/컨테이너에 전달되는가.
if (/data-fit=\{previewFit\}/.test(app)) ok('선택값이 data-fit 속성으로 이미지에 전달된다');
else bad('선택값이 data-fit 으로 전달된다', 'data-fit={previewFit} 없음');

if (/style=\{previewFitStyle\(previewFit\)\}/.test(app)) ok('선택값이 인라인 스타일에도 전달된다');
else bad('선택값이 previewFitStyle 에 전달된다');

const fitFn = app.match(/export function previewFitStyle[\s\S]*?\n\}/);
if (fitFn) {
  const fn = fitFn[0];
  const actualOk = /mode === "actual"[\s\S]*?maxWidth:\s*"none"/.test(fn);
  const fillOk = /mode === "fill"[\s\S]*?objectFit:\s*"cover"/.test(fn);
  const containOk = /objectFit:\s*"contain"/.test(fn);
  if (actualOk && fillOk && containOk) ok('previewFitStyle 이 세 모드를 서로 다르게 반환한다');
  else
    bad(
      'previewFitStyle 이 세 모드를 구분한다',
      `actual=${actualOk} fill=${fillOk} contain=${containOk}`,
    );
} else {
  bad('previewFitStyle 함수가 있다');
}

// 6) 미리보기 패널 폭 — 320px 이면 16:9 이미지가 손바닥만 해진다.
const studio = blocks('.studio');
const cols = studio ? decl(studio[0], 'grid-template-columns') : null;
const rightCol = cols ? cols.split(/\s+/).pop() : null;
const rightPx = rightCol ? parseInt(rightCol, 10) : NaN;
if (!Number.isNaN(rightPx) && rightPx >= 360) {
  ok(`미리보기 패널 폭 ${rightPx}px (>= 360px)`);
} else {
  bad('미리보기 패널 폭이 360px 이상', `grid-template-columns: ${cols || '없음'}`);
}

// 7) 세 모드 선택지가 사전 키로 노출된다(하드코딩 라벨 금지).
const i18n = readFileSync('src-ui/i18n.ts', 'utf8');
for (const key of ['preview.fitFit', 'preview.fitActual', 'preview.fitFill']) {
  if (i18n.includes(`"${key}"`)) ok(`i18n 키 존재: ${key}`);
  else bad(`i18n 키 존재: ${key}`);
}

console.log(`\n${pass}/${pass + fail} ok — 미리보기 보기형식 크기 분기 계약 ${fail === 0 ? '통과' : '실패'}`);
process.exit(fail === 0 ? 0 : 1);
