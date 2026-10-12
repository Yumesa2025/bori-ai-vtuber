/**
 * 모드별 LLM 클라이언트 단위 검사.
 * 실제 createLlmClient를 쓰고 fetch만 가짜로 바꾼다. 1:1이 연달아 실패해도 방송 회로가 열리지 않아야 한다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { boriEmotionNames } from "@bori/live2d";
import { createLlmClient, type LlmRequest } from "@bori/llm";
import type { LlmSettings } from "@bori/shared";
import { createModeLlmClients } from "../src/conversation/index.js";

const settings: LlmSettings = {
  enabled: true,
  provider: "openai",
  model: "test-model",
  maxReplyLength: 120,
  timeoutMs: 1000,
  failureThreshold: 3,
  cooldownSeconds: 60,
  rollingSummaryEnabled: false,
  rollingSummaryTurns: 4,
  macroEnabled: false,
};

const request = (mode: LlmRequest["mode"]): LlmRequest => ({
  mode,
  content: "안녕하세요",
  recentTurns: [],
  memories: [],
  sessionSummary: "",
  macroPrompts: [],
  broadcastStatus: [],
  allowedEmotions: boriEmotionNames,
  allowedMotions: [],
  maxReplyLength: 120,
  timeoutMs: 1000,
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // 모든 호출이 서버 오류로 실패한다.
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "테스트 실패" } }), { status: 500 })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("모드별 LLM 클라이언트", () => {
  test("모드마다 다른 인스턴스를 돌려주고, 같은 모드는 같은 인스턴스다", () => {
    const clients = createModeLlmClients(createLlmClient);
    assert.notEqual(clients.llmFor("broadcast"), clients.llmFor("companion"));
    assert.equal(clients.llmFor("companion"), clients.llmFor("companion"));
    assert.throws(() => clients.llmFor("unknown" as never));
  });

  test("1:1이 연달아 실패해 회로가 열려도 방송 회로와 통계는 그대로다", async () => {
    const clients = createModeLlmClients(createLlmClient);
    const companion = clients.llmFor("companion");
    const broadcast = clients.llmFor("broadcast");

    for (let i = 0; i < settings.failureThreshold; i += 1) {
      const outcome = await companion.respond(settings, "fake-key", request("companion"));
      assert.equal(outcome.ok, false);
    }

    assert.equal(companion.isCircuitOpen(), true);
    assert.equal(broadcast.isCircuitOpen(), false);
    assert.equal(companion.status(settings, "fake-key").failureCount, settings.failureThreshold);
    assert.equal(broadcast.status(settings, "fake-key").callCount, 0);
    assert.equal(broadcast.status(settings, "fake-key").failureCount, 0);
  });

  test("resetAll은 모든 모드의 회로와 통계를 초기화한다", async () => {
    const clients = createModeLlmClients(createLlmClient);
    for (const mode of ["broadcast", "companion"] as const) {
      for (let i = 0; i < settings.failureThreshold; i += 1) await clients.llmFor(mode).respond(settings, "fake-key", request(mode));
      assert.equal(clients.llmFor(mode).isCircuitOpen(), true);
    }

    clients.resetAll();
    for (const mode of ["broadcast", "companion"] as const) {
      assert.equal(clients.llmFor(mode).isCircuitOpen(), false);
      assert.equal(clients.llmFor(mode).status(settings, "fake-key").failureCount, 0);
    }
  });
});
