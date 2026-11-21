/**
 * 대시보드 자동 갱신 판정. 대시보드를 열 때(GET /api/dashboard) 서버가 쓴다.
 * - 데이터 없음 / 수집 24시간 넘음 / 사전 시즌이 지금 시즌이 아님 → 갱신한다.
 * - 하루에 한 번만 판정한다. 판정 뒤 갱신이 실패해도 그날은 다시 판정하지 않는다.
 *   하루 문은 메모리에만 둔다(앱을 다시 켜면 그날도 다시 판정한다).
 */

/** 이보다 오래된 집계는 오래됨(stale)이고 자동 갱신 대상이다. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** 하루의 경계는 한국 시간 자정이다. */
const KOREA_OFFSET_MS = 9 * 60 * 60 * 1000;

export type RefreshReason = "missing" | "old" | "season";

export function refreshReason(input: {
  /** 집계 수집 시각. 집계가 없으면 null */
  collectedAt: string | null;
  metaSeasonId: number | null;
  dictionarySeasonId: number | null;
  /** 사전의 현재 시즌 끝 시각(ISO). 모르면 null */
  seasonEnd: string | null;
  now: number;
}): RefreshReason | null {
  if (input.collectedAt === null) return "missing";
  const collectedAt = Date.parse(input.collectedAt);
  if (!Number.isFinite(collectedAt) || input.now - collectedAt > STALE_AFTER_MS) return "old";
  const seasonEnd = input.seasonEnd === null ? NaN : Date.parse(input.seasonEnd);
  if (Number.isFinite(seasonEnd) && input.now >= seasonEnd) return "season";
  if (input.metaSeasonId !== input.dictionarySeasonId) return "season";
  return null;
}

/** 한국 날짜 "YYYY-MM-DD" */
export const koreanDay = (now: number) => new Date(now + KOREA_OFFSET_MS).toISOString().slice(0, 10);

/** 그날 첫 tryToday()만 true. */
export function createDailyGate(now: () => number) {
  let lastDay: string | null = null;
  return {
    tryToday(): boolean {
      const today = koreanDay(now());
      if (today === lastDay) return false;
      lastDay = today;
      return true;
    },
  };
}
