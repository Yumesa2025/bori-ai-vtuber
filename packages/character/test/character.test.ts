import assert from "node:assert/strict";
import { test } from "node:test";
import { boriPersonaLines, boriScopeLines, conversationModes, conversationPolicies } from "../src/index.js";

test("모든 모드에 정책이 있고 키와 mode 값이 같다", () => {
  for (const mode of conversationModes) {
    const policy = conversationPolicies[mode];
    assert.equal(policy.mode, mode);
    assert.ok(policy.rules.length > 0);
    assert.ok(policy.noMemoryLine.length > 0);
  }
});

test("공통 페르소나에는 모드 전용 호칭 규칙이 없다", () => {
  const common = [...boriPersonaLines, ...boriScopeLines].join("\n");
  assert.ok(!common.includes("여러분"));
  assert.ok(!common.includes("닉네임"));
});

test("1:1 대화 정책에 방송 호칭·닉네임 규칙이 섞이지 않는다", () => {
  const companion = JSON.stringify(conversationPolicies.companion);
  assert.ok(!companion.includes("여러분"));
  assert.ok(!companion.includes("닉네임"));
  assert.ok(!companion.includes("시청자"));
});

test("방송은 규칙 문장·무반응·서버 폴백을 그대로 쓰고, 1:1은 규칙 없이 거절·폴백 문장을 갖는다", () => {
  const { broadcast, companion } = conversationPolicies;
  assert.equal(broadcast.ruleReplies, true);
  assert.deepEqual(broadcast.refusalReplies, []);
  assert.equal(broadcast.fallbackReplies, null);

  assert.equal(companion.ruleReplies, false);
  assert.ok(companion.refusalReplies.length > 0);
  assert.ok((companion.fallbackReplies ?? []).length > 0);
});

test("1:1 정책에 관계 맥락 지침(초안)이 있고, 방송 정책 문장은 그대로다", () => {
  const rules = conversationPolicies.companion.rules.join("\n");
  for (const phrase of ["처음 대화한다고 되어 있으면", "반가움을 표현한다", "[기억]이나 지난 대화 요약에 있는 것만", "아는 척하지 않는다", "그 상황에 먼저 반응한다"]) {
    assert.ok(rules.includes(phrase), phrase);
  }
  assert.deepEqual(conversationPolicies.broadcast.rules, [
    "- 밝고 편안한 소통 방송 진행자다.",
    "- 시청자를 부를 때는 '여러분'이라고 한다.",
    "- 시청자 닉네임은 절대 부르지 않는다.",
  ]);
});

test("1:1 정책에 지어내기 방지 지침(초안)이 있다", () => {
  const rules = conversationPolicies.companion.rules.join("\n");
  for (const phrase of ["'당신'이라고 부르지 않는다", "'저희'가 아니라 상대의 것", "이야기를 지어내지 않는다", "'기억해요'라고 하지 않는다", "다시 와 준 것을 반가워하는"]) {
    assert.ok(rules.includes(phrase), phrase);
  }
});
