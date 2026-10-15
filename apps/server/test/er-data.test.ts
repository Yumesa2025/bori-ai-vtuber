/**
 * 이터널리턴 데이터 저장 단위 검사.
 * 파일이 없을 때 missing, 갱신이 사전·메타를 파일로 쓰고 다시 읽히는지, 갱신 중 중복 시작·키 없음·실패·오래된 메타를 본다.
 * 응답은 @bori/er 검사의 가짜 클라이언트와 고정 자료를 그대로 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createErData } from "../src/show/er-data.js";
import { dictionaryRoutes, fakeClient, fixture } from "../../../packages/er/test/fake-client.js";
import { waitFor } from "./chzzk-fake.js";

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
});

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
    assert.deepEqual(data.top5(), []);
    assert.equal(data.basis(), null);
    assert.equal(data.available(), false);
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
    assert.deepEqual(data.top5().map(stat => stat.name), ["아야", "재키", "피오라", "리 다이린"]);
    assert.equal(data.available(), true);
    assert.ok(existsSync(join(dir, "er-dictionary.json")) && existsSync(join(dir, "er-meta.json")));

    const reloaded = open(null as never);
    assert.deepEqual(reloaded.top5(), data.top5());
    assert.equal(reloaded.dictionary()?.seasonName, "시즌 21");
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
    assert.equal(failing.top5().length, 4);
  });

  test("일주일 넘은 메타는 stale이다", async () => {
    let clock = Date.now();
    const data = open(fakeClient(routes()), () => clock);
    data.refresh();
    await waitFor(() => !data.status().refreshing, "갱신 끝");
    clock += 8 * 24 * 60 * 60 * 1000;
    assert.equal(data.connection(), "stale");
  });

  test("깨진 파일은 없는 것으로 본다", () => {
    writeFileSync(join(dir, "er-dictionary.json"), "{ 깨짐");
    writeFileSync(join(dir, "er-meta.json"), JSON.stringify({ stats: "아님" }));
    const data = open();
    assert.equal(data.connection(), "missing");
    assert.equal(data.dictionary(), null);
  });
});
