/**
 * 설정 PATCH 검증 단위 검사. 경계값 안쪽은 받고 바깥쪽은 거부하는지, 모르는 키와 잘못된 타입을 거부하는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { QueueSettings } from "@bori/shared";
import { defaultTtsSettings, type TtsSettings } from "@bori/llm";
import { isValidVoice, validateMemorySettingsPatch, validateQueueSettingsPatch, validateTtsSettingsPatch } from "../src/http/settings.js";

const queue: QueueSettings = {
  responseDelayMinSeconds: 5,
  responseDelayMaxSeconds: 10,
  maxQueueSize: 100,
  visibleChatLimit: 8,
  duplicateWindowMinutes: 5,
  sameReplyCooldownMinutes: 5,
  monologueEnabled: true,
  monologueMinSeconds: 30,
  monologueMaxSeconds: 60,
};

describe("채팅 큐 설정", () => {
  test("관리자 화면이 보내는 전체 설정을 받는다", () => {
    const result = validateQueueSettingsPatch({ ...queue }, queue);
    assert.ok(result.ok);
    assert.deepEqual(result.patch, queue);
  });

  test("경계값", () => {
    const cases: [Partial<QueueSettings>, boolean][] = [
      [{ responseDelayMinSeconds: 0 }, true],
      [{ responseDelayMinSeconds: -1 }, false],
      [{ responseDelayMaxSeconds: 120 }, true],
      [{ responseDelayMaxSeconds: 121 }, false],
      [{ maxQueueSize: 1 }, true],
      [{ maxQueueSize: 0 }, false],
      [{ maxQueueSize: 1000 }, true],
      [{ maxQueueSize: 1001 }, false],
      [{ maxQueueSize: 10.5 }, false],
      [{ visibleChatLimit: 50 }, true],
      [{ visibleChatLimit: 51 }, false],
      [{ duplicateWindowMinutes: 0 }, true],
      [{ duplicateWindowMinutes: 1441 }, false],
      [{ sameReplyCooldownMinutes: 1440 }, true],
      [{ sameReplyCooldownMinutes: -0.5 }, false],
      [{ monologueMinSeconds: 1, monologueMaxSeconds: 1 }, true],
      [{ monologueMinSeconds: 0.5 }, false],
      [{ monologueMaxSeconds: 3601 }, false],
    ];
    for (const [patch, expected] of cases) {
      assert.equal(validateQueueSettingsPatch(patch, queue).ok, expected, JSON.stringify(patch));
    }
  });

  test("최솟값이 최댓값보다 크면 현재 값과 합쳐서 거부한다", () => {
    assert.equal(validateQueueSettingsPatch({ responseDelayMinSeconds: 11 }, queue).ok, false);
    assert.equal(validateQueueSettingsPatch({ responseDelayMinSeconds: 11, responseDelayMaxSeconds: 12 }, queue).ok, true);
    assert.equal(validateQueueSettingsPatch({ monologueMaxSeconds: 20 }, queue).ok, false);
  });

  test("모르는 키, 잘못된 타입, 객체가 아닌 본문은 거부한다", () => {
    const cases: unknown[] = [
      { maxQueueSize: "100" },
      { monologueEnabled: "true" },
      { monologueEnabled: 1 },
      { maxQueueSize: null },
      { unknownKey: 1 },
      JSON.parse('{"__proto__":{"maxQueueSize":1}}'),
      [],
      null,
      "settings",
      42,
    ];
    for (const input of cases) {
      const result = validateQueueSettingsPatch(input, queue);
      assert.equal(result.ok, false, JSON.stringify(input));
      if (!result.ok) assert.ok(result.error.length > 0);
    }
  });

  test("받은 키만 patch에 담는다", () => {
    const result = validateQueueSettingsPatch({ maxQueueSize: 5 }, queue);
    assert.ok(result.ok);
    assert.deepEqual(result.patch, { maxQueueSize: 5 });
  });
});

describe("기억 설정", () => {
  test("경계값", () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ enabled: false }, true],
      [{ enabled: "no" }, false],
      [{ maxMemories: 1 }, true],
      [{ maxMemories: 20 }, true],
      [{ maxMemories: 0 }, false],
      [{ maxMemories: 21 }, false],
      [{ maxMemories: 2.5 }, false],
      [{ minSimilarity: 0 }, true],
      [{ minSimilarity: 1 }, true],
      [{ minSimilarity: 1.01 }, false],
      [{ minSimilarity: -0.1 }, false],
      [{ retentionDays: 1 }, true],
      [{ retentionDays: 3650 }, true],
      [{ retentionDays: 0 }, false],
      [{ retentionDays: 3651 }, false],
      [{ embeddingModel: "text-embedding-3-small" }, true],
      [{ embeddingModel: "" }, false],
      [{ embeddingModel: "../../etc/passwd" }, false],
      [{ privateDigestEveryMessages: 0 }, true],
      [{ privateDigestEveryMessages: 6 }, true],
      [{ privateDigestEveryMessages: 50 }, true],
      [{ privateDigestEveryMessages: 51 }, false],
      [{ privateDigestEveryMessages: -1 }, false],
      [{ privateDigestEveryMessages: 2.5 }, false],
      [{ privateDigestEveryMessages: "6" }, false],
      [{ apiKey: "x" }, false],
    ];
    for (const [patch, expected] of cases) {
      assert.equal(validateMemorySettingsPatch(patch).ok, expected, JSON.stringify(patch));
    }
  });
});

describe("음성 설정", () => {
  const current: TtsSettings = { ...defaultTtsSettings };
  const elevenLabs: TtsSettings = { ...defaultTtsSettings, provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM" };

  test("업체별 목소리 허용 목록", () => {
    assert.ok(isValidVoice("openai", "nova"));
    assert.ok(!isValidVoice("openai", "21m00Tcm4TlvDq8ikWAM"));
    assert.ok(isValidVoice("elevenlabs", "21m00Tcm4TlvDq8ikWAM"));
    assert.ok(!isValidVoice("elevenlabs", "../voices"));
    assert.ok(!isValidVoice("elevenlabs", "a".repeat(65)));
    assert.ok(isValidVoice("fish", "0123456789abcdef0123456789abcdef"));
    assert.ok(!isValidVoice("fish", "nova"));
    assert.ok(!isValidVoice("fish", "../model"));
  });

  test("목소리는 바뀐 뒤의 업체 기준으로 본다", () => {
    assert.equal(validateTtsSettingsPatch({ voice: "shimmer" }, current).ok, true);
    assert.equal(validateTtsSettingsPatch({ voice: "21m00Tcm4TlvDq8ikWAM" }, current).ok, false);
    assert.equal(validateTtsSettingsPatch({ provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM" }, current).ok, true);
    assert.equal(validateTtsSettingsPatch({ voice: "nova" }, elevenLabs).ok, true);
    assert.equal(validateTtsSettingsPatch({ provider: "openai", voice: "21m00Tcm4TlvDq8ikWAM" }, elevenLabs).ok, false);
  });

  test("업체만 바꾸는 요청은 목소리를 보지 않는다", () => {
    assert.equal(validateTtsSettingsPatch({ provider: "openai" }, elevenLabs).ok, true);
  });

  test("경계값", () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ provider: "azure" }, false],
      [{ speed: 0.25 }, true],
      [{ speed: 4 }, true],
      [{ speed: 0.2 }, false],
      [{ speed: 4.1 }, false],
      [{ stability: 0 }, true],
      [{ stability: 1.5 }, false],
      [{ similarity: 1 }, true],
      [{ similarity: -1 }, false],
      [{ timeoutMs: 1000 }, true],
      [{ timeoutMs: 60000 }, true],
      [{ timeoutMs: 999 }, false],
      [{ timeoutMs: 60001 }, false],
      [{ model: "gpt-4o-mini-tts" }, true],
      [{ model: "" }, false],
      [{ model: "tts 1" }, false],
      [{ enabled: true }, true],
      [{ enabled: "yes" }, false],
      [{ elevenLabsApiKey: "" }, true],
      [{ elevenLabsApiKey: "sk_abc" }, true],
      [{ elevenLabsApiKey: "x".repeat(513) }, false],
      [{ elevenLabsApiKey: 123 }, false],
      [{ apiKey: "x" }, false],
    ];
    for (const [patch, expected] of cases) {
      assert.equal(validateTtsSettingsPatch(patch, current).ok, expected, JSON.stringify(patch));
    }
  });
});
