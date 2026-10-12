/**
 * 토큰 사용량 단위 검사.
 * 업체 응답의 usage를 어댑터 결과에 싣는지, 없으면 비워 두는지, 클라이언트가 호출마다 알리는지 본다.
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { LlmSettings } from "@bori/shared";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createLlmClient, type LlmCallReport } from "../src/index.js";
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
  mode: "companion",
  content: "안녕",
  recentTurns: [],
  memories: [],
  sessionSummary: "",
  macroPrompts: [],
  broadcastStatus: [],
  allowedEmotions: ["calm"],
  allowedMotions: [],
  maxReplyLength: 120,
  timeoutMs: 1000,
};

const reply = JSON.stringify({ reply: "안녕하세요", emotion: { primary: "calm", intensity: 0.4, durationSeconds: 5 }, actions: [] });

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

describe("createLlmClient onCall", () => {
  const settings: LlmSettings = {
    enabled: true,
    provider: "openai",
    model: "gpt-4o-mini",
    maxReplyLength: 120,
    timeoutMs: 1000,
    failureThreshold: 3,
    cooldownSeconds: 60,
    rollingSummaryEnabled: false,
    rollingSummaryTurns: 10,
    macroEnabled: false,
  };

  test("성공·실패를 모드·모델·토큰과 함께 알리고, 부르지 않은 호출은 알리지 않는다", async () => {
    const reports: LlmCallReport[] = [];
    const client = createLlmClient({ onCall: report => reports.push(report) });

    respondWith(200, { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    const ok = await client.respond(settings, "key", request);
    assert.equal(ok.ok, true);

    respondWith(500, { error: "실패" });
    const failed = await client.respond(settings, "key", { ...request, mode: "broadcast" });
    assert.equal(failed.ok, false);

    // 꺼져 있으면 업체를 부르지 않으므로 기록도 없다.
    await client.respond({ ...settings, enabled: false }, "key", request);

    assert.deepEqual(reports, [
      { mode: "companion", model: "gpt-4o-mini", ok: true, usage: { inputTokens: 7, outputTokens: 3 } },
      { mode: "broadcast", model: "gpt-4o-mini", ok: false },
    ]);
  });

  test("형식 검증 실패는 과금된 호출이라 ok로 알린다", async () => {
    const reports: LlmCallReport[] = [];
    const client = createLlmClient({ onCall: report => reports.push(report) });
    respondWith(200, { choices: [{ message: { content: "{\"reply\":1}" } }] });
    const outcome = await client.respond(settings, "key", request);
    assert.equal(outcome.ok, false);
    assert.deepEqual(reports, [{ mode: "companion", model: "gpt-4o-mini", ok: true }]);
  });

  test("onCall이 던져도 답변은 그대로 나온다", async () => {
    const client = createLlmClient({ onCall: () => { throw new Error("기록 실패"); } });
    respondWith(200, { choices: [{ message: { content: reply } }] });
    const originalError = console.error;
    console.error = () => {};
    try {
      const outcome = await client.respond(settings, "key", request);
      assert.equal(outcome.ok, true);
    } finally {
      console.error = originalError;
    }
  });
});
