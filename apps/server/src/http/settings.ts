/**
 * 설정 PATCH 본문 검증.
 *
 * 예전에는 받은 객체를 그대로 펼쳐 병합해서, 모르는 키나 문자열 숫자, 음수 대기 시간도 저장됐다.
 * 키 허용 목록·타입·범위를 먼저 검사하고, 하나라도 틀리면 아무것도 병합하지 않는다.
 * 범위는 관리자 화면 입력값과 기본값, 통합 검사가 쓰는 값을 모두 받도록 정했다.
 */
import type { LlmSettings } from "@bori/shared";
import { FISH_VOICE_ID, openAiVoices, supportedProviders, type TtsProvider, type TtsSettings } from "@bori/llm";
import { normalizeApiKey } from "../secret-store.js";

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
/** API 키는 형식이 업체마다 달라 길이만 제한한다. 공백을 지운 뒤 보이는 ASCII만 남는지는 checkApiKey가 본다. */
const API_KEY_MAX_LENGTH = 512;
const apiKeyRule: FieldRule = { kind: "string", pattern: new RegExp(`^[\\s\\S]{0,${API_KEY_MAX_LENGTH}}$`), description: `${API_KEY_MAX_LENGTH}자 이하 문자열` };

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

/**
 * 키에 섞인 공백·개행은 지우고, 그 밖의 보이지 않는 문자나 ASCII 밖 문자가 있으면 거부한다.
 * 오류 문장에 키를 넣지 않는다.
 */
function checkApiKey<T extends Record<string, unknown>>(result: PatchResult<T>, field: keyof T & string): PatchResult<T> {
  if (!result.ok || typeof result.patch[field] !== "string") return result;
  const normalized = normalizeApiKey(result.patch[field] as string);
  if (normalized === null) return { ok: false, error: `${field}에는 영문·숫자·기호만 쓸 수 있습니다.` };
  return { ok: true, patch: { ...result.patch, [field]: normalized } };
}

/**
 * 파일에서 읽은 설정을 키 하나씩 PATCH 검증기로 본다(점검 D-5).
 * PATCH와 달리 하나가 틀려도 나머지는 쓴다. 통과한 키만 patch에 담고, 틀린 키 이름은 rejected로 돌려준다. 틀린 키는 기본값으로 남는다.
 * validate의 두 번째 인자는 앞에서 통과한 값이다. 목소리처럼 다른 키(업체)에 따라 달라지는 검사에 쓴다.
 */
export function pickValidSettings<T>(input: Record<string, unknown>, validate: (patch: Record<string, unknown>, accepted: Partial<T>) => PatchResult<T>): { patch: Partial<T>; rejected: string[] } {
  const patch: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const checked = validate({ [key]: value }, patch as Partial<T>);
    if (checked.ok) Object.assign(patch, checked.patch);
    else rejected.push(key);
  }
  return { patch: patch as Partial<T>, rejected };
}

// ── 음성 합성 ────────────────────────────────────────────────

export const ttsProviders: readonly TtsProvider[] = ["openai", "elevenlabs", "fish"];

/** 업체별 목소리 허용 목록. OpenAI는 고정 목록, ElevenLabs는 voice id 형식, Fish Audio는 32자리 모델 id. */
export function isValidVoice(provider: TtsProvider, voice: string): boolean {
  if (provider === "openai") return (openAiVoices as readonly string[]).includes(voice);
  if (provider === "fish") return FISH_VOICE_ID.test(voice);
  return ELEVENLABS_VOICE_ID.test(voice);
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
  const result = checkApiKey(checkFields<TtsSettingsPatch>(input, { ...ttsRules, elevenLabsApiKey: apiKeyRule }), "elevenLabsApiKey");
  if (!result.ok) return result;

  const { voice, provider } = result.patch;
  if (voice !== undefined && !isValidVoice(provider ?? current.provider, voice)) {
    return { ok: false, error: `${provider ?? current.provider}에서 쓸 수 없는 목소리입니다: ${voice}` };
  }
  return result;
}

// ── 외부 LLM ─────────────────────────────────────────────────

/** 키는 설정과 함께 오지만 설정에 병합하지 않는다. 빈 문자열은 키를 지우는 뜻이다. */
export type LlmSettingsPatch = Partial<LlmSettings> & { apiKey?: string };

/**
 * 검증 표
 *
 * | 키                    | 규칙                                                                  |
 * | --------------------- | --------------------------------------------------------------------- |
 * | enabled               | true 또는 false                                                        |
 * | provider              | 어댑터가 있는 업체(supportedProviders: openai, anthropic)              |
 * | model                 | 모델 이름(영숫자와 . _ : -, 1~100자)                                   |
 * | maxReplyLength        | 20~1000 정수                                                           |
 * | timeoutMs             | 1000~120000 정수                                                       |
 * | failureThreshold      | 1~100 정수                                                             |
 * | cooldownSeconds       | 0~3600                                                                 |
 * | apiKey                | 512자 이하 문자열. 공백·개행은 지우고, 보이는 ASCII 밖 문자는 거부한다 |
 */
const llmRules: { readonly [K in keyof LlmSettingsPatch]-?: FieldRule } = {
  enabled: { kind: "boolean" },
  provider: { kind: "enum", values: supportedProviders },
  model: { kind: "string", pattern: MODEL_NAME, description: "모델 이름(영숫자와 . _ : -, 100자 이하)" },
  maxReplyLength: { kind: "number", min: 20, max: 1000, integer: true },
  timeoutMs: { kind: "number", min: 1000, max: 120_000, integer: true },
  failureThreshold: { kind: "number", min: 1, max: 100, integer: true },
  cooldownSeconds: { kind: "number", min: 0, max: 3600 },
  apiKey: apiKeyRule,
};

/**
 * 1:1 대화를 쓰던 때(2026-11-21 이전) LLM 설정에 있던 칸. 누적 요약과 키워드 매크로는 대화와 함께 지웠다.
 * 예전 llm-config.json에 이 칸이 남아 있어도 잘못된 값으로 보지 않는다(원본 백업·경고 없이 무시).
 * 다음 저장 때 파일에서 빠진다.
 */
export const LEGACY_LLM_SETTING_KEYS: readonly string[] = ["rollingSummaryEnabled", "rollingSummaryTurns", "macroEnabled"];

/** 읽은 LLM 설정에서 지운 칸만 뺀 복사본. 모르는 다른 칸은 그대로 둬서 검증이 거부하게 한다. */
export function withoutLegacyLlmKeys(saved: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(saved).filter(([key]) => !LEGACY_LLM_SETTING_KEYS.includes(key)));
}

/** TTS와 같이 모두 검사한 뒤 하나라도 틀리면 아무것도 바꾸지 않는다. */
export function validateLlmSettingsPatch(input: unknown): PatchResult<LlmSettingsPatch> {
  return checkApiKey(checkFields<LlmSettingsPatch>(input, llmRules), "apiKey");
}
