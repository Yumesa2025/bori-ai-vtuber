import type { CharacterResponse, LlmProvider, LlmSettings, LlmStatus } from "@bori/shared";
import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAiAdapter } from "./openai.js";
import type { LlmAdapter, LlmAdapterConfig, LlmRequest } from "./types.js";
import { validateLlmOutput } from "./validate.js";

export type { LlmAdapter, LlmAdapterConfig, LlmRequest, LlmValidation } from "./types.js";
export { validateLlmOutput } from "./validate.js";
export { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
export { summarizeBroadcast, summarizeSessionProgress, type BroadcastSummary, type SummaryTurn } from "./summarize.js";
export {
  synthesizeSpeech,
  listVoices,
  defaultTtsSettings,
  defaultTtsModels,
  openAiVoices,
  type TtsProvider,
  type TtsSettings,
  type TtsResult,
  type TtsCredentials,
  type TtsVoiceOption,
} from "./tts.js";

/** 요약처럼 클라이언트를 거치지 않는 작업에서 어댑터를 직접 만들 때 쓴다. */
export function createAdapter(provider: LlmProvider, config: LlmAdapterConfig): LlmAdapter | null {
  const factory = adapterFactories[provider];
  return factory ? factory(config) : null;
}

/**
 * 제공 업체별 어댑터 생성기. 새 업체를 붙이려면 여기에 한 줄만 추가하면 된다.
 * 방송 로직은 어댑터 구현을 알지 못한다.
 */
const adapterFactories: Record<LlmProvider, ((config: LlmAdapterConfig) => LlmAdapter) | null> = {
  openai: createOpenAiAdapter,
  anthropic: createAnthropicAdapter,
  gemini: null,
};

export const supportedProviders = (Object.keys(adapterFactories) as LlmProvider[])
  .filter(provider => adapterFactories[provider] !== null);

export const defaultModels: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  gemini: "",
};

/** 답변 대신 실패 이유를 돌려준다. 보리는 무반응하고 관리자만 이유를 본다. */
export type LlmOutcome =
  | { ok: true; response: CharacterResponse; latencyMs: number }
  | { ok: false; reason: string; kind: "disabled" | "circuit" | "call" | "validation" };

export function createLlmClient() {
  let adapter: LlmAdapter | null = null;
  let adapterKey = "";

  let callCount = 0;
  let failureCount = 0;
  let validationFailureCount = 0;
  let consecutiveFailures = 0;
  let latencyTotal = 0;
  let latencySamples = 0;
  let circuitOpenUntil = 0;
  let lastError: string | null = null;

  /** 설정이 바뀌면 어댑터를 다시 만든다. 키는 여기에만 머문다. */
  function ensureAdapter(settings: LlmSettings, apiKey: string): LlmAdapter | null {
    const factory = adapterFactories[settings.provider];
    if (!factory || apiKey.trim().length === 0) return null;

    const key = `${settings.provider}|${settings.model}|${apiKey}`;
    if (adapter && adapterKey === key) return adapter;

    adapter = factory({ apiKey, model: settings.model });
    adapterKey = key;
    return adapter;
  }

  function recordFailure(settings: LlmSettings, reason: string, validation: boolean) {
    lastError = reason;
    if (validation) validationFailureCount += 1; else failureCount += 1;
    consecutiveFailures += 1;
    if (consecutiveFailures >= settings.failureThreshold) {
      circuitOpenUntil = Date.now() + settings.cooldownSeconds * 1000;
    }
  }

  return {
    isCircuitOpen: () => Date.now() < circuitOpenUntil,

    status(settings: LlmSettings, apiKey: string): LlmStatus {
      return {
        enabled: settings.enabled,
        provider: settings.provider,
        model: settings.model,
        hasApiKey: apiKey.trim().length > 0,
        circuitOpen: Date.now() < circuitOpenUntil,
        callCount,
        failureCount,
        validationFailureCount,
        consecutiveFailures,
        averageLatencyMs: latencySamples === 0 ? 0 : Math.round(latencyTotal / latencySamples),
        lastError,
      };
    },

    reset() {
      callCount = 0;
      failureCount = 0;
      validationFailureCount = 0;
      consecutiveFailures = 0;
      latencyTotal = 0;
      latencySamples = 0;
      circuitOpenUntil = 0;
      lastError = null;
    },

    async respond(settings: LlmSettings, apiKey: string, request: LlmRequest): Promise<LlmOutcome> {
      if (!settings.enabled) return { ok: false, reason: "LLM이 꺼져 있습니다.", kind: "disabled" };

      const active = ensureAdapter(settings, apiKey);
      if (!active) return { ok: false, reason: "API 키가 없거나 지원하지 않는 업체입니다.", kind: "disabled" };

      // 연속 실패가 쌓이면 잠시 호출을 멈춘다. 방송이 매번 지연되는 것을 막는다.
      if (Date.now() < circuitOpenUntil) {
        return { ok: false, reason: "연속 실패로 LLM 호출을 잠시 멈췄습니다.", kind: "circuit" };
      }

      callCount += 1;
      let raw: string;
      let latencyMs: number;
      try {
        const result = await active.complete(request);
        raw = result.raw;
        latencyMs = result.latencyMs;
        latencyTotal += latencyMs;
        latencySamples += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordFailure(settings, reason, false);
        return { ok: false, reason, kind: "call" };
      }

      const validated = validateLlmOutput(raw, request);
      if (!validated.ok) {
        recordFailure(settings, validated.reason, true);
        return { ok: false, reason: validated.reason, kind: "validation" };
      }

      consecutiveFailures = 0;
      lastError = null;
      return { ok: true, response: validated.response, latencyMs };
    },
  };
}
