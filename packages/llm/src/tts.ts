import { redactSecrets } from "./redact.js";

/** 프록시나 호환 엔드포인트로 돌릴 때 환경변수로 바꾼다. */
const OPENAI_BASE_URL = process.env.BORI_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const ELEVENLABS_BASE_URL = process.env.BORI_ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1";

/** 지원하는 음성 합성 업체. 어댑터를 추가하면 여기에 이름을 늘린다. */
export type TtsProvider = "openai" | "elevenlabs";

export type TtsSettings = {
  enabled: boolean;
  provider: TtsProvider;
  /** OpenAI는 tts-1 / tts-1-hd, ElevenLabs는 eleven_multilingual_v2 등을 쓴다. */
  model: string;
  /** OpenAI는 목소리 이름, ElevenLabs는 voice id. */
  voice: string;
  /** OpenAI만 지원한다. 0.25~4.0 */
  speed: number;
  /** ElevenLabs 안정성. 낮으면 감정 표현이 커지고 높으면 일정해진다. 0~1 */
  stability: number;
  /** ElevenLabs 목소리 유사도. 0~1 */
  similarity: number;
  timeoutMs: number;
};

export const defaultTtsSettings: TtsSettings = {
  enabled: false,
  provider: "openai",
  model: "tts-1",
  voice: "nova",
  speed: 1.0,
  stability: 0.4,
  similarity: 0.75,
  timeoutMs: 15_000,
};

/** OpenAI 기본 목소리. ElevenLabs는 계정마다 다르므로 목록을 API로 받아 온다. */
export const openAiVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

export const defaultTtsModels: Record<TtsProvider, string> = {
  openai: "tts-1",
  elevenlabs: "eleven_multilingual_v2",
};

export type TtsResult = { audio: Buffer; latencyMs: number };
export type TtsVoiceOption = { id: string; name: string; description?: string };

/** 업체별 API 키. 서버에서만 다루고 브라우저로 내보내지 않는다. */
export type TtsCredentials = { openAiApiKey: string; elevenLabsApiKey: string };

function abortAfter(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function synthesizeWithOpenAi(apiKey: string, settings: TtsSettings, text: string): Promise<Buffer> {
  const { signal, done } = abortAfter(settings.timeoutMs);
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: settings.model, voice: settings.voice, input: text, speed: settings.speed, response_format: "mp3" }),
      signal,
    });
    // 업체 오류 본문은 키 모양 문자열을 가린 뒤 앞부분만 남긴다.
    if (!response.ok) throw new Error(`OpenAI TTS ${response.status}: ${redactSecrets(await response.text(), [apiKey]).slice(0, 200)}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    done();
  }
}

async function synthesizeWithElevenLabs(apiKey: string, settings: TtsSettings, text: string): Promise<Buffer> {
  const { signal, done } = abortAfter(settings.timeoutMs);
  try {
    const response = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(settings.voice)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": apiKey, Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: settings.model,
        voice_settings: { stability: settings.stability, similarity_boost: settings.similarity },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${redactSecrets(await response.text(), [apiKey]).slice(0, 200)}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    done();
  }
}

/**
 * 답변 음성을 만든다.
 * 업체가 달라도 호출부는 같다. 결과는 항상 mp3다.
 */
export async function synthesizeSpeech(credentials: TtsCredentials, settings: TtsSettings, text: string): Promise<TtsResult> {
  const startedAt = Date.now();
  const apiKey = settings.provider === "elevenlabs" ? credentials.elevenLabsApiKey : credentials.openAiApiKey;
  if (apiKey.trim().length === 0) throw new Error(`${settings.provider} API 키가 없습니다.`);

  try {
    const audio = settings.provider === "elevenlabs"
      ? await synthesizeWithElevenLabs(apiKey, settings, text)
      : await synthesizeWithOpenAi(apiKey, settings, text);
    return { audio, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`음성 합성이 ${settings.timeoutMs}ms 안에 끝나지 않았습니다.`);
    }
    throw error;
  }
}

/**
 * 고를 수 있는 목소리 목록.
 * OpenAI는 고정 목록이고 ElevenLabs는 계정에 담긴 목소리를 받아 온다.
 */
export async function listVoices(credentials: TtsCredentials, provider: TtsProvider): Promise<TtsVoiceOption[]> {
  if (provider === "openai") {
    return openAiVoices.map(name => ({ id: name, name }));
  }

  if (credentials.elevenLabsApiKey.trim().length === 0) return [];

  const response = await fetch(`${ELEVENLABS_BASE_URL}/voices`, { headers: { "xi-api-key": credentials.elevenLabsApiKey } });
  if (!response.ok) throw new Error(`ElevenLabs 목소리 목록 ${response.status}`);

  const payload = await response.json() as { voices?: { voice_id?: string; name?: string; labels?: Record<string, string> }[] };
  return (payload.voices ?? [])
    .filter((voice): voice is { voice_id: string; name: string; labels?: Record<string, string> } => typeof voice.voice_id === "string" && typeof voice.name === "string")
    .map(voice => ({
      id: voice.voice_id,
      name: voice.name,
      // 성별과 나이대 정보가 있으면 어떤 목소리인지 고르기 쉬워진다.
      description: [voice.labels?.gender, voice.labels?.age, voice.labels?.description].filter(Boolean).join(" · ") || undefined,
    }));
}
