import type { DashboardState } from "@bori/shared";
import { playerMessage } from "../dashboard";
import { formatCount, formatDecimal, formatMmr, formatPercent, formatRank } from "../format";

type Props = { player: DashboardState["player"] | null; erAvailable: boolean };

/** 판수가 0이면 평균 값은 의미가 없어 "0.0위" 대신 "—"를 보인다(점검 V2 19번). */
const whenPlayed = (games: number, text: string) => (games > 0 ? text : "—");

/** MMR 변화 색. 0은 오르지도 내리지도 않았으니 중립색이다. */
const mmrClass = (gain: number | null) => (gain === null || gain === 0 ? "mmr-flat" : gain < 0 ? "mmr-down" : "mmr-up");

/** 내 전적: 닉네임이 없으면 설정 안내. 있으면 MMR·순위 백분위·평균 킬·최근 10판·주캐릭터의 메타 위치. */
export function PlayerCard({ player, erAvailable }: Props) {
  const summary = player?.status === "ready" ? player.summary : null;

  return (
    <section className="panel player" aria-labelledby="player-title">
      <div className="panel-head">
        <h2 id="player-title">내 전적</h2>
        {summary && <span className="panel-hint">{summary.nickname} · {summary.seasonName}</span>}
      </div>
      {!summary ? <p className={`empty${player?.status === "error" || player?.status === "not-found" ? " empty-warn" : ""}`}>{playerMessage(player && player.status !== "ready" ? player.status : "loading", erAvailable)}</p> : (
        <>
          <dl className="stat-row">
            <div><dt>MMR</dt><dd>{summary.mmr === null ? "—" : formatCount(summary.mmr)}</dd></div>
            <div><dt>순위</dt><dd>{summary.rankPercent === null ? "—" : `상위 ${formatPercent(summary.rankPercent)}`}</dd></div>
            <div><dt>판수</dt><dd>{formatCount(summary.games)}</dd></div>
            <div><dt>평균 순위</dt><dd>{whenPlayed(summary.games, `${formatRank(summary.avgRank)}위`)}</dd></div>
            <div><dt>1등 비율</dt><dd>{whenPlayed(summary.games, formatPercent(summary.top1Rate))}</dd></div>
            <div><dt>평균 킬</dt><dd>{summary.avgKills === null ? "—" : whenPlayed(summary.games, formatDecimal(summary.avgKills))}</dd></div>
          </dl>
          <div className="player-grid">
            <div>
              <h3>주캐릭터</h3>
              {summary.mainCharacters.length === 0 ? <p className="empty">기록 없음</p> : (
                <ol className="mains">
                  {summary.mainCharacters.map(main => (
                    <li key={main.name}>
                      <span>{main.name}</span>
                      <span className="muted-text">{formatCount(main.games)}판 · {whenPlayed(main.games, `${formatRank(main.avgRank)}위`)}</span>
                      <span className="meta-place">{main.metaRank === null ? "메타 순위 밖" : `메타 ${main.metaRank}위`}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <h3>{summary.recent.length > 0 ? `최근 ${summary.recent.length}판` : "최근 경기"}</h3>
              {summary.recent.length === 0 ? <p className="empty">최근 경기 기록이 없어요.</p> : (
                <ol className="recent">
                  {summary.recent.map((game, index) => (
                    <li key={index} className={game.rank === 1 ? "win" : ""}>
                      <span className="recent-rank">{game.rank}위</span>
                      <span className="recent-name">{game.characterName} {game.weaponName}</span>
                      <span className="muted-text">{game.kills}킬</span>
                      <span className={mmrClass(game.mmrGain)}>{game.mmrGain === null ? "—" : formatMmr(game.mmrGain).replace(/\.0$/, "")}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
