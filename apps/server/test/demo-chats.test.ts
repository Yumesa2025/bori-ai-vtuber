/**
 * 시연 채팅 대본 단위 검사. 코너가 시작된 뒤 정한 시간에 한 번씩 올리는지, 방송 중에만 올리는지, 틀린 줄을 빼는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ShowStage } from "@bori/shared";
import { createDemoChats, parseDemoScript } from "../src/show/demo-chats.js";

const script = parseDemoScript({
  corners: {
    qna: [{ after: 38, nickname: "시청자1", content: "요즘 1티어 뭐야?" }, { after: 8, nickname: "시청자3", content: "재키 어때?" }],
    diagnosis: [{ after: 10, nickname: "시청자2", content: "!전적 닉네임" }, { after: -1, nickname: "x", content: "빠짐" }, { nickname: "y", content: "빠짐" }],
  },
});

function setup() {
  let stage: ShowStage = "qna";
  let epoch = 1;
  let clock = 0;
  let live = true;
  const posted: string[] = [];
  const demo = createDemoChats({
    stage: () => stage, epoch: () => epoch, live: () => live,
    load: () => script,
    post: chat => { posted.push(`${chat.nickname}:${chat.content}`); return null; },
    now: () => clock,
  });
  return { demo, posted, advance(ms: number) { clock += ms; }, moveTo(next: ShowStage) { stage = next; epoch += 1; }, setLive(value: boolean) { live = value; } };
}

describe("시연 채팅 대본", () => {
  test("틀린 줄은 빼고 시간순으로 정렬한다", () => {
    assert.deepEqual(script?.qna?.map(line => line.after), [8, 38]);
    assert.deepEqual(script?.diagnosis?.map(line => line.content), ["!전적 닉네임"]);
    assert.equal(parseDemoScript({ nope: true }), null);
  });

  test("켜기 전에는 올리지 않고, 켜면 코너 시작 뒤 정한 시간에 한 번씩 올린다", () => {
    const context = setup();
    context.advance(10_000);
    context.demo.tick();
    assert.deepEqual(context.posted, []);

    assert.equal(context.demo.setEnabled(true), true);
    context.demo.tick();
    assert.deepEqual(context.posted, ["시청자3:재키 어때?"]);
    context.demo.tick();
    assert.equal(context.posted.length, 1);
    context.advance(30_000);
    context.demo.tick();
    assert.deepEqual(context.posted, ["시청자3:재키 어때?", "시청자1:요즘 1티어 뭐야?"]);
  });

  test("코너가 바뀌면 그 코너 시작부터 다시 센다", () => {
    const context = setup();
    context.demo.setEnabled(true);
    context.advance(60_000);
    context.moveTo("diagnosis");
    context.demo.tick();
    assert.equal(context.posted.filter(line => line.includes("전적")).length, 0);
    context.advance(10_000);
    context.demo.tick();
    assert.ok(context.posted.includes("시청자2:!전적 닉네임"));
  });

  test("방송 중이 아니면 올리지 않는다", () => {
    const context = setup();
    context.demo.setEnabled(true);
    context.setLive(false);
    context.advance(60_000);
    context.demo.tick();
    assert.deepEqual(context.posted, []);
  });

  test("대본이 없으면 켜지지 않는다", () => {
    const demo = createDemoChats({ stage: () => "qna", epoch: () => 1, live: () => true, load: () => null, post: () => null });
    assert.equal(demo.setEnabled(true), false);
    assert.equal(demo.status().enabled, false);
  });
});
