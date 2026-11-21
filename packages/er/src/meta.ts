/**
 * 메타 집계. 상위 랭커의 최근 이번 시즌 랭크 경기를 모아 (캐릭터, 무기) 조합별 원래 개수(합·횟수)를 센다.
 * 비율·변화량·표본 기준은 서버가 계산한다(apps/server/src/er/combos.ts).
 * 개인 키는 초당 1회라 전체 규모(랭커 100명)는 몇 분 걸린다. 진행률을 onProgress로 알린다.
 *
 * 시즌 판정은 경기 행의 seasonId로 한다(2026-11-21 실제 응답 확인: 경기 상세·유저 경기 목록 모두 seasonId가 있고,
 * Season API의 seasonID와 같은 번호다. versionSeason은 게임 표기 번호라 사전과 바로 비교되지 않는다).
 */
import { ErApiError, type ErClient } from "./client.js";
import type { ErDictionary } from "./dictionary.js";

export type MetaProgress = (done: number, total: number) => void;

/** 조합 하나의 원래 개수. 기록 파일에 그대로 쓰므로 코드 키는 문자열이다. */
export type ErComboTally = {
  characterCode: number;
  /** 경기 결과의 bestWeapon(숙련도 코드). 모르면 0 */
  weaponCode: number;
  participants: number;
  rankSum: number;
  top1: number;
  /** 랭크 MMR 증감 합과 그 표본 수(mmrGain이 있는 행만) */
  mmrGainSum: number;
  mmrGainSamples: number;
  kills: number;
  assists: number;
  deaths: number;
  /** 플레이어에게 준 피해 합 */
  damage: number;
  /** 코어 특성 코드 → 횟수 */
  traits: Record<string, number>;
  /** 부위("0"~"4") → 최종 장비 코드 → 횟수 */
  equipment: Record<string, Record<string, number>>;
};

export type ErMetaCollectionBasis = {
  seasonId: number;
  seasonName: string;
  /** 센 경기에서 가장 많은 "versionMajor.versionMinor". 모르면 null */
  patch: string | null;
  /** 센 경기 수 */
  games: number;
  /** 센 참가자 수(조합 참가자의 합) */
  participants: number;
  /** uid를 찾은 랭커 수 */
  rankers: number;
  gamesPerRanker: number;
  collectedAt: string;
};

export type ErMetaCollection = { combos: ErComboTally[]; basis: ErMetaCollectionBasis };

/** 랭크 대전(공식 문서 MatchingMode 3). 메타는 랭크 경기만 센다. */
const RANKED_MODE = 3;
/** 랭킹은 스쿼드(MatchingTeamMode 3)만 지원한다. */
const SQUAD_TEAM_MODE = 3;
/** 최종 장비 부위 0~4(무기·옷·머리·팔·다리) */
const EQUIPMENT_SLOTS = ["0", "1", "2", "3", "4"];

type TopRanksResponse = { topRanks?: Array<{ nickname: string; rank: number }> };
/** 공식 문서 예시는 uid지만 실제 응답(2026-10-15 확인)은 userId다. 둘 다 받는다. */
type NicknameResponse = { user?: { userId?: string; uid?: string } };
type GameRow = {
  gameId: number;
  seasonId?: number;
  matchingMode?: number;
  characterNum?: number;
  gameRank?: number;
  bestWeapon?: number;
  versionMajor?: number;
  versionMinor?: number;
  mmrGain?: number;
  playerKill?: number;
  playerAssistant?: number;
  playerDeaths?: number;
  damageToPlayer?: number;
  traitFirstCore?: number;
  equipment?: Record<string, number>;
};
type GamesResponse = { userGames?: GameRow[] };

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const bump = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

/** 버전 문자열 비교용. "7.10"이 "7.9"보다 크다. */
function compareVersion(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/** 경기 수가 가장 많은 패치. 같으면 큰 버전. */
function mostCommonPatch(counts: Map<string, number>): string | null {
  return [...counts].sort((a, b) => b[1] - a[1] || compareVersion(b[0], a[0]))[0]?.[0] ?? null;
}

function emptyTally(characterCode: number, weaponCode: number): ErComboTally {
  return { characterCode, weaponCode, participants: 0, rankSum: 0, top1: 0, mmrGainSum: 0, mmrGainSamples: 0, kills: 0, assists: 0, deaths: 0, damage: 0, traits: {}, equipment: {} };
}

function addRow(tally: ErComboTally, row: GameRow) {
  tally.participants += 1;
  tally.rankSum += row.gameRank!;
  if (row.gameRank === 1) tally.top1 += 1;
  if (typeof row.mmrGain === "number" && Number.isFinite(row.mmrGain)) {
    tally.mmrGainSum += row.mmrGain;
    tally.mmrGainSamples += 1;
  }
  tally.kills += num(row.playerKill);
  tally.assists += num(row.playerAssistant);
  tally.deaths += num(row.playerDeaths);
  tally.damage += num(row.damageToPlayer);
  if (row.traitFirstCore) bump(tally.traits, String(row.traitFirstCore));
  for (const slot of EQUIPMENT_SLOTS) {
    const item = row.equipment?.[slot];
    if (item) bump((tally.equipment[slot] ??= {}), String(item));
  }
}

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
  options: { rankers: number; gamesPerRanker: number; onProgress?: MetaProgress; now?: () => number },
): Promise<ErMetaCollection> {
  const { gamesPerRanker } = options;
  const isCurrentRanked = (row: { matchingMode?: number; seasonId?: number }) => row.matchingMode === RANKED_MODE && row.seasonId === dict.seasonId;
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

  // 3. 랭커마다 최근 이번 시즌 랭크 경기 gamesPerRanker개. 여러 랭커가 같은 경기에 있으면 한 번만 받는다.
  //    지난 시즌 경기는 여기서 걸러 상세 호출을 아낀다.
  const gameIds = new Set<number>();
  for (const uid of uids) {
    const games = await orSkip(client.get<GamesResponse>(`/v1/user/games/uid/${encodeURIComponent(uid)}`));
    for (const game of (games?.userGames ?? []).filter(isCurrentRanked).slice(0, gamesPerRanker)) {
      gameIds.add(game.gameId);
    }
    step();
  }
  total = 1 + rankers.length + uids.length + gameIds.size;

  // 4. 경기마다 이번 시즌 랭크 참가자를 (캐릭터, 무기) 조합으로 센다.
  const tallies = new Map<string, ErComboTally>();
  const patches = new Map<string, number>();
  let participants = 0;
  let games = 0;
  for (const gameId of gameIds) {
    const game = await orSkip(client.get<GamesResponse>(`/v1/games/${gameId}`));
    const rows = (game?.userGames ?? []).filter((row) => isCurrentRanked(row) && !!row.characterNum && !!row.gameRank);
    for (const row of rows) {
      const weaponCode = row.bestWeapon ?? 0;
      const key = `${row.characterNum}:${weaponCode}`;
      const tally = tallies.get(key) ?? emptyTally(row.characterNum!, weaponCode);
      addRow(tally, row);
      tallies.set(key, tally);
      participants += 1;
    }
    if (rows.length > 0) {
      games += 1;
      const first = rows[0]!;
      if (typeof first.versionMajor === "number" && typeof first.versionMinor === "number") {
        const patch = `${first.versionMajor}.${first.versionMinor}`;
        patches.set(patch, (patches.get(patch) ?? 0) + 1);
      }
    }
    step();
  }
  if (participants === 0) throw new Error("집계할 경기를 하나도 받지 못했습니다");

  const combos = [...tallies.values()].sort((a, b) => b.participants - a.participants || a.characterCode - b.characterCode || a.weaponCode - b.weaponCode);
  return {
    combos,
    basis: {
      seasonId: dict.seasonId,
      seasonName: dict.seasonName,
      patch: mostCommonPatch(patches),
      games,
      participants,
      rankers: uids.length,
      gamesPerRanker,
      collectedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    },
  };
}
