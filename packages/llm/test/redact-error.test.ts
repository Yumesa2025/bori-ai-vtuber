/**
 * 어댑터 예외 메시지 가리기 단위 검사(점검 L-4).
 * 개행이 섞인 키를 헤더에 넣으면 fetch가 키 전체를 담은 TypeError를 던진다. 그 메시지가 lastError·로그로 나가기 전에
 * 키를 가리는지 본다. fetch를 가짜로 바꿔 네트워크를 쓰지 않는다. 키 값은 테스트용 가짜 문자열만 쓴다.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { boriEmotionNames } from "@bori/live2d";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createOpenAiAdapter } from "../src/openai.js";
import { redactError, redactSecrets } from "../src/redact.js";
import { defaultTtsSettings, listVoices, synthesizeSpeech } from "../src/tts.js";
import type { LlmRequest } from "../src/types.js";

const KEY = "fake-AUDIT0123456789\nTAILSECRETPART";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 헤더 값 검사에서 실패하는 fetch. 실제 fetch처럼 헤더 값을 메시지에 그대로 담는다. */
function rejectHeaders() {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const value = headers.Authorization ?? headers["x-api-key"] ?? headers["xi-api-key"] ?? "";
    throw new TypeError(`Headers.append: "${value}" is an invalid header value.`);
  }) as typeof fetch;
}

const request: LlmRequest = {
  mode: "companion",
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

const leaks = (message: string) => message.includes("AUDIT0123456789") || message.includes("TAILSECRETPART");

describe("redactError", () => {
  test("개행으로 나뉜 키 조각도 가린다", () => {
    assert.equal(leaks(redactSecrets(`앞 fake-AUDIT0123456789\n다음 줄 TAILSECRETPART`, [KEY])), false);
  });

  test("가릴 것이 없으면 원래 예외를 그대로 돌려준다", () => {
    const error = new TypeError("fetch failed");
    assert.equal(redactError(error, [KEY]), error);
  });

  test("가리면 이름은 그대로 두고 새 예외를 만든다", () => {
    const redacted = redactError(new TypeError(`bad ${KEY}`), [KEY]);
    assert.equal(redacted.name, "TypeError");
    assert.equal(leaks(redacted.message), false);
  });
});

describe("어댑터가 던지는 예외", () => {
  test("OpenAI·Anthropic 답변", async () => {
    rejectHeaders();
    const openai = await messageOf(() => createOpenAiAdapter({ apiKey: KEY, model: "test" }).complete(request));
    const anthropic = await messageOf(() => createAnthropicAdapter({ apiKey: KEY, model: "test" }).complete(request));
    assert.ok(openai.startsWith("Headers.append"), openai);
    assert.equal(leaks(openai), false, openai);
    assert.equal(leaks(anthropic), false, anthropic);
  });

  test("음성 합성과 ElevenLabs 목소리 목록", async () => {
    rejectHeaders();
    const openai = await messageOf(() => synthesizeSpeech({ openAiApiKey: KEY, elevenLabsApiKey: "" }, defaultTtsSettings, "안녕"));
    const eleven = await messageOf(() => synthesizeSpeech({ openAiApiKey: "", elevenLabsApiKey: KEY }, { ...defaultTtsSettings, provider: "elevenlabs", voice: "voice1" }, "안녕"));
    const voices = await messageOf(() => listVoices({ openAiApiKey: "", elevenLabsApiKey: KEY }, "elevenlabs"));
    for (const message of [openai, eleven, voices]) assert.equal(leaks(message), false, message);
  });
});
