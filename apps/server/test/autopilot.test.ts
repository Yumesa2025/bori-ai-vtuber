/**
 * 코너 자동 진행 단위 검사. 시계와 말하기를 가짜로 두고, 시간이 다 되면 말을 마친 뒤 연결 멘트 → 다음 코너로 가는지,
 * 대기는 방송 켜기 뒤에만 오프닝으로 가는지, 엔딩은 한 번만 마무리하는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ShowStage } from "@bori/shared";
import { BRIDGE_LINES, CORNER_SECONDS, createAutopilot } from "../src/show/autopilot.js";

const order: ShowStage[] = ["idle", "opening", "briefing", "qna", "diagnosis", "ending"];

function setup(options: { stage?: ShowStage; enabled?: boolean; onAir?: boolean } = {}) {
  let stage: ShowStage = options.stage ?? "qna";
  let epoch = 1;
  let clock = 0;
  let busy = false;
  let onAir = options.onAir ?? true;
  let finished = 0;
  const said: string[] = [];
  const autopilot = createAutopilot({
    stage: () => stage,
    epoch: () => epoch,
    onAir: () => onAir,
    ready: () => !busy,
    say: async line => { said.push(line); },
    waitQuiet: async () => undefined,
    next: async () => { stage = order[Math.min(order.length - 1, order.indexOf(stage) + 1)]; epoch += 1; },
    finish: async () => { finished += 1; },
    enabled: options.enabled ?? true,
    now: () => clock,
  });
  return {
    autopilot, said,
    stage: () => stage,
    finished: () => finished,
    advance(ms: number) { clock += ms; },
    setBusy(value: boolean) { busy = value; },
    setOnAir(value: boolean) { onAir = value; },
    moveTo(next: ShowStage) { stage = next; epoch += 1; },
  };
}

const settle = async (autopilot: ReturnType<typeof createAutopilot>) => {
  for (let i = 0; i < 10 && autopilot.isAdvancing(); i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe("코너 자동 진행", () => {
  test("4분 구성의 목표 시간을 쓴다", () => {
    assert.deepEqual(CORNER_SECONDS, { idle: 8, opening: 22, briefing: 55, qna: 70, diagnosis: 65, ending: 6 });
  });

  test("시간이 되기 전에는 넘어가지 않고 채팅 답도 막지 않는다", async () => {
    const context = setup();
    context.advance(CORNER_SECONDS.qna * 1000 - 1);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "qna");
    assert.equal(context.autopilot.holding(), false);
  });

  test("시간이 다 되면 새 답을 미루고, 말을 마친 뒤 연결 멘트를 하고 다음 코너로 간다", async () => {
    const context = setup();
    context.advance(CORNER_SECONDS.qna * 1000);
    context.setBusy(true);
    context.autopilot.tick();
    await settle(context.autopilot);
    // 말하는 중에는 끊지 않는다.
    assert.equal(context.stage(), "qna");
    assert.equal(context.autopilot.holding(), true);

    context.setBusy(false);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.deepEqual(context.said, [BRIDGE_LINES.qna]);
    assert.equal(context.stage(), "diagnosis");
    // 새 코너는 시간을 새로 센다.
    assert.equal(context.autopilot.holding(), false);
    assert.equal(context.autopilot.status().stageSeconds, CORNER_SECONDS.diagnosis);
  });

  test("대기는 방송 켜기 전에는 기다리고, 켠 뒤 8초가 지나면 오프닝으로 간다", async () => {
    const context = setup({ stage: "idle", onAir: false });
    context.advance(60_000);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "idle");
    assert.equal(context.autopilot.status().stageSeconds, 0);

    context.setOnAir(true);
    context.autopilot.status();
    context.advance(CORNER_SECONDS.idle * 1000 - 1);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "idle");
    context.advance(1);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "opening");
    // 대기에서는 연결 멘트 없이 넘어간다.
    assert.deepEqual(context.said, []);
  });

  test("엔딩은 넘어가지 않고, 시간이 되면 한 번만 마무리(음악 줄이기)한다", async () => {
    const context = setup({ stage: "ending" });
    context.advance(CORNER_SECONDS.ending * 1000);
    context.autopilot.tick();
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "ending");
    assert.equal(context.finished(), 1);
    assert.equal(context.autopilot.holding(), false);
  });

  test("꺼져 있으면 시간이 지나도 넘어가지 않는다", async () => {
    const context = setup({ enabled: false });
    context.advance(10 * 60_000);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "qna");
    assert.equal(context.autopilot.holding(), false);
  });

  test("운영자가 직접 넘기면 그 코너의 시간을 새로 센다", async () => {
    const context = setup({ stage: "briefing" });
    context.advance(50_000);
    context.moveTo("qna");
    context.autopilot.status();
    context.advance(60_000);
    context.autopilot.tick();
    await settle(context.autopilot);
    assert.equal(context.stage(), "qna");
    assert.equal(context.autopilot.status().elapsedSeconds, 60);
  });
});
