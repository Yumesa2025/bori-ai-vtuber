/**
 * 외부 API 오류 본문 가리기 단위 검사.
 * 업체 오류 본문이 오류 메시지(로그·관리자 API의 lastError)로 나가기 전에 키 모양 문자열을 가리는지 본다.
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다. 키 값은 테스트용 가짜 문자열만 쓴다.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { boriEmotionNames } from "@bori/live2d";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createOpenAiAdapter } from "../src/openai.js";
import { redactSecrets } from "../src/redact.js";
import { defaultTtsSettings, synthesizeSpeech } from "../src/tts.js";
import type { LlmRequest } from "../src/types.js";

const KEY = "sk-proj-FAKEfakeFAKEfake0123456789abcdefABCDEF";
const ELEVEN_KEY = "0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 다음 fetch가 이 상태와 본문으로 실패하게 한다. */
function failNextFetch(status: number, body: string) {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

const request: LlmRequest = {
  mode: "broadcast",
  content: "안녕",
  recentTurns: [],
  memories: [],
  sessionSummary: "",
  macroPrompts: [],
  broadcastStatus: [],
  allowedEmotions: boriEmotionNames,
  allowedMotions: [],
  maxReplyLength: 120,
  timeoutMs: 1000,
};

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("실패해야 하는데 성공했습니다.");
}

describe("redactSecrets", () => {
  test("sk- 키, 가려진 키 표기, Bearer 토큰, 긴 토큰을 가린다", () => {
    const text = [
      `Incorrect API key provided: ${KEY}.`,
      "Incorrect API key provided: sk-proj-****************************abcd.",
      "Authorization: Bearer abc.def-ghi_123",
      `xi-api-key ${ELEVEN_KEY} is invalid`,
      "sk-ant-api03-FAKEfakeFAKE-fake_0123456789",
    ].join("\n");
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes(KEY));
    assert.ok(!redacted.includes("abcd."), "가려진 키의 끝 네 글자도 남기지 않는다");
    assert.ok(!redacted.includes("abc.def-ghi_123"));
    assert.ok(!redacted.includes(ELEVEN_KEY));
    assert.ok(!redacted.includes("FAKEfakeFAKE"));
    assert.ok(redacted.includes("Incorrect API key provided: [가림]"), redacted);
    assert.ok(redacted.includes("Bearer [가림]"), redacted);
  });

  test("넘겨받은 키는 모양과 상관없이 그대로 가린다", () => {
    assert.equal(redactSecrets("key short-key-1 is bad", ["short-key-1"]), "key [가림] is bad");
    // 빈 키나 공백 키는 무시한다. 빈 문자열로 바꾸면 모든 글자 사이에 표시가 들어간다.
    assert.equal(redactSecrets("평범한 오류", ["", "  "]), "평범한 오류");
  });

  test("평범한 오류 문장은 그대로 둔다", () => {
    const text = '{"error":{"message":"Rate limit reached for gpt-4o-mini","type":"requests","code":"rate_limit_exceeded"}}';
    assert.equal(redactSecrets(text), text);
  });
});

describe("어댑터 오류 메시지", () => {
  test("OpenAI 실패 본문에 섞인 키를 가린다", async () => {
    failNextFetch(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.` } }));
    const message = await messageOf(() => createOpenAiAdapter({ apiKey: KEY, model: "test" }).complete(request));
    assert.ok(message.startsWith("OpenAI 401:"), message);
    assert.ok(!message.includes(KEY), message);
  });

  test("Anthropic 실패 본문에 섞인 키를 가린다", async () => {
    const key = "sk-ant-api03-FAKEfakeFAKEfake-0123456789";
    failNextFetch(401, JSON.stringify({ error: { type: "authentication_error", message: `invalid x-api-key ${key}` } }));
    const message = await messageOf(() => createAnthropicAdapter({ apiKey: key, model: "test" }).complete(request));
    assert.ok(message.startsWith("Anthropic 401:"), message);
    assert.ok(!message.includes(key), message);
  });

  test("OpenAI·ElevenLabs 음성 합성 실패 본문에 섞인 키를 가린다", async () => {
    failNextFetch(401, `Incorrect API key provided: ${KEY}`);
    const openai = await messageOf(() => synthesizeSpeech({ openAiApiKey: KEY, elevenLabsApiKey: "" }, defaultTtsSettings, "안녕"));
    assert.ok(openai.startsWith("OpenAI TTS 401:") && !openai.includes(KEY), openai);

    failNextFetch(401, JSON.stringify({ detail: { status: "invalid_api_key", message: `Invalid API key: ${ELEVEN_KEY}` } }));
    const eleven = await messageOf(() => synthesizeSpeech({ openAiApiKey: "", elevenLabsApiKey: ELEVEN_KEY }, { ...defaultTtsSettings, provider: "elevenlabs", voice: "voice-1" }, "안녕"));
    assert.ok(eleven.startsWith("ElevenLabs 401:") && !eleven.includes(ELEVEN_KEY), eleven);
  });

  test("본문을 자르기 전에 가려서, 잘린 키 조각이 남지 않는다", async () => {
    // 200자 경계에 키가 걸치면 자른 뒤에는 "sk-proj"만 남아 키 모양 규칙에 걸리지 않는다.
    failNextFetch(400, `${"가".repeat(192)} ${KEY}`);
    const message = await messageOf(() => createOpenAiAdapter({ apiKey: "other-key", model: "test" }).complete(request));
    assert.ok(!message.includes("sk-proj"), message);
  });
});
