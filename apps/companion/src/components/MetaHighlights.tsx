import type { ErComboStat } from "@bori/shared";
import { cell, comboKey, comboLabel, moverChangeText, previousRank, selectMovers } from "../dashboard";
import { formatRank } from "../format";

type Props = { combos: readonly ErComboStat[]; spokenKeys: ReadonlySet<string>; onSelect: (combo: ErComboStat) => void };

export function MetaHighlights({ combos, spokenKeys, onSelect }: Props) {
  const leader = combos[0];
  const riser = selectMovers(combos, 1).risers[0];
  if (!leader) return null;

  return (
    <section className="meta-highlights" aria-label="메타 하이라이트">
      <button type="button" className="highlight highlight-leader" data-spoken={spokenKeys.has(comboKey(leader))} onClick={() => onSelect(leader)}>
        <span className="highlight-symbol" aria-hidden="true">
          <svg viewBox="0 0 28 28" fill="none"><path d="m4 8 5 4 5-7 5 7 5-4-2 12H6L4 8Zm3 15h14" /></svg>
        </span>
        <span className="highlight-copy">
          <span className="highlight-label">메타 1위 <span>· 픽률 기준</span></span>
          <strong>{comboLabel(leader)}</strong>
        </span>
        <span className="highlight-metric"><strong>{cell.pickRate(leader)}</strong><span>픽률</span></span>
      </button>
      {riser && (
        <button type="button" className="highlight highlight-riser" data-spoken={spokenKeys.has(comboKey(riser))} onClick={() => onSelect(riser)}>
          <span className="highlight-symbol" aria-hidden="true">
            <svg viewBox="0 0 28 28" fill="none"><path d="m4 21 7-7 4 4 8-11m-6 0h6v6" /></svg>
          </span>
          <span className="highlight-copy">
            <span className="highlight-label">가장 크게 오른 조합</span>
            <strong>{comboLabel(riser)}</strong>
          </span>
          <span className="highlight-metric">
            <strong>▲ {moverChangeText(riser)}</strong>
            <span>{formatRank(previousRank(riser))}위 → {formatRank(riser.avgRank)}위</span>
          </span>
        </button>
      )}
    </section>
  );
}
