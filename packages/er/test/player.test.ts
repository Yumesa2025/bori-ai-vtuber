/**
 * 전적 조회 단위 검사. 닉네임 → uid → 랭크(없으면 일반) 통계 → 최근 경기 순서로 묻는다.
 * 결과는 대시보드 "내 전적" 칸의 재료다(주캐릭터 메타 순위는 서버가 붙인다). 닉네임·uid는 가짜 값이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ErApiError } from "../src/client.js";
import { loadDictionary } from "../src/dictionary.js";
import { lookupPlayer } from "../src/player.js";
import { dictionaryRoutes, fakeClient, fixture } from "./fake-client.js";

const NICK = "보리팬클럽";
const nicknamePath = `/v1/user/nickname?query=${encodeURIComponent(NICK)}`;
const RANKED = "/v2/user/stats/uid/uid-p/41/3";
const NORMAL = "/v2/user/stats/uid/uid-p/0/2";
const GAMES = "/v1/user/games/uid/uid-p";

function playerRoutes(): Record<string, unknown> {
  return {
    ...dictionaryRoutes(),
    [nicknamePath]: { code: 200, message: "Success", user: { userId: "uid-p", nickname: NICK } },
    [RANKED]: fixture("user-stats-ranked.json"),
    [NORMAL]: fixture("user-stats-normal.json"),
    [GAMES]: fixture("user-games-player.json"),
  };
}

async function lookup(routes: Record<string, unknown>, nickname = NICK) {
  const dict = await loadDictionary(fakeClient(routes));
  const client = fakeClient(routes);
  return { report: await lookupPlayer(client, dict, nickname), calls: client.calls };
}

test("랭크 통계로 MMR·백분위·평균 킬과 최근 10판·주캐릭터를 만든다", async () => {
  const { report, calls } = await lookup(playerRoutes());
  assert.deepEqual(report, {
    nickname: NICK,
    seasonName: "시즌 12",
    mmr: 3107,
    rankPercent: 0.41,
    games: 40,
    avgRank: 3.45,
    top1Rate: 0.15,
    avgKills: 2.5,
    avgAssists: 4.1,
    // 랭크 경기만, 최신이 앞, 최대 10개
    recent: [
      { characterName: "아야", weaponName: "권총", rank: 3, kills: 4, mmrGain: 12 },
      { characterName: "아야", weaponName: "권총", rank: 1, kills: 6, mmrGain: 48 },
      { characterName: "아야", weaponName: "권총", rank: 5, kills: 1, mmrGain: -20 },
      { characterName: "아야", weaponName: "권총", rank: 2, kills: 3, mmrGain: 30 },
      { characterName: "아야", weaponName: "권총", rank: 8, kills: 0, mmrGain: -45 },
      { characterName: "아야", weaponName: "권총", rank: 4, kills: 2, mmrGain: 5 },
      { characterName: "아야", weaponName: "권총", rank: 1, kills: 7, mmrGain: 60 },
      { characterName: "아야", weaponName: "권총", rank: 6, kills: 1, mmrGain: -10 },
      { characterName: "아야", weaponName: "권총", rank: 2, kills: 3, mmrGain: 35 },
      { characterName: "아야", weaponName: "권총", rank: 7, kills: 2, mmrGain: -30 },
    ],
    mainCharacters: [
      { code: 2, name: "아야", games: 20, avgRank: 2.9 },
      { code: 1, name: "재키", games: 12, avgRank: 3.8 },
      { code: 3, name: "피오라", games: 5, avgRank: 4.2 },
    ],
  });
  // 랭크가 있으면 일반 통계는 묻지 않는다
  assert.deepEqual(calls, [nicknamePath, RANKED, GAMES]);
});

test("랭크 통계가 비어 있으면 일반 통계와 일반 경기를 쓰고 MMR·백분위는 null이다", async () => {
  const routes = { ...playerRoutes(), [RANKED]: { code: 200, message: "Success", userStats: [] } };
  const { report, calls } = await lookup(routes);
  assert.equal(report?.seasonName, "일반 대전");
  assert.equal(report?.games, 8);
  assert.equal(report?.avgRank, 4);
  assert.equal(report?.top1Rate, 0.25);
  assert.equal(report?.mmr, null);
  assert.equal(report?.rankPercent, null);
  assert.equal(report?.avgKills, null);
  assert.deepEqual(report?.recent, [
    { characterName: "재키", weaponName: "단검", rank: 10, kills: 2, mmrGain: null },
    { characterName: "재키", weaponName: "단검", rank: 11, kills: 3, mmrGain: null },
  ]);
  assert.deepEqual(report?.mainCharacters, [{ code: 1, name: "재키", games: 8, avgRank: 4 }]);
  assert.deepEqual(calls, [nicknamePath, RANKED, NORMAL, GAMES]);
});

test("닉네임은 응답의 표기를 쓰고, 없으면 입력한 닉네임을 쓴다", async () => {
  const routes = { ...playerRoutes(), [nicknamePath]: { code: 200, message: "Success", user: { userId: "uid-p" } } };
  const { report } = await lookup(routes);
  assert.equal(report?.nickname, NICK);
});

test("무기·캐릭터를 모르는 최근 경기는 빈 무기 이름과 코드 이름을 쓴다", async () => {
  const routes = { ...playerRoutes(), [GAMES]: { code: 200, message: "Success", userGames: [{ gameId: 1, matchingMode: 3, seasonId: 41, characterNum: 77, gameRank: 2 }] } };
  const { report } = await lookup(routes);
  assert.deepEqual(report?.recent, [{ characterName: "캐릭터 77", weaponName: "", rank: 2, kills: 0, mmrGain: null }]);
});

test("닉네임 응답이 공식 문서 예시처럼 uid여도 받는다", async () => {
  const routes = { ...playerRoutes(), [nicknamePath]: { code: 200, message: "Success", user: { uid: "uid-p", nickname: NICK } } };
  const { report } = await lookup(routes);
  assert.equal(report?.games, 40);
});

test("랭크 통계가 404여도 일반 통계로 넘어간다", async () => {
  const routes = { ...playerRoutes(), [RANKED]: new ErApiError(404, 404, "Not Found") };
  const { report } = await lookup(routes);
  assert.equal(report?.games, 8);
});

test("통계가 모두 없으면 0경기 전적을 돌려준다", async () => {
  const empty = { code: 200, message: "Success", userStats: [] };
  const routes = { ...playerRoutes(), [RANKED]: empty, [NORMAL]: empty, [GAMES]: { code: 200, message: "Success", userGames: [] } };
  const { report } = await lookup(routes);
  assert.deepEqual(report, {
    nickname: NICK, seasonName: "시즌 12", mmr: null, rankPercent: null, games: 0, avgRank: 0, top1Rate: 0,
    avgKills: null, avgAssists: null, recent: [], mainCharacters: [],
  });
});

test("닉네임이 없으면 null", async () => {
  const cases: unknown[] = [
    new ErApiError(200, 404, "Not Found"),
    new ErApiError(404, null, "Not Found"),
    { code: 200, message: "Success" },
  ];
  for (const response of cases) {
    const { report, calls } = await lookup({ ...playerRoutes(), [nicknamePath]: response });
    assert.equal(report, null);
    assert.deepEqual(calls, [nicknamePath]);
  }
});

test("그 밖의 오류는 그대로 낸다", async () => {
  const routes = { ...playerRoutes(), [RANKED]: new ErApiError(500, 500, "서버 오류") };
  await assert.rejects(lookup(routes), (error: unknown) => error instanceof ErApiError && error.status === 500);
});
