/**
 * 감상 예시 묶음 검사. 지시에는 부를 때마다 꼴 보기 문장 몇 개와 종류별 느낌 낱말 일부만 무작위로 싣는다(과제 A, 2026-11-22).
 * 묶음의 예시는 모두 감상 규칙을 통과해야 하고, 예시를 그대로 베낀 감상은 서버가 버린다(check.ts copied).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkComment } from "../src/narration/comment.js";
import { COMMENT_EXAMPLE_POOL, COMMENT_FEELING_POOL, commentKey, FEELINGS_PER_KIND, isCopiedExample, pickCommentExamples, SAMPLE_COUNT, seededRandom } from "../src/narration/examples.js";
import { FACT_KIND_LABELS } from "../src/narration/writer.js";
import { fixtureNames } from "./narration-fixtures.js";

const kinds = Object.keys(FACT_KIND_LABELS) as Array<keyof typeof FACT_KIND_LABELS>;
const pool = Object.values(COMMENT_EXAMPLE_POOL).flat();

describe("감상 예시 묶음", () => {
  test("모든 사실 종류에 예시 문장과 고르는 수보다 많은 느낌 낱말이 있다", () => {
    assert.deepEqual(Object.keys(COMMENT_EXAMPLE_POOL).sort(), [...kinds].sort());
    assert.deepEqual(Object.keys(COMMENT_FEELING_POOL).sort(), [...kinds].sort());
    for (const kind of kinds) {
      assert.ok(COMMENT_EXAMPLE_POOL[kind].length >= 8, kind);
      assert.ok(COMMENT_FEELING_POOL[kind].length > FEELINGS_PER_KIND, kind);
    }
    assert.ok(SAMPLE_COUNT < kinds.length);
  });

  test("느낌 낱말은 감상 규칙의 금지 낱말·지표·이름이 아니다", () => {
    for (const word of Object.values(COMMENT_FEELING_POOL).flat()) {
      assert.equal(checkComment(`${word}이 느껴져요.`, fixtureNames).ok, true, word);
    }
  });

  test("묶음의 예시는 모두 감상 규칙을 통과한다", () => {
    for (const comment of pool) assert.deepEqual(checkComment(comment, fixtureNames), { ok: true, text: comment }, comment);
  });

  test("묶음 안에 공백·문장부호만 다른 같은 문장이 없다", () => {
    assert.equal(new Set(pool.map(commentKey)).size, pool.length);
  });

  test("commentKey는 공백·문장부호만 지운다", () => {
    assert.equal(commentKey(" 요즘  정말 자주 보여요!! "), commentKey("요즘 정말 자주 보여요."));
    assert.equal(commentKey("요즘정말자주보여요"), commentKey("요즘 정말 자주 보여요."));
    assert.notEqual(commentKey("요즘 정말 자주 보이네요."), commentKey("요즘 정말 자주 보여요."));
  });

  test("예시를 그대로·공백과 문장부호만 바꿔 쓴 감상은 베낀 것이다. 낱말이 다르면 아니다", () => {
    const example = COMMENT_EXAMPLE_POOL.top[0];
    assert.equal(isCopiedExample(example), true);
    assert.equal(isCopiedExample(`${example.replace(/[.!?]+$/, "")}!`), true);
    assert.equal(isCopiedExample(example.replace(/ /g, "")), true);
    assert.equal(isCopiedExample(`  ${example}  `), true);
    assert.equal(isCopiedExample("오늘따라 유난히 반가운 얼굴이에요."), false);
    assert.equal(isCopiedExample(""), false);
  });

  test("꼴 보기는 서로 다른 종류에서 하나씩, 느낌은 종류마다 정해진 수만큼 겹치지 않게 고른다", () => {
    const { samples, feelings } = pickCommentExamples(seededRandom(7));
    assert.equal(samples.length, SAMPLE_COUNT);
    const sampleKinds = samples.map(sample => kinds.find(kind => COMMENT_EXAMPLE_POOL[kind].includes(sample)));
    assert.ok(sampleKinds.every(kind => kind !== undefined));
    assert.equal(new Set(sampleKinds).size, SAMPLE_COUNT);
    assert.deepEqual(feelings.map(entry => entry.kind), kinds);
    for (const { kind, words } of feelings) {
      assert.equal(words.length, FEELINGS_PER_KIND, kind);
      assert.equal(new Set(words).size, words.length, kind);
      for (const word of words) assert.ok(COMMENT_FEELING_POOL[kind].includes(word), word);
    }
  });

  test("같은 시드면 같은 예시, 시드가 다르면 다른 예시를 고른다", () => {
    assert.deepEqual(pickCommentExamples(seededRandom(1)), pickCommentExamples(seededRandom(1)));
    const seen = new Set(Array.from({ length: 10 }, (_, seed) => JSON.stringify(pickCommentExamples(seededRandom(seed)))));
    assert.ok(seen.size >= 8, String(seen.size));
  });

  test("여러 번 고르면 묶음의 예시 문장과 느낌 낱말이 고루 나온다", () => {
    const random = seededRandom(42);
    const samples = new Set<string>();
    const words = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const picked = pickCommentExamples(random);
      for (const sample of picked.samples) samples.add(sample);
      for (const entry of picked.feelings) for (const word of entry.words) words.add(`${entry.kind}:${word}`);
    }
    assert.equal(samples.size, pool.length);
    assert.equal(words.size, Object.values(COMMENT_FEELING_POOL).flat().length);
  });

  test("seededRandom은 0 이상 1 미만이다", () => {
    const random = seededRandom(123);
    for (let i = 0; i < 1000; i++) {
      const value = random();
      assert.ok(value >= 0 && value < 1, String(value));
    }
  });
});
