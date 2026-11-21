/**
 * PATCH /api/llm 본문 검증 단위 검사. TTS 검증과 같이 모르는 키·잘못된 타입·범위 밖 값을 거부하고,
 * 하나라도 틀리면 patch를 돌려주지 않는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LlmSettings } from "@bori/shared";
import { LEGACY_LLM_SETTING_KEYS, validateLlmSettingsPatch, withoutLegacyLlmKeys, type LlmSettingsPatch } from "../src/http/settings.js";

/** 서버 기본값과 같은 전체 설정. 관리자 화면은 한 항목씩 보내지만 전체도 받아야 한다. */
const full: LlmSettings = {
  enabled: false,
  provider: "openai",
  model: "gpt-4o-mini",
  maxReplyLength: 120,
  timeoutMs: 8000,
  failureThreshold: 3,
  cooldownSeconds: 60,
};

describe("외부 LLM 설정", () => {
  test("전체 설정과 빈 객체를 받는다", () => {
    const result = validateLlmSettingsPatch({ ...full });
    assert.ok(result.ok);
    assert.deepEqual(result.patch, full);
    assert.deepEqual(validateLlmSettingsPatch({}), { ok: true, patch: {} });
  });

  test("경계값", () => {
    const cases: [LlmSettingsPatch, boolean][] = [
      [{ provider: "openai" }, true],
      [{ provider: "anthropic" }, true],
      // 어댑터가 없는 업체는 받지 않는다.
      [{ provider: "gemini" }, false],
      [{ model: "claude-sonnet-5" }, true],
      [{ model: "" }, false],
      [{ model: "a".repeat(100) }, true],
      [{ model: "a".repeat(101) }, false],
      [{ model: "gpt 4o" }, false],
      [{ maxReplyLength: 20 }, true],
      [{ maxReplyLength: 19 }, false],
      [{ maxReplyLength: 1000 }, true],
      [{ maxReplyLength: 1001 }, false],
      [{ maxReplyLength: 120.5 }, false],
      [{ timeoutMs: 1000 }, true],
      [{ timeoutMs: 999 }, false],
      [{ timeoutMs: 120_000 }, true],
      [{ timeoutMs: 120_001 }, false],
      [{ failureThreshold: 1 }, true],
      [{ failureThreshold: 0 }, false],
      [{ failureThreshold: 101 }, false],
      [{ cooldownSeconds: 0 }, true],
      [{ cooldownSeconds: 3600 }, true],
      [{ cooldownSeconds: -1 }, false],
      [{ apiKey: "" }, true],
      [{ apiKey: "k".repeat(512) }, true],
      [{ apiKey: "k".repeat(513) }, false],
    ];
    for (const [patch, expected] of cases) {
      assert.equal(validateLlmSettingsPatch(patch).ok, expected, JSON.stringify(patch).slice(0, 80));
    }
  });

  test("모르는 키와 잘못된 타입을 거부한다", () => {
    const cases: unknown[] = [
      { unknownKey: 1 },
      { enabled: "true" },
      { enabled: 1 },
      { timeoutMs: "8000" },
      { timeoutMs: Number.NaN },
      // 1:1 대화를 쓰던 때의 칸(누적 요약·매크로)은 2026-11-21 지웠다. PATCH로는 받지 않는다.
      { macroEnabled: true },
      { rollingSummaryEnabled: false },
      { rollingSummaryTurns: 10 },
      { provider: 1 },
      { apiKey: 1234 },
      { apiKey: null },
      null,
      [],
      "settings",
    ];
    for (const input of cases) {
      const result = validateLlmSettingsPatch(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      if (!result.ok) assert.ok(result.error.length > 0);
    }
  });

  test("하나라도 틀리면 옳은 값도 patch로 돌려주지 않는다", () => {
    const result = validateLlmSettingsPatch({ model: "gpt-4o", apiKey: "new-key", timeoutMs: -5 });
    assert.equal(result.ok, false);
    assert.equal("patch" in result, false);
    if (!result.ok) assert.match(result.error, /timeoutMs/);
  });

  test("오류 문장에 키 값이 들어가지 않는다", () => {
    const secret = "sk-test-secret-value";
    const result = validateLlmSettingsPatch({ apiKey: secret, unknownKey: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(!result.error.includes(secret));
  });
});

describe("예전 LLM 설정 파일의 지운 칸", () => {
  test("누적 요약·매크로 칸 세 개를 지운 칸으로 안다", () => {
    assert.deepEqual([...LEGACY_LLM_SETTING_KEYS].sort(), ["macroEnabled", "rollingSummaryEnabled", "rollingSummaryTurns"]);
  });

  test("읽은 설정에서 지운 칸만 조용히 빼고 나머지는 그대로 둔다", () => {
    const saved = { enabled: true, model: "gpt-4o-mini", rollingSummaryEnabled: true, rollingSummaryTurns: 4, macroEnabled: false, unknownKey: 1 };
    assert.deepEqual(withoutLegacyLlmKeys(saved), { enabled: true, model: "gpt-4o-mini", unknownKey: 1 });
    // 원본 객체는 바꾸지 않는다.
    assert.equal(saved.rollingSummaryTurns, 4);
  });
});
