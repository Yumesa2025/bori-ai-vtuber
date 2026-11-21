import type { ErComboStat } from "@bori/shared";
import { comboKey, comboLabel, moverChangeText, previousRank, selectMovers } from "../dashboard";
import { formatRank } from "../format";

type Props = { combos: readonly ErComboStat[]; onSelect: (combo: ErComboStat) => void };

/** 오르고 내린 조합: 평균 순위 변화 상위·하위 5개씩. 보리 대사와 같은 규칙(selectMovers). */
export function Movers({ combos, onSelect }: Props) {
  const { risers, fallers } = selectMovers(combos, 5);
  const comparable = combos.some(combo => combo.change !== null);

  const list = (title: string, items: ErComboStat[], tone: "up" | "down") => (
    <div className={`movers-list movers-${tone}`}>
      <h3>{title}</h3>
      {items.length === 0 ? <p className="empty">{comparable ? "눈에 띄게 움직인 조합이 없어요." : "비교할 지난 갱신이 없어요."}</p> : (
        <ol>
          {items.map(combo => (
            <li key={comboKey(combo)}>
              <button type="button" className="mover" onClick={() => onSelect(combo)}>
                <span className="mover-name">{comboLabel(combo)}</span>
                <span className="mover-rank">{formatRank(previousRank(combo))}위 → <strong>{formatRank(combo.avgRank)}위</strong></span>
                <span className={`trend trend-${tone}`} role="img" aria-label={`평균 순위 ${moverChangeText(combo)} ${tone === "up" ? "좋아짐" : "나빠짐"}`}>{tone === "up" ? "▲" : "▼"} {moverChangeText(combo)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  return (
    <section className="panel movers" aria-labelledby="movers-title">
      <div className="panel-head">
        <h2 id="movers-title">오르고 내린 조합</h2>
        <span className="panel-hint">평균 순위 변화 · 표본 적은 조합 제외</span>
      </div>
      <div className="movers-grid">
        {list("올랐어요", risers, "up")}
        {list("내려갔어요", fallers, "down")}
      </div>
    </section>
  );
}
