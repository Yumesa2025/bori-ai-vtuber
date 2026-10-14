/**
 * 출력 검증 단위 검사(점검 L-1, a6 A6-02, a3 F7·F8·F12·F13·F14).
 * 감정·모션처럼 곁가지 값 하나가 틀려도 답을 버리지 않고 그 값만 기본값으로 바꾸는지,
 * 답이 될 수 없는 출력만 실패로 보는지, 요청별 스키마에 허용 목록이 들어가는지 본다. 네트워크를 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { maxOutputTokensFor, REPLY_MAX_OUTPUT_TOKENS, responseJsonSchemaFor, TASK_MAX_OUTPUT_TOKENS } from "../src/prompt.js";
import type { LlmRequest } from "../src/types.js";
import { DEFAULT_EMOTION, stripDecorations, validateLlmOutput } from "../src/validate.js";

const request: LlmRequest = {
  mode: "companion",
  content: "안녕",
  recentTurns: [],
  memories: [],
  sessionSummary: "",
  macroPrompts: [],
  broadcastStatus: [],
  allowedEmotions: ["calm", "happy", "sad"],
  allowedMotions: [{ name: "kuqi", description: "운다" }, { name: "shoushi", description: "게임패드" }],
  maxReplyLength: 120,
  timeoutMs: 1000,
};

const output = (patch: Record<string, unknown>) => JSON.stringify({
  reply: "오늘도 와 주셔서 고마워요.",
  emotion: { primary: "happy", intensity: 0.5, durationSeconds: 6 },
  actions: [],
  ...patch,
});

function validOf(raw: string) {
  const result = validateLlmOutput(raw, request);
  if (!result.ok) throw new Error(`검증 실패: ${result.reason}`);
  return result;
}

describe("곁가지 값 보정", () => {
  test("허용 밖 감정이면 답은 살리고 감정만 기본값으로 바꾼다(위기 답의 concerned, A6-02)", () => {
    const result = validOf(output({ emotion: { primary: "concerned", intensity: 0.4, durationSeconds: 6 } }));
    assert.equal(result.response.reply, "오늘도 와 주셔서 고마워요.");
    assert.equal(result.response.emotion.primary, DEFAULT_EMOTION);
    assert.equal(result.corrections.length, 1);
  });

  test("대소문자만 다른 감정은 같은 감정으로 받는다", () => {
    const result = validOf(output({ emotion: { primary: "Happy", intensity: 0.4, durationSeconds: 6 } }));
    assert.equal(result.response.emotion.primary, "happy");
    assert.deepEqual(result.corrections, []);
  });

  test("허용 밖 보조 감정은 빼고, 강도·지속 시간은 범위 안으로 맞춘다", () => {
    const result = validOf(output({ emotion: { primary: "sad", secondary: "angry", intensity: 3, durationSeconds: 0 } }));
    assert.deepEqual(result.response.emotion, { primary: "sad", intensity: 1, durationSeconds: 1 });
    assert.equal(result.corrections.length, 3);
  });

  test("emotion이 없어도 기본 감정으로 답한다", () => {
    const result = validOf(JSON.stringify({ reply: "네, 좋아요.", actions: [] }));
    assert.equal(result.response.emotion.primary, DEFAULT_EMOTION);
  });

  test("모르는 모션은 빼고 허용된 모션 하나만 body·2로 남긴다(F13)", () => {
    const result = validOf(output({ actions: [{ name: "dance", layer: "body", priority: 2 }, { name: "kuqi", layer: "face", priority: 3 }, { name: "shoushi", layer: "system", priority: 1 }] }));
    assert.deepEqual(result.response.actions, [{ name: "kuqi", layer: "body", priority: 2 }]);
    assert.ok(result.corrections.length >= 2);
  });

  test("actions가 배열이 아니면 비운다", () => {
    assert.deepEqual(validOf(output({ actions: "kuqi" })).response.actions, []);
  });

  test("이모지·마크다운·태그는 지우고 통과시킨다(F12)", () => {
    const result = validOf(output({ reply: "**굵게** 😀 [링크](http://x) <script>alert(1)</script> 좋아요👍🏻" }));
    assert.equal(result.response.reply, "굵게 링크 alert(1) 좋아요");
    assert.equal(result.corrections.length, 1);
  });

  test("정상 출력은 보정 없이 그대로다", () => {
    const result = validOf(output({ actions: [{ name: "shoushi", layer: "body", priority: 2 }] }));
    assert.deepEqual(result.corrections, []);
    assert.deepEqual(result.response.actions, [{ name: "shoushi", layer: "body", priority: 2 }]);
  });
});

describe("답이 될 수 없는 출력은 실패", () => {
  test("JSON이 아니거나 reply가 없거나 비면 실패다", () => {
    assert.equal(validateLlmOutput("{\"reply\": \"깨진", request).ok, false);
    assert.equal(validateLlmOutput(JSON.stringify({ emotion: {} }), request).ok, false);
    assert.equal(validateLlmOutput(output({ reply: "  " }), request).ok, false);
  });

  test("기호를 지우고 나면 빈 답도 실패다", () => {
    assert.equal(validateLlmOutput(output({ reply: "😀😀 **" }), request).ok, false);
  });

  test("길이는 코드포인트로 센다(F14). UTF-16 두 칸 글자 120개는 통과, 121개는 실패", () => {
    // 확장 한자(𠀀)는 UTF-16으로 두 칸이지만 한 글자다. 이모지가 아니라 지워지지 않는다.
    assert.equal(validateLlmOutput(output({ reply: "𠀀".repeat(120) }), request).ok, true);
    const over = validateLlmOutput(output({ reply: "𠀀".repeat(121) }), request);
    assert.equal(over.ok, false);
  });
});

describe("기호 지우기", () => {
  test("줄머리 기호와 줄바꿈을 정리한다", () => {
    assert.equal(stripDecorations("# 제목\n- 하나\n> 인용\n1. 둘"), "제목 하나 인용 둘");
  });

  test("한국어 문장과 숫자·물음표는 그대로 둔다", () => {
    assert.equal(stripDecorations("오늘 3시에 볼까요? 좋아요!"), "오늘 3시에 볼까요? 좋아요!");
  });
});

describe("요청별 스키마와 출력 상한(F8)", () => {
  test("감정·모션 허용 목록과 고정 레이어·우선순위가 enum으로 들어간다", () => {
    const schema = responseJsonSchemaFor(request);
    assert.deepEqual(schema.properties.emotion.properties.primary, { type: "string", enum: ["calm", "happy", "sad"] });
    assert.deepEqual(schema.properties.actions.items.properties.name, { type: "string", enum: ["kuqi", "shoushi"] });
    assert.deepEqual(schema.properties.actions.items.properties.layer, { type: "string", enum: ["body"] });
    assert.deepEqual(schema.properties.actions.items.properties.priority, { type: "integer", enum: [2] });
    // strict 스키마의 나머지 모양은 그대로다.
    assert.deepEqual(schema.required, ["reply", "emotion", "actions"]);
    assert.equal(schema.additionalProperties, false);
  });

  test("목록이 비면 빈 enum 대신 문자열로 둔다", () => {
    const schema = responseJsonSchemaFor({ allowedEmotions: [], allowedMotions: [] });
    assert.deepEqual(schema.properties.emotion.properties.primary, { type: "string" });
    assert.deepEqual(schema.properties.actions.items.properties.name, { type: "string" });
  });

  test("답변 요청과 요약 요청의 최대 출력 토큰", () => {
    assert.equal(maxOutputTokensFor(request), REPLY_MAX_OUTPUT_TOKENS);
    assert.equal(maxOutputTokensFor({ overrideSchema: {} }), TASK_MAX_OUTPUT_TOKENS);
  });
});
