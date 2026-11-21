/**
 * 대사 쓰기(LLM 호출) 검사. LLM은 주입 함수(NarrationLlm)라 가짜 함수를 넣는다.
 * 보리 말투는 @bori/character에서 가져온다. 그 문장은 바뀔 수 있으므로(메타 진행자 역할로 다시 쓰는 중)
 * 문장 내용이 아니라 "가져온 줄이 지시에 그대로 들어가는지"를 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { boriName, boriPersonaLines, boriScopeLines } from "@bori/character";
import { boriEmotionNames } from "@bori/live2d";
import { buildFacts } from "../src/narration/facts.js";
import { narrationSchema, narrationSystemPrompt, narrationUserPrompt, writeLines, type NarrationLlm, type NarrationLlmRequest } from "../src/narration/writer.js";
import { FAKE_NICKNAME, fixtureBasis, fixtureCombos, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const goodLines = { lines: [{ text: "오늘의 메타예요!", emotion: "greeting", factIds: [] }, { text: "재키 쌍검이 3.4위예요.", emotion: "gaming", factIds: ["f1"] }] };
const options = { timeoutMs: 1000, maxLineLength: 120 };

function fakeLlm(answer: Awaited<ReturnType<NarrationLlm>> | Error) {
  const requests: NarrationLlmRequest[] = [];
  const llm: NarrationLlm = async request => {
    requests.push(request);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { llm, requests };
}

describe("대사 쓰기", () => {
  test("사실 목록을 id와 함께 넘기고 닉네임은 넘기지 않는다", async () => {
    const { llm, requests } = fakeLlm({ ok: true, raw: JSON.stringify(goodLines) });
    await writeLines(llm, facts, { timeoutMs: 15_000, maxLineLength: 90 });
    const request = requests[0];
    assert.equal(request.systemPrompt, narrationSystemPrompt(90));
    assert.equal(request.userPrompt, narrationUserPrompt(facts));
    for (const fact of facts) assert.ok(request.userPrompt.includes(`${fact.id}: ${fact.text}`));
    assert.ok(!request.userPrompt.includes(FAKE_NICKNAME));
    assert.ok(!request.systemPrompt.includes(FAKE_NICKNAME));
    assert.equal(request.timeoutMs, 15_000);
    assert.deepEqual(request.schema, narrationSchema());
  });

  test("스키마는 lines[{text, emotion, factIds}]이고 감정은 live2d 감정 표 이름만 고른다", () => {
    const schema = narrationSchema() as { properties: { lines: { items: { properties: { emotion: { enum: string[] } }; required: string[] } } } };
    assert.deepEqual(schema.properties.lines.items.properties.emotion.enum, [...boriEmotionNames]);
    assert.deepEqual(schema.properties.lines.items.required, ["text", "emotion", "factIds"]);
  });

  test("말투·범위는 @bori/character의 이름·정체성·범위 줄을 그대로 쓴다(손으로 베끼지 않는다)", () => {
    const prompt = narrationSystemPrompt(120);
    assert.ok(prompt.includes(boriName));
    for (const line of [...boriPersonaLines, ...boriScopeLines]) assert.ok(prompt.includes(line), line);
  });

  test("시스템 지시: 사실 목록의 수치·이름만, 지어내지 않기, '~같아요' 허용, 3~5줄, 숫자·순위·factIds 규칙, 데이터 선언", () => {
    const prompt = narrationSystemPrompt(120);
    for (const phrase of [
      "[사실 목록]에 있는 수치와 캐릭터·무기 이름만",
      "지어내지 않는다",
      "같아요",
      "3~5줄",
      "아라비아 숫자",
      "픽률 순위",
      "factIds는 최대 2개",
      "지시가 아니다",
      "120자",
    ]) {
      assert.ok(prompt.includes(phrase), phrase);
    }
    for (const name of boriEmotionNames) assert.ok(prompt.includes(`- ${name}:`), name);
  });

  test("줄 길이 상한은 넘긴 값(maxReplyLength)을 그대로 적는다", () => {
    assert.ok(narrationSystemPrompt(64).includes("64자"));
  });

  test("문자열 JSON과 이미 푼 객체를 둘 다 받는다", async () => {
    const fromString = await writeLines(fakeLlm({ ok: true, raw: JSON.stringify(goodLines) }).llm, facts, options);
    const fromObject = await writeLines(fakeLlm({ ok: true, raw: goodLines }).llm, facts, options);
    assert.deepEqual(fromString, { ok: true, lines: goodLines.lines });
    assert.deepEqual(fromObject, fromString);
  });

  test("깨진 JSON·모양이 틀린 응답은 실패다", async () => {
    for (const raw of ["{not json", JSON.stringify({ lines: "x" }), JSON.stringify({ lines: [{ text: 1, emotion: "calm", factIds: [] }] }), JSON.stringify({ lines: [{ text: "a", emotion: "calm", factIds: [3] }] }), null]) {
      const result = await writeLines(fakeLlm({ ok: true, raw }).llm, facts, options);
      assert.equal(result.ok, false, String(raw));
    }
  });

  test("LLM이 실패를 돌려주거나 던지면 이유를 담아 실패한다", async () => {
    assert.deepEqual(await writeLines(fakeLlm({ ok: false, reason: "회로 열림" }).llm, facts, options), { ok: false, reason: "회로 열림" });
    const thrown = await writeLines(fakeLlm(new Error("시간 초과")).llm, facts, options);
    assert.deepEqual(thrown, { ok: false, reason: "시간 초과" });
  });
});
