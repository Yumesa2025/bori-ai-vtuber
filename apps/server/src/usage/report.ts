import type { UsageFeature, UsageMode, UsagePeriod, UsagePrice, UsageReport, UsageRow, UsageTotals } from "@bori/shared";
import { DEFAULT_PRICES_AS_OF, type PriceTable } from "./prices.js";
import { localDateKey, localDateKeyDaysBefore, type UsageCounter, type UsageDays } from "./store.js";

const FEATURES: readonly UsageFeature[] = ["reply", "summary", "digest", "embedding", "tts"];
const MODES: readonly UsageMode[] = ["broadcast", "companion", "none"];

const emptyTotals = (): UsageTotals => ({
  calls: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  callsWithoutTokens: 0,
  characters: 0,
  estimatedCostUsd: 0,
  costComplete: true,
});

/**
 * 한 줄의 추정 비용.
 * 음성은 글자 단가, 나머지는 입력·출력 토큰 단가를 쓴다. 필요한 단가가 하나라도 없으면 단가 없음이다.
 * 토큰 수를 모르는 호출은 추측하지 않고 빼며, 그런 호출만 있으면 비용을 null로 둔다.
 */
function costOf(counter: UsageCounter, price: UsagePrice | undefined): Pick<UsageRow, "estimatedCostUsd" | "costComplete" | "costNote"> {
  // 성공한 호출이 없으면 과금된 것도 없다.
  if (counter.calls === counter.failures) return { estimatedCostUsd: 0, costComplete: true, costNote: null };
  if (counter.feature === "tts") {
    if (price?.charactersPerMillionUsd === undefined) return { estimatedCostUsd: null, costComplete: false, costNote: "단가 없음" };
    return { estimatedCostUsd: (counter.characters * price.charactersPerMillionUsd) / 1_000_000, costComplete: true, costNote: null };
  }

  if (price?.inputPerMillionUsd === undefined || price.outputPerMillionUsd === undefined) {
    return { estimatedCostUsd: null, costComplete: false, costNote: "단가 없음" };
  }
  const tokenCalls = counter.calls - counter.failures - counter.callsWithoutTokens;
  if (counter.callsWithoutTokens > 0 && tokenCalls === 0) {
    return { estimatedCostUsd: null, costComplete: false, costNote: "토큰 정보 없음" };
  }
  const cost = (counter.inputTokens * price.inputPerMillionUsd + counter.outputTokens * price.outputPerMillionUsd) / 1_000_000;
  return counter.callsWithoutTokens > 0
    ? { estimatedCostUsd: cost, costComplete: false, costNote: "일부 호출 토큰 정보 없음" }
    : { estimatedCostUsd: cost, costComplete: true, costNote: null };
}

/** 줄을 합계에 더한다. 비용은 아는 부분만 더하고, 하나라도 빠지면 costComplete를 내린다. */
function addTo(totals: UsageTotals, row: UsageRow) {
  totals.calls += row.calls;
  totals.failures += row.failures;
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.callsWithoutTokens += row.callsWithoutTokens;
  totals.characters += row.characters;
  if (row.estimatedCostUsd !== null) totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + row.estimatedCostUsd;
  if (!row.costComplete) totals.costComplete = false;
}

/**
 * 계산할 수 있는 비용이 하나도 없는데 빠진 호출이 있으면 0이 아니라 null이다.
 * 0으로 보이면 "무료"로 읽힌다.
 */
function finish(totals: UsageTotals, rows: readonly UsageRow[]): UsageTotals {
  const anyCost = rows.some(row => row.estimatedCostUsd !== null);
  return { ...totals, estimatedCostUsd: !anyCost && !totals.costComplete ? null : totals.estimatedCostUsd };
}

/** from~to(로컬 날짜, 양 끝 포함) 기간의 누계를 기능·모드·모델별로 합친다. */
export function summarizePeriod(days: UsageDays, from: string, to: string, prices: ReadonlyMap<string, UsagePrice>): UsagePeriod {
  const merged = new Map<string, UsageCounter>();
  for (const [key, counters] of Object.entries(days)) {
    if (key < from || key > to) continue;
    for (const counter of counters) {
      const id = `${counter.feature}\u0000${counter.mode}\u0000${counter.model}`;
      const current = merged.get(id);
      if (!current) { merged.set(id, { ...counter }); continue; }
      current.calls += counter.calls;
      current.failures += counter.failures;
      current.inputTokens += counter.inputTokens;
      current.outputTokens += counter.outputTokens;
      current.callsWithoutTokens += counter.callsWithoutTokens;
      current.characters += counter.characters;
    }
  }

  const rows: UsageRow[] = [...merged.values()]
    .map(counter => ({ ...counter, ...costOf(counter, prices.get(counter.model)) }))
    .sort((a, b) => FEATURES.indexOf(a.feature) - FEATURES.indexOf(b.feature) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || a.model.localeCompare(b.model));

  const totals = emptyTotals();
  const byFeature = Object.fromEntries(FEATURES.map(feature => [feature, emptyTotals()])) as Record<UsageFeature, UsageTotals>;
  const byMode = Object.fromEntries(MODES.map(mode => [mode, emptyTotals()])) as Record<UsageMode, UsageTotals>;
  for (const row of rows) {
    addTo(totals, row);
    addTo(byFeature[row.feature], row);
    addTo(byMode[row.mode], row);
  }

  return {
    from,
    to,
    totals: finish(totals, rows),
    byFeature: Object.fromEntries(FEATURES.map(feature => [feature, finish(byFeature[feature], rows.filter(row => row.feature === feature))])) as Record<UsageFeature, UsageTotals>,
    byMode: Object.fromEntries(MODES.map(mode => [mode, finish(byMode[mode], rows.filter(row => row.mode === mode))])) as Record<UsageMode, UsageTotals>,
    rows,
    unpricedModels: [...new Set(rows.filter(row => row.costNote === "단가 없음").map(row => row.model))],
  };
}

/** 오늘·최근 7일·최근 31일(모두 오늘 포함) 보고서. */
export function buildUsageReport(days: UsageDays, table: PriceTable, now: number): UsageReport {
  const today = localDateKey(now);
  return {
    generatedAt: new Date(now).toISOString(),
    today: summarizePeriod(days, today, today, table.prices),
    last7Days: summarizePeriod(days, localDateKeyDaysBefore(now, 6), today, table.prices),
    last31Days: summarizePeriod(days, localDateKeyDaysBefore(now, 30), today, table.prices),
    prices: {
      defaultAsOf: DEFAULT_PRICES_AS_OF,
      note: `추정치입니다. 기본 단가는 ${DEFAULT_PRICES_AS_OF} 기준 공식 표준 요금이며 캐시·배치 할인은 반영하지 않습니다. 실제 청구액은 업체 대시보드를 확인하세요.`,
      fileLoaded: table.fileLoaded,
      fileError: table.fileError,
      models: [...table.prices.values()].sort((a, b) => a.model.localeCompare(b.model)),
    },
  };
}
