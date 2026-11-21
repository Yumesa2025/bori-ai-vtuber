/**
 * 속도 제한(429) 재시도와 회로 차단기 단위 검사(점검 L-3, a3 F15), 출력 보정이 실패로 세지지 않는지(a3 F7).
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다. 키는 테스트용 가짜 문자열이다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { LlmSettings } from "@bori/shared";
import { createLlmClient } from "../src/index.js";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createOpenAiAdapter } from "../src/openai.js";
import { RateLimitError, retryAfterMsOf, sendWithRateLimitRetry } from "../src/retry.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type LlmRequest } from "../src/types.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const request: LlmRequest = {
  overrideSystemPrompt: "시스템 지시",
  overrideUserPrompt: "사용자 내용",
  overrideSchema: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"], additionalProperties: false },
  timeoutMs: 2000,
};

const settings: LlmSettings = {
  enabled: true,
  provider: "openai",
  model: "test-model",
  maxReplyLength: 120,
  timeoutMs: 2000,
  failureThreshold: 2,
  cooldownSeconds: 60,
};

const completion = (content: object) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const rateLimited = (retryAfter?: string) => new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
const okReply = { lines: ["네, 반가워요."] };

/** 응답을 차례로 돌려주는 가짜 fetch. 받은 요청 본문을 남긴다. */
function scriptFetch(responses: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error("준비한 응답이 없습니다.");
    return next();
  }) as typeof fetch;
  return bodies;
}

describe("Retry-After 읽기", () => {
  test("초, HTTP 날짜, 없음", () => {
    assert.equal(retryAfterMsOf("2"), 2000);
    assert.equal(retryAfterMsOf("0.5"), 500);
    const now = Date.parse("2026-10-15T00:00:00Z");
    assert.equal(retryAfterMsOf("Thu, 15 Oct 2026 00:00:03 GMT", now), 3000);
    assert.equal(retryAfterMsOf(null), null);
    assert.equal(retryAfterMsOf("곧"), null);
  });
});

describe("429 한 번 다시 보내기", () => {
  test("Retry-After만큼 기다렸다 한 번 다시 보낸다", async () => {
    let calls = 0;
    const startedAt = Date.now();
    const response = await sendWithRateLimitRetry(async () => (calls++ === 0 ? rateLimited("0.2") : new Response("ok")), startedAt + 5000);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.ok(Date.now() - startedAt >= 190);
  });

  test("기다림이 호출 상한을 넘으면 다시 보내지 않고 429를 돌려준다", async () => {
    let calls = 0;
    const response = await sendWithRateLimitRetry(async () => { calls += 1; return rateLimited("20"); }, Date.now() + 2000);
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
  });

  test("다시 보내도 429면 그대로 돌려준다(두 번까지만)", async () => {
    let calls = 0;
    const response = await sendWithRateLimitRetry(async () => { calls += 1; return rateLimited("0"); }, Date.now() + 5000);
    assert.equal(response.status, 429);
    assert.equal(calls, 2);
  });

  test("어댑터는 남은 429를 RateLimitError로 던진다", async () => {
    scriptFetch([() => rateLimited("30")]);
    await assert.rejects(createOpenAiAdapter({ apiKey: "fake-key", model: "test" }).complete(request), (error: unknown) => error instanceof RateLimitError);
  });

  test("어댑터는 재시도가 성공하면 답을 돌려준다", async () => {
    scriptFetch([() => rateLimited("0"), () => completion(okReply)]);
    const result = await createOpenAiAdapter({ apiKey: "fake-key", model: "test" }).complete(request);
    assert.deepEqual(JSON.parse(result.raw).lines, ["네, 반가워요."]);
  });
});

const parseLines = (raw: string) => {
  const value = JSON.parse(raw) as { lines?: unknown };
  return Array.isArray(value.lines) ? { ok: true as const, value: value.lines } : { ok: false as const, reason: "lines가 없습니다." };
};

describe("요청 본문", () => {
  test("OpenAI: 부르는 쪽의 프롬프트·스키마를 그대로 보내고 출력 상한 기본값은 1024다", async () => {
    const bodies = scriptFetch([() => completion(okReply), () => completion(okReply)]);
    await createOpenAiAdapter({ apiKey: "fake-key", model: "test" }).complete(request);
    await createOpenAiAdapter({ apiKey: "fake-key", model: "test" }).complete({ ...request, maxOutputTokens: 300 });
    assert.deepEqual(bodies[0].messages, [{ role: "system", content: "시스템 지시" }, { role: "user", content: "사용자 내용" }]);
    assert.deepEqual((bodies[0].response_format as { json_schema: { strict: boolean; schema: object } }).json_schema.schema, request.overrideSchema);
    assert.equal((bodies[0].response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
    assert.equal(bodies[0].max_completion_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(bodies[1].max_completion_tokens, 300);
  });

  test("Anthropic: system 칸과 도구 입력 스키마로 보낸다", async () => {
    const bodies = scriptFetch([() => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "bori_response", input: okReply }] }), { status: 200 })]);
    const result = await createAnthropicAdapter({ apiKey: "fake-key", model: "test" }).complete({ ...request, maxOutputTokens: 200 });
    assert.equal(bodies[0].system, "시스템 지시");
    assert.deepEqual(bodies[0].messages, [{ role: "user", content: "사용자 내용" }]);
    assert.deepEqual((bodies[0].tools as Array<{ input_schema: object }>)[0].input_schema, request.overrideSchema);
    assert.equal(bodies[0].max_tokens, 200);
    assert.deepEqual(JSON.parse(result.raw), okReply);
  });
});

describe("회로 차단기(실제 어댑터)", () => {
  test("429는 연속 실패로 세지 않아 회로가 열리지 않는다", async () => {
    const client = createLlmClient();
    scriptFetch(Array.from({ length: 4 }, () => () => rateLimited("30")));
    for (let i = 0; i < 4; i += 1) {
      const outcome = await client.complete(settings, "fake-key", request, parseLines);
      assert.equal(outcome.ok, false);
    }
    const status = client.status(settings, "fake-key");
    assert.equal(status.circuitOpen, false);
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.failureCount, 4);
    assert.match(status.lastError ?? "", /429/);
  });

  test("500은 연속 실패로 세어 회로를 연다", async () => {
    const client = createLlmClient();
    scriptFetch([() => new Response("{}", { status: 500 }), () => new Response("{}", { status: 500 })]);
    await client.complete(settings, "fake-key", request, parseLines);
    await client.complete(settings, "fake-key", request, parseLines);
    assert.equal(client.status(settings, "fake-key").circuitOpen, true);
  });
});
