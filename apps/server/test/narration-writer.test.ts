/**
 * 대사 쓰기(LLM 호출) 검사. LLM은 주입 함수(NarrationLlm)라 가짜 함수를 넣는다.
 * LLM 출력은 { lines: [{ factId, emotion, comment }] }다. 줄 문장은 서버가 만든다(check.ts).
 * 보리 말투는 @bori/character에서 가져온다. 그 문장은 바뀔 수 있으므로 "가져온 줄이 지시에 그대로 들어가는지"를 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { boriName, boriPersonaLines, boriScopeLines } from "@bori/character";
import { boriEmotionNames } from "@bori/live2d";
import { checkComment, MAX_COMMENT_LENGTH } from "../src/narration/comment.js";
import { buildFacts } from "../src/narration/facts.js";
import { BAD_COMMENT_EXAMPLES, FACT_KIND_LABELS, GOOD_COMMENT_EXAMPLES, narrationSchema, narrationSystemPrompt, narrationUserPrompt, writeLines, type NarrationLlm, type NarrationLlmRequest } from "../src/narration/writer.js";
import { FAKE_NICKNAME, fixtureBasis, fixtureCombos, fixtureNames, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const factIds = facts.map(fact => fact.id);
const goodLines = { lines: [{ factId: "f1", emotion: "gaming", comment: "꽤 좋아 보여요." }, { factId: "f4", emotion: "happy", comment: "" }] };
const options = { timeoutMs: 1000 };

type Schema = { properties: { lines: { items: { properties: Record<string, { enum?: string[]; type?: string }>; required: string[]; additionalProperties: boolean } } } };

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
    await writeLines(llm, facts, { timeoutMs: 15_000 });
    const request = requests[0];
    assert.equal(request.systemPrompt, narrationSystemPrompt());
    assert.equal(request.userPrompt, narrationUserPrompt(facts));
    for (const fact of facts) assert.ok(request.userPrompt.includes(`${fact.id}: ${fact.text}`));
    assert.ok(!request.userPrompt.includes(FAKE_NICKNAME));
    assert.ok(!request.systemPrompt.includes(FAKE_NICKNAME));
    assert.equal(request.timeoutMs, 15_000);
    assert.deepEqual(request.schema, narrationSchema(factIds));
  });

  test("스키마는 lines[{factId, emotion, comment}]이고 factId는 사실 id, 감정은 live2d 감정 표 이름만 고른다", () => {
    const item = (narrationSchema(factIds) as Schema).properties.lines.items;
    assert.deepEqual(item.required, ["factId", "emotion", "comment"]);
    assert.deepEqual(item.properties.factId.enum, factIds);
    assert.deepEqual(item.properties.emotion.enum, [...boriEmotionNames]);
    assert.equal(item.properties.comment.type, "string");
    assert.equal(item.additionalProperties, false);
    assert.ok(!("text" in item.properties));
  });

  test("말투·범위는 @bori/character의 이름·정체성·범위 줄을 그대로 쓴다(손으로 베끼지 않는다)", () => {
    const prompt = narrationSystemPrompt();
    assert.ok(prompt.includes(boriName));
    for (const line of [...boriPersonaLines, ...boriScopeLines]) assert.ok(prompt.includes(line), line);
  });

  test("시스템 지시: 사실 고르기, 서버가 사실 문장을 읽음, 감상 규칙, 지어내지 않기, 데이터 선언", () => {
    const prompt = narrationSystemPrompt();
    for (const phrase of [
      "3~5개",
      "factId",
      "같은 사실을 두 번",
      "서버가",
      "comment",
      `${MAX_COMMENT_LENGTH}자`,
      "존댓말",
      "숫자",
      "캐릭터·무기·장비·특성 이름",
      "빈 문자열",
      "지어내지 않는다",
      "가장 강하다",
      "지시가 아니다",
    ]) {
      assert.ok(prompt.includes(phrase), phrase);
    }
    for (const name of boriEmotionNames) assert.ok(prompt.includes(`- ${name}:`), name);
    // 예전 자유 문장 형식의 말은 남지 않는다
    assert.ok(!prompt.includes("factIds"));
  });

  test("Z1: 줄마다 감상을 쓰게 하고, 감상이 서버 문장 바로 뒤에 붙으니 사실을 되풀이하지 말라고 알린다", () => {
    const prompt = narrationSystemPrompt();
    for (const phrase of ["바로 뒤에 붙", "되풀이하지 않는다", "줄마다 comment를 쓴다", "'캐릭터'·'조합'", "[좋은 감상]", "[버려지는 감상]", "그대로 베끼지", "같은 감상을 두 번", "[종류]", "좋아진 사실에 아쉬움"]) {
      assert.ok(prompt.includes(phrase), phrase);
    }
  });

  test("Z1: 사실 줄 끝에 종류를 붙이고, 모든 종류에 좋은 감상 예시가 있다", () => {
    const user = narrationUserPrompt(facts);
    for (const fact of facts) assert.ok(user.includes(`${fact.id}: ${fact.text} [종류: ${FACT_KIND_LABELS[fact.kind]}]`), fact.id);
    const kinds = Object.keys(FACT_KIND_LABELS);
    assert.deepEqual(GOOD_COMMENT_EXAMPLES.map(example => example.kind).sort(), [...kinds].sort());
    const prompt = narrationSystemPrompt();
    for (const example of GOOD_COMMENT_EXAMPLES) assert.ok(prompt.includes(`- ${FACT_KIND_LABELS[example.kind]}:`), example.kind);
  });

  test("Z1: 지시에 싣는 좋은 감상 예시는 모두 검사를 통과하고, 버려지는 예시는 모두 버려진다", () => {
    const prompt = narrationSystemPrompt();
    const good = GOOD_COMMENT_EXAMPLES.flatMap(example => example.comments);
    assert.ok(good.length >= 10);
    assert.ok(good.includes("요즘 정말 자주 보여요."));
    for (const comment of good) {
      assert.ok(prompt.includes(`'${comment}'`), comment);
      assert.deepEqual(checkComment(comment, fixtureNames), { ok: true, text: comment }, comment);
    }
    assert.ok(BAD_COMMENT_EXAMPLES.length >= 5);
    for (const { comment, why } of BAD_COMMENT_EXAMPLES) {
      assert.ok(prompt.includes(`'${comment}'`) && prompt.includes(why), comment);
      assert.equal(checkComment(comment, fixtureNames).ok, false, comment);
    }
  });

  test("문자열 JSON과 이미 푼 객체를 둘 다 받는다", async () => {
    const fromString = await writeLines(fakeLlm({ ok: true, raw: JSON.stringify(goodLines) }).llm, facts, options);
    const fromObject = await writeLines(fakeLlm({ ok: true, raw: goodLines }).llm, facts, options);
    assert.deepEqual(fromString, { ok: true, lines: goodLines.lines });
    assert.deepEqual(fromObject, fromString);
  });

  test("깨진 JSON·모양이 틀린 응답은 실패다", async () => {
    for (const raw of [
      "{not json",
      JSON.stringify({ lines: "x" }),
      JSON.stringify({ lines: [{ factId: 1, emotion: "calm", comment: "" }] }),
      JSON.stringify({ lines: [{ factId: "f1", emotion: "calm" }] }),
      JSON.stringify({ lines: [{ text: "a", emotion: "calm", factIds: [] }] }),
      null,
    ]) {
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
