import type { ErComboStat } from "@bori/shared";
import { comboKey, comboLabel, moverChangeText, previousRank, selectMovers } from "../dashboard";
import { formatRank } from "../format";

type Props = { combos: readonly ErComboStat[]; onSelect: (combo: ErComboStat) => void };

/** 기울기 그림 크기. 왼쪽 점이 직전, 오른쪽 점이 이번 갱신이다. */
const SLOPE = { width: 52, height: 32, left: 6, right: 46, mid: 16, minOffset: 3, maxOffset: 11 };

/**
 * 직전→이번 두 점을 잇는 작은 기울기 그림. 평균 순위는 작을수록 좋으므로 좋아지면 선이 올라간다.
 * 기울기는 같은 칸 안 가장 큰 변화(maxDelta)에 맞춰 그려 행끼리 크기를 견줄 수 있다. 수치는 옆 글자가 알린다.
 */
function Slope({ delta, maxDelta, tone }: { delta: number; maxDelta: number; tone: "up" | "down" }) {
  const offset = SLOPE.minOffset + (Math.min(Math.abs(delta), maxDelta) / maxDelta) * (SLOPE.maxOffset - SLOPE.minOffset);
  const [from, to] = tone === "up" ? [SLOPE.mid + offset, SLOPE.mid - offset] : [SLOPE.mid - offset, SLOPE.mid + offset];
  return (
    <svg className={`slope slope-${tone}`} viewBox={`0 0 ${SLOPE.width} ${SLOPE.height}`} width={SLOPE.width} height={SLOPE.height} aria-hidden="true" focusable="false">
      <line className="slope-axis" x1={SLOPE.left} x2={SLOPE.left} y1={2} y2={SLOPE.height - 2} />
      <line className="slope-axis" x1={SLOPE.right} x2={SLOPE.right} y1={2} y2={SLOPE.height - 2} />
      <line className="slope-line" x1={SLOPE.left} y1={from} x2={SLOPE.right} y2={to} />
      <circle className="slope-prev" cx={SLOPE.left} cy={from} r={3} />
      <circle className="slope-now" cx={SLOPE.right} cy={to} r={3.5} />
    </svg>
  );
}

/** 오르고 내린 조합: 평균 순위 변화 상위·하위 5개씩. 보리 대사와 같은 규칙(selectMovers). */
export function Movers({ combos, onSelect }: Props) {
  const { risers, fallers } = selectMovers(combos, 5);
  const comparable = combos.some(combo => combo.change !== null);
  const maxDelta = Math.max(0.1, ...[...risers, ...fallers].map(combo => Math.abs(combo.change?.avgRank ?? 0)));

  const list = (title: string, items: ErComboStat[], tone: "up" | "down") => (
    <div className={`movers-list movers-${tone}`}>
      <h3><span className={`movers-mark movers-mark-${tone}`} aria-hidden="true">{tone === "up" ? "▲" : "▼"}</span>{title}</h3>
      {items.length === 0 ? <p className="empty">{comparable ? "눈에 띄게 움직인 조합이 없어요." : "비교할 지난 갱신이 없어요."}</p> : (
        <ol>
          {items.map(combo => (
            <li key={comboKey(combo)}>
              <button type="button" className="mover" onClick={() => onSelect(combo)}>
                <span className="mover-text">
                  <span className="mover-name">{comboLabel(combo)}</span>
                  <span className="mover-rank">{formatRank(previousRank(combo))}위 → <strong>{formatRank(combo.avgRank)}위</strong></span>
                </span>
                <Slope delta={combo.change?.avgRank ?? 0} maxDelta={maxDelta} tone={tone} />
                <span className={`trend trend-${tone}`} role="img" aria-label={`평균 순위 ${moverChangeText(combo)} ${tone === "up" ? "좋아짐" : "나빠짐"}`}>{tone === "up" ? "▲" : "▼"} {moverChangeText(combo)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  return (
    <section className="movers" aria-labelledby="movers-title">
      <div className="section-head">
        <h2 id="movers-title">오르고 내린 조합</h2>
        <span className="section-hint">평균 순위 변화 · 표본 적은 조합 제외 · <span className="slope-legend" aria-hidden="true"><i className="dot-prev" />직전 <i className="dot-now" />이번</span></span>
      </div>
      <div className="movers-grid">
        {list("올랐어요", risers, "up")}
        {list("내려갔어요", fallers, "down")}
      </div>
    </section>
  );
}
