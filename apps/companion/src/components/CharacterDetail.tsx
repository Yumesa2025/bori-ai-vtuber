import type { ErComboStat } from "@bori/shared";
import { cell, comboKey, EQUIPMENT_SLOT_LABELS } from "../dashboard";
import { formatCount, formatDecimal, formatPercent } from "../format";
import { CharacterChip } from "./CharacterChip";

type Props = { combos: readonly ErComboStat[]; selected: ErComboStat | null; onSelect: (combo: ErComboStat) => void };

/** 비율 0~1을 막대 길이로. 그림일 뿐이고 수치는 옆 글자다. */
const rateWidth = (rate: number) => `${Math.max(2, Math.min(100, Math.round(rate * 100)))}%`;

/** 캐릭터 상세: 표에서 고른 캐릭터의 무기별 비교, 고른 조합의 코어 특성·부위별 장비 1~2위, 평균 킬·딜량. */
export function CharacterDetail({ combos, selected, onSelect }: Props) {
  if (!selected) {
    return (
      <section className="detail" aria-labelledby="detail-title">
        <div className="section-head"><h2 id="detail-title">캐릭터 상세</h2></div>
        <p className="empty">메타 표에서 조합을 고르면 자세히 보여 드려요.</p>
      </section>
    );
  }

  const weapons = combos.filter(combo => combo.characterCode === selected.characterCode).sort((a, b) => b.pickRate - a.pickRate);

  return (
    <section className="detail" aria-labelledby="detail-title">
      <div className="detail-head">
        <CharacterChip name={selected.characterName} code={selected.characterCode} size="md" />
        <div>
          <h2 id="detail-title">{selected.characterName} <span className="detail-title-suffix">상세</span></h2>
          <p className="section-hint">{selected.weaponName || "무기 모름"} · 참가자 {formatCount(selected.participants)}명{selected.lowSample ? " · 표본 적음" : ""}</p>
        </div>
      </div>

      <dl className="figures">
        <div><dt>평균 킬</dt><dd>{formatDecimal(selected.avgKills)}</dd></div>
        <div><dt>평균 어시스트</dt><dd>{formatDecimal(selected.avgAssists)}</dd></div>
        <div><dt>평균 데스</dt><dd>{formatDecimal(selected.avgDeaths)}</dd></div>
        <div><dt>평균 딜량</dt><dd>{formatCount(selected.avgDamage)}</dd></div>
      </dl>

      <div className="detail-block">
        <h3>무기별</h3>
        <table className="data-table weapon-table">
          <thead><tr><th scope="col" className="th-left">무기</th><th scope="col">픽률</th><th scope="col">평균 순위</th><th scope="col">1등 비율</th><th scope="col">평균 MMR</th></tr></thead>
          <tbody>
            {weapons.map(combo => (
              <tr key={comboKey(combo)} className={`${combo.lowSample ? "low-sample" : ""}${comboKey(combo) === comboKey(selected) ? " selected" : ""}`}>
                <th scope="row"><button type="button" className="row-button" onClick={() => onSelect(combo)}>{combo.weaponName || "무기 모름"}</button></th>
                <td>{cell.pickRate(combo)}</td>
                <td>{cell.avgRank(combo)}</td>
                <td>{cell.top1Rate(combo)}</td>
                <td>{cell.avgMmrGain(combo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 코어 특성은 짧아 두 칸으로, 장비는 이름이 길어(예: "아흐라만의 손길") 부위마다 1위·2위를 나란히 두고 이름은 줄바꿈한다. 잘라 내지 않는다. */}
      <div className="detail-block">
        <h3>코어 특성</h3>
        {selected.topTraits.length === 0 ? <p className="empty">기록 없음</p> : (
          <ol className="traits">
            {selected.topTraits.map(trait => (
              <li key={trait.code}>
                <span className="trait-name">{trait.name}</span>
                <span className="rate">{formatPercent(trait.rate)}</span>
                <span className="rate-bar" aria-hidden="true"><span style={{ width: rateWidth(trait.rate) }} /></span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="detail-block">
        <h3>부위별 장비 <span className="equipment-legend">1위 · 2위</span></h3>
        {selected.topEquipment.length === 0 ? <p className="empty">기록 없음</p> : (
          <ul className="equipment">
            {selected.topEquipment.map(slot => (
              <li key={slot.slot}>
                <span className="slot">{EQUIPMENT_SLOT_LABELS[slot.slot] ?? `부위 ${slot.slot}`}</span>
                {[0, 1].map(index => {
                  const item = slot.items[index];
                  return item
                    ? <span key={item.code} className={index === 0 ? "item item-first" : "item"}><span className="item-name">{item.name}</span> <span className="rate">{formatPercent(item.rate)}</span></span>
                    : <span key={`empty-${index}`} className="item item-empty" aria-hidden="true">—</span>;
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
