/**
 * narrator 검사: 사실 목록 → LLM 대사 → 검사 → (없으면) 정해진 문장 → 음성 → 저장.
 * LLM·음성·저장소는 모두 가짜를 넣고, 파일은 임시 폴더에 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Narration } from "@bori/shared";
import { createNarrator, type NarratorDeps } from "../src/narration/index.js";
import { createNarrationStore, type NarrationStore } from "../src/narration/store.js";
import { templateLines } from "../src/narration/template.js";
import { buildFacts } from "../src/narration/facts.js";
import type { NarrationLlm } from "../src/narration/writer.js";
import { FAKE_NICKNAME, fixtureBasis, fixtureCombos, fixturePlayer } from "./narration-fixtures.js";

const input = { basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer };
const facts = buildFacts(input);
const riserId = facts.find(fact => fact.kind === "riser")!.id;

let dir: string;
let store: NarrationStore;
const logs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-narrator-"));
  store = createNarrationStore(join(dir, "narration.json"), () => undefined);
  logs.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const answer = (lines: unknown[]): NarrationLlm => async () => ({ ok: true, raw: JSON.stringify({ lines }) });

function setup(overrides: Partial<NarratorDeps> = {}) {
  let audioSeq = 0;
  const spoken: string[] = [];
  let ids = 0;
  const deps: NarratorDeps = {
    llm: answer([
      { text: "오늘의 메타 분석이에요!", emotion: "greeting", factIds: [] },
      { text: "재키 쌍검이 3.9위에서 3.4위로 올랐어요. 좋아진 것 같아요.", emotion: "happy", factIds: [riserId] },
      { text: "재키 쌍검 승률은 55%래요.", emotion: "gaming", factIds: [riserId] },
    ]),
    prepareAudio: async text => { spoken.push(text); audioSeq += 1; return `audio-${audioSeq}`; },
    store,
    now: () => new Date("2026-11-21T03:00:00.000Z"),
    newId: () => `n-${(ids += 1)}`,
    log: message => { logs.push(message); },
    ...overrides,
  };
  return { narrator: createNarrator(deps), spoken };
}

describe("narrator", () => {
  test("LLM 대사 중 검사를 통과한 줄만 읽고 줄마다 음성을 만든다", async () => {
    const { narrator, spoken } = setup();
    const narration = await narrator.narrate(input);
    assert.equal(narration.source, "llm");
    assert.equal(narration.id, "n-1");
    assert.equal(narration.createdAt, "2026-11-21T03:00:00.000Z");
    assert.deepEqual(narration.lines, [
      { text: "오늘의 메타 분석이에요!", emotion: "greeting", audioId: "audio-1" },
      { text: "재키 쌍검이 3.9위에서 3.4위로 올랐어요. 좋아진 것 같아요.", emotion: "happy", audioId: "audio-2" },
    ]);
    assert.deepEqual(spoken, narration.lines.map(line => line.text));
    // 로그에는 버린 줄 수와 이유만 남고 대사 본문은 없다.
    assert.ok(logs.some(message => message.includes("1줄") && message.includes("number")));
    assert.ok(!logs.some(message => message.includes("승률")));
  });

  test("모든 줄이 검사에서 버려지면 정해진 문장을 읽는다", async () => {
    const { narrator } = setup({ llm: answer([{ text: "재키 쌍검 승률은 55%래요.", emotion: "gaming", factIds: [riserId] }]) });
    const narration = await narrator.narrate(input);
    assert.equal(narration.source, "template");
    assert.deepEqual(narration.lines.map(line => line.text), templateLines(facts).map(line => line.text));
  });

  test("LLM이 없거나 실패하거나 던지면 정해진 문장을 읽는다", async () => {
    const cases: NarratorDeps["llm"][] = [
      null,
      async () => ({ ok: false, reason: "회로 열림" }),
      async () => { throw new Error("시간 초과"); },
    ];
    for (const llm of cases) {
      const narration = await setup({ llm }).narrator.narrate(input);
      assert.equal(narration.source, "template");
      assert.equal(narration.lines.length, 3);
    }
  });

  test("음성 합성이 실패한 줄은 자막만 남는다", async () => {
    let call = 0;
    const { narrator } = setup({ prepareAudio: async () => { call += 1; if (call === 1) return undefined; throw new Error("TTS 실패"); } });
    const narration = await narrator.narrate(input);
    assert.ok(narration.lines.every(line => line.audioId === undefined));
    assert.equal(narration.lines.length, 2);
  });

  test("닉네임은 LLM 요청에 들어가지 않는다", async () => {
    const prompts: string[] = [];
    const llm: NarrationLlm = async request => { prompts.push(request.systemPrompt, request.userPrompt); return { ok: false, reason: "x" }; };
    await setup({ llm }).narrator.narrate(input);
    assert.ok(prompts.length > 0);
    assert.ok(prompts.every(prompt => !prompt.includes(FAKE_NICKNAME)));
  });

  test("저장한 대사를 새 narrator가 latest로 돌려준다", async () => {
    const first = setup().narrator;
    assert.equal(first.latest(), null);
    const narration = await first.narrate(input);
    assert.deepEqual(first.latest(), narration);
    assert.deepEqual(setup().narrator.latest(), narration);
  });

  test("저장이 실패해도 대사는 돌려주고 로그를 남긴다", async () => {
    const broken: NarrationStore = { load: () => null, save: () => { throw new Error("디스크 꽉 참"); } };
    const { narrator } = setup({ store: broken });
    const narration = await narrator.narrate(input);
    assert.equal(narration.lines.length, 2);
    assert.deepEqual(narrator.latest(), narration);
    assert.ok(logs.some(message => message.includes("디스크 꽉 참")));
  });

  test("다시 듣기는 음성이 없거나 캐시에서 사라진 줄만 다시 만든다", async () => {
    const saved: Narration = {
      id: "old", createdAt: "2026-11-20T03:00:00.000Z", source: "template",
      lines: [{ text: "가", emotion: "calm", audioId: "alive" }, { text: "나", emotion: "calm", audioId: "expired" }, { text: "다", emotion: "calm" }],
    };
    store.save(saved);
    const { narrator, spoken } = setup({ hasAudio: id => id === "alive" });
    const replayed = await narrator.replay();
    assert.deepEqual(spoken, ["나", "다"]);
    assert.deepEqual(replayed?.lines.map(line => line.audioId), ["alive", "audio-1", "audio-2"]);
    assert.equal(replayed?.id, "old");
    assert.deepEqual(createNarrationStore(join(dir, "narration.json")).load(), replayed);
  });

  test("다시 듣기: 대사가 없으면 null, 모든 음성이 살아 있으면 그대로", async () => {
    assert.equal(await setup().narrator.replay(), null);
    const { narrator, spoken } = setup({ hasAudio: () => true });
    const narration = await narrator.narrate(input);
    spoken.length = 0;
    assert.deepEqual(await narrator.replay(), narration);
    assert.deepEqual(spoken, []);
  });

  test("동시에 두 번 부르면 차례로 만든다", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const llm: NarrationLlm = async () => {
      calls += 1;
      const mine = calls;
      order.push(`start-${mine}`);
      if (mine === 1) await gate;
      order.push(`end-${mine}`);
      return { ok: false, reason: "x" };
    };
    const { narrator } = setup({ llm });
    const first = narrator.narrate(input);
    const second = narrator.narrate(input);
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
    assert.deepEqual([a.id, b.id], ["n-1", "n-2"]);
    assert.equal(narrator.latest()?.id, "n-2");
  });
});
