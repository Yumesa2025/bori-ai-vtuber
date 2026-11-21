import { useMemo, useState } from "react";
import type { ErComboStat } from "@bori/shared";
import { cell, comboKey, comboLabel, defaultDirection, sortCombos, type SortDirection, type SortKey } from "../dashboard";
import { formatCount } from "../format";
import { Trend } from "./Trend";

type Props = { combos: readonly ErComboStat[]; selectedKey: string | null; onSelect: (combo: ErComboStat) => void };

const COLUMNS: Array<{ key: SortKey; label: string; render: (combo: ErComboStat) => string; trend?: "pickRate" | "avgRank" | "top1Rate" | "avgMmrGain" }> = [
  { key: "pickRate", label: "픽률", render: cell.pickRate, trend: "pickRate" },
  { key: "avgRank", label: "평균 순위", render: cell.avgRank, trend: "avgRank" },
  { key: "top1Rate", label: "1등 비율", render: cell.top1Rate, trend: "top1Rate" },
  { key: "avgMmrGain", label: "평균 MMR", render: cell.avgMmrGain, trend: "avgMmrGain" },
  { key: "participants", label: "참가자", render: combo => formatCount(combo.participants) },
];

/** 메타 TOP: 캐릭터+무기 표. 열 머리를 눌러 정렬하고, 행을 눌러 캐릭터 상세를 고른다. 표본 적은 조합은 흐리게. */
export function MetaTable({ combos, selectedKey, onSelect }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "pickRate", direction: "desc" });
  const rows = useMemo(() => sortCombos(combos, sort.key, sort.direction), [combos, sort]);

  const toggle = (key: SortKey) => setSort(current => (current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: defaultDirection(key) }));

  return (
    <section className="panel meta-table" aria-labelledby="meta-title">
      <div className="panel-head">
        <h2 id="meta-title">메타 TOP</h2>
        <span className="panel-hint">픽률 순 · ▲▼ 지난번 대비 · 흐린 줄은 참가자 30명 미만</span>
      </div>
      {combos.length === 0 ? <p className="empty">아직 집계한 조합이 없어요.</p> : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col" className="col-rank">#</th>
                <th scope="col" className="th-left">조합</th>
                {COLUMNS.map(column => (
                  <th key={column.key} scope="col" aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" className="sort-button" onClick={() => toggle(column.key)}>
                      {column.label}{sort.key === column.key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((combo, index) => {
                const key = comboKey(combo);
                const selected = key === selectedKey;
                return (
                  <tr key={key} className={`${combo.lowSample ? "low-sample" : ""}${selected ? " selected" : ""}`} onClick={() => onSelect(combo)}>
                    <td className="col-rank">{index + 1}</td>
                    <th scope="row">
                      <button type="button" className="row-button" aria-pressed={selected} onClick={event => { event.stopPropagation(); onSelect(combo); }}>{comboLabel(combo)}</button>
                      {combo.lowSample && <span className="tag">표본 적음</span>}
                      {combo.change === null && !combo.lowSample && <span className="tag tag-new">새로</span>}
                    </th>
                    {COLUMNS.map(column => (
                      <td key={column.key}>
                        <span className="value">{column.render(combo)}</span>
                        {column.trend && <Trend metric={column.trend} change={combo.change} />}
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
