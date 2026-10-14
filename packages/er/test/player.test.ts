/**
 * 전적 진단 단위 검사. 닉네임 → uid → 랭크(없으면 일반) 통계 → 최근 경기 순서로 묻는다.
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
    [nicknamePath]: { code: 200, message: "Success", user: { uid: "uid-p", nickname: NICK } },
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

test("랭크 통계로 가린 닉네임·평균 순위·최근 순위·주 캐릭터를 만든다", async () => {
  const { report, calls } = await lookup(playerRoutes());
  assert.deepEqual(report, {
    maskedNickname: "보리팬**",
    seasonName: "시즌 21",
    games: 40,
    avgRank: 3.45,
    top1Rate: 0.15,
    // 랭크 경기만, 최신이 앞, 최대 10개
    recentRanks: [3, 1, 5, 2, 8, 4, 1, 6, 2, 7],
    mainCharacters: [
      { name: "아야", games: 20, avgRank: 2.9 },
      { name: "재키", games: 12, avgRank: 3.8 },
      { name: "피오라", games: 5, avgRank: 4.2 },
    ],
  });
  // 랭크가 있으면 일반 통계는 묻지 않는다
  assert.deepEqual(calls, [nicknamePath, RANKED, GAMES]);
});

test("랭크 통계가 비어 있으면 일반 통계와 일반 경기를 쓴다", async () => {
  const routes = { ...playerRoutes(), [RANKED]: { code: 200, message: "Success", userStats: [] } };
  const { report, calls } = await lookup(routes);
  assert.equal(report?.seasonName, "일반 대전");
  assert.equal(report?.games, 8);
  assert.equal(report?.avgRank, 4);
  assert.equal(report?.top1Rate, 0.25);
  assert.deepEqual(report?.recentRanks, [10, 11]);
  assert.deepEqual(report?.mainCharacters, [{ name: "재키", games: 8, avgRank: 4 }]);
  assert.deepEqual(calls, [nicknamePath, RANKED, NORMAL, GAMES]);
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
  assert.deepEqual(report, { maskedNickname: "보리팬**", seasonName: "시즌 21", games: 0, avgRank: 0, top1Rate: 0, recentRanks: [], mainCharacters: [] });
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
