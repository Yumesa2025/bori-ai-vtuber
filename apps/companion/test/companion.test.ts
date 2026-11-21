/**
 * 대시보드 화면 밖 규칙 단위 검사.
 * 오류 응답 분류, LLM이 준 감정 이름을 allowlist로 거르는지, 개발용 가짜 API가 DashboardState 형식대로 답하는지 본다.
 * 브라우저와 네트워크를 쓰지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardState, Narration } from "@bori/shared";
import { ApiError, errorKindForStatus, readResponse } from "../src/api";
import { planReaction } from "../src/live2d/reaction";
import { readFileSync } from "node:fs";
import { createMockStore, mockScenarios, MOCK_NICKNAME, MOCK_REFRESH_MS } from "../dev/mock-store";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function kindOf(response: Response) {
  try { await readResponse(response); } catch (error) { return error instanceof ApiError ? error.kind : "unknown"; }
  return "ok";
}

describe("오류 응답 분류", () => {
  test("상태 코드별 종류", () => {
    assert.equal(errorKindForStatus(400), "badRequest");
    assert.equal(errorKindForStatus(404), "notFound");
    assert.equal(errorKindForStatus(409), "conflict");
    assert.equal(errorKindForStatus(500), "server");
    assert.equal(errorKindForStatus(503), "server");
  });

  test("서버가 준 { error } 5xx는 서버 오류, JSON이 아닌 5xx는 연결 끊김", async () => {
    assert.equal(await kindOf(json(500, { error: "내부 오류" })), "server");
    assert.equal(await kindOf(new Response("proxy error", { status: 502 })), "disconnected");
    assert.equal(await kindOf(new Response("", { status: 500 })), "disconnected");
  });

  test("성공 응답은 본문을 그대로 돌려주고, JSON이 아니면 서버 오류로 본다", async () => {
    assert.deepEqual(await readResponse(json(200, { started: true })), { started: true });
    assert.equal(await kindOf(new Response("<html>", { status: 200 })), "server");
  });

  test("4xx는 서버 원문을 보관한다", async () => {
    await assert.rejects(readResponse(json(404, { error: "대사 없음" })), (error: unknown) => error instanceof ApiError && error.kind === "notFound" && error.serverMessage === "대사 없음");
  });
});

describe("표정·모션 계획", () => {
  test("감정 이름만으로 감정 표의 표정·모션을 고른다", () => {
    const plan = planReaction({ primary: "gaming" }, []);
    assert.deepEqual(plan.motion, { group: "shoushi", priority: 2 });
    assert.equal(plan.expression, "shoushi");
    assert.equal(plan.holdMs, 4000);
  });

  test("감정 표 밖 이름은 표정을 켜지 않는다", () => {
    const plan = planReaction({ primary: "ecstatic", durationSeconds: 999 }, [{ name: "backflip", layer: "body", priority: 99 }]);
    assert.equal(plan.motion, null);
    assert.equal(plan.expression, null);
    assert.equal(plan.holdMs, 15000);
  });

  test("기본 얼굴 감정(calm)과 감정 없음은 표정을 켜지 않는다", () => {
    assert.equal(planReaction({ primary: "calm" }, []).expression, null);
    assert.equal(planReaction(undefined, undefined).motion, null);
  });
});

describe("개발용 가짜 API", () => {
  const stateOf = (store: ReturnType<typeof createMockStore>) => store.dashboard().body as DashboardState;

  test("모든 시나리오가 DashboardState 모양이고 조합은 픽률 순이다", () => {
    for (const name of mockScenarios) {
      const state = stateOf(createMockStore(name));
      assert.deepEqual(Object.keys(state).sort(), ["basis", "combos", "connection", "narration", "player", "refresh"], name);
      assert.deepEqual(Object.keys(state.refresh).sort(), ["autoStarted", "available", "lastError", "progress", "running"], name);
      for (let i = 1; i < state.combos.length; i += 1) assert.ok(state.combos[i - 1].pickRate >= state.combos[i].pickRate, name);
      assert.equal(state.basis === null, state.combos.length === 0, name);
    }
  });

  test("데이터 있음에는 표본 적은 조합·직전 값 없는 조합·움직인 조합이 함께 있다", () => {
    const { combos, narration, player } = stateOf(createMockStore("ready"));
    assert.ok(combos.some(entry => entry.lowSample));
    assert.ok(combos.some(entry => entry.change === null && !entry.lowSample));
    assert.ok(combos.some(entry => (entry.change?.avgRank ?? 0) < -0.1));
    assert.equal(player.status, "ready");
    assert.ok(narration && narration.lines.length >= 3 && narration.lines.every(line => line.audioId));
  });

  test("상태별: 키 없음·갱신 중·오류·패치 바뀜·전적 상태", () => {
    assert.equal(stateOf(createMockStore("no-key")).refresh.available, false);
    const refreshing = stateOf(createMockStore("refreshing"));
    assert.equal(refreshing.connection, "refreshing");
    assert.equal(refreshing.refresh.running, true);
    assert.ok(refreshing.combos.length > 0, "갱신 중에도 지난 데이터를 보여 준다");
    assert.ok(stateOf(createMockStore("error")).refresh.lastError);
    assert.equal(stateOf(createMockStore("patch-changed")).basis?.patchChanged, true);
    assert.equal(stateOf(createMockStore("stale")).connection, "stale");
    for (const [name, status] of [["player-unset", "unset"], ["player-loading", "loading"], ["player-not-found", "not-found"], ["player-error", "error"]] as const) {
      const { player } = stateOf(createMockStore(name));
      assert.equal(player.status, status);
      assert.equal(player.summary, null);
    }
  });

  test("갱신 버튼: 진행률이 오르고 끝나면 새 대사가 붙는다", () => {
    let clock = 1_000_000;
    const store = createMockStore("stale", { now: () => clock });
    const oldNarration = stateOf(store).narration?.id;
    assert.deepEqual(store.refresh().body, { started: true });
    assert.deepEqual(store.refresh().body, { started: false }, "갱신 중에는 또 시작하지 않는다");
    clock += MOCK_REFRESH_MS / 2;
    const half = stateOf(store);
    assert.equal(half.connection, "refreshing");
    assert.equal(half.refresh.progress, 0.5);
    clock += MOCK_REFRESH_MS;
    const done = stateOf(store);
    assert.equal(done.connection, "ready");
    assert.equal(done.refresh.running, false);
    assert.notEqual(done.narration?.id, oldNarration);
    assert.equal(done.basis?.collectedAt, new Date(clock).toISOString());
  });

  test("키가 없으면 갱신을 시작하지 않는다", () => {
    assert.deepEqual(createMockStore("no-key").refresh().body, { started: false });
  });

  test("다시 듣기는 같은 대사에 새 음성 id를 붙여 준다", () => {
    const store = createMockStore("ready");
    const before = stateOf(store).narration!;
    const { narration } = store.replay().body as { narration: Narration };
    assert.equal(narration.id, before.id);
    assert.deepEqual(narration.lines.map(line => line.text), before.lines.map(line => line.text));
    assert.ok(narration.lines.every((line, index) => line.audioId !== before.lines[index].audioId && store.hasAudio(line.audioId!)));
    assert.equal(createMockStore("missing").replay().status, 404);
  });

  test("시나리오 바꾸기: 없는 이름은 400", () => {
    const store = createMockStore("ready");
    assert.equal(store.setScenario({ name: "refreshing" }).status, 200);
    assert.equal(stateOf(store).connection, "refreshing");
    assert.equal(store.setScenario({ name: "nope" }).status, 400);
    assert.equal(store.scenario(), "refreshing");
  });

  test("닉네임 설정: 저장하면 전적이 준비되고 지우면 설정 안내", () => {
    const store = createMockStore("player-unset");
    assert.equal(store.saveSettings({ nickname: "  " }).status, 400);
    assert.deepEqual(store.saveSettings({ nickname: "다른유저" }).body, { nickname: "다른유저" });
    assert.equal(stateOf(store).player.summary?.nickname, "다른유저");
    store.saveSettings({ nickname: null });
    assert.equal(stateOf(store).player.status, "unset");
  });

  test("키 없음: 실제 서버처럼 닉네임이 있으면 전적은 error다", () => {
    const { player, connection, refresh } = stateOf(createMockStore("no-key"));
    assert.equal(connection, "missing");
    assert.equal(refresh.available, false);
    assert.deepEqual(player, { status: "error", summary: null });
  });

  test("키 없음 + 지난 데이터: 실제 서버처럼 저장된 기준·조합을 그대로 준다", () => {
    const state = stateOf(createMockStore("no-key-with-data"));
    assert.equal(state.connection, "missing");
    assert.equal(state.refresh.available, false);
    assert.ok(state.basis && state.combos.length > 0);
    assert.equal(state.player.status, "error");
  });

  test("데이터 없음에서 갱신하면 직전 갱신이 없으므로 변화량이 모두 null이다", () => {
    let clock = 1_000_000;
    const store = createMockStore("missing", { now: () => clock });
    store.refresh();
    clock += MOCK_REFRESH_MS * 2;
    const done = stateOf(store);
    assert.equal(done.basis?.previousCollectedAt, null);
    assert.ok(done.combos.length > 0 && done.combos.every(entry => entry.change === null));
  });

  test("정해진 문장·음성 실패·대사 없음 시나리오", () => {
    assert.equal(stateOf(createMockStore("template-narration")).narration?.source, "template");
    const failed = stateOf(createMockStore("tts-failed")).narration!;
    assert.ok(failed.lines.some(line => line.audioId === undefined) && failed.lines.some(line => line.audioId !== undefined));
    const none = createMockStore("no-narration");
    assert.equal(stateOf(none).narration, null);
    assert.ok(stateOf(none).combos.length > 0);
    assert.equal(none.replay().status, 404);
  });

  test("가짜 대사도 서버 검사 규칙(3~5줄)을 따른다", () => {
    for (const name of mockScenarios) {
      const narration = stateOf(createMockStore(name)).narration;
      if (narration) assert.ok(narration.lines.length >= 3 && narration.lines.length <= 5, name);
    }
  });

  test("닉네임은 서버와 같이 32자(코드포인트)까지", () => {
    const store = createMockStore("player-unset");
    assert.equal(store.saveSettings({ nickname: "가".repeat(33) }).status, 400);
    assert.equal(store.saveSettings({ nickname: "😊".repeat(32) }).status, 200);
    assert.ok(MOCK_NICKNAME.length <= 32);
  });
});

describe("대시보드 화면 CSP", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const directive = (name: string) => csp.split(";").map(part => part.trim()).find(part => part.startsWith(`${name} `)) ?? "";

  test("스튜디오와 같은 수준으로 이 출처 밖 스크립트·전송을 막는다", () => {
    assert.equal(directive("default-src"), "default-src 'self'");
    assert.equal(directive("script-src"), "script-src 'self'");
    assert.equal(directive("connect-src"), "connect-src 'self'");
    assert.equal(directive("media-src"), "media-src 'self' blob:");
    assert.equal(directive("object-src"), "object-src 'none'");
    assert.equal(directive("base-uri"), "base-uri 'none'");
    assert.ok(!csp.includes("unsafe-eval"), "Cubism Core 5-r.5는 wasm2js라 eval이 필요 없다");
  });

  test("Live2D 텍스처(이 출처 이미지)와 React 인라인 style은 허용한다", () => {
    assert.match(directive("img-src"), /'self'/);
    assert.match(directive("style-src"), /'unsafe-inline'/);
  });
});
