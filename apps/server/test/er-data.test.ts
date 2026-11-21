/**
 * 이터널리턴 데이터 저장 단위 검사.
 * 파일이 없을 때 missing, 갱신이 사전·조합 집계를 파일과 history로 쓰고 다시 읽히는지, 직전 집계, 갱신 알림,
 * 갱신 중 중복 시작·키 없음·실패·오래된 메타, 예전 형식 파일을 본다.
 * 응답은 @bori/er 검사의 가짜 클라이언트와 고정 자료를 그대로 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createErData } from "../src/er/er-data.js";
import { dictionaryRoutes, fakeClient, fixture } from "../../../packages/er/test/fake-client.js";
import { waitFor } from "./wait.js";

const nicknamePath = (nickname: string) => `/v1/user/nickname?query=${encodeURIComponent(nickname)}`;
const routes = (): Record<string, unknown> => ({
  ...dictionaryRoutes(),
  "/v1/rank/top/41/3": fixture("rank-top.json"),
  [nicknamePath("랭커A")]: { code: 200, message: "Success", user: { userId: "uid-a", nickname: "랭커A" } },
  [nicknamePath("랭커B")]: { code: 200, message: "Success", user: { userId: "uid-b", nickname: "랭커B" } },
  "/v1/user/games/uid/uid-a": fixture("user-games-a.json"),
  "/v1/user/games/uid/uid-b": fixture("user-games-b.json"),
  "/v1/games/1001": fixture("game-1001.json"),
  "/v1/games/1002": fixture("game-1002.json"),
  [nicknamePath("가짜플레이어")]: { code: 200, message: "Success", user: { userId: "uid-p", nickname: "가짜플레이어" } },
  "/v2/user/stats/uid/uid-p/41/3": fixture("user-stats-ranked.json"),
  "/v1/user/games/uid/uid-p": fixture("user-games-player.json"),
});
const HOUR = 60 * 60 * 1000;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bori-er-data-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const open = (client = fakeClient(routes()), now?: () => number) => {
  const data = createErData({ dataDir: dir, client, rankers: 2, gamesPerRanker: 2, ...(now ? { now } : {}) });
  data.load();
  return data;
};

describe("이터널리턴 데이터", () => {
  test("파일이 없으면 missing이고 전적을 볼 수 없다", () => {
    const data = open();
    assert.equal(data.connection(), "missing");
    assert.equal(data.meta(), null);
    assert.equal(data.available(), false);
    // 상태에는 갱신 정보만 있다. 기준은 대시보드 상태(basis)가 따로 만든다
    assert.deepEqual(data.status(), { refreshing: false, progress: null, lastError: null });
  });

  test("갱신하면 사전과 메타를 파일로 쓰고 ready가 된다. 다시 읽어도 같다", async () => {
    const data = open();
    assert.equal(data.refresh(), true);
    assert.equal(data.connection(), "refreshing");
    assert.equal(data.available(), false);
    // 이미 도는 중이면 새로 시작하지 않는다.
    assert.equal(data.refresh(), false);
    await waitFor(() => !data.status().refreshing, "갱신 끝");
    assert.equal(data.status().lastError, null);
    assert.equal(data.status().progress, null);
    assert.equal(data.connection(), "ready");
    assert.deepEqual(new Set(data.meta()?.combos.map(combo => combo.characterCode)), new Set([1, 2, 3, 10]));
    assert.equal(data.available(), true);
    assert.ok(existsSync(join(dir, "er-dictionary.json")) && existsSync(join(dir, "er-meta.json")));
    assert.equal(readdirSync(join(dir, "er-history")).length, 1);
    assert.equal(data.meta()?.basis.participants, 8);
    assert.equal(data.meta()?.basis.games, 2);
    assert.equal(data.previousMeta(), null);

    const reloaded = open(null as never);
    assert.deepEqual(reloaded.meta(), data.meta());
    assert.equal(reloaded.dictionary()?.seasonName, "시즌 12");
  });

  test("시즌 표기 표시가 없는 예전 사전은 읽을 때 게임 시즌 번호로 바꾼다", () => {
    writeFileSync(join(dir, "er-dictionary.json"), JSON.stringify({ characters: [], weaponNames: {}, seasonId: 41, seasonName: "시즌 21" }));
    const data = createErData({ dataDir: dir, client: null, rankers: 2, gamesPerRanker: 2 });
    data.load();
    assert.equal(data.dictionary()?.seasonName, "시즌 12");
  });

  test("조합 집계가 없는 예전 형식 메타(stats만)는 없는 것으로 본다", () => {
    writeFileSync(join(dir, "er-dictionary.json"), JSON.stringify({ characters: [], weaponNames: {}, seasonId: 41, seasonName: "시즌 12", seasonLabel: "official" }));
    writeFileSync(join(dir, "er-meta.json"), JSON.stringify({ stats: [], basis: { seasonName: "프리시즌 21", sampleGames: 1, collectedAt: new Date().toISOString(), description: "예시" } }));
    const data = createErData({ dataDir: dir, client: null, rankers: 2, gamesPerRanker: 2 });
    data.load();
    assert.equal(data.meta(), null);
    assert.equal(data.connection(), "missing");
  });

  test("키가 없으면 갱신하지 않고 이유를 남긴다", () => {
    const data = createErData({ dataDir: dir, client: null, rankers: 2, gamesPerRanker: 2 });
    data.load();
    assert.equal(data.refresh(), false);
    assert.match(data.status().lastError ?? "", /ER_API_KEY/);
  });

  test("갱신이 실패하면 lastError를 남기고 이전 데이터를 지우지 않는다", async () => {
    const data = open();
    data.refresh();
    await waitFor(() => !data.status().refreshing, "첫 갱신");
    const broken = routes();
    delete broken["/v1/rank/top/41/3"];
    const failing = createErData({ dataDir: dir, client: fakeClient(broken), rankers: 2, gamesPerRanker: 2 });
    failing.load();
    failing.refresh();
    await waitFor(() => !failing.status().refreshing, "실패한 갱신");
    assert.match(failing.status().lastError ?? "", /rank\/top/);
    assert.equal(failing.meta()?.basis.participants, 8);
  });

  test("24시간 넘은 메타는 stale이다", async () => {
    let clock = Date.now();
    const data = open(fakeClient(routes()), () => clock);
    data.refresh();
    await waitFor(() => !data.status().refreshing, "갱신 끝");
    clock += 23 * HOUR;
    assert.equal(data.connection(), "ready");
    clock += 2 * HOUR;
    assert.equal(data.connection(), "stale");
  });

  test("두 번 갱신하면 history에 둘이 남고 직전 집계는 첫 것이다", async () => {
    let clock = Date.parse("2026-11-21T00:00:00.000Z");
    const data = open(fakeClient(routes()), () => clock);
    data.refresh();
    await waitFor(() => !data.status().refreshing, "첫 갱신");
    const first = data.meta()?.basis.collectedAt;
    clock += HOUR;
    data.refresh();
    await waitFor(() => !data.status().refreshing, "둘째 갱신");
    assert.equal(readdirSync(join(dir, "er-history")).length, 2);
    assert.equal(data.meta()?.basis.collectedAt, "2026-11-21T01:00:00.000Z");
    assert.equal(data.previousMeta()?.basis.collectedAt, first);
    // 다시 읽어도 직전 집계를 찾는다
    const reloaded = open(null as never);
    assert.equal(reloaded.previousMeta()?.basis.collectedAt, first);
  });

  test("갱신이 끝나면 듣는 쪽을 부른다. 실패하면 부르지 않는다", async () => {
    const data = open();
    let calls = 0;
    const stop = data.onRefreshed(() => { calls += 1; });
    data.refresh();
    await waitFor(() => !data.status().refreshing, "갱신 끝");
    assert.equal(calls, 1);

    const broken = routes();
    delete broken["/v1/rank/top/41/3"];
    const failing = open(fakeClient(broken));
    let failingCalls = 0;
    failing.onRefreshed(() => { failingCalls += 1; });
    failing.refresh();
    await waitFor(() => !failing.status().refreshing, "실패한 갱신");
    assert.equal(failingCalls, 0);

    stop();
    data.refresh();
    await waitFor(() => !data.status().refreshing, "셋째 갱신");
    assert.equal(calls, 1);
  });

  test("전적 요약은 사전이 있어야 조회한다", async () => {
    const data = open();
    await assert.rejects(data.lookupPlayerSummary("가짜플레이어"), /쓸 수 없습니다/);
    data.refresh();
    await waitFor(() => !data.status().refreshing, "갱신 끝");
    const summary = await data.lookupPlayerSummary("가짜플레이어");
    assert.equal(summary?.nickname, "가짜플레이어");
    assert.equal(summary?.mainCharacters[0]?.code, 2);
    assert.deepEqual(summary?.recent.slice(0, 3).map(game => game.rank), [3, 1, 5]);
    assert.equal(await data.lookupPlayerSummary("없는닉"), null);
  });

  test("깨진 파일은 없는 것으로 본다", () => {
    writeFileSync(join(dir, "er-dictionary.json"), "{ 깨짐");
    writeFileSync(join(dir, "er-meta.json"), JSON.stringify({ stats: "아님" }));
    const data = open();
    assert.equal(data.connection(), "missing");
    assert.equal(data.dictionary(), null);
  });
});
