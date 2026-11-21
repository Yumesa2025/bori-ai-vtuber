import type { ErComboTally, ErDictionary, ErMetaCollection, ErMetaCollectionBasis } from "@bori/er";
import type { ErComboStat, ErMetaBasisV2 } from "@bori/shared";

/**
 * 조합 원래 개수(@bori/er collectMeta) → 대시보드 수치(ErComboStat). 모두 순수 함수다.
 * - 픽률의 분모는 집계한 전체 참가자 수, 나머지 비율·평균의 분모는 그 조합 참가자 수다.
 * - 변화량은 모두 "이번 값 − 직전 값"이다(평균 순위 3.9 → 3.4면 -0.5).
 */

/** 이보다 참가자가 적은 조합은 표본이 적다. 화면에서 흐리게, 보리 대사에서는 뺀다. */
export const LOW_SAMPLE_PARTICIPANTS = 30;
const TOP_TRAITS = 2;
const TOP_ITEMS_PER_SLOT = 2;

type Names = Pick<ErDictionary, "characters" | "weaponNames" | "itemNames" | "traitNames">;

/** 많은 순으로 limit개. 같으면 코드가 작은 쪽. 비율은 participants 대비. */
function topCounts(counts: Record<string, number>, limit: number, participants: number, name: (code: number) => string) {
  return Object.entries(counts)
    .map(([code, count]) => ({ code: Number(code), count }))
    .sort((a, b) => b.count - a.count || a.code - b.code)
    .slice(0, limit)
    .map(({ code, count }) => ({ code, name: name(code), rate: count / participants }));
}

function toComboStat(tally: ErComboTally, totalParticipants: number, names: Names | null): ErComboStat {
  const characterName = names?.characters.find((character) => character.code === tally.characterCode)?.name ?? `캐릭터 ${tally.characterCode}`;
  const weaponName = tally.weaponCode ? (names?.weaponNames[tally.weaponCode] ?? "") : "";
  const n = tally.participants;
  return {
    characterCode: tally.characterCode,
    characterName,
    weaponCode: tally.weaponCode,
    weaponName,
    participants: n,
    pickRate: totalParticipants > 0 ? n / totalParticipants : 0,
    avgRank: tally.rankSum / n,
    top1Rate: tally.top1 / n,
    avgMmrGain: tally.mmrGainSamples > 0 ? tally.mmrGainSum / tally.mmrGainSamples : null,
    avgKills: tally.kills / n,
    avgAssists: tally.assists / n,
    avgDeaths: tally.deaths / n,
    avgDamage: tally.damage / n,
    topTraits: topCounts(tally.traits, TOP_TRAITS, n, (code) => names?.traitNames?.[code] ?? `특성 ${code}`),
    topEquipment: Object.keys(tally.equipment)
      .map(Number)
      .sort((a, b) => a - b)
      .map((slot) => ({ slot, items: topCounts(tally.equipment[String(slot)] ?? {}, TOP_ITEMS_PER_SLOT, n, (code) => names?.itemNames?.[code] ?? `장비 ${code}`) })),
    lowSample: n < LOW_SAMPLE_PARTICIPANTS,
    change: null,
  };
}

/** 픽률 순(같으면 평균 순위·캐릭터·무기 코드 순). change는 null이다. */
export function toComboStats(collection: ErMetaCollection, names: Names | null): ErComboStat[] {
  return collection.combos
    .filter((tally) => tally.participants > 0)
    .map((tally) => toComboStat(tally, collection.basis.participants, names))
    .sort((a, b) => b.pickRate - a.pickRate || a.avgRank - b.avgRank || a.characterCode - b.characterCode || a.weaponCode - b.weaponCode);
}

const comboKey = (stat: Pick<ErComboStat, "characterCode" | "weaponCode">) => `${stat.characterCode}:${stat.weaponCode}`;

/**
 * 직전 갱신 대비 변화량을 붙인다. 비교 키는 캐릭터 code + 무기 code(이름은 번역이 바뀔 수 있다).
 * 직전이나 이번 중 하나라도 표본이 적으면 change는 null이다. 잡음끼리의 차이를 화면 ▲▼·오르고 내린 조합·보리 대사가
 * 모두 같은 기준으로 거르게 한다(직전 5명 6.2위 → 이번 35명 3.8위 같은 가짜 급등을 막는다).
 */
function withChanges(current: ErComboStat[], previous: ErComboStat[] | null): ErComboStat[] {
  if (!previous) return current;
  const before = new Map(previous.map((stat) => [comboKey(stat), stat]));
  return current.map((stat) => {
    const old = before.get(comboKey(stat));
    if (!old || old.lowSample || stat.lowSample) return stat;
    return {
      ...stat,
      change: {
        avgRank: stat.avgRank - old.avgRank,
        top1Rate: stat.top1Rate - old.top1Rate,
        pickRate: stat.pickRate - old.pickRate,
        avgMmrGain: stat.avgMmrGain !== null && old.avgMmrGain !== null ? stat.avgMmrGain - old.avgMmrGain : null,
      },
    };
  });
}

/** 대시보드 combos. 직전 집계가 없으면 change는 모두 null. 직전·이번 중 하나라도 표본이 적은 조합도 null. */
export function dashboardCombos(current: ErMetaCollection, previous: ErMetaCollection | null, names: Names | null): ErComboStat[] {
  return withChanges(toComboStats(current, names), previous ? toComboStats(previous, names) : null);
}

/** 직전 갱신과 시즌이나 기준 패치가 다르다. 직전이 없으면 false. */
export function isPatchChanged(current: ErMetaCollectionBasis, previous: ErMetaCollectionBasis | null): boolean {
  if (!previous) return false;
  return current.seasonId !== previous.seasonId || current.patch !== previous.patch;
}

export function toBasisV2(current: ErMetaCollectionBasis, previous: ErMetaCollectionBasis | null): ErMetaBasisV2 {
  return {
    seasonId: current.seasonId,
    seasonName: current.seasonName,
    patch: current.patch,
    games: current.games,
    participants: current.participants,
    rankers: current.rankers,
    gamesPerRanker: current.gamesPerRanker,
    collectedAt: current.collectedAt,
    previousCollectedAt: previous?.collectedAt ?? null,
    patchChanged: isPatchChanged(current, previous),
  };
}
