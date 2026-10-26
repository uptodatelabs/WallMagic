/// Puter 리소스 단위·월간 사용량 정규화 (React 비의존 순수 모듈).
///
/// 왜 분리했나: 이 로직은 이전까지 `App.tsx` 안에 있어 정규식 문자열 검사로만 검증됐고,
/// "크레딧이 모두 0 으로 표시" 결함을 잡지 못했다. 순수 모듈로 떼어내면
/// `scripts/verify-puter-usage-normalize.mjs` 가 **실제 함수를 실행**해 응답 형태별로
/// 기대값과 대조할 수 있다 (React·DOM·Tauri 없이 node 에서 동작).
///
/// 근거: https://docs.puter.com/Objects/monthlyusage/
///   - `allowanceInfo.monthUsageAllowance` (월 총 allowance)
///   - `allowanceInfo.remaining` (남은 allowance)
///   - `usage.<api>.cost` / `appTotals.<app>.total` (사용량 분해)
///   - "Resources in Puter are measured in microcents (e.g., $0.01 = 1,000,000)"

/// Puter 리소스는 microcents 단위다 ($0.01 = 1,000,000).
export const PUTER_MICROCENTS_PER_CENT = 1_000_000;

/// Puter 남은 크레딧 표시용 정규화 결과. null 은 "응답에 없음/아직 조회 안 함"이다.
export interface PuterUsageSummary {
  /// 남은 allowance (microcents).
  remaining: number | null;
  /// 월 총 allowance (microcents).
  allowance: number | null;
  /// 이번 달 사용량 (microcents).
  spent: number | null;
  /// 값을 꺼낸 응답 경로 (예: "allowanceInfo.remaining"). UI 진단용.
  remainingPath: string | null;
  allowancePath: string | null;
  spentPath: string | null;
}

/// `fetchPuterUsage` 반환값 — 정규화 결과와 원본 응답을 함께 넘긴다.
/// SDK 버전별 스키마·단위 차이를 화면에서 바로 확인할 수 있게 하기 위함이다.
export interface PuterUsageResult {
  summary: PuterUsageSummary;
  raw: unknown;
}

export interface FoundNumber {
  value: number;
  path: string;
}

const EMPTY_SUMMARY: PuterUsageSummary = {
  remaining: null,
  allowance: null,
  spent: null,
  remainingPath: null,
  allowancePath: null,
  spentPath: null,
};

/// 응답 탐색 최대 깊이 — 래핑(`result`/`data`/`monthlyUsage`)을 넉넉히 덮는다.
const MAX_DEPTH = 5;

/// 숫자·숫자 문자열만 microcents 값으로 인정한다. 그 외는 null(=모름).
/// SDK 가 문자열로 직렬화해 돌려주는 경우(`"73000000"`)를 0 으로 떨어뜨리지 않기 위함.
export function toMicrocents(value: unknown): number | null {
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

interface Visit {
  node: unknown;
  path: string;
  depth: number;
}

function walk(root: unknown, visit: (v: Visit, entries: [string, unknown][]) => boolean): void {
  if (!root || typeof root !== "object") return;
  const seen = new Set<unknown>();
  const queue: Visit[] = [{ node: root, path: "", depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift() as Visit;
    if (!cur.node || typeof cur.node !== "object" || cur.depth > MAX_DEPTH) continue;
    if (seen.has(cur.node)) continue;
    seen.add(cur.node);
    const entries = Object.entries(cur.node as Record<string, unknown>);
    if (visit(cur, entries)) return;
    for (const [key, value] of entries) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        queue.push({
          node: value,
          path: cur.path ? `${cur.path}.${key}` : key,
          depth: cur.depth + 1,
        });
      }
    }
  }
}

/// 후보 키 중 **가장 얕은** 숫자 필드를 찾는다 (BFS 라 `allowanceInfo.remaining` 이
/// 더 깊은 엉뚱한 `remaining` 보다 먼저 선택된다).
export function findUsageNumber(root: unknown, keys: string[]): FoundNumber | null {
  let found: FoundNumber | null = null;
  walk(root, (cur, entries) => {
    for (const [key, value] of entries) {
      if (!keys.includes(key)) continue;
      const num = toMicrocents(value);
      if (num === null) continue;
      found = { value: num, path: cur.path ? `${cur.path}.${key}` : key };
      return true;
    }
    return false;
  });
  return found;
}

/// 후보 키로 객체를 찾는다 (예: `usage`).
function findObjectByKeys(root: unknown, keys: string[]): { node: object; path: string } | null {
  let found: { node: object; path: string } | null = null;
  walk(root, (cur, entries) => {
    for (const [key, value] of entries) {
      if (!keys.includes(key)) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      found = { node: value as object, path: cur.path ? `${cur.path}.${key}` : key };
      return true;
    }
    return false;
  });
  return found;
}

/// `usage` 의 총 사용량 — `usage.total` 이 있으면 그것을, 없으면 `usage.<api>.cost` 합계를 쓴다.
export function sumApiCosts(root: unknown): FoundNumber | null {
  const usage = findObjectByKeys(root, ["usage"]);
  if (!usage) return null;
  const total = toMicrocents((usage.node as Record<string, unknown>).total);
  if (total !== null) return { value: total, path: `${usage.path}.total` };

  let sum = 0;
  let parts = 0;
  for (const [key, value] of Object.entries(usage.node as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const cost = toMicrocents((value as Record<string, unknown>).cost);
    if (cost === null) continue;
    sum += cost;
    parts += 1;
    void key;
  }
  if (parts === 0) return null;
  return {
    value: sum,
    path: parts === 1 ? "usage.<api>.cost" : `usage.<api>.cost 합계(${parts}개 API)`,
  };
}

/// `puter.auth.getMonthlyUsage()` 응답을 정규화한다.
///
/// 고정 경로(`allowanceInfo.remaining`)만 보지 않고 후보 키를 트리에서 탐색하는 이유:
/// 실제 응답은 SDK 버전에 따라 `result`/`data`/`monthlyUsage` 로 감싸이거나 snake_case 로
/// 올 수 있고, 그 경우 고정 경로 조회는 **null → 화면 0/모름**으로 떨어진다.
/// 해석 불가면 0 이 아니라 null 을 돌려준다 (실제 0 크레딧과 "모름"을 UI 에서 구분).
export function puterUsageSummary(raw: unknown): PuterUsageSummary {
  if (!raw || typeof raw !== "object") return { ...EMPTY_SUMMARY };

  const remainingFound = findUsageNumber(raw, [
    "remaining",
    "remainingAllowance",
    "remaining_allowance",
  ]);
  const allowanceFound = findUsageNumber(raw, [
    "monthUsageAllowance",
    "month_usage_allowance",
    "totalAllowance",
    "total_allowance",
    "allowance",
  ]);

  // 사용량: 남은 값과 한도가 모두 있으면 차액이 가장 정확하다(문서상 항상 최신).
  // 없으면 명시적 spent/total 필드 → usage 분해 순으로 폴백한다.
  let spentFound: FoundNumber | null =
    remainingFound && allowanceFound
      ? {
          value: allowanceFound.value - remainingFound.value,
          path: `${allowanceFound.path} - ${remainingFound.path}`,
        }
      : findUsageNumber(raw, ["totalSpent", "total_spent", "spent"]);
  if (!spentFound) spentFound = sumApiCosts(raw);

  // 반대 방향 폴백: 남은 값이 없고 한도·사용량이 있으면 역산한다.
  let remainingFinal = remainingFound;
  if (!remainingFinal && allowanceFound && spentFound) {
    remainingFinal = {
      value: allowanceFound.value - spentFound.value,
      path: `${allowanceFound.path} - ${spentFound.path}`,
    };
  }

  return {
    remaining: remainingFinal ? remainingFinal.value : null,
    allowance: allowanceFound ? allowanceFound.value : null,
    spent: spentFound ? spentFound.value : null,
    remainingPath: remainingFinal ? remainingFinal.path : null,
    allowancePath: allowanceFound ? allowanceFound.path : null,
    spentPath: spentFound ? spentFound.path : null,
  };
}

/// microcents → "$1.23" 표시 문자열. null(미확인)은 "알 수 없음".
/// 값이 1센트 미만이면 2자리 반올림에서 0.00 으로 뭉개져 실제 값이 가려지므로 4자리로 보여준다.
export function formatMicrocents(value: number | null): string {
  if (value === null) return "알 수 없음";
  if (value === 0) return "$0.00";
  const dollars = value / (PUTER_MICROCENTS_PER_CENT * 100);
  return `$${dollars.toFixed(Math.abs(value) < PUTER_MICROCENTS_PER_CENT ? 4 : 2)}`;
}

/// 원본 응답을 화면 표시용 문자열로 만든다 (순환 참조·직렬화 실패에도 예외 없이).
export function stringifyUsageRaw(raw: unknown): string {
  try {
    const text = JSON.stringify(raw, null, 1);
    if (typeof text === "string") return text.length > 4000 ? `${text.slice(0, 4000)}\n… (생략)` : text;
  } catch {
    // 아래 폴백으로 진행한다.
  }
  try {
    return String(raw);
  } catch {
    return "(직렬화 불가)";
  }
}
