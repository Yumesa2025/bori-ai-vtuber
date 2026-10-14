/**
 * 임베딩 예외 메시지 가리기 단위 검사(점검 L-4).
 * 개행이 섞인 키로 fetch가 헤더 오류를 던지거나 업체가 키를 담은 오류 본문을 돌려줘도, 메시지에 키가 남지 않는지 본다.
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다. 키 값은 테스트용 가짜 문자열만 쓴다.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAiEmbedding } from "../src/embedding.js";

const KEY = "fake-AUDIT0123456789\nTAILSECRETPART";
const realFetch = globalThis.fetch;
const leaks = (message: string) => message.includes("AUDIT0123456789") || message.includes("TAILSECRETPART");

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("실패해야 하는데 성공했습니다.");
}

test("헤더 오류 메시지에 담긴 키를 가린다", async () => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    throw new TypeError(`Headers.append: "${(init?.headers as Record<string, string>).Authorization}" is an invalid header value.`);
  }) as typeof fetch;
  const message = await messageOf(() => createOpenAiEmbedding({ apiKey: KEY, model: "test" }).embed(["문장"]));
  assert.ok(message.startsWith("Headers.append"), message);
  assert.equal(leaks(message), false, message);
});

test("업체 오류 본문에 섞인 키를 가린다", async () => {
  globalThis.fetch = (async () => new Response(`Incorrect API key provided: ${KEY}`, { status: 401 })) as typeof fetch;
  const message = await messageOf(() => createOpenAiEmbedding({ apiKey: KEY, model: "test" }).embed(["문장"]));
  assert.ok(message.startsWith("임베딩 401:"), message);
  assert.equal(leaks(message), false, message);
});
