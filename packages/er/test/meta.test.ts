/**
 * 메타 집계 단위 검사. 2경기 × 4명 가짜 응답(실제 필드 모양, 닉네임은 가짜)으로 손계산한 원래 개수와 맞춘다.
 *
 * 1001: 재키·단검 1등, 아야·권총 2등, 피오라·레이피어 3등, 재키·양손검 4등(MMR 증감 없음)
 * 1002: 아야·권총 1등, 재키·단검 2등, 아야·돌격 소총 3등, 리 다이린·글러브 4등
 * 경기 2, 참가자 8. 두 경기 모두 시즌 41·패치 7.0
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
    [nicknamePath("랭커A")]: { code: 200, message: "Success", user: { userId: "uid-a", nickname: "랭커A" } },
    // 공식 문서 예시는 uid지만 실제 응답(2026-10-15)은 userId다. 둘 다 받는다
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

const NOW = Date.parse("2026-11-21T00:00:00.000Z");
const collect = (client: Parameters<typeof collectMeta>[0], dict: Parameters<typeof collectMeta>[1], rankers = 2, gamesPerRanker = 2) =>
  collectMeta(client, dict, { rankers, gamesPerRanker, now: () => NOW });

test("상위 랭커의 이번 시즌 랭크 경기를 (캐릭터, 무기) 조합별 원래 개수로 모은다", async () => {
  const { dict, client } = await setup();
  const { combos, basis } = await collect(client, dict);

  // 참가자 많은 순, 같으면 캐릭터·무기 코드 순
  assert.deepEqual(combos.map((c) => [c.characterCode, c.weaponCode, c.participants]), [[1, 15, 2], [2, 9, 2], [1, 16, 1], [2, 10, 1], [3, 21, 1], [10, 1, 1]]);
  assert.deepEqual(combos[0], {
    characterCode: 1, weaponCode: 15, participants: 2, rankSum: 3, top1: 1,
    mmrGainSum: 65, mmrGainSamples: 2, kills: 9, assists: 8, deaths: 3, damage: 36000,
    traits: { "7000201": 2 },
    equipment: { "0": { "117406": 1, "118403": 1 }, "1": { "202529": 2 }, "2": { "201404": 2 }, "3": { "205408": 2 }, "4": { "204416": 2 } },
  });
  assert.deepEqual(basis, { seasonId: 41, seasonName: "시즌 12", patch: "12.7", games: 2, participants: 8, rankers: 2, gamesPerRanker: 2, collectedAt: "2026-11-21T00:00:00.000Z" });
});

test("MMR 증감이 없는 행은 MMR 표본에서 뺀다", async () => {
  const { dict, client } = await setup();
  const { combos } = await collect(client, dict);
  const twoHand = combos.find((c) => c.characterCode === 1 && c.weaponCode === 16)!;
  assert.equal(twoHand.mmrGainSamples, 0);
  assert.equal(twoHand.mmrGainSum, 0);
  assert.equal(twoHand.participants, 1);
});

test("지난 시즌 경기는 상세를 받지 않고, 상세에서도 다른 시즌·랭크 아닌 행은 세지 않는다", async () => {
  const routes = metaRoutes();
  const userGamesA = routes["/v1/user/games/uid/uid-a"] as { userGames: Array<Record<string, unknown>> };
  // 랭커A의 최근 경기 맨 앞에 지난 시즌(40) 랭크 경기를 끼운다
  routes["/v1/user/games/uid/uid-a"] = { ...userGamesA, userGames: [{ gameId: 990, matchingMode: 3, matchingTeamMode: 3, seasonId: 40, characterNum: 1, gameRank: 1 }, ...userGamesA.userGames] };
  const game1002 = routes["/v1/games/1002"] as { userGames: Array<Record<string, unknown>> };
  routes["/v1/games/1002"] = {
    ...game1002,
    userGames: [...game1002.userGames, { ...game1002.userGames[0], seasonId: 40 }, { ...game1002.userGames[0], matchingMode: 2 }],
  };
  const { dict, client } = await setup(routes);
  const { basis } = await collect(client, dict);
  assert.equal(client.calls.includes("/v1/games/990"), false);
  assert.equal(basis.participants, 8);
  assert.equal(basis.games, 2);
});

test("무기를 모르는 행은 무기 0으로 센다", async () => {
  const routes = metaRoutes();
  const game1002 = routes["/v1/games/1002"] as { userGames: Array<Record<string, unknown>> };
  routes["/v1/games/1002"] = { ...game1002, userGames: game1002.userGames.map((row, i) => (i === 3 ? { ...row, bestWeapon: undefined } : row)) };
  const { dict, client } = await setup(routes);
  const { combos } = await collect(client, dict);
  assert.ok(combos.some((c) => c.characterCode === 10 && c.weaponCode === 0));
});

test("패치는 versionSeason.versionMajor의 경기 수 최빈값이고 같으면 큰 버전, 버전 필드가 없으면 null", async () => {
  const withVersion = (fields: Record<string, number>) => {
    const routes = metaRoutes();
    const game1002 = routes["/v1/games/1002"] as { userGames: Array<Record<string, unknown>> };
    routes["/v1/games/1002"] = { ...game1002, userGames: game1002.userGames.map((row) => ({ ...row, ...fields })) };
    return routes;
  };
  // 12.7 한 판, 12.8 한 판 → 큰 버전
  let { dict, client } = await setup(withVersion({ versionMajor: 8 }));
  assert.equal((await collect(client, dict)).basis.patch, "12.8");
  // versionMinor(핫픽스)는 패치 구분에 쓰지 않는다
  ({ dict, client } = await setup(withVersion({ versionMinor: 1 })));
  assert.equal((await collect(client, dict)).basis.patch, "12.7");

  const noVersion = metaRoutes();
  for (const id of ["1001", "1002"]) {
    const game = noVersion[`/v1/games/${id}`] as { userGames: Array<Record<string, unknown>> };
    noVersion[`/v1/games/${id}`] = { ...game, userGames: game.userGames.map(({ versionSeason: _season, versionMajor: _major, versionMinor: _minor, ...row }) => row) };
  }
  ({ dict, client } = await setup(noVersion));
  assert.equal((await collect(client, dict)).basis.patch, null);
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
  const { combos, basis } = await collectMeta(client, dict, { rankers: 3, gamesPerRanker: 2 });
  assert.ok(client.calls.includes(nicknamePath("랭커C")));
  assert.equal(basis.games, 1);
  assert.equal(basis.participants, 4);
  // 랭커C는 uid를 못 찾아 랭커 수에서 빠진다
  assert.equal(basis.rankers, 2);
  assert.deepEqual(combos.map((c) => [c.characterCode, c.weaponCode]), [[1, 15], [1, 16], [2, 9], [3, 21]]);
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

test("경기 수와 참가자 수를 따로 센다", async () => {
  const many = Array.from({ length: 1234 }, (_, i) => ({ gameId: 1001, matchingMode: 3, seasonId: 41, characterNum: 1, gameRank: (i % 8) + 1, bestWeapon: 15 }));
  const routes = { ...metaRoutes(), "/v1/games/1001": { code: 200, message: "Success", userGames: many } };
  const { dict, client } = await setup(routes);
  const { basis, combos } = await collectMeta(client, dict, { rankers: 1, gamesPerRanker: 1 });
  assert.equal(basis.games, 1);
  assert.equal(basis.participants, 1234);
  assert.equal(combos[0]?.participants, 1234);
});

// 유저 경기 목록은 한 쪽에 10판이고 next가 있으면 ?next=<값>으로 다음 쪽을 받는다(2026-11-21 실제 응답 확인)
test("경기 목록 한 쪽으로 모자라면 next로 다음 쪽을 받아 gamesPerRanker개까지 채운다", async () => {
  const page1 = { code: 200, message: "Success", next: 77, userGames: [{ gameId: 1001, matchingMode: 3, seasonId: 41 }, { gameId: 1000, matchingMode: 2, seasonId: 0 }] };
  const page2 = { code: 200, message: "Success", userGames: [{ gameId: 1002, matchingMode: 3, seasonId: 41 }] };
  const routes = { ...metaRoutes(), "/v1/user/games/uid/uid-a": page1, "/v1/user/games/uid/uid-a?next=77": page2 };
  const { dict, client } = await setup(routes);
  const progress: Array<[number, number]> = [];
  const { basis } = await collectMeta(client, dict, { rankers: 1, gamesPerRanker: 2, onProgress: (done, total) => progress.push([done, total]) });
  assert.ok(client.calls.includes("/v1/user/games/uid/uid-a?next=77"));
  assert.equal(basis.games, 2);
  // 더 받은 쪽도 진행률에 넣고, 끝에서 done === total이다
  const last = progress.at(-1)!;
  assert.equal(last[0], last[1]);
  for (const [done, total] of progress) assert.ok(done <= total);
});

test("다 채웠거나 지난 시즌 랭크 경기가 보이면 다음 쪽을 받지 않는다", async () => {
  const older = { code: 200, message: "Success", next: 77, userGames: [{ gameId: 1001, matchingMode: 3, seasonId: 41 }, { gameId: 900, matchingMode: 3, seasonId: 40 }] };
  const { dict, client } = await setup({ ...metaRoutes(), "/v1/user/games/uid/uid-a": older });
  await collectMeta(client, dict, { rankers: 1, gamesPerRanker: 5 });
  assert.equal(client.calls.some((call) => call.includes("next=")), false);

  const full = { code: 200, message: "Success", next: 77, userGames: [{ gameId: 1001, matchingMode: 3, seasonId: 41 }] };
  const second = await setup({ ...metaRoutes(), "/v1/user/games/uid/uid-a": full });
  await collectMeta(second.client, second.dict, { rankers: 1, gamesPerRanker: 1 });
  assert.equal(second.client.calls.some((call) => call.includes("next=")), false);
});

test("랭커 수는 이번 시즌 랭크 경기를 하나라도 낸 랭커만 센다", async () => {
  const normalOnly = { code: 200, message: "Success", userGames: [{ gameId: 1000, matchingMode: 2, seasonId: 0 }] };
  const { dict, client } = await setup({ ...metaRoutes(), "/v1/user/games/uid/uid-b": normalOnly });
  const { basis } = await collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2 });
  assert.equal(basis.rankers, 1);
});

test("건너뛴 랭커(uid 못 찾음·경기 목록 실패)와 경기를 onSkip으로 알린다", async () => {
  const listA = { code: 200, message: "Success", userGames: [{ gameId: 1001, matchingMode: 3, seasonId: 41 }, { gameId: 1003, matchingMode: 3, seasonId: 41 }] };
  const routes = { ...metaRoutes(), "/v1/user/games/uid/uid-a": listA, "/v1/user/games/uid/uid-b": new ErApiError(500, 500, "서버 오류") };
  const { dict, client } = await setup(routes);
  const skipped: string[] = [];
  // 랭커C는 닉네임 경로가 없고, 경기 1003은 상세 경로가 없다(둘 다 404)
  const { basis } = await collectMeta(client, dict, { rankers: 3, gamesPerRanker: 2, onSkip: (what) => skipped.push(what) });
  assert.deepEqual(skipped.sort(), ["game", "ranker", "ranker"]);
  assert.equal(basis.rankers, 1);
  assert.equal(basis.games, 1);
});
