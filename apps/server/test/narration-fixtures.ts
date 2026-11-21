/**
 * narration 검사가 같이 쓰는 가짜 메타 집계. 파일 이름이 *.test.ts가 아니라 검사로 직접 돌지 않는다.
 * 캐릭터·무기 이름은 게임의 공개 이름을 쓰고, 플레이어 닉네임은 가짜 값이다.
 */
import type { ErComboStat, ErMetaBasisV2, ErPlayerSummary } from "@bori/shared";

type ComboSeed = Pick<ErComboStat, "characterCode" | "characterName" | "weaponCode" | "weaponName" | "participants" | "pickRate" | "avgRank" | "top1Rate"> & Partial<ErComboStat>;

export function combo(seed: ComboSeed): ErComboStat {
  return {
    avgMmrGain: 10,
    avgKills: 3.2,
    avgAssists: 4.1,
    avgDeaths: 2.5,
    avgDamage: 12_000,
    topTraits: [],
    topEquipment: [],
    lowSample: false,
    change: null,
    ...seed,
  };
}

/** 픽률 순. 유키 양손검은 표본이 적다. */
export const fixtureCombos: ErComboStat[] = [
  combo({ characterCode: 1, characterName: "재키", weaponCode: 13, weaponName: "쌍검", participants: 412, pickRate: 0.081, avgRank: 3.42, top1Rate: 0.14, avgMmrGain: 12.3, change: { avgRank: -0.5, top1Rate: 0.02, pickRate: 0.01, avgMmrGain: 3 } }),
  combo({ characterCode: 2, characterName: "아야", weaponCode: 7, weaponName: "권총", participants: 380, pickRate: 0.075, avgRank: 4.1, top1Rate: 0.1, change: { avgRank: 0.6, top1Rate: -0.01, pickRate: -0.004, avgMmrGain: -2 } }),
  combo({ characterCode: 3, characterName: "현우", weaponCode: 9, weaponName: "글러브", participants: 350, pickRate: 0.07, avgRank: 3.8, top1Rate: 0.12, change: { avgRank: -0.2, top1Rate: 0.01, pickRate: 0.002, avgMmrGain: null } }),
  combo({ characterCode: 4, characterName: "나딘", weaponCode: 11, weaponName: "활", participants: 300, pickRate: 0.06, avgRank: 4.5, top1Rate: 0.08, change: null }),
  combo({ characterCode: 6, characterName: "하트", weaponCode: 20, weaponName: "기타", participants: 200, pickRate: 0.05, avgRank: 4.4, top1Rate: 0.09, change: { avgRank: 0.02, top1Rate: 0, pickRate: 0, avgMmrGain: 0 } }),
  combo({ characterCode: 5, characterName: "유키", weaponCode: 14, weaponName: "양손검", participants: 12, pickRate: 0.003, avgRank: 2.0, top1Rate: 0.3, lowSample: true, change: { avgRank: -2, top1Rate: 0.2, pickRate: 0.001, avgMmrGain: 20 } }),
];

export const fixtureBasis: ErMetaBasisV2 = {
  seasonId: 31,
  seasonName: "시즌 13",
  patch: "1.47",
  games: 300,
  participants: 7_200,
  rankers: 100,
  gamesPerRanker: 3,
  collectedAt: "2026-11-21T03:00:00.000Z",
  previousCollectedAt: "2026-11-20T03:00:00.000Z",
  patchChanged: false,
};

export const FAKE_NICKNAME = "테스트유저";

export const fixturePlayer: ErPlayerSummary = {
  nickname: FAKE_NICKNAME,
  seasonName: "시즌 13",
  mmr: 4321,
  rankPercent: 0.05,
  games: 40,
  avgRank: 4.2,
  top1Rate: 0.1,
  avgKills: 3.1,
  avgAssists: 2.2,
  recent: [{ characterName: "재키", weaponName: "쌍검", rank: 2, kills: 5, mmrGain: 30 }],
  mainCharacters: [{ name: "재키", games: 23, avgRank: 4.24, metaRank: 2 }, { name: "아야", games: 10, avgRank: 5, metaRank: null }],
};
