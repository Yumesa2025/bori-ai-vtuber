/**
 * LLM 대사 검사. 줄마다 숫자가 그 줄이 밝힌 사실(factIds)의 숫자 안에 있어야 하고,
 * 알려진 캐릭터·무기 이름은 그 사실에 나온 것만 쓸 수 있다. 어긋난 줄은 버린다(설계 3절 3).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkLines, MAX_LINES, MAX_LINE_LENGTH } from "../src/narration/check.js";
import { buildFacts } from "../src/narration/facts.js";
import { fixtureBasis, fixtureCombos, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const known = fixtureCombos.flatMap(entry => [entry.characterName, entry.weaponName]);
const riser = facts.find(fact => fact.kind === "riser" && fact.names.includes("재키"))!;
const top1 = facts.find(fact => fact.kind === "top")!;

describe("대사 검사", () => {
  test("사실의 숫자만 쓴 줄은 남긴다", () => {
    const result = checkLines([{ text: "재키 쌍검이 3.9위에서 3.4위로 올라왔어요. 꽤 좋아진 것 같아요!", emotion: "happy", factIds: [riser.id] }], facts, known);
    assert.deepEqual(result.kept, [{ text: "재키 쌍검이 3.9위에서 3.4위로 올라왔어요. 꽤 좋아진 것 같아요!", emotion: "happy" }]);
    assert.deepEqual(result.dropped, []);
  });

  test("사실에 없는 숫자가 있으면 버린다", () => {
    const result = checkLines([{ text: "재키 쌍검이 3.5위까지 올라왔어요.", emotion: "happy", factIds: [riser.id] }], facts, known);
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped[0].reason, "number");
  });

  test("다른 사실의 숫자는 그 사실을 밝히지 않으면 쓸 수 없다", () => {
    const result = checkLines([{ text: "재키 쌍검 픽률은 8.1%예요.", emotion: "gaming", factIds: [riser.id] }], facts, known);
    assert.equal(result.kept.length, 0);
    const cited = checkLines([{ text: "재키 쌍검 픽률은 8.1%예요.", emotion: "gaming", factIds: [riser.id, top1.id] }], facts, known);
    assert.equal(cited.kept.length, 1);
  });

  test("없는 사실 id는 근거가 되지 않는다", () => {
    const result = checkLines([{ text: "재키 쌍검이 3.4위예요.", emotion: "gaming", factIds: ["f99"] }], facts, known);
    assert.equal(result.kept.length, 0);
  });

  test("숫자 없는 인사 줄은 근거 없이도 남긴다", () => {
    const result = checkLines([{ text: "오늘의 메타 분석, 시작해 볼게요!", emotion: "greeting", factIds: [] }], facts, known);
    assert.equal(result.kept.length, 1);
  });

  test("사실에 없는 캐릭터·무기 이름이 나오면 버린다", () => {
    const result = checkLines([{ text: "재키 쌍검이 3.4위예요. 아야도 좋아요.", emotion: "gaming", factIds: [riser.id] }], facts, known);
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped[0].reason, "name");
  });

  test("모르는 감정은 calm으로 바꾼다", () => {
    const result = checkLines([{ text: "정리해 봤어요.", emotion: "ecstatic", factIds: [] }], facts, known);
    assert.equal(result.kept[0].emotion, "calm");
  });

  test("빈 줄과 너무 긴 줄은 버리고, 앞뒤 공백을 정리하고, 최대 줄 수까지만 남긴다", () => {
    const lines = [
      { text: "   ", emotion: "calm", factIds: [] },
      { text: "가".repeat(MAX_LINE_LENGTH + 1), emotion: "calm", factIds: [] },
      ...Array.from({ length: MAX_LINES + 2 }, (_, index) => ({ text: `  인사 ${"하나둘셋넷다섯여섯일곱"[index]}  `, emotion: "calm", factIds: [] })),
    ];
    const result = checkLines(lines, facts, known);
    assert.equal(result.kept.length, MAX_LINES);
    assert.equal(result.kept[0].text, "인사 하");
    assert.deepEqual(result.dropped.slice(0, 2).map(entry => entry.reason), ["empty", "length"]);
  });
});
