/**
 * 대시보드 화면 규칙 중 React·DOM에 묶이지 않는 부분. 화면 밖 단위 검사에서 그대로 부른다.
 */
import type { ErComboStat } from "@bori/shared";
import { formatRank } from "./format";

/** 직전 갱신의 평균 순위. change는 "이번 값 − 직전 값"이다. */
const previousRank = (combo: ErComboStat) => combo.avgRank - (combo.change?.avgRank ?? 0);

/**
 * 오르고 내린 조합. 평균 순위 변화로 고르고(작아지면 오름), 표본 적음·직전 값 없음·반올림하면 같은 움직임은 뺀다.
 * 보리 대사(apps/server/src/narration/facts.ts의 rankMovers)와 같은 규칙이다. 서버 검사가 두 결과를 비교한다.
 */
export function selectMovers(combos: readonly ErComboStat[], limit = 5): { risers: ErComboStat[]; fallers: ErComboStat[] } {
  const moved = combos.filter(combo => !combo.lowSample && combo.change !== null && formatRank(previousRank(combo)) !== formatRank(combo.avgRank));
  const delta = (combo: ErComboStat) => combo.change?.avgRank ?? 0;
  return {
    risers: moved.filter(combo => delta(combo) < 0).sort((a, b) => delta(a) - delta(b)).slice(0, limit),
    fallers: moved.filter(combo => delta(combo) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, limit),
  };
}
