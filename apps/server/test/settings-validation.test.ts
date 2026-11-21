/**
 * 설정 PATCH 검증 단위 검사. 경계값 안쪽은 받고 바깥쪽은 거부하는지, 모르는 키와 잘못된 타입을 거부하는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaultTtsSettings, type TtsSettings } from "@bori/llm";
import { isValidVoice, validateTtsSettingsPatch } from "../src/http/settings.js";

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
