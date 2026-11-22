/**
 * narrator 검사: 사실 목록 → LLM이 고른 사실·감상 → 서버 문장 + 감상 → (모자라면) 정해진 문장 → 음성 → 저장.
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
import { renderFact, templateLines } from "../src/narration/template.js";
import { buildFacts } from "../src/narration/facts.js";
import { COMMENT_EXAMPLE_POOL, pickCommentExamples, seededRandom } from "../src/narration/examples.js";
import { narrationSystemPrompt, type NarrationLlm } from "../src/narration/writer.js";
import { FAKE_NICKNAME, fixtureBasis, fixtureCombos, fixturePlayer } from "./narration-fixtures.js";

const topSpoken = "지금 가장 많이 고른 건 재키예요. 픽률 8.1%, 평균 순위 3.4위예요.";

const input = { basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer };
const facts = buildFacts(input);
const riser = facts.find(fact => fact.kind === "riser")!;
const riserId = riser.id;
const topId = facts.find(fact => fact.kind === "top")!.id;
const mainFact = facts.find(fact => fact.kind === "main")!;

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
      { factId: riserId, emotion: "happy", comment: "좋아진 것 같아요." },
      { factId: riserId, emotion: "gaming", comment: "다시 말해요." },
      { factId: topId, emotion: "gaming", comment: "승률은 55%래요." },
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
  test("LLM이 고른 사실을 서버 문장으로 읽고 통과한 감상만 붙이며, 3줄이 안 되면 정해진 문장으로 채우고, 줄마다 음성을 만든다", async () => {
    const { narrator, spoken } = setup();
    const narration = await narrator.narrate(input);
    assert.equal(narration.source, "llm");
    assert.equal(narration.id, "n-1");
    assert.equal(narration.createdAt, "2026-11-21T03:00:00.000Z");
    assert.deepEqual(narration.lines, [
      { text: `${renderFact(riser)} 좋아진 것 같아요.`, emotion: "happy", audioId: "audio-1" },
      { text: topSpoken, emotion: "gaming", audioId: "audio-2" },
      { text: renderFact(mainFact), emotion: "gaming", audioId: "audio-3" },
    ]);
    assert.deepEqual(spoken, narration.lines.map(line => line.text));
    // 로그에는 버린 줄·감상 수와 이유만 남고 대사 본문은 없다.
    assert.ok(logs.some(message => message.includes("1줄") && message.includes("duplicate")), logs.join(" / "));
    assert.ok(logs.some(message => message.includes("감상 1개") && message.includes("number")), logs.join(" / "));
    assert.ok(!logs.some(message => message.includes("승률") || message.includes("좋아진")));
  });

  test("남은 LLM 줄이 없으면(없는 사실 id·빈 목록) 정해진 문장을 읽는다", async () => {
    for (const lines of [[{ factId: "f99", emotion: "gaming", comment: "" }], []]) {
      const narration = await setup({ llm: answer(lines) }).narrator.narrate(input);
      assert.equal(narration.source, "template");
      assert.deepEqual(narration.lines.map(line => line.text), templateLines(facts).map(line => line.text));
    }
  });

  test("감상 이름 검사는 주입한 사전의 전체 이름(장비·특성 포함)을 쓴다", async () => {
    const lines = [
      { factId: riserId, emotion: "happy", comment: "레온이 보여요." },
      { factId: topId, emotion: "happy", comment: "청룡도가 보여요." },
    ];
    const dictionary = { characters: [{ name: "재키" }, { name: "레온" }], weaponNames: { 13: "쌍검" }, itemNames: { 1: "청룡도" } };
    const narration = await setup({ llm: answer(lines), dictionary: () => dictionary }).narrator.narrate(input);
    assert.equal(narration.source, "llm");
    assert.ok(!narration.lines.some(line => line.text.includes("레온") || line.text.includes("청룡도")));
    assert.ok(logs.some(message => message.includes("감상 2개") && message.includes("name")));
  });

  test("과제 A: 예시를 베낀 감상·같은 대사에서 되풀이한 감상은 버리고 로그 요약에 copied·repeated로 남긴다", async () => {
    const example = COMMENT_EXAMPLE_POOL.riser[0];
    const lines = [
      { factId: riserId, emotion: "happy", comment: example },
      { factId: topId, emotion: "gaming", comment: "오늘따라 유난히 반가워요." },
      { factId: mainFact.id, emotion: "gaming", comment: "오늘따라 유난히 반가워요!" },
    ];
    const narration = await setup({ llm: answer(lines) }).narrator.narrate(input);
    assert.equal(narration.source, "llm");
    assert.deepEqual(narration.lines.map(line => line.text), [renderFact(riser), `${topSpoken} 오늘따라 유난히 반가워요.`, renderFact(mainFact)]);
    assert.ok(logs.some(message => message.includes("감상 2개") && message.includes("copied") && message.includes("repeated")), logs.join(" / "));
    assert.ok(!logs.some(message => message.includes(example) || message.includes("반가워요")));
  });

  test("과제 A: 주입한 random으로 지시의 예시를 고른다(같은 시드면 같은 지시)", async () => {
    const prompts: string[] = [];
    const llm: NarrationLlm = async request => { prompts.push(request.systemPrompt); return { ok: true, raw: JSON.stringify({ lines: [] }) }; };
    await setup({ llm, random: seededRandom(5) }).narrator.narrate(input);
    await setup({ llm, random: seededRandom(5) }).narrator.narrate(input);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1]);
    assert.equal(prompts[0], narrationSystemPrompt(pickCommentExamples(seededRandom(5))));
  });

  test("합친 줄이 maxLineLength를 넘으면 감상만 뺀다", async () => {
    const llm = answer([{ factId: riserId, emotion: "happy", comment: "좋아진 것 같아요." }]);
    const narration = await setup({ llm, maxLineLength: () => [...renderFact(riser)].length + 2 }).narrator.narrate(input);
    assert.equal(narration.source, "llm");
    assert.equal(narration.lines[0].text, renderFact(riser));
    assert.ok(logs.some(message => message.includes("length")));
  });

  test("LLM이 시간 상한 안에 답하지 않으면 정해진 문장으로 넘어간다", async () => {
    const llm: NarrationLlm = () => new Promise(() => undefined);
    const narration = await setup({ llm, timeoutMs: 40 }).narrator.narrate(input);
    assert.equal(narration.source, "template");
    assert.ok(logs.some(message => message.includes("시간")));
  });

  test("음성 합성이 시간 상한 안에 끝나지 않으면 그 줄은 자막만 남고 다음 줄로 넘어간다", async () => {
    const narration = await setup({ llm: null, prepareAudio: () => new Promise(() => undefined), audioTimeoutMs: 20 }).narrator.narrate(input);
    assert.equal(narration.lines.length, 3);
    assert.ok(narration.lines.every(line => line.audioId === undefined));
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
    assert.equal(narration.lines.length, 3);
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
    assert.equal(narration.lines.length, 3);
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

  test("다시 듣기: 사라진 음성을 다시 만들지 못하면 죽은 id를 빼고 돌려준다", async () => {
    store.save({ id: "old", createdAt: "2026-11-20T03:00:00.000Z", source: "template", lines: [{ text: "가", emotion: "calm", audioId: "expired" }] });
    const { narrator } = setup({ hasAudio: () => false, prepareAudio: async () => undefined });
    const replayed = await narrator.replay();
    assert.deepEqual(replayed?.lines, [{ text: "가", emotion: "calm" }]);
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
