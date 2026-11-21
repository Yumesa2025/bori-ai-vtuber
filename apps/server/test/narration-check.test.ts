/**
 * LLM 대사 검사. 줄의 숫자 토큰마다 인용한 사실(factIds, 최대 2개)의 같은 단위·값 토큰이 있어야 하고,
 * 사전에 있는 캐릭터 이름은 인용한 사실에 나온 것만, "캐릭터 무기" 조합은 인용한 사실의 조합만 쓸 수 있다.
 * 어긋난 줄은 버린다(설계 3절 3). 점검 보고서의 우회 예문은 narration-regression.test.ts에 따로 고정한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkLines, DEFAULT_MAX_LINE_LENGTH, MAX_FACT_IDS, MAX_LINES } from "../src/narration/check.js";
import { buildFacts } from "../src/narration/facts.js";
import { dictionaryNames, findCharacterNames, findPairs } from "../src/narration/names.js";
import { fixtureBasis, fixtureCombos, fixtureNames, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const options = { names: fixtureNames };
const riser = facts.find(fact => fact.kind === "riser" && fact.names.includes("재키"))!;
const top1 = facts.find(fact => fact.kind === "top")!;
const basis = facts.find(fact => fact.kind === "basis")!;
const check = (text: string, factIds: string[], extra: Partial<Parameters<typeof checkLines>[2]> = {}) =>
  checkLines([{ text, emotion: "gaming", factIds }], facts, { ...options, ...extra });

describe("대사 검사", () => {
  test("사실의 숫자 토큰만 쓴 줄은 남기고 인용한 사실 id를 같이 돌려준다", () => {
    const result = checkLines([{ text: "재키 쌍검이 3.9위에서 3.4위로 올라왔어요. 꽤 좋아진 것 같아요!", emotion: "happy", factIds: [riser.id] }], facts, options);
    assert.deepEqual(result.kept, [{ text: "재키 쌍검이 3.9위에서 3.4위로 올라왔어요. 꽤 좋아진 것 같아요!", emotion: "happy", factIds: [riser.id] }]);
    assert.deepEqual(result.dropped, []);
  });

  test("사실 문장을 그대로 읽은 줄은 모두 통과한다", () => {
    const all = buildFacts({ basis: { ...fixtureBasis, patchChanged: true }, combos: fixtureCombos, player: fixturePlayer });
    for (const fact of all) {
      assert.equal(checkLines([{ text: fact.text, emotion: "calm", factIds: [fact.id] }], all, options).kept.length, 1, fact.text);
      assert.equal(checkLines([{ text: fact.spoken, emotion: "calm", factIds: [fact.id] }], all, options).kept.length, 1, fact.spoken);
    }
  });

  test("사실에 없는 숫자가 있으면 버린다", () => {
    const result = check("재키 쌍검이 3.5위까지 올라왔어요.", [riser.id]);
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped[0].reason, "number");
  });

  test("같은 값이라도 단위가 다르면 버린다(3.4위 ≠ 3.4%)", () => {
    assert.equal(check("재키 쌍검 픽률이 3.4%예요.", [riser.id]).kept.length, 0);
  });

  test("같은 단위·값이라도 앞 낱말의 뜻이 다르면 버린다(1등 비율 14.0%를 픽률로)", () => {
    assert.equal(check("재키 쌍검은 픽률 14.0%예요.", [top1.id]).kept.length, 0);
    assert.equal(check("재키 쌍검은 1등 비율 14.0%예요.", [top1.id]).kept.length, 1);
  });

  test("쉼표 숫자는 쉼표 없이 써도 같은 수다", () => {
    assert.equal(check("참가자 7200명을 모았어요.", [basis.id]).kept.length, 1);
  });

  test("다른 사실의 숫자는 그 사실을 밝히지 않으면 쓸 수 없다", () => {
    assert.equal(check("재키 쌍검 픽률은 8.1%예요.", [riser.id]).kept.length, 0);
    assert.equal(check("재키 쌍검 픽률은 8.1%예요.", [riser.id, top1.id]).kept.length, 1);
  });

  test(`factIds는 최대 ${MAX_FACT_IDS}개이고, 없는 사실 id가 있으면 버린다`, () => {
    const three = facts.slice(0, 3).map(fact => fact.id);
    assert.equal(check("오늘 분석이에요.", three).dropped[0]?.reason, "facts");
    assert.equal(check("재키 쌍검이 3.4위예요.", ["f99"]).dropped[0]?.reason, "facts");
  });

  test("숫자 없는 인사 줄은 근거 없이도 남긴다", () => {
    assert.equal(check("오늘의 메타 분석, 시작해 볼게요!", []).kept.length, 1);
  });

  test("사전에 있는 캐릭터 이름이 인용한 사실에 없으면 버린다", () => {
    const result = check("재키 쌍검이 3.4위예요. 아야도 좋아요.", [riser.id]);
    assert.equal(result.dropped[0].reason, "name");
  });

  test("캐릭터 이름은 낱말 경계로만 찾는다", () => {
    assert.deepEqual(findCharacterNames("아야는 오늘", fixtureNames), ["아야"]);
    assert.deepEqual(findCharacterNames("재키가, 재키쌍검", fixtureNames), ["재키"]);
    assert.deepEqual(findCharacterNames("하트 모양, 리 다이린이", fixtureNames), ["하트", "리 다이린"]);
    assert.deepEqual(findCharacterNames("아야야 아파요", fixtureNames), []);
  });

  test("무기 이름은 '캐릭터 무기' 꼴일 때만 조합으로 본다", () => {
    assert.deepEqual(findPairs("재키 활이 좋고 기타 조합도", fixtureNames), [{ character: "재키", weapon: "활" }]);
    assert.deepEqual(findPairs("활약이 좋아요", fixtureNames), []);
    assert.deepEqual(findPairs("리 다이린 돌격 소총", fixtureNames), [{ character: "리 다이린", weapon: "돌격 소총" }]);
  });

  test("사전 모양(characters·weaponNames)에서 이름 목록을 만든다", () => {
    assert.deepEqual(dictionaryNames({ characters: [{ name: "재키" }, { name: "" }], weaponNames: { 13: "쌍검", 7: "권총" } }), { characters: ["재키"], weapons: ["권총", "쌍검"] });
    assert.equal(dictionaryNames(null), null);
  });

  test("꾸밈(마크다운·이모지)과 제어 문자를 지운 글로 검사하고 남긴다", () => {
    const result = check("**재키 쌍검**이 픽률 1위예요 😊\u202e", [top1.id]);
    assert.deepEqual(result.kept.map(line => line.text), ["재키 쌍검이 픽률 1위예요"]);
  });

  test("모르는 감정은 calm으로 바꾼다", () => {
    const result = checkLines([{ text: "정리해 봤어요.", emotion: "ecstatic", factIds: [] }], facts, options);
    assert.equal(result.kept[0].emotion, "calm");
  });

  test("줄 길이는 코드포인트로 세고 상한은 설정으로 바꿀 수 있다", () => {
    assert.equal(check("가".repeat(DEFAULT_MAX_LINE_LENGTH), []).kept.length, 1);
    assert.equal(check("가".repeat(DEFAULT_MAX_LINE_LENGTH + 1), []).dropped[0].reason, "length");
    assert.equal(check("가".repeat(30), [], { maxLineLength: 20 }).dropped[0].reason, "length");
    // 이모지는 지운 뒤에 센다
    assert.equal(check(`${"가".repeat(20)}😊`, [], { maxLineLength: 20 }).kept.length, 1);
  });

  test("빈 줄은 버리고, 앞뒤 공백을 정리하고, 최대 줄 수를 넘는 줄은 count로 버린다", () => {
    const lines = [
      { text: "   ", emotion: "calm", factIds: [] },
      ...Array.from({ length: MAX_LINES + 2 }, (_, index) => ({ text: `  인사 ${"하나둘셋넷다섯여섯일곱"[index]}  `, emotion: "calm", factIds: [] })),
    ];
    const result = checkLines(lines, facts, options);
    assert.equal(result.kept.length, MAX_LINES);
    assert.equal(result.kept[0].text, "인사 하");
    assert.deepEqual(result.dropped.map(entry => entry.reason), ["empty", "count", "count"]);
  });
});
