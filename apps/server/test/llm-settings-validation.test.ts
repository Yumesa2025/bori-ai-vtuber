/**
 * PATCH /api/llm 본문 검증 단위 검사. TTS 검증과 같이 모르는 키·잘못된 타입·범위 밖 값을 거부하고,
 * 하나라도 틀리면 patch를 돌려주지 않는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LlmSettings } from "@bori/shared";
import { validateLlmSettingsPatch, type LlmSettingsPatch } from "../src/http/settings.js";

/** 서버 기본값과 같은 전체 설정. 관리자 화면은 한 항목씩 보내지만 전체도 받아야 한다. */
const full: LlmSettings = {
  enabled: false,
  provider: "openai",
  model: "gpt-4o-mini",
  maxReplyLength: 120,
  timeoutMs: 8000,
  failureThreshold: 3,
  cooldownSeconds: 60,
  rollingSummaryEnabled: true,
  rollingSummaryTurns: 10,
  macroEnabled: true,
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
      // 4 미만은 거부하지 않는다. 라우트가 기존처럼 4로 올린다.
      [{ rollingSummaryTurns: 2 }, true],
      [{ rollingSummaryTurns: 0 }, true],
      [{ rollingSummaryTurns: -1 }, false],
      [{ rollingSummaryTurns: 1001 }, false],
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
      { macroEnabled: null },
      { rollingSummaryEnabled: "no" },
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
