import type { ErComboStat } from "@bori/shared";
import { cell, comboKey, comboLabel, pickPlaces, type TrendMetric } from "../dashboard";
import { formatCount } from "../format";
import { CharacterChip } from "./CharacterChip";
import { Trend } from "./Trend";

type Props = { combos: readonly ErComboStat[]; onSelect: (combo: ErComboStat) => void };

const STATS: Array<{ metric: TrendMetric; label: string; render: (combo: ErComboStat) => string }> = [
  { metric: "pickRate", label: "픽률", render: cell.pickRate },
  { metric: "avgRank", label: "평균 순위", render: cell.avgRank },
  { metric: "top1Rate", label: "1등 비율", render: cell.top1Rate },
  { metric: "avgMmrGain", label: "평균 MMR", render: cell.avgMmrGain },
];

/**
 * 메타 1위: 표본이 충분한 조합 중 픽률 1위(표의 #1, 캐릭터 상세의 기본 선택과 같은 기준).
 * 화면에서 가장 먼저 읽히도록 이름과 네 수치를 크게 보인다. 바로 뒤 두 조합은 한 줄로 덧붙인다.
 */
export function Spotlight({ combos, onSelect }: Props) {
  const ranked = combos.filter(combo => !combo.lowSample);
  const top = ranked[0] ?? combos[0] ?? null;
  const next = ranked.slice(1, 3);
  const places = pickPlaces(combos);

  return (
    <section className="spotlight" aria-labelledby="spotlight-title">
      <h2 id="spotlight-title" className="eyebrow">지금 메타 1위</h2>
      {!top ? <p className="empty">아직 집계한 조합이 없어요.</p> : (
        <>
          <div className="spotlight-name">
            <CharacterChip name={top.characterName} code={top.characterCode} size="lg" />
            <button type="button" className="spotlight-pick" onClick={() => onSelect(top)}>{comboLabel(top)}</button>
          </div>
          <p className="spotlight-sub">픽률 {places.get(comboKey(top))}위 · 참가자 {formatCount(top.participants)}명</p>
          <dl className="spotlight-stats">
            {STATS.map(stat => (
              <div key={stat.metric}>
                <dt>{stat.label}</dt>
                <dd><span className="spotlight-value">{stat.render(top)}</span><Trend metric={stat.metric} change={top.change} /></dd>
              </div>
            ))}
          </dl>
          {next.length > 0 && (
            <p className="spotlight-next">
              <span className="spotlight-next-label">이어서</span>
              {next.map(combo => (
                <button key={comboKey(combo)} type="button" className="link-button" onClick={() => onSelect(combo)}>
                  <span className="spotlight-next-place">{places.get(comboKey(combo))}</span>{comboLabel(combo)} <span className="muted-text">{cell.pickRate(combo)}</span>
                </button>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}
