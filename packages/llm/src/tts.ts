import { redactError, redactSecrets } from "./redact.js";

/** 프록시나 호환 엔드포인트로 돌릴 때 환경변수로 바꾼다. */
const OPENAI_BASE_URL = process.env.BORI_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const ELEVENLABS_BASE_URL = process.env.BORI_ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1";
const FISH_BASE_URL = process.env.BORI_FISH_BASE_URL ?? "https://api.fish.audio";

/** 지원하는 음성 합성 업체. 어댑터를 추가하면 여기에 이름을 늘린다. */
export type TtsProvider = "openai" | "elevenlabs" | "fish";

export type TtsSettings = {
  enabled: boolean;
  provider: TtsProvider;
  /** OpenAI는 tts-1 / tts-1-hd, ElevenLabs는 eleven_multilingual_v2, Fish Audio는 s2.1-pro·s1 등을 쓴다. */
  model: string;
  /** OpenAI는 목소리 이름, ElevenLabs는 voice id, Fish Audio는 목소리 모델 id(reference_id). */
  voice: string;
  /** OpenAI(0.25~4.0)와 Fish Audio(0.5~2.0, 범위 밖은 잘라서 보낸다)가 쓴다. */
  speed: number;
  /** 안정성. 낮으면 감정 표현이 커지고 높으면 일정해진다. 0~1. ElevenLabs는 stability, Fish Audio는 temperature·top_p(1 - 안정성)로 쓴다. */
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
  fish: "s2.1-pro",
};

/** durationMs는 mp3 프레임에서 센 재생 길이다. 말풍선 표시 시간을 음성 길이에 맞출 때 쓴다(a4 A4-12). */
export type TtsResult = { audio: Buffer; latencyMs: number; durationMs: number };
export type TtsVoiceOption = { id: string; name: string; description?: string };

/** 업체별 API 키. 서버에서만 다루고 브라우저로 내보내지 않는다. */
/** fishApiKey는 Fish Audio를 쓸 때만 필요하다(.env의 FISH_API_KEY). */
export type TtsCredentials = { openAiApiKey: string; elevenLabsApiKey: string; fishApiKey?: string };

/** 업체별로 쓰는 키. */
export function ttsApiKey(credentials: TtsCredentials, provider: TtsProvider): string {
  if (provider === "elevenlabs") return credentials.elevenLabsApiKey;
  if (provider === "fish") return credentials.fishApiKey ?? "";
  return credentials.openAiApiKey;
}

/**
 * 음성 한 건의 최대 크기. 120자 답은 128kbps mp3로 20초 안팎(약 320KB)이라 5MB는 열 배 넘는 여유다.
 * 상한이 없으면 업체·프록시가 큰 응답을 주는 대로 메모리에 쌓였다(a4 A4-15, 10MB×30건 = 344MB).
 */
export const AUDIO_MAX_BYTES = 5 * 1024 * 1024;

/** 응답 본문을 상한까지만 받아 Buffer로 만든다. 길이 헤더로 미리 알 수 있으면 받기 전에 끊는다. */
async function readAudio(response: Response, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AUDIO_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} 음성이 ${AUDIO_MAX_BYTES}바이트를 넘습니다.`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length > AUDIO_MAX_BYTES) throw new Error(`${label} 음성이 ${AUDIO_MAX_BYTES}바이트를 넘습니다.`);
  return audio;
}

// ── mp3 확인 ──────────────────────────────────────────────────
// 업체가 200으로 빈 본문이나 깨진 데이터를 주면 화면은 재생에 실패하고 자동재생 차단으로 오인했다(a4 A4-13).
// 서버가 받을 때 mp3 프레임이 있는지 보고, 프레임을 세어 재생 길이도 같이 구한다.

/** Layer III 비트레이트(kbps). MPEG1과 MPEG2·2.5가 다르다. 0과 15번은 쓰지 않는 값이다. */
const MP3_BITRATES = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
/** 버전 비트(3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5)별 표본율. */
const MP3_SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** 첫 프레임을 찾을 범위. 태그 뒤 앞부분에 쓰레기 바이트가 조금 있어도 받는다. */
const MP3_SYNC_SEARCH_BYTES = 4096;

function mp3FrameAt(audio: Buffer, offset: number): { length: number; seconds: number } | null {
  if (offset + 4 > audio.length) return null;
  if (audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (audio[offset + 1] >> 3) & 3;
  const layer = (audio[offset + 1] >> 1) & 3;
  const bitrateIndex = audio[offset + 2] >> 4;
  const rateIndex = (audio[offset + 2] >> 2) & 3;
  // 버전 1은 예약 값이고, 업체 음성은 모두 Layer III(값 1)다.
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = (version === 3 ? MP3_BITRATES.mpeg1 : MP3_BITRATES.mpeg2)[bitrateIndex] * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version][rateIndex];
  const samples = version === 3 ? 1152 : 576;
  const padding = (audio[offset + 2] >> 1) & 1;
  return { length: Math.floor((samples / 8) * bitrate / sampleRate) + padding, seconds: samples / sampleRate };
}

/**
 * mp3인지 보고 재생 길이(ms)를 센다. 프레임을 하나도 찾지 못하면 null이다.
 * 앞의 ID3 태그는 건너뛴다. 마지막 프레임이 잘려 있어도 머리가 온전하면 센다.
 */
export function mp3DurationMs(audio: Buffer): number | null {
  let offset = 0;
  if (audio.length >= 10 && audio.toString("latin1", 0, 3) === "ID3") {
    // 태그 크기는 7비트씩 쓰는 syncsafe 정수다. 바닥글 표시가 있으면 10바이트가 더 붙는다.
    const size = (audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9];
    offset = 10 + size + (audio[5] & 0x10 ? 10 : 0);
  }
  const searchEnd = Math.min(audio.length, offset + MP3_SYNC_SEARCH_BYTES);
  while (offset < searchEnd && !mp3FrameAt(audio, offset)) offset += 1;

  let seconds = 0;
  let frames = 0;
  for (let frame = mp3FrameAt(audio, offset); frame; frame = mp3FrameAt(audio, offset)) {
    seconds += frame.seconds;
    frames += 1;
    offset += frame.length;
  }
  return frames > 0 ? Math.round(seconds * 1000) : null;
}

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
    return await readAudio(response, "OpenAI TTS");
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
    return await readAudio(response, "ElevenLabs");
  } finally {
    done();
  }
}

/** Fish Audio 목소리 모델 id(fish.audio/m/<id>). 형식이 맞지 않으면(다른 업체 목소리 이름 등) 보내지 않고 Fish 기본 목소리를 쓴다. */
export const FISH_VOICE_ID = /^[0-9a-f]{32}$/i;

/** Fish Audio 속도 범위. https://docs.fish.audio (prosody.speed) */
const FISH_SPEED_MIN = 0.5;
const FISH_SPEED_MAX = 2.0;

/** 안정성(0~1)을 Fish temperature·top_p로 바꾼다. 안정성이 높을수록 낮아진다. 0.1~0.9 안으로 둔다. */
export function fishRandomness(stability: number): number {
  return Math.round(Math.min(0.9, Math.max(0.1, 1 - stability)) * 100) / 100;
}

async function synthesizeWithFish(apiKey: string, settings: TtsSettings, text: string): Promise<Buffer> {
  const { signal, done } = abortAfter(settings.timeoutMs);
  try {
    const response = await fetch(`${FISH_BASE_URL}/v1/tts`, {
      method: "POST",
      // 모델은 본문이 아니라 model 헤더로 고른다.
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, model: settings.model },
      body: JSON.stringify({
        text,
        ...(FISH_VOICE_ID.test(settings.voice) ? { reference_id: settings.voice } : {}),
        format: "mp3",
        mp3_bitrate: 128,
        latency: "normal",
        prosody: { speed: Math.min(FISH_SPEED_MAX, Math.max(FISH_SPEED_MIN, settings.speed)) },
        // 무작위성. 샘플 하나로 빠르게 복제한 목소리는 이 값이 높으면 합성마다 음색이 흔들린다(2026-10-15 리허설). Fish 기본값은 0.7이다.
        temperature: fishRandomness(settings.stability),
        top_p: fishRandomness(settings.stability),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Fish Audio ${response.status}: ${redactSecrets(await response.text(), [apiKey]).slice(0, 200)}`);
    return await readAudio(response, "Fish Audio");
  } finally {
    done();
  }
}

/**
 * 답변 음성을 만든다.
 * 업체가 달라도 호출부는 같다. 결과는 항상 mp3다. 빈 본문이나 mp3 프레임이 없는 응답은 실패로 본다(a4 A4-13).
 */
export async function synthesizeSpeech(credentials: TtsCredentials, settings: TtsSettings, text: string): Promise<TtsResult> {
  const startedAt = Date.now();
  const apiKey = ttsApiKey(credentials, settings.provider);
  if (apiKey.trim().length === 0) throw new Error(`${settings.provider} API 키가 없습니다.`);

  try {
    const audio = settings.provider === "elevenlabs"
      ? await synthesizeWithElevenLabs(apiKey, settings, text)
      : settings.provider === "fish"
        ? await synthesizeWithFish(apiKey, settings, text)
        : await synthesizeWithOpenAi(apiKey, settings, text);
    if (audio.length === 0) throw new Error("음성 데이터가 비어 있습니다.");
    const durationMs = mp3DurationMs(audio);
    if (durationMs === null) throw new Error("음성 데이터가 mp3가 아닙니다.");
    return { audio, latencyMs: Date.now() - startedAt, durationMs };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`음성 합성이 ${settings.timeoutMs}ms 안에 끝나지 않았습니다.`);
    }
    // 이 메시지는 음성 lastError와 로그로 나간다. 헤더 오류처럼 키가 담긴 메시지도 있다.
    throw redactError(error, [apiKey]);
  }
}

/** 목소리 목록 요청 상한. 전에는 상한이 없어 업체가 멈추면 GET·PATCH /api/tts 응답도 멈췄다(a4 A4-08). */
export const VOICE_LIST_TIMEOUT_MS = 5000;

/**
 * 고를 수 있는 목소리 목록.
 * OpenAI는 고정 목록이고 ElevenLabs·Fish Audio는 계정에 담긴 목소리를 받아 온다.
 */
export async function listVoices(credentials: TtsCredentials, provider: TtsProvider, timeoutMs = VOICE_LIST_TIMEOUT_MS): Promise<TtsVoiceOption[]> {
  if (provider === "openai") {
    return openAiVoices.map(name => ({ id: name, name }));
  }

  if (provider === "fish") return listFishVoices(ttsApiKey(credentials, provider), timeoutMs);
  if (credentials.elevenLabsApiKey.trim().length === 0) return [];

  const { signal, done } = abortAfter(timeoutMs);
  let payload: { voices?: { voice_id?: string; name?: string; labels?: Record<string, string> }[] };
  try {
    const response = await fetch(`${ELEVENLABS_BASE_URL}/voices`, { headers: { "xi-api-key": credentials.elevenLabsApiKey }, signal });
    if (!response.ok) throw new Error(`ElevenLabs 목소리 목록 ${response.status}`);
    payload = await response.json() as typeof payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`ElevenLabs 목소리 목록이 ${timeoutMs}ms 안에 오지 않았습니다.`);
    throw redactError(error, [credentials.elevenLabsApiKey]);
  } finally {
    done();
  }
  return (payload.voices ?? [])
    .filter((voice): voice is { voice_id: string; name: string; labels?: Record<string, string> } => typeof voice.voice_id === "string" && typeof voice.name === "string")
    .map(voice => ({
      id: voice.voice_id,
      name: voice.name,
      // 성별과 나이대 정보가 있으면 어떤 목소리인지 고르기 쉬워진다.
      description: [voice.labels?.gender, voice.labels?.age, voice.labels?.description].filter(Boolean).join(" · ") || undefined,
    }));
}

/**
 * Fish Audio에서 내가 만든 목소리(self=true) 중 학습이 끝난 것. 공개 목소리는 목록에 없으므로 화면에서 id를 직접 넣는다.
 */
async function listFishVoices(apiKey: string, timeoutMs: number): Promise<TtsVoiceOption[]> {
  if (apiKey.trim().length === 0) return [];
  const { signal, done } = abortAfter(timeoutMs);
  let payload: { items?: { _id?: string; title?: string; languages?: string[]; state?: string }[] };
  try {
    const response = await fetch(`${FISH_BASE_URL}/model?self=true&page_size=100`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!response.ok) throw new Error(`Fish Audio 목소리 목록 ${response.status}`);
    payload = await response.json() as typeof payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Fish Audio 목소리 목록이 ${timeoutMs}ms 안에 오지 않았습니다.`);
    throw redactError(error, [apiKey]);
  } finally {
    done();
  }
  return (payload.items ?? [])
    .filter((item): item is { _id: string; title: string; languages?: string[]; state?: string } => typeof item._id === "string" && typeof item.title === "string" && (item.state === undefined || item.state === "trained"))
    .map(item => ({ id: item._id, name: item.title, description: item.languages?.join(", ") || undefined }));
}

/** 목소리 목록을 다시 쓰는 시간. 관리자 화면이 1.5초마다 GET /api/tts를 불러 ElevenLabs에 시간당 약 2,400회 요청이 갔다(a4 A4-08). */
export const VOICE_LIST_CACHE_MS = 10 * 60_000;
/** 실패도 잠시 기억한다. 업체가 멈춘 동안 폴링마다 상한(5초)만큼 기다리지 않게 한다. */
export const VOICE_LIST_FAILURE_CACHE_MS = 30_000;

/**
 * 목소리 목록 캐시. 업체와 키가 같으면 VOICE_LIST_CACHE_MS 동안 다시 묻지 않고, 키나 업체가 바뀌면 새로 묻는다.
 * 동시에 들어온 요청은 진행 중인 요청 하나를 같이 기다린다. 실패하면 전처럼 빈 목록을 돌려준다.
 * OpenAI 목록은 고정 값이라 캐시하지 않는다. 키는 이 프로세스 메모리 안에서 비교만 한다.
 */
export function createVoiceListCache(options: { load?: typeof listVoices; now?: () => number } = {}) {
  const load = options.load ?? listVoices;
  const now = options.now ?? Date.now;
  let entry: { key: string; expiresAt: number; voices: Promise<TtsVoiceOption[]> } | null = null;

  return {
    get(credentials: TtsCredentials, provider: TtsProvider): Promise<TtsVoiceOption[]> {
      if (provider === "openai") return load(credentials, provider).catch(() => []);
      const key = `${provider}\n${ttsApiKey(credentials, provider)}`;
      if (entry && entry.key === key && now() < entry.expiresAt) return entry.voices;

      // 응답이 올 때까지는 만료되지 않은 것으로 둔다. 그동안 들어온 요청도 같은 응답을 기다린다.
      const current: { key: string; expiresAt: number; voices: Promise<TtsVoiceOption[]> } = { key, expiresAt: Number.POSITIVE_INFINITY, voices: Promise.resolve([]) };
      current.voices = load(credentials, provider).then(
        voices => { current.expiresAt = now() + VOICE_LIST_CACHE_MS; return voices; },
        () => { current.expiresAt = now() + VOICE_LIST_FAILURE_CACHE_MS; return []; },
      );
      entry = current;
      return current.voices;
    },
    /** 다음 요청에서 다시 묻는다. 음성 설정을 저장할 때 부른다. ElevenLabs에서 목소리를 새로 만든 뒤 바로 보이게 한다. */
    clear() { entry = null; },
  };
}
