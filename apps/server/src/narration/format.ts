/**
 * 보리 대사에 쓰는 숫자 모양. 화면(apps/companion/src/format.ts)과 같은 규칙이다.
 * 두 앱이 코드를 나눠 쓰지 않으므로 같은 구현을 두고, test/narration-format.test.ts가 두 쪽 결과를 비교해 고정한다.
 * 한쪽을 고치면 다른 쪽도 같이 고친다.
 */

/** 소수 한 자리 반올림. 부동소수 오차(12.4999…)를 12자리로 먼저 정리하고, -0은 0으로 바꾼다. */
function round1(value: number): number {
  const rounded = Math.round(Number((value * 10).toPrecision(12))) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** 수가 아닌 값(NaN·무한)을 보일 때 쓰는 표시. "NaN%"가 화면에 나가지 않게 한다(점검 V2 19번). */
const NOT_A_NUMBER = "—";
const finite = (value: number) => Number.isFinite(value);

const fixed1 = (value: number) => (finite(value) ? round1(value).toFixed(1) : NOT_A_NUMBER);

const signed = (value: number) => {
  if (!finite(value)) return NOT_A_NUMBER;
  const rounded = round1(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
};

/** 0~1 비율 → "12.3%" */
export const formatPercent = (rate: number) => (finite(rate) ? `${fixed1(rate * 100)}%` : NOT_A_NUMBER);

/** 평균 순위 → "3.9" */
export const formatRank = (rank: number) => fixed1(rank);

/** 비율 변화량 → "+1.2%p" */
export const formatPointChange = (delta: number) => (finite(delta) ? `${signed(delta * 100)}%p` : NOT_A_NUMBER);

/** 평균 순위 변화량 → "-0.5" */
export const formatRankChange = (delta: number) => signed(delta);

/** 평균 MMR 증감 → "+12.3", 없으면 "—" */
export const formatMmr = (gain: number | null) => (gain === null ? "—" : signed(gain));

/** 평균 킬 같은 소수 → "4.3" */
export const formatDecimal = (value: number) => fixed1(value);

/** 개수 → "7,200" */
export function formatCount(value: number): string {
  if (!finite(value)) return NOT_A_NUMBER;
  const digits = String(Math.round(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 && grouped !== "0" ? `-${grouped}` : grouped;
}
