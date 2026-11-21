/**
 * 대사 줄 만들기 검사. LLM은 줄마다 사실 id(factId)·감정·감상(comment)만 고르고,
 * 줄 문장은 서버가 "사실의 정해진 문장 + 통과한 감상"으로 만든다(Codex C2 1~3절).
 * 점검 보고서의 우회 예문은 narration-regression.test.ts에 따로 고정한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { composeLines, DEFAULT_MAX_LINE_LENGTH, MAX_LINES } from "../src/narration/check.js";
import { buildFacts } from "../src/narration/facts.js";
import { renderFact } from "../src/narration/template.js";
import { fixtureBasis, fixtureCombos, fixtureNames, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const options = { names: fixtureNames };
const [f1, f2, f3, f4, f5, f6] = facts;
const line = (factId: string, comment = "", emotion = "gaming") => ({ factId, emotion, comment });

describe("대사 줄 만들기", () => {
  test("줄 문장은 사실의 정해진 문장 뒤에 통과한 감상을 붙인 것이다", () => {
    const result = composeLines([line(f1.id, "꽤 좋아 보여요.", "happy")], facts, options);
    assert.deepEqual(result.kept, [{ text: `${renderFact(f1)} 꽤 좋아 보여요.`, emotion: "happy", factId: f1.id }]);
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(result.commentDropped, []);
  });

  test("renderFact는 사실의 정해진 문장(화면과 같은 반올림)이다", () => {
    assert.equal(renderFact(f1), "지금 가장 많이 고른 조합은 재키 쌍검이에요. 픽률 8.1%, 평균 순위 3.4위예요.");
  });

  test("감상이 비어 있으면 서버 문장만 읽고 버림으로 세지 않는다", () => {
    const result = composeLines([line(f1.id, "  ")], facts, options);
    assert.deepEqual(result.kept.map(entry => entry.text), [renderFact(f1)]);
    assert.deepEqual(result.commentDropped, []);
  });

  test("감상이 규칙을 어기면 감상만 버리고 서버 문장은 남긴다", () => {
    const result = composeLines([line(f1.id, "픽률이 99%예요."), line(f2.id, "레온입니다.")], facts, options);
    assert.deepEqual(result.kept.map(entry => entry.text), [renderFact(f1), renderFact(f2)]);
    assert.deepEqual(result.commentDropped, ["number", "name"]);
  });

  test("없는 사실 id와 같은 사실을 다시 고른 줄은 버린다", () => {
    const result = composeLines([line("f99", "좋아요."), line(f1.id), line(f1.id, "또 좋아요.")], facts, options);
    assert.deepEqual(result.kept.map(entry => entry.factId), [f1.id]);
    assert.deepEqual(result.dropped, ["fact", "duplicate"]);
  });

  test(`최대 ${MAX_LINES}줄이고 넘는 줄은 count로 버린다`, () => {
    const result = composeLines([f1, f2, f3, f4, f5, f6].map(fact => line(fact.id)), facts, options);
    assert.equal(result.kept.length, MAX_LINES);
    assert.deepEqual(result.dropped, ["count"]);
  });

  test("합친 줄이 글자 상한을 넘으면 감상을 버린다", () => {
    const limit = [...renderFact(f1)].length + 3;
    const result = composeLines([line(f1.id, "꽤 좋아 보여요.")], facts, { ...options, maxLineLength: limit });
    assert.deepEqual(result.kept.map(entry => entry.text), [renderFact(f1)]);
    assert.deepEqual(result.commentDropped, ["length"]);
    assert.ok(DEFAULT_MAX_LINE_LENGTH >= 100);
  });

  test("모르는 감정은 calm으로 바꾼다", () => {
    assert.equal(composeLines([line(f1.id, "", "ecstatic")], facts, options).kept[0].emotion, "calm");
  });
});
