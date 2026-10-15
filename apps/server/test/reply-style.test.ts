/**
 * 방송 답 끝맺음 다듬기 검사. 시청자에게 의견을 묻는 문장만 빼고 나머지는 그대로 둔다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutOpinionQuestions } from "../src/conversation/reply-style.js";

test("끝에 붙은 의견 묻기 문장을 뺀다", () => {
  assert.equal(withoutOpinionQuestions("재키는 픽률이 8.1%로 높아요. 여러분은 어떻게 생각하시나요?"), "재키는 픽률이 8.1%로 높아요.");
  assert.equal(withoutOpinionQuestions("오늘 메타 재밌네요! 여러분의 의견을 듣고 싶어요."), "오늘 메타 재밌네요!");
  assert.equal(withoutOpinionQuestions("여러분 생각은 어떠세요? 저는 재키가 좋아요!"), "저는 재키가 좋아요!");
});

test("의견을 묻지 않는 답과 소수점은 그대로다", () => {
  assert.equal(withoutOpinionQuestions("재키 좋아요. 평균 3.4위예요!"), "재키 좋아요. 평균 3.4위예요!");
  assert.equal(withoutOpinionQuestions("어떤 캐릭터가 궁금하세요?"), "어떤 캐릭터가 궁금하세요?");
});

test("그 문장뿐인 답은 비우지 않고 그대로 둔다", () => {
  assert.equal(withoutOpinionQuestions("어떻게 생각하세요?"), "어떻게 생각하세요?");
});
