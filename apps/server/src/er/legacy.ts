import { maskNickname, type ErDictionary, type ErMetaCollection, type ErPlayerLookup } from "@bori/er";
import type { ErCharacterStat, ErMetaBasis, ErPlayerReport } from "@bori/shared";

/**
 * 예전 방송 경로(show/·OBS 대시보드·스튜디오 ER 패널)가 쓰는 형식으로 바꾼다.
 * 새 대시보드는 쓰지 않는다. 방송 코드를 지우는 작업(T2)이 끝나면 이 파일과 er-data의 legacy 메서드를 같이 지운다.
 */

/** 조합을 캐릭터로 합친다. 픽 수 내림차순, 같으면 평균 순위·코드 순. 주 무기는 가장 많이 쓴 무기(같으면 코드가 작은 쪽). */
export function toCharacterStats(collection: ErMetaCollection, dict: ErDictionary | null): ErCharacterStat[] {
  const byCharacter = new Map<number, { picks: number; rankSum: number; top1: number; weapons: Map<number, number> }>();
  for (const combo of collection.combos) {
    const entry = byCharacter.get(combo.characterCode) ?? { picks: 0, rankSum: 0, top1: 0, weapons: new Map<number, number>() };
    entry.picks += combo.participants;
    entry.rankSum += combo.rankSum;
    entry.top1 += combo.top1;
    if (combo.weaponCode) entry.weapons.set(combo.weaponCode, (entry.weapons.get(combo.weaponCode) ?? 0) + combo.participants);
    byCharacter.set(combo.characterCode, entry);
  }
  const names = new Map((dict?.characters ?? []).map((character) => [character.code, character.name]));
  const total = collection.basis.participants;
  return [...byCharacter]
    .filter(([, entry]) => entry.picks > 0)
    .map(([code, entry]) => {
      const weapon = [...entry.weapons].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      return {
        code,
        name: names.get(code) ?? `캐릭터 ${code}`,
        picks: entry.picks,
        pickRate: total > 0 ? entry.picks / total : 0,
        avgRank: entry.rankSum / entry.picks,
        top1Rate: entry.top1 / entry.picks,
        mainWeapon: weapon === undefined ? "" : (dict?.weaponNames[weapon] ?? ""),
      };
    })
    .sort((a, b) => b.picks - a.picks || a.avgRank - b.avgRank || a.code - b.code);
}

/** sampleGames는 예전 뜻(캐릭터-경기 수 = 참가자 수) 그대로 두고, 문구에서 경기 수와 참가자 수를 나눠 밝힌다. */
export function toLegacyBasis(collection: ErMetaCollection): ErMetaBasis {
  const { games, participants, seasonName, collectedAt } = collection.basis;
  return {
    seasonName,
    sampleGames: participants,
    collectedAt,
    description: `상위 랭커 경기 ${games.toLocaleString("en-US")}판(참가자 ${participants.toLocaleString("en-US")}명) 기준`,
  };
}

/** 방송 화면용 보고서. 닉네임은 가린다. */
export function toPlayerReport(lookup: ErPlayerLookup): ErPlayerReport {
  return {
    maskedNickname: maskNickname(lookup.nickname),
    seasonName: lookup.seasonName,
    games: lookup.games,
    avgRank: lookup.avgRank,
    top1Rate: lookup.top1Rate,
    recentRanks: lookup.recent.map((game) => game.rank),
    mainCharacters: lookup.mainCharacters.map(({ name, games, avgRank }) => ({ name, games, avgRank })),
  };
}
