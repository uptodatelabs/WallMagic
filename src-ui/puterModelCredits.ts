/// Puter 이미지 모델별 1회당 크레딧(단가) 표시 (React·DOM·Tauri 비의존 순수 모듈).
///
/// 왜 분리했나:
///  - `App.tsx` 안에 두면 정규식 문자열 검사만 가능해 "0 으로 표시" 같은 결함을 놓친다.
///    순수 모듈로 떼어내면 `scripts/verify-puter-model-credits.mjs` 가 **함수를 실제 실행**해
///    기대값과 대조할 수 있다 (node 에서 React 없이 동작).
///  - 단가는 "실측 / 미확인"을 구분해야 한다. 모르는 값을 그럴듯한 숫자로 채우면 사용자가
///    실제 크레딧 소모와 다른 기대를 갖게 되므로, **null + 사유(basis)** 로 남긴다.
///
/// 실측 근거 (`puter.auth.getMonthlyUsage()` 원본 응답):
/// ```json
/// "usage": {
///   "openai:gpt-image-2:low:1024x1024:output": { "cost": 188.16, "count": 10 },
///   "openai:gpt-image-2:low:1024x1024:input":  { "cost": 2.048,  "count": 10 }
/// }
/// ```
/// → 1회당 (188.16 + 2.048) / 10 = **19.0208 credits**.
///
/// 카탈로그 근거: https://docs.puter.com/AI/txt2img/
///   "Discover the image catalog, including model IDs, aliases, provider names, and pricing metadata:
///    `await puter.drivers.call('puter-image-generation', 'models', {})`"
/// → 런타임에 카탈로그를 조회해 `pricing.unit === "credits"` 항목만 단가로 채택한다
///   (달러/센트 단가를 credit 으로 오인하지 않는다).

/// 모델을 선택하지 않았을 때 Puter 가 쓰는 기본 모델 (공식 문서: OpenAI gpt-image-2).
export const PUTER_DEFAULT_MODEL_ID = "openai/gpt-image-2";

/// 단가를 모르는 모델에 붙이는 사유 문구.
const UNMEASURED_BASIS =
  "실측 없음 — [모델 단가 조회]로 Puter 카탈로그(pricing)를 확인하거나, 1회 생성 후 사용량에서 확인 필요";

export interface PuterModelCredit {
  /// Puter 모델 ID (`PUTER_IMAGE_MODELS` 의 id 와 동일).
  id: string;
  /// 1회 생성에 소모되는 credits. 모르면 null (0 으로 위장하지 않는다).
  creditsPerImage: number | null;
  /// 그 값의 근거(실측 경로 또는 미확인 사유).
  basis: string;
}

/// 정적 단가 표 — App 의 이미지 모델 목록(15개)과 1:1 로 대응한다.
export const PUTER_MODEL_CREDITS: PuterModelCredit[] = [
  {
    id: "openai/gpt-image-2",
    creditsPerImage: 19.0208,
    basis:
      "실측: usage['openai:gpt-image-2:low:1024x1024'] output 188.16 + input 2.048 / 10회 = 19.0208",
  },
  { id: "openai/gpt-image-2.5-flare", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "openai/gpt-image-2.5-sunburst", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "google/gemini-3-pro-image", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "google/gemini-3.1-flash-image", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "google/imagen-4.0", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "black-forest-labs/flux-2-pro", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "black-forest-labs/flux-2-dev", creditsPerImage: null, basis: UNMEASURED_BASIS },
  {
    id: "black-forest-labs/flux-2-klein-9b-base",
    creditsPerImage: null,
    basis: UNMEASURED_BASIS,
  },
  { id: "black-forest-labs/flux-1.1-pro", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "black-forest-labs/flux-schnell", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "x-ai/grok-imagine-image-2.0", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "leonardoai/lucid-origin", creditsPerImage: null, basis: UNMEASURED_BASIS },
  { id: "qwen/qwen-image", creditsPerImage: null, basis: UNMEASURED_BASIS },
  {
    id: "stabilityai/stable-diffusion-xl-base-1.0",
    creditsPerImage: null,
    basis: UNMEASURED_BASIS,
  },
];

/// 숫자·숫자 문자열만 수치로 인정한다 (카탈로그가 문자열로 직렬화하는 경우 대응).
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/,/g, "");
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

/// 카탈로그 응답에서 모델 배열을 찾는다 (`result`/`models`/`data`/`items` 래핑 대응).
function extractCatalogArray(raw: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  for (const key of ["result", "models", "data", "items"]) {
    const value = rec[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractCatalogArray(value, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function creditUnitIsCredits(unit: unknown): boolean {
  if (typeof unit !== "string") return false;
  const v = unit.trim().toLowerCase();
  return v === "credits" || v === "credit";
}

/// Puter 모델 카탈로그(`drivers.call('puter-image-generation','models')`) 응답에서
/// **credits 단가만** 뽑아낸다.
///
/// `pricing.unit` 이 credits 가 아니면(= usd/cents 등) 채택하지 않는다 —
/// 달러 단가 0.04 를 "0.04 credits" 로 표시하면 실제 소모의 1/475 수준으로 오해된다.
/// 예상 밖 형태(문자열·null·중첩 없음)는 예외 없이 빈 배열을 돌려준다.
export function parseModelCatalogCredits(
  raw: unknown,
): { id: string; creditsPerImage: number }[] {
  const items = extractCatalogArray(raw);
  const out: { id: string; creditsPerImage: number }[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;

    let value: number | null = null;
    const pricing = rec.pricing;
    if (pricing && typeof pricing === "object" && !Array.isArray(pricing)) {
      const p = pricing as Record<string, unknown>;
      if (creditUnitIsCredits(p.unit)) {
        value =
          asNumber(p.cost) ?? asNumber(p.credits_per_image) ?? asNumber(p.creditsPerImage);
      }
    }
    if (value === null) {
      value = asNumber(rec.credits_per_image) ?? asNumber(rec.creditsPerImage) ?? asNumber(rec.credit);
    }
    if (value === null) continue;
    out.push({ id, creditsPerImage: value });
  }
  return out;
}

/// 정적 표에 카탈로그 조회 결과를 병합한다 (카탈로그 값이 우선).
export function mergeModelCredits(
  base: PuterModelCredit[],
  live: { id: string; creditsPerImage: number }[],
): PuterModelCredit[] {
  const byId = new Map(live.map((l) => [l.id.toLowerCase(), l.creditsPerImage]));
  return base.map((c) => {
    const value = byId.get(c.id.toLowerCase());
    if (value === undefined) return c;
    return { ...c, creditsPerImage: value, basis: "Puter 모델 카탈로그(pricing.unit=credits)" };
  });
}

/// 모델 ID 로 단가 항목을 찾는다. Puter 는 모델 ID 조회를 대소문자 무시로 처리하므로
/// 같은 규칙을 따른다. 없는 ID 는 null (기본 표로 폴백하지 않는다).
export function creditForModel(
  id: string,
  list: PuterModelCredit[] = PUTER_MODEL_CREDITS,
): PuterModelCredit | null {
  const key = id.trim().toLowerCase();
  if (!key) return null;
  return list.find((c) => c.id.toLowerCase() === key) ?? null;
}

/// 1회당 크레딧 표시 문자열. 모르면 "정보 없음" (0 이라고 쓰지 않는다).
export function formatCreditsPerImage(entry: PuterModelCredit | null | undefined): string {
  if (!entry || entry.creditsPerImage === null) return "정보 없음";
  return `약 ${entry.creditsPerImage.toFixed(2)} credits/회`;
}

/// 남은 크레딧으로 이 모델을 몇 회 생성할 수 있는지. 단가·잔액을 모르거나 단가가 0 이하이면
/// null (= 계산 불가) 이다. 소수점은 버린다 — 반올림해 1회 더 가능하다고 표시하면 실패한다.
export function estimateImagesForCredits(
  remaining: number | null,
  creditsPerImage: number | null,
): number | null {
  if (remaining === null || creditsPerImage === null) return null;
  if (!Number.isFinite(remaining) || !Number.isFinite(creditsPerImage)) return null;
  if (creditsPerImage <= 0) return null;
  if (remaining < 0) return null;
  return Math.floor(remaining / creditsPerImage);
}
