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
