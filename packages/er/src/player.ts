/**
 * 전적 조회. 닉네임으로 이번 시즌 랭크 전적(없으면 일반 대전)을 요약한다.
 * 대시보드 "내 전적" 칸의 재료다. 주캐릭터가 메타에서 몇 위인지는 서버가 메타와 맞춰 붙인다.
 * 닉네임은 화면에만 보인다. 로그·LLM 사실 목록에는 넣지 않는다(오류 메시지에도 쿼리를 넣지 않는다).
 */
import type { ErPlayerSummary } from "@bori/shared";
import { ErApiError, type ErClient } from "./client.js";
import type { ErDictionary } from "./dictionary.js";

/** 공식 문서 MatchingMode: 2 일반, 3 랭크. 일반 대전 통계는 시즌 0으로 묻는다. */
const NORMAL_MODE = 2;
const RANKED_MODE = 3;
const RECENT_GAMES = 10;
const MAIN_CHARACTERS = 3;

/** ErPlayerSummary에서 주캐릭터 메타 순위만 빠지고, 메타와 맞출 캐릭터 code가 있다. */
export type ErPlayerLookup = Omit<ErPlayerSummary, "mainCharacters"> & {
  mainCharacters: Array<{ code: number; name: string; games: number; avgRank: number }>;
};

/** 공식 문서 예시는 uid지만 실제 응답(2026-10-15 확인)은 userId다. 둘 다 받는다. */
type NicknameResponse = { user?: { userId?: string; uid?: string; nickname?: string } };
type UserStats = {
  mmr?: number;
  rankPercent?: number;
  totalGames?: number;
  totalWins?: number;
  averageRank?: number;
  averageKills?: number;
  averageAssistants?: number;
  top1?: number;
  characterStats?: Array<{ characterCode: number; totalGames?: number; averageRank?: number }>;
};
type StatsResponse = { userStats?: UserStats[] };
type GameRow = { matchingMode?: number; seasonId?: number; characterNum?: number; bestWeapon?: number; gameRank?: number; playerKill?: number; mmrGain?: number };
type GamesResponse = { userGames?: GameRow[] };

const isNotFound = (error: unknown) => error instanceof ErApiError && (error.code === 404 || error.status === 404);
const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

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

/** 최근 경기 목록. 경기 기록이 없는 계정은 404로 올 수 있어 빈 목록으로 본다. */
async function fetchGames(client: ErClient, path: string): Promise<GameRow[]> {
  try {
    return (await client.get<GamesResponse>(path)).userGames ?? [];
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** 없으면 null */
export async function lookupPlayer(client: ErClient, dict: ErDictionary, nickname: string): Promise<ErPlayerLookup | null> {
  let user: NicknameResponse["user"];
  try {
    user = (await client.get<NicknameResponse>(`/v1/user/nickname?query=${encodeURIComponent(nickname)}`)).user;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const userId = user?.userId ?? user?.uid;
  if (!user || !userId) return null;
  const uid = encodeURIComponent(userId);

  const ranked = await fetchStats(client, `/v2/user/stats/uid/${uid}/${dict.seasonId}/${RANKED_MODE}`);
  const normal = ranked ? null : await fetchStats(client, `/v2/user/stats/uid/${uid}/0/${NORMAL_MODE}`);
  const stats = ranked ?? normal;

  // 최근 경기는 통계와 같은 모드만 센다(랭크는 이번 시즌만). 목록은 최신 경기가 앞이다.
  const sameMode = normal
    ? (game: GameRow) => game.matchingMode === NORMAL_MODE
    : (game: GameRow) => game.matchingMode === RANKED_MODE && game.seasonId === dict.seasonId;
  const games = await fetchGames(client, `/v1/user/games/uid/${uid}`);
  const names = new Map(dict.characters.map((character) => [character.code, character.name]));
  const characterName = (code: number) => names.get(code) ?? `캐릭터 ${code}`;
  const recent = games
    .filter((game) => sameMode(game) && typeof game.gameRank === "number")
    .slice(0, RECENT_GAMES)
    .map((game) => ({
      characterName: characterName(game.characterNum ?? 0),
      weaponName: game.bestWeapon ? (dict.weaponNames[game.bestWeapon] ?? "") : "",
      rank: game.gameRank!,
      kills: numberOrNull(game.playerKill) ?? 0,
      mmrGain: numberOrNull(game.mmrGain),
    }));

  const totalGames = stats?.totalGames ?? 0;
  return {
    nickname: user.nickname ?? nickname,
    seasonName: normal ? "일반 대전" : dict.seasonName,
    // 일반 대전에는 랭크 점수·백분위가 없다
    mmr: ranked ? numberOrNull(ranked.mmr) : null,
    rankPercent: ranked ? numberOrNull(ranked.rankPercent) : null,
    games: totalGames,
    avgRank: stats?.averageRank ?? 0,
    top1Rate: stats?.top1 ?? (totalGames > 0 ? (stats?.totalWins ?? 0) / totalGames : 0),
    avgKills: numberOrNull(stats?.averageKills),
    avgAssists: numberOrNull(stats?.averageAssistants),
    recent,
    mainCharacters: [...(stats?.characterStats ?? [])]
      .sort((a, b) => (b.totalGames ?? 0) - (a.totalGames ?? 0))
      .slice(0, MAIN_CHARACTERS)
      .map((character) => ({
        code: character.characterCode,
        name: characterName(character.characterCode),
        games: character.totalGames ?? 0,
        avgRank: character.averageRank ?? 0,
      })),
  };
}
