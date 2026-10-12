/**
 * 서버 단위 검사가 같이 쓰는 가짜 의존성. 네트워크를 쓰지 않는다.
 * 파일 이름이 *.test.ts가 아니라 검사로 직접 돌지 않는다.
 */
import type { LlmOutcome, LlmRequest } from "@bori/llm";
import type { MemoryAccess, MemorySearchHit, MemorySettings } from "@bori/memory";
import type { LlmSettings } from "@bori/shared";
import type { ConversationEngineDeps } from "../src/conversation/index.js";

export type FakeEngineHarness = {
  deps: ConversationEngineDeps;
  llmSettings: LlmSettings;
  apiKey: string;
  circuitOpen: boolean;
  /** 모드별로 받은 LLM 요청. */
  llmRequests: { mode: string; request: LlmRequest }[];
  searches: MemoryAccess[];
  /** 검색 결과로 돌려줄 기억 문장. */
  memoryTexts: string[];
  /** 다음 LLM 호출 결과. 비워 두면 성공한다. */
  nextOutcome: LlmOutcome | null;
};

export const testMemorySettings: MemorySettings = { enabled: true, maxMemories: 5, minSimilarity: 0.3, retentionDays: 30, embeddingModel: "test", privateDigestEveryMessages: 6 };

export function createFakeEngineHarness(): FakeEngineHarness {
  const harness: FakeEngineHarness = {
    llmSettings: {
      enabled: true,
      provider: "openai",
      model: "test-model",
      maxReplyLength: 120,
      timeoutMs: 8000,
      failureThreshold: 3,
      cooldownSeconds: 60,
      // 누적 요약은 이 검사들의 관심사가 아니다. 가짜 어댑터 없이 돌도록 끈다.
      rollingSummaryEnabled: false,
      rollingSummaryTurns: 4,
      macroEnabled: true,
    },
    apiKey: "fake-key",
    circuitOpen: false,
    llmRequests: [],
    searches: [],
    memoryTexts: [],
    nextOutcome: null,
    deps: undefined as unknown as ConversationEngineDeps,
  };

  harness.deps = {
    llmFor: mode => ({
      isCircuitOpen: () => harness.circuitOpen,
      respond: async (_settings, _apiKey, request) => {
        harness.llmRequests.push({ mode, request });
        const outcome = harness.nextOutcome;
        harness.nextOutcome = null;
        return outcome ?? { ok: true, response: { reply: "LLM 답변", emotion: { primary: "calm", intensity: 0.4, durationSeconds: 6 }, actions: [], source: "llm" }, latencyMs: 1 };
      },
    }),
    llmSettings: () => harness.llmSettings,
    apiKey: () => harness.apiKey,
    memoryStore: {
      search: async (_query, _settings, _embedding, access): Promise<MemorySearchHit[]> => {
        harness.searches.push(access);
        return harness.memoryTexts.map((text, index) => ({
          record: { id: `m${index}`, text, kind: "viewer", scope: "private", importance: 0.5, confidence: 0.5, repeatCount: 1, createdAt: "", expiresAt: "" },
          score: 1,
        }));
      },
    },
    memorySettings: () => testMemorySettings,
    embedding: () => null,
    macros: () => [],
    replyCooldownMinutes: () => 0,
  };
  return harness;
}
