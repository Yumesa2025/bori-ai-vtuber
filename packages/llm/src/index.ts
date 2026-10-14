import type { ConversationMode } from "@bori/character";
import type { CharacterResponse, LlmProvider, LlmSettings, LlmStatus } from "@bori/shared";
import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAiAdapter } from "./openai.js";
import type { LlmAdapter, LlmAdapterConfig, LlmRequest, LlmTokenUsage } from "./types.js";
import { isRateLimitError } from "./retry.js";
import { validateLlmOutput } from "./validate.js";

export type { LlmAdapter, LlmAdapterConfig, LlmRawResult, LlmRequest, LlmTokenUsage, LlmValidation } from "./types.js";
export { DEFAULT_EMOTION, replyLengthOf, stripDecorations, validateLlmOutput } from "./validate.js";
export { isRateLimitError, RateLimitError, retryAfterMsOf, sendWithRateLimitRetry } from "./retry.js";
export { buildPromptLayers, buildSystemPrompt, buildUserPrompt, currentDateLine, koreanDateLabel, koreanDateParts, maxOutputTokensFor, neutralizeUserText, promptLayerOrder, quoteUserText, responseJsonSchemaFor, type PromptLayer, type PromptLayerId } from "./prompt.js";
export type { ConversationMode } from "@bori/character";
export { digestPrivateMemories, isBroadcastMemoryText, limitSummaryTurns, PRIVATE_MEMORY_DIGEST_LIMIT, summarizeBroadcast, summarizeSessionProgress, type BroadcastSummary, type DigestedMemory, type DigestExisting, type SummaryTurn } from "./summarize.js";
export {
  synthesizeSpeech,
  listVoices,
  createVoiceListCache,
  mp3DurationMs,
  AUDIO_MAX_BYTES,
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

/**
 * 업체 API를 실제로 부른 한 번의 결과. 사용량 집계에 쓰며 대화 내용은 담지 않는다.
 * ok는 업체 호출 자체의 성공 여부다. 응답 형식 검증 실패는 이미 과금된 호출이라 ok로 본다.
 */
export type LlmCallReport = { mode: ConversationMode; model: string; ok: boolean; usage?: LlmTokenUsage };

export type LlmClientOptions = {
  /** 업체를 부른 뒤마다 부른다. 꺼져 있거나 회로가 열려 부르지 않은 경우는 알리지 않는다. */
  onCall?: (report: LlmCallReport) => void;
};

export function createLlmClient(options: LlmClientOptions = {}) {
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

  /** 집계 쪽 오류가 답변 경로로 번지지 않게 막는다. */
  function reportCall(report: LlmCallReport) {
    try {
      options.onCall?.(report);
    } catch (error) {
      console.error("[bori-llm] 호출 기록 실패:", error);
    }
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
        reportCall({ mode: request.mode, model: settings.model, ok: true, ...(result.usage ? { usage: result.usage } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reportCall({ mode: request.mode, model: settings.model, ok: false });
        // 속도 제한(429)은 어댑터가 Retry-After를 지켜 한 번 다시 보낸 뒤에도 남은 경우다.
        // 업체가 고장 난 것이 아니므로 실패 수와 lastError에만 남기고 회로를 열 연속 실패로 세지 않는다(ADR-024).
        if (isRateLimitError(error)) {
          failureCount += 1;
          lastError = reason;
          return { ok: false, reason, kind: "call" };
        }
        recordFailure(settings, reason, false);
        return { ok: false, reason, kind: "call" };
      }

      const validated = validateLlmOutput(raw, request);
      if (!validated.ok) {
        recordFailure(settings, validated.reason, true);
        return { ok: false, reason: validated.reason, kind: "validation" };
      }
      // 감정·모션·기호를 기본값으로 바꾼 답은 정상 답이다. 실패로 세지 않고 로그로만 남긴다.
      if (validated.corrections.length > 0) console.warn(`[bori-llm] 출력 보정(${request.mode}): ${validated.corrections.join(" / ")}`);

      consecutiveFailures = 0;
      lastError = null;
      return { ok: true, response: validated.response, latencyMs };
    },
  };
}
