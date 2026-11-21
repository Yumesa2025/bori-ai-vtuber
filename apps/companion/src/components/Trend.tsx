import type { ErComboStat } from "@bori/shared";
import { changeText, trendOf, type TrendMetric } from "../dashboard";

const ARROW = { up: "▲", down: "▼", flat: "–" } as const;
const WORD = { up: "좋아짐", down: "나빠짐", flat: "그대로" } as const;

/**
 * 지난번 대비 ▲▼. 평균 순위는 작아지면 ▲(좋아짐). 직전 값이 없으면 그리지 않는다.
 * 역할 없는 span의 aria-label은 화면 낭독기가 무시할 수 있어 img 역할을 준다(점검 V2 20번).
 */
export function Trend({ metric, change }: { metric: TrendMetric; change: ErComboStat["change"] }) {
  const trend = trendOf(metric, change);
  const text = changeText(metric, change);
  if (!trend || !text) return null;
  return (
    <span className={`trend trend-${trend}`} role="img" title={`지난번 대비 ${text}`} aria-label={`지난번 대비 ${text}, ${WORD[trend]}`}>
      {ARROW[trend]}{trend === "flat" ? "" : ` ${text.replace(/^[+-]/, "")}`}
    </span>
  );
}
