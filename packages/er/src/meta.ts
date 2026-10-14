/**
 * 메타 집계. 상위 랭커의 최근 랭크 경기를 모아 캐릭터별 픽 수·평균 순위·1등 비율·주 무기를 센다.
 * 개인 키는 초당 1회라 전체 규모(랭커 100명)는 몇 분 걸린다. 진행률을 onProgress로 알린다.
 */
import type { ErCharacterStat, ErMetaBasis } from "@bori/shared";
import { ErApiError, type ErClient } from "./client.js";
import type { ErDictionary } from "./dictionary.js";

export type MetaProgress = (done: number, total: number) => void;

/** 랭크 대전(공식 문서 MatchingMode 3). 메타는 랭크 경기만 센다. */
const RANKED_MODE = 3;
/** 랭킹은 스쿼드(MatchingTeamMode 3)만 지원한다. */
const SQUAD_TEAM_MODE = 3;

type TopRanksResponse = { topRanks?: Array<{ nickname: string; rank: number }> };
/** 공식 문서 예시는 uid지만 실제 응답(2026-10-15 확인)은 userId다. 둘 다 받는다. */
type NicknameResponse = { user?: { userId?: string; uid?: string } };
type GamesResponse = { userGames?: Array<{ gameId: number; matchingMode?: number; characterNum?: number; gameRank?: number; bestWeapon?: number }> };

type Tally = { picks: number; rankSum: number; top1: number; weapons: Map<number, number> };

/** 랭커 한 명·경기 하나를 못 받아도 전체 집계는 계속한다. 연결이 끊긴 것 같은 오류(그 외)는 그대로 낸다. */
async function orSkip<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ErApiError && error.status !== 0) return null;
    throw error;
  }
}

export async function collectMeta(
  client: ErClient,
  dict: ErDictionary,
  options: { rankers: number; gamesPerRanker: number; onProgress?: MetaProgress },
): Promise<{ stats: ErCharacterStat[]; basis: ErMetaBasis }> {
  const { gamesPerRanker } = options;
  let done = 0;
  let total = 1 + options.rankers * (2 + gamesPerRanker);
  const step = () => {
    done += 1;
    options.onProgress?.(done, total);
  };

  // 1. 상위 랭커. 이 목록을 못 받으면 집계할 수 없으니 오류를 그대로 낸다.
  const top = await client.get<TopRanksResponse>(`/v1/rank/top/${dict.seasonId}/${SQUAD_TEAM_MODE}`);
  const rankers = [...(top.topRanks ?? [])].sort((a, b) => a.rank - b.rank).slice(0, options.rankers);
  total = 1 + rankers.length * (2 + gamesPerRanker);
  step();

  // 2. 닉네임 → uid. 닉네임을 바꾼 랭커는 찾지 못하니 건너뛴다.
  const uids: string[] = [];
  for (const ranker of rankers) {
    const found = await orSkip(client.get<NicknameResponse>(`/v1/user/nickname?query=${encodeURIComponent(ranker.nickname)}`));
    const uid = found?.user?.userId ?? found?.user?.uid;
    if (uid) uids.push(uid);
    else total -= 1 + gamesPerRanker;
    step();
  }

  // 3. 랭커마다 최근 랭크 경기 gamesPerRanker개. 여러 랭커가 같은 경기에 있으면 한 번만 받는다.
  const gameIds = new Set<number>();
  for (const uid of uids) {
    const games = await orSkip(client.get<GamesResponse>(`/v1/user/games/uid/${encodeURIComponent(uid)}`));
    for (const game of (games?.userGames ?? []).filter((g) => g.matchingMode === RANKED_MODE).slice(0, gamesPerRanker)) {
      gameIds.add(game.gameId);
    }
    step();
  }
  total = 1 + rankers.length + uids.length + gameIds.size;

  // 4. 경기마다 모든 참가자를 센다.
  const tallies = new Map<number, Tally>();
  let participants = 0;
  for (const gameId of gameIds) {
    const game = await orSkip(client.get<GamesResponse>(`/v1/games/${gameId}`));
    for (const player of game?.userGames ?? []) {
      if (!player.characterNum || !player.gameRank) continue;
      const tally = tallies.get(player.characterNum) ?? { picks: 0, rankSum: 0, top1: 0, weapons: new Map() };
      tally.picks += 1;
      tally.rankSum += player.gameRank;
      if (player.gameRank === 1) tally.top1 += 1;
      if (player.bestWeapon) tally.weapons.set(player.bestWeapon, (tally.weapons.get(player.bestWeapon) ?? 0) + 1);
      tallies.set(player.characterNum, tally);
      participants += 1;
    }
    step();
  }
  if (participants === 0) throw new Error("집계할 경기를 하나도 받지 못했습니다");

  const names = new Map(dict.characters.map((character) => [character.code, character.name]));
  const stats: ErCharacterStat[] = [...tallies].map(([code, tally]) => {
    // 가장 많이 쓴 무기. 같으면 숙련도 코드가 작은 쪽
    const weapon = [...tally.weapons].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    return {
      code,
      name: names.get(code) ?? `캐릭터 ${code}`,
      picks: tally.picks,
      pickRate: tally.picks / participants,
      avgRank: tally.rankSum / tally.picks,
      top1Rate: tally.top1 / tally.picks,
      mainWeapon: weapon === undefined ? "" : (dict.weaponNames[weapon] ?? ""),
    };
  });
  stats.sort((a, b) => b.picks - a.picks || a.avgRank - b.avgRank || a.code - b.code);

  return {
    stats,
    basis: {
      seasonName: dict.seasonName,
      sampleGames: participants,
      collectedAt: new Date().toISOString(),
      description: `최근 상위 랭커 ${participants.toLocaleString("en-US")}판 기준`,
    },
  };
}
