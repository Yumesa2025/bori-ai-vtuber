/**
 * 메타 집계 단위 검사. 2경기 × 4명 가짜 응답으로 손계산한 값과 맞춘다.
 *
 * 1001: 재키 1등(단검), 아야 2등(권총), 피오라 3등(레이피어), 재키 4등(양손검)
 * 1002: 아야 1등(권총), 재키 2등(단검), 아야 3등(돌격 소총), 리 다이린 4등(글러브)
 * 전체 참가자 8명
 * - 아야: 3픽, 순위 2·1·3 → 평균 2, 1등 1/3, 권총
 * - 재키: 3픽, 순위 1·4·2 → 평균 7/3, 1등 1/3, 단검
 * - 피오라: 1픽, 평균 3 / 리 다이린: 1픽, 평균 4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ErApiError } from "../src/client.js";
import { loadDictionary } from "../src/dictionary.js";
import { collectMeta } from "../src/meta.js";
import { dictionaryRoutes, fakeClient, fixture } from "./fake-client.js";

const nicknamePath = (nickname: string) => `/v1/user/nickname?query=${encodeURIComponent(nickname)}`;

function metaRoutes(): Record<string, unknown> {
  return {
    ...dictionaryRoutes(),
    "/v1/rank/top/41/3": fixture("rank-top.json"),
    [nicknamePath("랭커A")]: { code: 200, message: "Success", user: { uid: "uid-a", nickname: "랭커A" } },
    [nicknamePath("랭커B")]: { code: 200, message: "Success", user: { uid: "uid-b", nickname: "랭커B" } },
    "/v1/user/games/uid/uid-a": fixture("user-games-a.json"),
    "/v1/user/games/uid/uid-b": fixture("user-games-b.json"),
    "/v1/games/1001": fixture("game-1001.json"),
    "/v1/games/1002": fixture("game-1002.json"),
  };
}

async function setup(routes = metaRoutes()) {
  const dictClient = fakeClient(routes);
  const dict = await loadDictionary(dictClient);
  return { dict, client: fakeClient(routes) };
}

test("상위 랭커의 랭크 경기를 모아 캐릭터별로 집계한다", async () => {
  const { dict, client } = await setup();
  const { stats, basis } = await collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2 });

  assert.deepEqual(
    stats.map((stat) => stat.name),
    ["아야", "재키", "피오라", "리 다이린"],
  );
  assert.deepEqual(stats[0], { code: 2, name: "아야", picks: 3, pickRate: 3 / 8, avgRank: 2, top1Rate: 1 / 3, mainWeapon: "권총" });
  assert.deepEqual(stats[1], { code: 1, name: "재키", picks: 3, pickRate: 3 / 8, avgRank: 7 / 3, top1Rate: 1 / 3, mainWeapon: "단검" });
  assert.deepEqual(stats[2], { code: 3, name: "피오라", picks: 1, pickRate: 1 / 8, avgRank: 3, top1Rate: 0, mainWeapon: "레이피어" });
  assert.deepEqual(stats[3], { code: 10, name: "리 다이린", picks: 1, pickRate: 1 / 8, avgRank: 4, top1Rate: 0, mainWeapon: "글러브" });

  assert.equal(basis.seasonName, "시즌 21");
  assert.equal(basis.sampleGames, 8);
  assert.equal(basis.description, "최근 상위 랭커 8판 기준");
  assert.ok(!Number.isNaN(Date.parse(basis.collectedAt)));
});

test("순위 1, 2위 랭커만 쓰고 일반 경기는 고르지 않으며 같은 경기는 한 번만 받는다", async () => {
  const { dict, client } = await setup();
  await collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2 });
  assert.deepEqual(client.calls, [
    "/v1/rank/top/41/3",
    nicknamePath("랭커A"),
    nicknamePath("랭커B"),
    "/v1/user/games/uid/uid-a",
    "/v1/user/games/uid/uid-b",
    "/v1/games/1001",
    "/v1/games/1002",
  ]);
});

test("닉네임이 바뀌어 uid를 못 찾은 랭커와 받지 못한 경기는 건너뛴다", async () => {
  const routes = { ...metaRoutes(), "/v1/games/1002": new ErApiError(500, 500, "서버 오류") };
  const { dict, client } = await setup(routes);
  // 랭커C는 닉네임 조회 경로가 없어 404다
  const { stats, basis } = await collectMeta(client, dict, { rankers: 3, gamesPerRanker: 2 });
  assert.ok(client.calls.includes(nicknamePath("랭커C")));
  assert.equal(basis.sampleGames, 4);
  assert.deepEqual(stats[0], { code: 1, name: "재키", picks: 2, pickRate: 0.5, avgRank: 2.5, top1Rate: 0.5, mainWeapon: "단검" });
});

test("진행률은 늘어나기만 하고 마지막에 done === total이다", async () => {
  const { dict, client } = await setup();
  const progress: Array<[number, number]> = [];
  await collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2, onProgress: (done, total) => progress.push([done, total]) });
  assert.ok(progress.length > 0);
  for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i]![0] > progress[i - 1]![0]);
  for (const [done, total] of progress) assert.ok(done <= total);
  const last = progress.at(-1)!;
  assert.deepEqual(last, [7, 7]);
});

test("모은 경기가 없으면 실패한다", async () => {
  const routes = { ...metaRoutes(), "/v1/rank/top/41/3": { code: 200, message: "Success", topRanks: [] } };
  const { dict, client } = await setup(routes);
  await assert.rejects(collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2 }), /경기/);
});

test("상위 랭커 목록을 받지 못하면 그 오류를 그대로 낸다", async () => {
  const routes = { ...metaRoutes(), "/v1/rank/top/41/3": new ErApiError(403, null, "금지") };
  const { dict, client } = await setup(routes);
  await assert.rejects(collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2 }), (error: unknown) => error instanceof ErApiError && error.status === 403);
});

test("기준 문구의 판 수는 천 단위 쉼표를 쓴다", async () => {
  const many = Array.from({ length: 1234 }, (_, i) => ({ gameId: 1001, matchingMode: 3, characterNum: 1, gameRank: (i % 8) + 1, bestWeapon: 15 }));
  const routes = { ...metaRoutes(), "/v1/games/1001": { code: 200, message: "Success", userGames: many } };
  const { dict, client } = await setup(routes);
  const { basis } = await collectMeta(client, dict, { rankers: 1, gamesPerRanker: 1 });
  assert.equal(basis.sampleGames, 1234);
  assert.equal(basis.description, "최근 상위 랭커 1,234판 기준");
});
