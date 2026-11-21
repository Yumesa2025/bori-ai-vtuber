/**
 * LLM 클라이언트(createLlmClient().complete) 단위 검사.
 * 켜짐·키·회로 차단·호출 기록·parse 규약을 가짜 어댑터로 본다. 네트워크를 쓰지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LlmSettings } from "@bori/shared";
import { createLlmClient, RateLimitError, type LlmAdapter, type LlmCallReport, type LlmParse, type LlmRequest } from "../src/index.js";

const settings: LlmSettings = { enabled: true, provider: "openai", model: "gpt-4o-mini", maxReplyLength: 120, timeoutMs: 1000, failureThreshold: 2, cooldownSeconds: 60 };
const request: LlmRequest = { overrideSystemPrompt: "시스템", overrideUserPrompt: "사용자", overrideSchema: { type: "object" }, timeoutMs: 1000 };

const parseLines: LlmParse<string[]> = raw => {
  const value = JSON.parse(raw) as { lines?: unknown };
  return Array.isArray(value.lines) ? { ok: true, value: value.lines as string[] } : { ok: false, reason: "lines가 없습니다." };
};

/** 차례로 응답하는 가짜 어댑터. 문자열은 원문, Error는 던진다. */
function fakeAdapter(answers: Array<string | Error>) {
  const requests: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    name: "fake",
    isConfigured: () => true,
    async complete(input) {
      requests.push(input);
      const next = answers.shift() ?? new Error("응답이 더 없습니다.");
      if (next instanceof Error) throw next;
      return { raw: next, latencyMs: 7, usage: { inputTokens: 10, outputTokens: 3 } };
    },
  };
  return { adapter, requests };
}

function clientWith(answers: Array<string | Error>) {
  const fake = fakeAdapter(answers);
  const reports: LlmCallReport[] = [];
  const client = createLlmClient({ onCall: report => reports.push(report), adapterFactory: () => fake.adapter });
  return { client, reports, requests: fake.requests };
}

describe("createLlmClient().complete", () => {
  test("꺼져 있으면 부르지 않고 disabled", async () => {
    const { client, requests } = clientWith(['{"lines":[]}']);
    const outcome = await client.complete({ ...settings, enabled: false }, "key", request, parseLines);
    assert.deepEqual(outcome, { ok: false, reason: "LLM이 꺼져 있습니다.", kind: "disabled" });
    assert.equal(requests.length, 0);
  });

  test("키가 없으면 부르지 않고 disabled", async () => {
    const { client, requests } = clientWith(['{"lines":[]}']);
    const outcome = await client.complete(settings, "  ", request, parseLines);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.kind, "disabled");
    assert.equal(requests.length, 0);
  });

  test("parse가 통과하면 값과 지연을 돌려주고, 요청을 그대로 넘기며, 호출을 narration으로 기록한다", async () => {
    const { client, reports, requests } = clientWith(['{"lines":["첫 줄"]}']);
    const outcome = await client.complete(settings, "key", request, parseLines);
    assert.deepEqual(outcome, { ok: true, value: ["첫 줄"], latencyMs: 7 });
    assert.deepEqual(requests, [request]);
    assert.deepEqual(reports, [{ mode: "narration", model: "gpt-4o-mini", ok: true, usage: { inputTokens: 10, outputTokens: 3 } }]);
    assert.equal(client.status(settings, "key").callCount, 1);
  });

  test("parse 실패는 validation이고, 연속 실패가 차면 회로가 열려 부르지 않는다", async () => {
    const { client, requests } = clientWith(['{"nope":1}', '{"nope":2}', '{"lines":[]}']);
    const first = await client.complete(settings, "key", request, parseLines);
    assert.deepEqual(first, { ok: false, reason: "lines가 없습니다.", kind: "validation" });
    await client.complete(settings, "key", request, parseLines);
    assert.equal(client.isCircuitOpen(), true);
    const third = await client.complete(settings, "key", request, parseLines);
    assert.equal(!third.ok && third.kind, "circuit");
    assert.equal(requests.length, 2);
    assert.equal(client.status(settings, "key").validationFailureCount, 2);
  });

  test("parse가 예외를 던져도 validation 실패로 센다", async () => {
    const { client } = clientWith(["JSON 아님"]);
    const outcome = await client.complete(settings, "key", request, parseLines);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.kind, "validation");
    assert.equal(client.status(settings, "key").validationFailureCount, 1);
  });

  test("어댑터 예외는 call 실패로 기록하고, 429는 회로를 열 연속 실패로 세지 않는다", async () => {
    const { client, reports } = clientWith([new RateLimitError("429"), new RateLimitError("429"), new Error("업체 오류")]);
    await client.complete(settings, "key", request, parseLines);
    await client.complete(settings, "key", request, parseLines);
    assert.equal(client.isCircuitOpen(), false);
    const third = await client.complete(settings, "key", request, parseLines);
    assert.deepEqual(third, { ok: false, reason: "업체 오류", kind: "call" });
    assert.deepEqual(reports.map(report => report.ok), [false, false, false]);
    assert.equal(client.status(settings, "key").failureCount, 3);
    assert.equal(client.status(settings, "key").consecutiveFailures, 1);
  });

  test("성공하면 연속 실패와 마지막 오류를 지운다", async () => {
    const { client } = clientWith([new Error("업체 오류"), '{"lines":[]}']);
    await client.complete(settings, "key", request, parseLines);
    assert.equal(client.status(settings, "key").lastError, "업체 오류");
    await client.complete(settings, "key", request, parseLines);
    assert.equal(client.status(settings, "key").consecutiveFailures, 0);
    assert.equal(client.status(settings, "key").lastError, null);
  });

  test("reset은 통계와 회로를 처음으로 돌린다", async () => {
    const { client } = clientWith(['{"x":1}', '{"x":1}']);
    await client.complete(settings, "key", request, parseLines);
    await client.complete(settings, "key", request, parseLines);
    client.reset();
    assert.equal(client.isCircuitOpen(), false);
    assert.equal(client.status(settings, "key").callCount, 0);
  });

  test("기록 함수가 던져도 결과는 그대로다", async () => {
    const fake = fakeAdapter(['{"lines":["a"]}']);
    const client = createLlmClient({ onCall: () => { throw new Error("기록 실패"); }, adapterFactory: () => fake.adapter });
    const originalError = console.error;
    console.error = () => {};
    try {
      const outcome = await client.complete(settings, "key", request, parseLines);
      assert.deepEqual(outcome, { ok: true, value: ["a"], latencyMs: 7 });
    } finally {
      console.error = originalError;
    }
  });
});
