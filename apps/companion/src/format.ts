/**
 * 대시보드 숫자 모양. 화면에 보이는 숫자는 모두 여기서 만든다.
 * 보리 대사(apps/server/src/narration/format.ts)도 같은 규칙을 쓰고, 서버 검사가 두 쪽 결과를 같은 입력으로 비교해 고정한다.
 * 규칙: 비율은 % 소수 한 자리, 순위·평균은 소수 한 자리, 개수는 쉼표.
 */

/**
 * 소수 한 자리로 반올림한다.
 * 0.0125*1000처럼 부동소수 오차로 .x49999…가 되는 값을 사람이 읽는 값대로 올리려고 12자리로 먼저 정리한다.
 * -0은 0으로 바꿔 "-0.0"이 나오지 않게 한다.
 */
function round1(value: number): number {
  const rounded = Math.round(Number((value * 10).toPrecision(12))) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** 수가 아닌 값(NaN·무한)을 보일 때 쓰는 표시. "NaN%"가 화면에 나가지 않게 한다(점검 V2 19번). */
const NOT_A_NUMBER = "—";
const finite = (value: number) => Number.isFinite(value);

const fixed1 = (value: number) => (finite(value) ? round1(value).toFixed(1) : NOT_A_NUMBER);

/** 0보다 크면 +를 붙인다. 반올림해서 0이 되면 부호를 붙이지 않는다. */
const signed = (value: number) => {
  if (!finite(value)) return NOT_A_NUMBER;
  const rounded = round1(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
};

/** 0~1 비율 → "12.3%" */
export const formatPercent = (rate: number) => (finite(rate) ? `${fixed1(rate * 100)}%` : NOT_A_NUMBER);

/** 평균 순위 → "3.9" (뒤에 "위"는 부르는 쪽이 붙인다) */
export const formatRank = (rank: number) => fixed1(rank);

/** 비율 변화량(0~1 단위) → "+1.2%p" */
export const formatPointChange = (delta: number) => (finite(delta) ? `${signed(delta * 100)}%p` : NOT_A_NUMBER);

/** 평균 순위 변화량 → "-0.5" */
export const formatRankChange = (delta: number) => signed(delta);

/** 평균 MMR 증감 → "+12.3", 표본이 없으면 "—" */
export const formatMmr = (gain: number | null) => (gain === null ? "—" : signed(gain));

/** 평균 킬 같은 소수 → "4.3" */
export const formatDecimal = (value: number) => fixed1(value);

/** 개수 → "7,200". 로캘 설정에 따라 모양이 바뀌지 않게 직접 쉼표를 넣는다. */
export function formatCount(value: number): string {
  if (!finite(value)) return NOT_A_NUMBER;
  const digits = String(Math.round(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 && grouped !== "0" ? `-${grouped}` : grouped;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** 수집 시각 → "11월 21일 09:05"(이 컴퓨터 시각). 읽을 수 없으면 "—" */
export function formatCollectedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
