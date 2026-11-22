import type { ErComboStat } from "@bori/shared";
import { cell, comboKey, comboLabel, moverChangeText, pickPlaces, previousRank, selectMovers } from "../dashboard";
import { formatCount, formatRank } from "../format";
import { ComboChip } from "./ComboChip";
import { Trend } from "./Trend";

type Props = { combos: readonly ErComboStat[]; selectedKey: string | null; onSelect: (combo: ErComboStat) => void };

const pad = (place: number | undefined) => String(place ?? 0).padStart(2, "0");

/**
 * 오늘의 메타 하이라이트 띠: 픽률 1~3위(표본 충분한 조합)와 가장 크게 오른 조합.
 * 표와 같은 값·같은 규칙(픽률 순번, selectMovers)을 크게 보여 줄 뿐이다. 누르면 캐릭터 상세가 그 조합으로 바뀐다.
 */
export function MetaHighlights({ combos, selectedKey, onSelect }: Props) {
  if (combos.length === 0) return null;
  const places = pickPlaces(combos);
  const [first, ...rest] = combos.filter(combo => !combo.lowSample).slice(0, 3);
  const riser = selectMovers(combos, 1).risers[0] ?? null;
  const comparable = combos.some(combo => combo.change !== null);
  const pressed = (combo: ErComboStat) => comboKey(combo) === selectedKey;

  return (
    <section className="highlights" aria-labelledby="highlights-title">
      <h2 id="highlights-title" className="sr-only">오늘의 메타</h2>
      {first && (
        <button type="button" className="hl-lead" aria-pressed={pressed(first)} onClick={() => onSelect(first)}>
          <span className="hl-eyebrow"><span className="hl-eyebrow-key">오늘의 메타</span> 픽률 1위</span>
          <span className="hl-lead-main">
            <span className="hl-place" aria-hidden="true">{pad(places.get(comboKey(first)))}</span>
            <ComboChip code={first.characterCode} name={first.characterName} size="lg" />
            <span className="hl-lead-name">{comboLabel(first)}</span>
          </span>
          <span className="hl-stats">
            <span className="hl-stat"><span className="hl-stat-label">픽률</span><span className="hl-stat-value">{cell.pickRate(first)}</span><Trend metric="pickRate" change={first.change} /></span>
            <span className="hl-stat"><span className="hl-stat-label">평균 순위</span><span className="hl-stat-value">{cell.avgRank(first)}</span><Trend metric="avgRank" change={first.change} /></span>
            <span className="hl-stat"><span className="hl-stat-label">1등 비율</span><span className="hl-stat-value">{cell.top1Rate(first)}</span><Trend metric="top1Rate" change={first.change} /></span>
            <span className="hl-stat"><span className="hl-stat-label">참가자</span><span className="hl-stat-value">{formatCount(first.participants)}</span></span>
          </span>
        </button>
      )}
      {rest.length > 0 && (
        <ol className="hl-runners" aria-label="픽률 2·3위">
          {rest.map(combo => (
            <li key={comboKey(combo)}>
              <button type="button" className="hl-runner" aria-pressed={pressed(combo)} onClick={() => onSelect(combo)}>
                <span className="hl-runner-place" aria-hidden="true">{pad(places.get(comboKey(combo)))}</span>
                <ComboChip code={combo.characterCode} name={combo.characterName} />
                <span className="hl-runner-name">{comboLabel(combo)}</span>
                <span className="hl-runner-stats">
                  <span><span className="hl-mini-label">픽률</span> {cell.pickRate(combo)}</span>
                  <span><span className="hl-mini-label">평균</span> {cell.avgRank(combo)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="hl-riser">
        <span className="hl-eyebrow"><span className="hl-eyebrow-up">가장 크게 오른 조합</span></span>
        {riser ? (
          <button type="button" className="hl-riser-body" aria-pressed={pressed(riser)} onClick={() => onSelect(riser)}>
            <span className="hl-riser-name"><ComboChip code={riser.characterCode} name={riser.characterName} size="sm" />{comboLabel(riser)}</span>
            <span className="hl-riser-delta" role="img" aria-label={`평균 순위 ${moverChangeText(riser)} 좋아짐`}>▲ {moverChangeText(riser)}</span>
            <span className="hl-riser-path">평균 순위 {formatRank(previousRank(riser))}위 → <strong>{formatRank(riser.avgRank)}위</strong></span>
          </button>
        ) : <p className="empty">{comparable ? "눈에 띄게 움직인 조합이 없어요." : "비교할 지난 갱신이 없어요."}</p>}
      </div>
    </section>
  );
}
