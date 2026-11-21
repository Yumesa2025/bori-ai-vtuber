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

const fixed1 = (value: number) => round1(value).toFixed(1);

const signed = (value: number) => {
  const rounded = round1(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
};

/** 0~1 비율 → "12.3%" */
export const formatPercent = (rate: number) => `${fixed1(rate * 100)}%`;

/** 평균 순위 → "3.9" */
export const formatRank = (rank: number) => fixed1(rank);

/** 비율 변화량 → "+1.2%p" */
export const formatPointChange = (delta: number) => `${signed(delta * 100)}%p`;

/** 평균 순위 변화량 → "-0.5" */
export const formatRankChange = (delta: number) => signed(delta);

/** 평균 MMR 증감 → "+12.3", 없으면 "—" */
export const formatMmr = (gain: number | null) => (gain === null ? "—" : signed(gain));

/** 평균 킬 같은 소수 → "4.3" */
export const formatDecimal = (value: number) => fixed1(value);

/** 개수 → "7,200" */
export function formatCount(value: number): string {
  const digits = String(Math.round(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 && grouped !== "0" ? `-${grouped}` : grouped;
}

/** 대사 검사에 쓰는 숫자 꼴(설계 3절). "7,200"은 "7"과 "200"으로 갈리지만 사실 쪽도 같은 정규식으로 뽑아 양쪽이 같다. */
export const NUMBER_PATTERN = /\d+(\.\d+)?/g;

/** 문장 속 숫자 문자열을 나온 순서대로 뽑는다. */
export const extractNumbers = (text: string): string[] => text.match(NUMBER_PATTERN) ?? [];
