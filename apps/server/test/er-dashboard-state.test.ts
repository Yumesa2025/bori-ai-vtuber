/**
 * 대시보드 상태(createDashboardData) 단위 검사. 가짜 ER 클라이언트와 임시 폴더, 주입한 시계로
 * 연결 상태·자동 갱신(하루 한 번)·버튼 갱신·기준·조합·변화량·내 전적·갱신 알림을 본다. 닉네임·uid는 가짜 값이다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErApiError } from "@bori/er";
import { createDashboardData } from "../src/er/dashboard-state.js";
import { createDashboardSettings } from "../src/er/dashboard-settings.js";
import { createErData } from "../src/er/er-data.js";
import { dictionaryRoutes, fakeClient, fixture } from "../../../packages/er/test/fake-client.js";
import { waitFor } from "./wait.js";

const PLAYER = "가짜플레이어";
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
  [nicknamePath(PLAYER)]: { code: 200, message: "Success", user: { userId: "uid-p", nickname: PLAYER } },
  "/v2/user/stats/uid/uid-p/41/3": fixture("user-stats-ranked.json"),
  "/v1/user/games/uid/uid-p": fixture("user-games-player.json"),
});

const HOUR = 60 * 60 * 1000;
/** 한국 시간 2026-11-21 09:00. 고정 자료의 시즌(41)은 끝 시각이 지난 것으로 보이므로 판정 검사는 시즌 끝을 따로 본다. */
const START = Date.parse("2026-11-21T00:00:00.000Z");

let dir: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-dashboard-"));
  clock = START;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setup(options: { client?: ReturnType<typeof fakeClient> | null } = {}) {
  const client = options.client === undefined ? fakeClient(routes()) : options.client;
  const erData = createErData({ dataDir: dir, client, rankers: 2, gamesPerRanker: 2, now: () => clock });
  erData.load();
  const settings = createDashboardSettings(dir, () => {});
  const dashboard = createDashboardData({ erData, settings, now: () => clock });
  return { erData, settings, dashboard };
}

const refreshed = (erData: ReturnType<typeof setup>["erData"], label = "갱신 끝") => waitFor(() => !erData.status().refreshing, label);

describe("대시보드 상태", () => {
  test("데이터가 없으면 missing이고 비어 있다", () => {
    const { dashboard } = setup();
    assert.deepEqual(dashboard.state(), {
      connection: "missing",
      refresh: { available: true, running: false, progress: null, lastError: null, autoStarted: false },
      basis: null,
      combos: [],
      player: { status: "unset", summary: null },
    });
  });

  test("처음 열면 자동 갱신을 시작하고, 같은 날 다시 열면 판정하지 않는다", async () => {
    const { erData, dashboard } = setup();
    assert.equal(dashboard.maybeAutoRefresh(), true);
    const running = dashboard.state();
    assert.equal(running.connection, "refreshing");
    assert.equal(running.refresh.running, true);
    assert.equal(running.refresh.autoStarted, true);
    await refreshed(erData);
    assert.equal(dashboard.state().connection, "ready");
    // 같은 날: 시즌 끝(고정 자료 2026-11-12)이 지나 판정하면 갱신 대상이지만 하루 한 번이라 열지 않는다
    assert.equal(dashboard.maybeAutoRefresh(), false);
  });

  test("갱신이 실패해도 그날은 다시 시도하지 않고, 다음 날 다시 판정한다", async () => {
    const broken = routes();
    delete broken["/v1/rank/top/41/3"];
    const { erData, dashboard } = setup({ client: fakeClient(broken) });
    assert.equal(dashboard.maybeAutoRefresh(), true);
    await refreshed(erData, "실패한 갱신");
    assert.match(dashboard.state().refresh.lastError ?? "", /rank\/top/);
    assert.equal(dashboard.maybeAutoRefresh(), false);
    clock += 24 * HOUR;
    assert.equal(dashboard.maybeAutoRefresh(), true);
  });

  test("데이터가 새것이면 그날 판정만 쓰고 갱신하지 않는다", async () => {
    // 시즌 끝을 먼 미래로 둔 사전
    const fresh = routes();
    fresh["/v2/data/Season"] = { code: 200, message: "Success", data: [{ seasonID: 41, seasonName: "Season21", seasonEnd: "2099-01-01 00:00:00", isCurrent: 1 }] };
    const first = setup({ client: fakeClient(fresh) });
    first.dashboard.refresh();
    await refreshed(first.erData);
    // 다시 켠다(하루 문은 새로). 1시간 뒤라 아직 새것이다
    clock += HOUR;
    const { dashboard } = setup({ client: fakeClient(fresh) });
    assert.equal(dashboard.maybeAutoRefresh(), false);
    // 하루가 지나 24시간을 넘기면 갱신한다
    clock += 24 * HOUR;
    assert.equal(dashboard.maybeAutoRefresh(), true);
  });

  test("갱신 뒤 기준(경기 수·참가자 수 따로)과 픽률 순 조합을 낸다", async () => {
    const { erData, dashboard } = setup();
    assert.equal(dashboard.refresh(), true);
    assert.equal(dashboard.state().refresh.autoStarted, false);
    await refreshed(erData);
    const state = dashboard.state();
    assert.deepEqual(state.basis, {
      seasonId: 41, seasonName: "시즌 12", patch: "12.7", games: 2, participants: 8, rankers: 2, gamesPerRanker: 2,
      collectedAt: "2026-11-21T00:00:00.000Z", previousCollectedAt: null, patchChanged: false,
    });
    assert.deepEqual(state.combos.map((c) => `${c.characterName}·${c.weaponName}`), ["재키·단검", "아야·권총", "아야·돌격 소총", "피오라·레이피어", "재키·양손검", "리 다이린·글러브"]);
    // 픽률·평균 순위가 같은 재키·단검과 아야·권총은 캐릭터 코드 순
    const aya = state.combos[1]!;
    assert.equal(aya.pickRate, 2 / 8);
    assert.equal(aya.avgRank, 1.5);
    assert.equal(aya.avgMmrGain, 37.5);
    assert.equal(aya.lowSample, true);
    assert.deepEqual(aya.topTraits, [{ code: 7000601, name: "아드레날린", rate: 1 }]);
    assert.equal(aya.change, null);
  });

  test("두 번째 갱신 뒤에는 직전 수집 시각이 있고, 표본 적은 조합은 변화량을 내지 않는다", async () => {
    const second = routes();
    const { erData, dashboard } = setup({ client: fakeClient(second) });
    dashboard.refresh();
    await refreshed(erData, "첫 갱신");
    // 둘째 갱신에서는 1002 경기를 못 받아 1001만 센다
    second["/v1/games/1002"] = new ErApiError(500, 500, "서버 오류");
    clock += HOUR;
    dashboard.refresh();
    await refreshed(erData, "둘째 갱신");
    const state = dashboard.state();
    assert.equal(state.basis?.previousCollectedAt, "2026-11-21T00:00:00.000Z");
    // 고정 자료는 조합마다 참가자가 30명 미만이라 모두 표본 적음 → 변화량 없음. 수치 변화량은 er-combos 검사가 본다
    assert.ok(state.combos.every((c) => c.lowSample && c.change === null));
  });

  test("키가 없으면 missing, 갱신할 수 없고 자동 갱신도 하지 않는다", () => {
    const { dashboard } = setup({ client: null });
    const state = dashboard.state();
    assert.equal(state.connection, "missing");
    assert.equal(state.refresh.available, false);
    assert.equal(dashboard.maybeAutoRefresh(), false);
    assert.equal(dashboard.refresh(), false);
  });
});

describe("내 전적", () => {
  test("닉네임을 저장하면 파일에 쓰고 전적과 주캐릭터의 메타 순위를 낸다", async () => {
    const { erData, dashboard } = setup();
    dashboard.refresh();
    await refreshed(erData);
    await dashboard.setSettings({ nickname: ` ${PLAYER} ` });
    assert.deepEqual(dashboard.settings(), { nickname: PLAYER });
    assert.deepEqual(createDashboardSettings(dir, () => {}).get(), { nickname: PLAYER });
    const { player } = dashboard.state();
    assert.equal(player.status, "ready");
    assert.equal(player.summary?.nickname, PLAYER);
    assert.equal(player.summary?.mmr, 3107);
    // 조합 순위에서 그 캐릭터가 처음 나오는 자리: 재키·단검 1위, 아야·권총 2위, 피오라·레이피어 4위
    assert.deepEqual(player.summary?.mainCharacters, [
      { name: "아야", games: 20, avgRank: 2.9, metaRank: 2 },
      { name: "재키", games: 12, avgRank: 3.8, metaRank: 1 },
      { name: "피오라", games: 5, avgRank: 4.2, metaRank: 4 },
    ]);
  });

  test("없는 닉네임은 not-found, 조회 오류는 error, 지우면 unset", async () => {
    const failing = routes();
    failing["/v2/user/stats/uid/uid-p/41/3"] = new ErApiError(500, 500, "서버 오류");
    const { erData, dashboard } = setup({ client: fakeClient(failing) });
    dashboard.refresh();
    await refreshed(erData);
    await dashboard.setSettings({ nickname: "없는닉" });
    assert.deepEqual(dashboard.state().player, { status: "not-found", summary: null });
    await dashboard.setSettings({ nickname: PLAYER });
    assert.deepEqual(dashboard.state().player, { status: "error", summary: null });
    await dashboard.setSettings({ nickname: null });
    assert.deepEqual(dashboard.state().player, { status: "unset", summary: null });
  });

  test("틀린 설정은 오류를 내고 저장하지 않는다", async () => {
    const { dashboard } = setup();
    await assert.rejects(dashboard.setSettings({ nickname: "가".repeat(40) }), /32자/);
    assert.deepEqual(dashboard.settings(), { nickname: null });
  });

  test("키가 없으면 닉네임이 있어도 error다", async () => {
    const { dashboard } = setup({ client: null });
    await dashboard.setSettings({ nickname: PLAYER });
    assert.equal(dashboard.state().player.status, "error");
  });

  test("갱신 중에 저장하면 loading이고, 갱신이 끝난 뒤 조회한다", async () => {
    const { erData, dashboard } = setup();
    dashboard.refresh();
    await dashboard.setSettings({ nickname: PLAYER });
    assert.equal(dashboard.state().player.status, "loading");
    await refreshed(erData);
    await waitFor(() => dashboard.state().player.status === "ready", "전적 조회");
  });

  test("켤 때 닉네임과 사전이 있으면 전적을 조회한다", async () => {
    const first = setup();
    first.dashboard.refresh();
    await refreshed(first.erData);
    await first.dashboard.setSettings({ nickname: PLAYER });
    const { dashboard } = setup();
    await waitFor(() => dashboard.state().player.status === "ready", "켤 때 전적 조회");
  });
});

describe("갱신 알림", () => {
  test("갱신이 끝나고 전적을 다시 조회한 뒤 한 번 부른다", async () => {
    const { erData, dashboard } = setup();
    await dashboard.setSettings({ nickname: PLAYER });
    const seen: Array<ReturnType<typeof dashboard.state>> = [];
    const stop = dashboard.onRefreshed((state) => seen.push(state));
    dashboard.refresh();
    await refreshed(erData);
    await waitFor(() => seen.length === 1, "알림");
    assert.equal(seen[0]?.connection, "ready");
    assert.equal(seen[0]?.player.status, "ready");
    assert.ok((seen[0]?.combos.length ?? 0) > 0);
    stop();
    dashboard.refresh();
    await refreshed(erData, "둘째 갱신");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, 1);
  });
});
