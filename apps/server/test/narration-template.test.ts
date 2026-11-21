/**
 * 정해진 문장 대사 검사. LLM이 꺼졌거나 실패했거나 모든 줄이 검사에서 버려졌을 때 읽는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkLines } from "../src/narration/check.js";
import { buildFacts } from "../src/narration/facts.js";
import { EMPTY_TEMPLATE_LINE, templateLines } from "../src/narration/template.js";
import { fixtureBasis, fixtureCombos, fixturePlayer } from "./narration-fixtures.js";

const known = fixtureCombos.flatMap(entry => [entry.characterName, entry.weaponName]);

describe("정해진 문장", () => {
  test("메타 1위 → 크게 오른 조합 → 주캐릭터 순으로 3줄을 읽는다", () => {
    const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
    const lines = templateLines(facts);
    assert.deepEqual(lines.map(line => line.text), [
      "지금 가장 많이 고른 조합은 재키 쌍검이에요. 픽률 8.1%, 평균 순위 3.4위예요.",
      "재키 쌍검은 평균 순위가 3.9위에서 3.4위로 좋아졌어요.",
      "자주 하시는 재키는 지금 메타 조합 순위 2위예요.",
    ]);
    assert.deepEqual(lines.map(line => line.emotion), ["gaming", "happy", "gaming"]);
  });

  test("패치가 바뀌었으면 비교가 참고용이라고 먼저 알린다", () => {
    const facts = buildFacts({ basis: { ...fixtureBasis, patchChanged: true }, combos: fixtureCombos, player: null });
    const lines = templateLines(facts);
    assert.equal(lines.length, 3);
    assert.match(lines[2].text, /시즌이나 패치가 바뀌어서/);
    assert.equal(lines[2].emotion, "curious");
  });

  test("움직임·주캐릭터가 없으면 TOP 2와 집계 기준으로 채운다", () => {
    const fresh = fixtureCombos.map(entry => ({ ...entry, change: null }));
    const facts = buildFacts({ basis: { ...fixtureBasis, previousCollectedAt: null }, combos: fresh, player: null });
    assert.deepEqual(templateLines(facts).map(line => line.text), [
      "지금 가장 많이 고른 조합은 재키 쌍검이에요. 픽률 8.1%, 평균 순위 3.4위예요.",
      "아야 권총도 픽률 7.5%로 많이 보이고, 평균 순위는 4.1위예요.",
      "이번 분석은 시즌 13 랭크 경기 300판, 참가자 7,200명을 모은 거예요.",
    ]);
  });

  test("정해진 문장도 대사 검사를 통과한다", () => {
    const facts = buildFacts({ basis: { ...fixtureBasis, patchChanged: true }, combos: fixtureCombos, player: fixturePlayer });
    const raw = templateLines(facts).map(line => ({ ...line, factIds: facts.filter(fact => line.text === fact.spoken).map(fact => fact.id) }));
    assert.equal(checkLines(raw, facts, known).kept.length, raw.length);
  });

  test("사실이 없으면 안내 한 줄", () => {
    assert.deepEqual(templateLines([]), [EMPTY_TEMPLATE_LINE]);
  });
});
