import type { LlmProvider, LlmSettings, LlmStatus, UsageMode } from "@bori/shared";
import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAiAdapter } from "./openai.js";
import type { LlmAdapter, LlmAdapterConfig, LlmRequest, LlmTokenUsage } from "./types.js";
import { isRateLimitError } from "./retry.js";

export { DEFAULT_MAX_OUTPUT_TOKENS, type LlmAdapter, type LlmAdapterConfig, type LlmRawResult, type LlmRequest, type LlmTokenUsage } from "./types.js";
export { DEFAULT_EMOTION, replyLengthOf, stripDecorations } from "./validate.js";
export { isRateLimitError, RateLimitError, retryAfterMsOf, sendWithRateLimitRetry } from "./retry.js";
export {
  synthesizeSpeech,
  FISH_VOICE_ID,
  ttsApiKey,
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

/** 회로 차단기 없이 어댑터를 직접 만들 때 쓴다. 보통은 createLlmClient를 쓴다. */
export function createAdapter(provider: LlmProvider, config: LlmAdapterConfig): LlmAdapter | null {
  const factory = adapterFactories[provider];
  return factory ? factory(config) : null;
}

/**
 * 제공 업체별 어댑터 생성기. 새 업체를 붙이려면 여기에 한 줄만 추가하면 된다.
 * 부르는 쪽(서버)은 어댑터 구현을 알지 못한다.
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

/**
 * 업체 원문(JSON 문자열)을 부르는 쪽의 값으로 바꾸는 함수.
 * 값으로 쓸 수 없으면 { ok: false, reason }을 돌려준다. 예외를 던져도 같은 실패(validation)로 본다.
 */
export type LlmParse<T> = (raw: string) => { ok: true; value: T } | { ok: false; reason: string };

/**
 * complete의 결과. 실패면 이유와 종류만 돌려주고, 부르는 쪽이 정해진 문장으로 대신한다.
 * - disabled: 꺼져 있거나 키가 없거나 지원하지 않는 업체라 부르지 않았다
 * - circuit: 연속 실패로 회로가 열려 부르지 않았다
 * - call: 업체 호출이 실패했다(시간 초과·HTTP 오류·재시도 뒤에도 429)
 * - validation: 업체는 답했지만 parse가 거부했다(이미 과금된 호출)
 */
export type LlmOutcome<T> =
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; reason: string; kind: "disabled" | "circuit" | "call" | "validation" };

/**
 * 업체 API를 실제로 부른 한 번의 결과. 사용량 집계에 쓰며 요청 내용은 담지 않는다.
 * ok는 업체 호출 자체의 성공 여부다. parse 실패는 이미 과금된 호출이라 ok로 본다.
 */
export type LlmCallReport = { mode: UsageMode; model: string; ok: boolean; usage?: LlmTokenUsage };

export type LlmClientOptions = {
  /** 업체를 부른 뒤마다 부른다. 꺼져 있거나 회로가 열려 부르지 않은 경우는 알리지 않는다. */
  onCall?: (report: LlmCallReport) => void;
  /** 호출 기록에 붙일 사용량 모드. 기본은 보리 읽어 주기(narration)다. */
  mode?: UsageMode;
  /** 업체별 어댑터를 만드는 함수. 검사에서 가짜 어댑터를 넣을 때 바꾼다. */
  adapterFactory?: (provider: LlmProvider, config: LlmAdapterConfig) => LlmAdapter | null;
};

/**
 * 회로 차단기와 호출 통계를 가진 LLM 클라이언트.
 * complete<T>(settings, apiKey, request, parse)는 꺼짐·키·회로를 먼저 보고, 업체를 한 번 부른 뒤 parse로 값을 만든다.
 * 연속 실패(호출 실패와 parse 실패, 429 제외)가 settings.failureThreshold번 쌓이면 settings.cooldownSeconds 동안 부르지 않는다.
 */
export function createLlmClient(options: LlmClientOptions = {}) {
  const mode: UsageMode = options.mode ?? "narration";
  const makeAdapter = options.adapterFactory ?? createAdapter;
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
    if (apiKey.trim().length === 0) return null;
    const key = `${settings.provider}|${settings.model}|${apiKey}`;
    if (adapter && adapterKey === key) return adapter;
    adapter = makeAdapter(settings.provider, { apiKey, model: settings.model });
    adapterKey = key;
    return adapter;
  }

  /** 집계 쪽 오류가 호출 경로로 번지지 않게 막는다. */
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

    async complete<T>(settings: LlmSettings, apiKey: string, request: LlmRequest, parse: LlmParse<T>): Promise<LlmOutcome<T>> {
      if (!settings.enabled) return { ok: false, reason: "LLM이 꺼져 있습니다.", kind: "disabled" };

      const active = ensureAdapter(settings, apiKey);
      if (!active) return { ok: false, reason: "API 키가 없거나 지원하지 않는 업체입니다.", kind: "disabled" };

      // 연속 실패가 쌓이면 잠시 호출을 멈춘다. 매번 시간 초과를 기다리지 않게 한다.
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
        reportCall({ mode, model: settings.model, ok: true, ...(result.usage ? { usage: result.usage } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reportCall({ mode, model: settings.model, ok: false });
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

      let parsed: ReturnType<LlmParse<T>>;
      try {
        parsed = parse(raw);
      } catch (error) {
        parsed = { ok: false, reason: `응답을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!parsed.ok) {
        recordFailure(settings, parsed.reason, true);
        return { ok: false, reason: parsed.reason, kind: "validation" };
      }

      consecutiveFailures = 0;
      lastError = null;
      return { ok: true, value: parsed.value, latencyMs };
    },
  };
}
