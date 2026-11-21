/**
 * 토큰 사용량 단위 검사.
 * 업체 응답의 usage를 어댑터 결과에 싣는지, 없으면 비워 두는지, 클라이언트가 호출마다 알리는지 본다.
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createOpenAiAdapter } from "../src/openai.js";
import type { LlmRequest } from "../src/types.js";
import { tokenUsageFrom } from "../src/usage.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 다음 fetch가 돌려줄 응답을 정한다. */
function respondWith(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

const request: LlmRequest = {
  overrideSystemPrompt: "시스템 지시",
  overrideUserPrompt: "사용자 내용",
  overrideSchema: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"], additionalProperties: false },
  timeoutMs: 1000,
};

const reply = JSON.stringify({ lines: ["안녕하세요"] });

describe("tokenUsageFrom", () => {
  test("0 이상의 정수 두 개만 받는다", () => {
    assert.deepEqual(tokenUsageFrom(10, 0), { inputTokens: 10, outputTokens: 0 });
    assert.equal(tokenUsageFrom(10, undefined), undefined);
    assert.equal(tokenUsageFrom("10", 3), undefined);
    assert.equal(tokenUsageFrom(-1, 3), undefined);
    assert.equal(tokenUsageFrom(1.5, 3), undefined);
  });
});

describe("어댑터 usage", () => {
  test("OpenAI prompt_tokens·completion_tokens를 싣는다", async () => {
    respondWith(200, { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
    const result = await createOpenAiAdapter({ apiKey: "k", model: "gpt-4o-mini", baseUrl: "http://mock" }).complete(request);
    assert.equal(result.raw, reply);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
  });

  test("OpenAI 응답에 usage가 없으면 usage 필드 자체가 없다", async () => {
    respondWith(200, { choices: [{ message: { content: reply } }] });
    const result = await createOpenAiAdapter({ apiKey: "k", model: "gpt-4o-mini", baseUrl: "http://mock" }).complete(request);
    assert.equal("usage" in result, false);
  });

  test("Anthropic input_tokens·output_tokens를 싣는다", async () => {
    respondWith(200, {
      content: [{ type: "tool_use", name: "bori_response", input: JSON.parse(reply) }],
      usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0 },
    });
    const result = await createAnthropicAdapter({ apiKey: "k", model: "claude-sonnet-5", baseUrl: "http://mock" }).complete(request);
    assert.deepEqual(JSON.parse(result.raw), JSON.parse(reply));
    assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 40 });
  });

  test("Anthropic 응답의 usage 형식이 틀리면 비워 둔다", async () => {
    respondWith(200, { content: [{ type: "tool_use", name: "bori_response", input: JSON.parse(reply) }], usage: { input_tokens: 200 } });
    const result = await createAnthropicAdapter({ apiKey: "k", model: "claude-sonnet-5", baseUrl: "http://mock" }).complete(request);
    assert.equal(result.usage, undefined);
  });
});
