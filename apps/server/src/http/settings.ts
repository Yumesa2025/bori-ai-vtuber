/**
 * 설정 PATCH 본문 검증.
 *
 * 예전에는 받은 객체를 그대로 펼쳐 병합해서, 모르는 키나 문자열 숫자, 음수 대기 시간도 저장됐다.
 * 키 허용 목록·타입·범위를 먼저 검사하고, 하나라도 틀리면 아무것도 병합하지 않는다.
 * 범위는 관리자 화면 입력값과 기본값, 통합 검사가 쓰는 값을 모두 받도록 정했다.
 */
import type { QueueSettings } from "@bori/shared";
import { openAiVoices, type TtsProvider, type TtsSettings } from "@bori/llm";
import type { MemorySettings } from "@bori/memory";

type FieldRule =
  | { kind: "boolean" }
  | { kind: "number"; min: number; max: number; integer?: boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; pattern: RegExp; description: string };

export type PatchResult<T> = { ok: true; patch: Partial<T> } | { ok: false; error: string };

/** 모델 이름. tts-1, gpt-4o-mini-tts, eleven_multilingual_v2, text-embedding-3-small 같은 형식. */
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,100}$/;
/** ElevenLabs voice id. 계정마다 달라 목록 대신 형식만 본다. 경로에 들어가므로 영숫자만 받는다. */
const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
/** API 키는 형식이 업체마다 달라 길이만 제한한다. */
const API_KEY_MAX_LENGTH = 512;

function describeRule(rule: FieldRule): string {
  switch (rule.kind) {
    case "boolean": return "true 또는 false";
    case "number": return `${rule.min}~${rule.max} 사이 ${rule.integer ? "정수" : "숫자"}`;
    case "enum": return rule.values.join(", ");
    case "string": return rule.description;
  }
}

function matches(rule: FieldRule, value: unknown): boolean {
  switch (rule.kind) {
    case "boolean": return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= rule.min && value <= rule.max && (!rule.integer || Number.isInteger(value));
    case "enum": return typeof value === "string" && rule.values.includes(value);
    case "string": return typeof value === "string" && rule.pattern.test(value);
  }
}

/** 키 허용 목록과 각 값의 타입·범위를 본다. 통과하면 받은 키만 담은 patch를 돌려준다. */
function checkFields<T>(input: unknown, rules: { readonly [K in keyof T]?: FieldRule }): PatchResult<T> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "설정은 JSON 객체여야 합니다." };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = (rules as Record<string, FieldRule | undefined>)[key];
    if (!rule) return { ok: false, error: `알 수 없는 설정 항목입니다: ${key}` };
    if (!matches(rule, value)) return { ok: false, error: `${key}는 ${describeRule(rule)}여야 합니다.` };
    patch[key] = value;
  }
  return { ok: true, patch: patch as Partial<T> };
}

// ── 채팅 큐 ──────────────────────────────────────────────────

const queueRules: { readonly [K in keyof QueueSettings]: FieldRule } = {
  responseDelayMinSeconds: { kind: "number", min: 0, max: 120 },
  responseDelayMaxSeconds: { kind: "number", min: 0, max: 120 },
  maxQueueSize: { kind: "number", min: 1, max: 1000, integer: true },
  visibleChatLimit: { kind: "number", min: 1, max: 50, integer: true },
  duplicateWindowMinutes: { kind: "number", min: 0, max: 1440 },
  sameReplyCooldownMinutes: { kind: "number", min: 0, max: 1440 },
  monologueEnabled: { kind: "boolean" },
  monologueMinSeconds: { kind: "number", min: 1, max: 3600 },
  monologueMaxSeconds: { kind: "number", min: 1, max: 3600 },
};

/** 최솟값이 최댓값보다 크면 거부한다. 한쪽만 보내도 현재 값과 합쳐서 본다. */
export function validateQueueSettingsPatch(input: unknown, current: QueueSettings): PatchResult<QueueSettings> {
  const result = checkFields<QueueSettings>(input, queueRules);
  if (!result.ok) return result;

  const merged = { ...current, ...result.patch };
  if (merged.responseDelayMinSeconds > merged.responseDelayMaxSeconds) {
    return { ok: false, error: "responseDelayMinSeconds는 responseDelayMaxSeconds보다 클 수 없습니다." };
  }
  if (merged.monologueMinSeconds > merged.monologueMaxSeconds) {
    return { ok: false, error: "monologueMinSeconds는 monologueMaxSeconds보다 클 수 없습니다." };
  }
  return result;
}

// ── 장기 기억 ────────────────────────────────────────────────

const memoryRules: { readonly [K in keyof MemorySettings]: FieldRule } = {
  enabled: { kind: "boolean" },
  maxMemories: { kind: "number", min: 1, max: 20, integer: true },
  minSimilarity: { kind: "number", min: 0, max: 1 },
  retentionDays: { kind: "number", min: 1, max: 3650, integer: true },
  embeddingModel: { kind: "string", pattern: MODEL_NAME, description: "모델 이름(영숫자와 . _ : -, 100자 이하)" },
  // 0은 LLM 기억 정리를 끈다.
  privateDigestEveryMessages: { kind: "number", min: 0, max: 50, integer: true },
};

export function validateMemorySettingsPatch(input: unknown): PatchResult<MemorySettings> {
  return checkFields<MemorySettings>(input, memoryRules);
}

// ── 음성 합성 ────────────────────────────────────────────────

export const ttsProviders: readonly TtsProvider[] = ["openai", "elevenlabs"];

/** 업체별 목소리 허용 목록. OpenAI는 고정 목록, ElevenLabs는 voice id 형식. */
export function isValidVoice(provider: TtsProvider, voice: string): boolean {
  return provider === "openai" ? (openAiVoices as readonly string[]).includes(voice) : ELEVENLABS_VOICE_ID.test(voice);
}

/** 키는 설정과 함께 오지만 설정에 병합하지 않는다. 검증만 여기서 한다. */
export type TtsSettingsPatch = Partial<TtsSettings> & { elevenLabsApiKey?: string };

const ttsRules: { readonly [K in keyof TtsSettings]: FieldRule } = {
  enabled: { kind: "boolean" },
  provider: { kind: "enum", values: ttsProviders },
  model: { kind: "string", pattern: MODEL_NAME, description: "모델 이름(영숫자와 . _ : -, 100자 이하)" },
  // 목소리는 업체에 따라 달라 아래에서 따로 본다.
  voice: { kind: "string", pattern: /^.{1,64}$/, description: "64자 이하 문자열" },
  speed: { kind: "number", min: 0.25, max: 4 },
  stability: { kind: "number", min: 0, max: 1 },
  similarity: { kind: "number", min: 0, max: 1 },
  timeoutMs: { kind: "number", min: 1000, max: 60_000, integer: true },
};

/** 목소리는 바뀐 뒤의 업체 기준으로 검사한다. 업체만 바꾸는 요청은 목소리를 보지 않는다. */
export function validateTtsSettingsPatch(input: unknown, current: TtsSettings): PatchResult<TtsSettingsPatch> {
  const keyRule: FieldRule = { kind: "string", pattern: new RegExp(`^[\\s\\S]{0,${API_KEY_MAX_LENGTH}}$`), description: `${API_KEY_MAX_LENGTH}자 이하 문자열` };
  const result = checkFields<TtsSettingsPatch>(input, { ...ttsRules, elevenLabsApiKey: keyRule });
  if (!result.ok) return result;

  const { voice, provider } = result.patch;
  if (voice !== undefined && !isValidVoice(provider ?? current.provider, voice)) {
    return { ok: false, error: `${provider ?? current.provider}에서 쓸 수 없는 목소리입니다: ${voice}` };
  }
  return result;
}
