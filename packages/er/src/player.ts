/**
 * 전적 진단. 시청자가 준 닉네임으로 이번 시즌 랭크 전적(없으면 일반 대전)을 요약한다.
 * 닉네임은 화면에 가려서만 보인다.
 */
import type { ErPlayerReport } from "@bori/shared";
import { ErApiError, type ErClient } from "./client.js";
import type { ErDictionary } from "./dictionary.js";
import { maskNickname } from "./mask.js";

/** 공식 문서 MatchingMode: 2 일반, 3 랭크. 일반 대전 통계는 시즌 0으로 묻는다. */
const NORMAL_MODE = 2;
const RANKED_MODE = 3;
const RECENT_GAMES = 10;
const MAIN_CHARACTERS = 3;

type NicknameResponse = { user?: { uid?: string; nickname?: string } };
type UserStats = {
  totalGames?: number;
  totalWins?: number;
  averageRank?: number;
  top1?: number;
  characterStats?: Array<{ characterCode: number; totalGames?: number; averageRank?: number }>;
};
type StatsResponse = { userStats?: UserStats[] };
type GamesResponse = { userGames?: Array<{ matchingMode?: number; gameRank?: number }> };

const isNotFound = (error: unknown) => error instanceof ErApiError && (error.code === 404 || error.status === 404);

/** 통계가 비었거나 404면 null. */
async function fetchStats(client: ErClient, path: string): Promise<UserStats | null> {
  try {
    const stats = (await client.get<StatsResponse>(path)).userStats?.[0];
    return stats && (stats.totalGames ?? 0) > 0 ? stats : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** 없으면 null */
export async function lookupPlayer(client: ErClient, dict: ErDictionary, nickname: string): Promise<ErPlayerReport | null> {
  let user: NicknameResponse["user"];
  try {
    user = (await client.get<NicknameResponse>(`/v1/user/nickname?query=${encodeURIComponent(nickname)}`)).user;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!user?.uid) return null;
  const uid = encodeURIComponent(user.uid);

  const ranked = await fetchStats(client, `/v2/user/stats/uid/${uid}/${dict.seasonId}/${RANKED_MODE}`);
  const normal = ranked ? null : await fetchStats(client, `/v2/user/stats/uid/${uid}/0/${NORMAL_MODE}`);
  const stats = ranked ?? normal;
  const mode = normal ? NORMAL_MODE : RANKED_MODE;

  // 최근 경기는 통계와 같은 모드만 센다. 목록은 최신 경기가 앞이다.
  const games = await client.get<GamesResponse>(`/v1/user/games/uid/${uid}`);
  const recentRanks = (games.userGames ?? [])
    .filter((game) => game.matchingMode === mode && typeof game.gameRank === "number")
    .slice(0, RECENT_GAMES)
    .map((game) => game.gameRank!);

  const names = new Map(dict.characters.map((character) => [character.code, character.name]));
  const totalGames = stats?.totalGames ?? 0;
  return {
    maskedNickname: maskNickname(user.nickname ?? nickname),
    seasonName: normal ? "일반 대전" : dict.seasonName,
    games: totalGames,
    avgRank: stats?.averageRank ?? 0,
    top1Rate: stats?.top1 ?? (totalGames > 0 ? (stats?.totalWins ?? 0) / totalGames : 0),
    recentRanks,
    mainCharacters: [...(stats?.characterStats ?? [])]
      .sort((a, b) => (b.totalGames ?? 0) - (a.totalGames ?? 0))
      .slice(0, MAIN_CHARACTERS)
      .map((character) => ({
        name: names.get(character.characterCode) ?? `캐릭터 ${character.characterCode}`,
        games: character.totalGames ?? 0,
        avgRank: character.averageRank ?? 0,
      })),
  };
}
