/**
 * 조합 원래 개수 → 대시보드 수치 단위 검사. 비율·이름·표본 기준·정렬·직전 갱신 대비 변화량·패치 바뀜을 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ErComboTally, ErDictionary, ErMetaCollection, ErMetaCollectionBasis } from "@bori/er";
import { dashboardCombos, isPatchChanged, LOW_SAMPLE_PARTICIPANTS, toBasisV2, toComboStats } from "../src/er/combos.js";

const dict: ErDictionary = {
  characters: [{ code: 1, name: "재키", weapons: [] }, { code: 2, name: "아야", weapons: [] }],
  weaponNames: { 15: "단검", 9: "권총" },
  itemNames: { 117406: "저지먼트", 118403: "Tac-50", 202529: "화령장" },
  traitNames: { 7000201: "취약", 7000601: "아드레날린" },
  seasonId: 41,
  seasonName: "시즌 12",
  seasonEnd: null,
};

const tally = (overrides: Partial<ErComboTally> & Pick<ErComboTally, "characterCode" | "weaponCode" | "participants">): ErComboTally => ({
  rankSum: overrides.participants * 4,
  top1: 0,
  mmrGainSum: 0,
  mmrGainSamples: 0,
  kills: 0,
  assists: 0,
  deaths: 0,
  damage: 0,
  traits: {},
  equipment: {},
  ...overrides,
});

const basis = (overrides: Partial<ErMetaCollectionBasis> = {}): ErMetaCollectionBasis => ({
  seasonId: 41, seasonName: "시즌 12", patch: "7.0", games: 10, participants: 100, rankers: 5, gamesPerRanker: 2, collectedAt: "2026-11-21T00:00:00.000Z", ...overrides,
});

const collection = (combos: ErComboTally[], overrides: Partial<ErMetaCollectionBasis> = {}): ErMetaCollection => ({ combos, basis: basis(overrides) });

describe("조합 수치", () => {
  test("원래 개수를 비율·평균으로 바꾸고 이름을 붙인다", () => {
    const [stat] = toComboStats(collection([tally({
      characterCode: 1, weaponCode: 15, participants: 40, rankSum: 120, top1: 8,
      mmrGainSum: 300, mmrGainSamples: 30, kills: 160, assists: 120, deaths: 80, damage: 600000,
      traits: { "7000201": 30, "7000601": 6, "7100401": 4 },
      equipment: { "0": { "117406": 20, "118403": 15, "999": 5 }, "1": { "202529": 40 } },
    })]), dict);
    assert.deepEqual(stat, {
      characterCode: 1, characterName: "재키", weaponCode: 15, weaponName: "단검",
      participants: 40, pickRate: 0.4, avgRank: 3, top1Rate: 0.2,
      avgMmrGain: 10, avgKills: 4, avgAssists: 3, avgDeaths: 2, avgDamage: 15000,
      // 최대 2개, 비율은 그 조합 참가자 대비
      topTraits: [{ code: 7000201, name: "취약", rate: 0.75 }, { code: 7000601, name: "아드레날린", rate: 0.15 }],
      topEquipment: [
        { slot: 0, items: [{ code: 117406, name: "저지먼트", rate: 0.5 }, { code: 118403, name: "Tac-50", rate: 0.375 }] },
        { slot: 1, items: [{ code: 202529, name: "화령장", rate: 1 }] },
      ],
      lowSample: false,
      change: null,
    });
  });

  test("MMR 표본이 없으면 평균 MMR 증감은 null이다", () => {
    const [stat] = toComboStats(collection([tally({ characterCode: 1, weaponCode: 15, participants: 40 })]), dict);
    assert.equal(stat?.avgMmrGain, null);
  });

  test("사전에 없는 이름은 코드로, 무기를 모르면 빈 이름이다", () => {
    const [stat] = toComboStats(collection([tally({
      characterCode: 77, weaponCode: 0, participants: 40, traits: { "123": 1 }, equipment: { "2": { "456": 1 } },
    })]), null);
    assert.equal(stat?.characterName, "캐릭터 77");
    assert.equal(stat?.weaponName, "");
    assert.equal(stat?.topTraits[0]?.name, "특성 123");
    assert.equal(stat?.topEquipment[0]?.items[0]?.name, "장비 456");
  });

  test("참가자 30명 미만은 표본이 적다", () => {
    assert.equal(LOW_SAMPLE_PARTICIPANTS, 30);
    const stats = toComboStats(collection([
      tally({ characterCode: 1, weaponCode: 15, participants: 30 }),
      tally({ characterCode: 2, weaponCode: 9, participants: 29 }),
    ]), dict);
    assert.deepEqual(stats.map((s) => s.lowSample), [false, true]);
  });

  test("픽률 높은 순, 같으면 평균 순위가 좋은 순이다", () => {
    const stats = toComboStats(collection([
      tally({ characterCode: 2, weaponCode: 9, participants: 10, rankSum: 50 }),
      tally({ characterCode: 1, weaponCode: 16, participants: 40, rankSum: 160 }),
      tally({ characterCode: 1, weaponCode: 15, participants: 10, rankSum: 30 }),
    ]), dict);
    assert.deepEqual(stats.map((s) => [s.characterCode, s.weaponCode]), [[1, 16], [1, 15], [2, 9]]);
  });
});

describe("직전 갱신과 비교", () => {
  test("변화량은 이번 값 − 직전 값이다(평균 순위 3.9 → 3.4면 -0.5)", () => {
    const previous = collection([tally({ characterCode: 1, weaponCode: 15, participants: 50, rankSum: 195, top1: 5, mmrGainSum: 100, mmrGainSamples: 50 })], { participants: 200 });
    const current = collection([tally({ characterCode: 1, weaponCode: 15, participants: 40, rankSum: 136, top1: 8, mmrGainSum: 400, mmrGainSamples: 40 })], { participants: 100 });
    const [stat] = dashboardCombos(current, previous, dict);
    assert.ok(stat?.change);
    assert.ok(Math.abs(stat.change.avgRank - -0.5) < 1e-9);
    assert.ok(Math.abs(stat.change.top1Rate - (0.2 - 0.1)) < 1e-9);
    assert.ok(Math.abs(stat.change.pickRate - (0.4 - 0.25)) < 1e-9);
    assert.ok(Math.abs((stat.change.avgMmrGain ?? NaN) - (10 - 2)) < 1e-9);
  });

  test("직전에 없던 조합은 change가 null, 한쪽 MMR 표본이 없으면 MMR 변화량은 null", () => {
    const previous = collection([tally({ characterCode: 1, weaponCode: 15, participants: 50 })]);
    const current = collection([
      tally({ characterCode: 1, weaponCode: 15, participants: 50, mmrGainSum: 100, mmrGainSamples: 50 }),
      tally({ characterCode: 2, weaponCode: 9, participants: 50 }),
    ]);
    const stats = dashboardCombos(current, previous, dict);
    assert.equal(stats.find((s) => s.characterCode === 1)?.change?.avgMmrGain, null);
    assert.equal(stats.find((s) => s.characterCode === 2)?.change, null);
  });

  test("직전 갱신이 없으면 모두 null", () => {
    const stats = dashboardCombos(collection([tally({ characterCode: 1, weaponCode: 15, participants: 50 })]), null, dict);
    assert.equal(stats[0]?.change, null);
  });

  test("시즌이나 패치가 다르면 patchChanged", () => {
    assert.equal(isPatchChanged(basis(), null), false);
    assert.equal(isPatchChanged(basis(), basis({ collectedAt: "2026-11-20T00:00:00.000Z" })), false);
    assert.equal(isPatchChanged(basis(), basis({ patch: "6.9" })), true);
    assert.equal(isPatchChanged(basis(), basis({ seasonId: 40 })), true);
    assert.equal(isPatchChanged(basis({ patch: null }), basis()), true);
  });

  test("기준 정보에 직전 수집 시각과 패치 바뀜을 담는다", () => {
    assert.deepEqual(toBasisV2(basis(), basis({ patch: "6.9", collectedAt: "2026-11-20T00:00:00.000Z" })), {
      seasonId: 41, seasonName: "시즌 12", patch: "7.0", games: 10, participants: 100, rankers: 5, gamesPerRanker: 2,
      collectedAt: "2026-11-21T00:00:00.000Z", previousCollectedAt: "2026-11-20T00:00:00.000Z", patchChanged: true,
    });
    assert.equal(toBasisV2(basis(), null).previousCollectedAt, null);
  });
});
