import { useMemo, useState } from "react";
import type { ErComboStat, ErMetaBasisV2 } from "@bori/shared";
import { cell, comboKey, comboLabel, defaultDirection, isNewCombo, pickPlaces, sortCombos, type SortDirection, type SortKey } from "../dashboard";
import { formatCount } from "../format";
import { CharacterChip } from "./CharacterChip";
import { Trend } from "./Trend";

type Props = { combos: readonly ErComboStat[]; basis: ErMetaBasisV2 | null; selectedKey: string | null; onSelect: (combo: ErComboStat) => void };

const COLUMNS: Array<{ key: SortKey; label: string; render: (combo: ErComboStat) => string; trend?: "pickRate" | "avgRank" | "top1Rate" | "avgMmrGain" }> = [
  { key: "pickRate", label: "픽률", render: cell.pickRate, trend: "pickRate" },
  { key: "avgRank", label: "평균 순위", render: cell.avgRank, trend: "avgRank" },
  { key: "top1Rate", label: "1등 비율", render: cell.top1Rate, trend: "top1Rate" },
  { key: "avgMmrGain", label: "평균 MMR", render: cell.avgMmrGain, trend: "avgMmrGain" },
  { key: "participants", label: "참가자", render: combo => formatCount(combo.participants) },
];

/** 픽률 칸 막대 길이(0~100%). 가장 많이 고른 조합이 꽉 찬다. 막대는 그림일 뿐이고 수치는 옆 글자다. */
const barWidth = (pickRate: number, max: number) => `${max > 0 ? Math.max(2, Math.round((pickRate / max) * 100)) : 0}%`;

/**
 * 메타 TOP: 캐릭터+무기 표. 열 머리를 눌러 정렬하고, 행을 눌러 캐릭터 상세를 고른다. 표본 적은 조합은 흐리게.
 * "#"는 정렬과 상관없는 픽률 순번이다(내 전적의 "메타 N위"와 같은 기준).
 */
export function MetaTable({ combos, basis, selectedKey, onSelect }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "pickRate", direction: "desc" });
  const rows = useMemo(() => sortCombos(combos, sort.key, sort.direction), [combos, sort]);
  const places = useMemo(() => pickPlaces(combos), [combos]);
  const maxPick = useMemo(() => Math.max(0, ...combos.map(combo => combo.pickRate)), [combos]);

  const toggle = (key: SortKey) => setSort(current => (current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: defaultDirection(key) }));

  return (
    <section className="meta-table" aria-labelledby="meta-title">
      <div className="section-head">
        <h2 id="meta-title">메타 TOP</h2>
        <span className="section-hint"># 픽률 순 · ▲▼ 지난번 대비 · 흐린 줄은 참가자 30명 미만(정렬하면 뒤로)</span>
      </div>
      {combos.length === 0 ? <p className="empty">아직 집계한 조합이 없어요.</p> : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="col-rank" title="픽률 순위">#</th>
                <th scope="col" className="th-left col-combo">조합</th>
                {COLUMNS.map(column => (
                  <th key={column.key} scope="col" className={`col-${column.key}`} aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" className={`sort-button${sort.key === column.key ? " sorted" : ""}`} onClick={() => toggle(column.key)}>
                      {column.label}<span className="sort-mark" aria-hidden="true">{sort.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : ""}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(combo => {
                const key = comboKey(combo);
                const selected = key === selectedKey;
                return (
                  <tr key={key} className={`${combo.lowSample ? "low-sample" : ""}${selected ? " selected" : ""}`} onClick={() => onSelect(combo)}>
                    <td className="col-rank">{places.get(key)}</td>
                    <th scope="row" className="col-combo">
                      <span className="combo-cell">
                        <CharacterChip name={combo.characterName} code={combo.characterCode} />
                        <button type="button" className="row-button" aria-pressed={selected} onClick={event => { event.stopPropagation(); onSelect(combo); }}>{comboLabel(combo)}</button>
                        {combo.lowSample && <span className="tag">표본 적음</span>}
                        {isNewCombo(combo, basis) && <span className="tag tag-new" title="지난 갱신에는 없던 조합">새로</span>}
                      </span>
                    </th>
                    {COLUMNS.map(column => (
                      <td key={column.key} className={`col-${column.key}`}>
                        <span className={`figure${column.key === "pickRate" ? " figure-bar" : ""}${column.trend ? "" : " figure-plain"}`}>
                          {column.key === "pickRate" && <span className="bar" aria-hidden="true"><span className="bar-fill" style={{ width: barWidth(combo.pickRate, maxPick) }} /></span>}
                          <span className="value">{column.render(combo)}</span>
                          {column.trend && <span className="trend-slot"><Trend metric={column.trend} change={combo.change} /></span>}
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
