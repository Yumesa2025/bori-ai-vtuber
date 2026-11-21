import type { DashboardState } from "@bori/shared";
import { formatCount, formatDecimal, formatMmr, formatPercent, formatRank } from "../format";

const STATUS_TEXT = {
  unset: "스튜디오 설정 탭에서 게임 닉네임을 한 번 저장하면 내 전적이 여기에 보여요.",
  loading: "전적을 불러오는 중이에요.",
  "not-found": "저장한 닉네임으로 플레이어를 찾지 못했어요. 설정 탭에서 닉네임을 확인해 주세요.",
  error: "전적을 불러오지 못했어요. 메타 분석은 그대로 볼 수 있어요.",
} as const;

/** 내 전적: 닉네임이 없으면 설정 안내. 있으면 MMR·순위 백분위·평균 킬·최근 10판·주캐릭터의 메타 위치. */
export function PlayerCard({ player }: { player: DashboardState["player"] | null }) {
  const summary = player?.status === "ready" ? player.summary : null;

  return (
    <section className="panel player" aria-labelledby="player-title">
      <div className="panel-head">
        <h2 id="player-title">내 전적</h2>
        {summary && <span className="panel-hint">{summary.nickname} · {summary.seasonName}</span>}
      </div>
      {!summary ? <p className={`empty${player?.status === "error" || player?.status === "not-found" ? " empty-warn" : ""}`}>{STATUS_TEXT[player && player.status !== "ready" ? player.status : "loading"]}</p> : (
        <>
          <dl className="stat-row">
            <div><dt>MMR</dt><dd>{summary.mmr === null ? "—" : formatCount(summary.mmr)}</dd></div>
            <div><dt>순위</dt><dd>{summary.rankPercent === null ? "—" : `상위 ${formatPercent(summary.rankPercent)}`}</dd></div>
            <div><dt>판수</dt><dd>{formatCount(summary.games)}</dd></div>
            <div><dt>평균 순위</dt><dd>{formatRank(summary.avgRank)}위</dd></div>
            <div><dt>1등 비율</dt><dd>{formatPercent(summary.top1Rate)}</dd></div>
            <div><dt>평균 킬</dt><dd>{summary.avgKills === null ? "—" : formatDecimal(summary.avgKills)}</dd></div>
          </dl>
          <div className="player-grid">
            <div>
              <h3>주캐릭터</h3>
              <ol className="mains">
                {summary.mainCharacters.map(main => (
                  <li key={main.name}>
                    <span>{main.name}</span>
                    <span className="muted-text">{formatCount(main.games)}판 · {formatRank(main.avgRank)}위</span>
                    <span className="meta-place">{main.metaRank === null ? "메타 순위 밖" : `메타 ${main.metaRank}위`}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3>최근 {summary.recent.length}판</h3>
              <ol className="recent">
                {summary.recent.map((game, index) => (
                  <li key={index} className={game.rank === 1 ? "win" : ""}>
                    <span className="recent-rank">{game.rank}위</span>
                    <span className="recent-name">{game.characterName} {game.weaponName}</span>
                    <span className="muted-text">{game.kills}킬</span>
                    <span className={game.mmrGain !== null && game.mmrGain < 0 ? "mmr-down" : "mmr-up"}>{game.mmrGain === null ? "—" : formatMmr(game.mmrGain).replace(/\.0$/, "")}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
