// 루트 .env를 가장 먼저 읽는다. 아래 모듈 일부가 import 시점에 환경 변수를 읽는다.
import "./load-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BroadcastState, ChatMessage, ChatSource, CharacterResponse, CompanionStats, LlmProvider, LlmSettings, MacroPrompt, MacroStatus, QueueSettings, ShowStage, ShowState, VisibleChat } from "@bori/shared";
import type { ConversationMode } from "@bori/character";
import { boriExpressionNames, boriMotionGroupNames, isBoriExpression, isBoriMotionGroup } from "@bori/live2d";
import { createAdapter as createProviderAdapter, createLlmClient, createVoiceListCache, defaultModels, defaultTtsModels, defaultTtsSettings, isBroadcastMemoryText, summarizeBroadcast, supportedProviders, synthesizeSpeech, ttsApiKey, type TtsProvider, type TtsSettings } from "@bori/llm";
import { createMemoryStore, createOpenAiEmbedding, defaultMemorySettings, extractMemoryCandidates, isAnonymousViewer, isStorableMemory, type EmbeddingProvider, type MemorySettings } from "@bori/memory";
import { bodyAction, createConversationEngine, createModeLlmClients, isChatter, isCrisisContent, isQuestion, isUnsafeContent, pickNextChatIndex, withoutCrisisTurns, type ConversationSession } from "./conversation/index.js";
import { cleanInputText, lengthOf } from "./input-text.js";
import { COMPANION_LOCAL_OWNER, createCompanionHandler, createPrivateMemoryDigest } from "./companion/index.js";
import { createApiKeySlot } from "./secret-store.js";
import { createConfigFile } from "./config-file.js";
import { allowedOriginsFrom, guardRequest, readBody } from "./http/guard.js";
import { serveStatic, type StaticRoute } from "./http/static.js";
import { isValidVoice, pickValidSettings, ttsProviders, validateLlmSettingsPatch, validateMemorySettingsPatch, validateQueueSettingsPatch, validateTtsSettingsPatch, type PatchResult } from "./http/settings.js";
import { buildUsageReport, createUsageStore, loadPriceTable, trackAdapter, trackEmbedding } from "./usage/index.js";
import { BACKUP_RETENTION_DAYS, purgeExpiredBackups } from "./retention.js";
import { createErClient, findCharacter } from "@bori/er";
import { createObsController } from "./obs/controller.js";
import { ChzzkCallbackError, createChzzkLink } from "./show/chzzk-link.js";
import { createAutopilot } from "./show/autopilot.js";
import { createDemoChats, parseDemoScript } from "./show/demo-chats.js";
import { createPlayerCommand } from "./show/commands.js";
import { createShowController } from "./show/controller.js";
import { createErData } from "./show/er-data.js";
import { buildGameData, isMetaQuestion } from "./show/game-data.js";

const port = Number(process.env.BORI_SERVER_PORT ?? 4310);

// 놓친 비동기 오류가 있어도 서버를 내리지 않고 기록만 남긴다. 알려진 경로는 모두 각자 catch가 있다(점검 X-3).
process.on("unhandledRejection", reason => {
  console.error("[bori-server] 처리되지 않은 비동기 오류:", reason);
});
let settings: QueueSettings = {
  responseDelayMinSeconds: 5,
  responseDelayMaxSeconds: 10,
  maxQueueSize: 100,
  visibleChatLimit: 8,
  duplicateWindowMinutes: 5,
  sameReplyCooldownMinutes: 5,
  monologueEnabled: true,
  monologueMinSeconds: 30,
  monologueMaxSeconds: 60,
};
const queue: ChatMessage[] = [];
/**
 * 최근에 들어온 채팅 문장과 그 시각.
 * Set으로 두면 한 번 나온 문장이 방송 내내 막혀 다른 시청자가 같은 인사를 못 한다.
 * duplicateWindowMinutes 안에서만 중복으로 본다.
 */
const recentContents = new Map<string, number>();
let responseTimer: NodeJS.Timeout | undefined;
/** 답변 대기를 끝내는 함수. 대기를 취소할 때도 불러, 그 대기를 기다리던 처리가 끝나지 않은 채 남지 않게 한다(a4 A4-16). */
let finishResponseWait: (() => void) | undefined;
/** 지금 답을 만드는 채팅과 그 세션. 생성 중에 방송이 끝나면 시청자 발언만이라도 그 세션 기록에 남긴다(a4 A4-19). */
let answering: { chat: ChatMessage; session: ConversationSession } | undefined;
let monologueTimer: NodeJS.Timeout | undefined;
/** 발화권. 답변을 말하는 동안에는 다음 답변도 혼잣말도 시작하지 않는다. */
let speaking = false;
/** 방송 진행기 대사가 발화권을 기다리는 수. 0보다 크면 새 채팅 답과 혼잣말을 시작하지 않는다. */
let showHold = 0;
/**
 * 방송 세션 세대. 시작할 때마다 증가한다.
 * LLM 호출은 비동기라 응답이 늦게 오는데, 그 사이 방송을 다시 시작했다면
 * 이전 세션의 답변이므로 화면에 올리지 않는다. status만 봐서는 구분할 수 없다.
 */
let sessionGeneration = 0;
let testActionSeq = 0;

const RESPONSE_DISPLAY_MS = 5000;
/** 음성이 있을 때 말풍선을 두는 최대 시간. 120자 답의 발화는 20초 안팎이라 끝까지 들리고, 큐가 한 답에 오래 묶이지 않는다. */
const AUDIO_DISPLAY_MAX_MS = 30_000;
/** 음성이 끝난 뒤 말풍선을 조금 더 둔다. 화면이 받아 재생을 시작하기까지의 지연(폴링 250ms·다운로드)을 덮는다. */
const AUDIO_DISPLAY_TAIL_MS = 1000;

// ── LLM 설정과 API 키 ─────────────────────────────────────────
// 키는 data/ 아래에만 둔다. data/는 .gitignore 대상이다.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/**
 * 설정과 기억이 들어가는 디렉터리.
 * 환경변수로 옮길 수 있게 해서, 실제 방송 데이터를 건드리지 않고 서버를 띄워 볼 수 있다.
 */
const dataRoot = process.env.BORI_DATA_DIR ? resolve(process.env.BORI_DATA_DIR) : resolve(projectRoot, "data");
// 보관 기간이 지난 백업·이전 관리자 로그를 지운다. 사용자 데이터 원본은 지우지 않는다(retention.ts).
const purgedBackups = purgeExpiredBackups(dataRoot);
if (purgedBackups.length > 0) console.log(`[bori-server] ${BACKUP_RETENTION_DAYS}일 지난 백업·로그 ${purgedBackups.length}건 정리`);
const llmConfigPath = resolve(dataRoot, "llm-config.json");
const llmConfigFile = createConfigFile(llmConfigPath, "LLM 설정");

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : "오류");

let llmSettings: LlmSettings = {
  enabled: false,
  provider: "openai",
  model: defaultModels.openai,
  maxReplyLength: 120,
  timeoutMs: 8000,
  failureThreshold: 3,
  cooldownSeconds: 60,
  rollingSummaryEnabled: true,
  rollingSummaryTurns: 10,
  macroEnabled: true,
};
// 환경변수로도 키를 넣을 수 있다. 저장된 키가 없을 때만 쓰고, 환경변수 키는 파일에 쓰지 않는다.
const llmKey = createApiKeySlot(process.env.OPENAI_API_KEY);
/** 지금 쓰는 키. llmKey가 바뀔 때마다 맞춘다. */
let llmApiKey = llmKey.current();

// ── API 사용량 ────────────────────────────────────────────────
// 기능·모드·모델별 호출 수와 토큰·글자 수만 날짜별로 센다. 대화 내용·닉네임·소유자 ID는 넘기지 않는다(ADR-018).
const usageStore = createUsageStore(resolve(dataRoot, "usage.json"));
usageStore.load();
const usagePricesPath = resolve(dataRoot, "usage-prices.json");

/** 어댑터를 직접 쓰는 호출(요약·기억 정리)을 기능 이름으로 세는 생성기. */
const trackedAdapterFactory = (feature: "summary" | "digest"): typeof createProviderAdapter => (provider, config) => {
  const adapter = createProviderAdapter(provider, config);
  return adapter ? trackAdapter(adapter, config.model, feature, usageStore.record) : null;
};
/**
 * 요약용 어댑터 생성기. 방송 요약(persistSessionMemories)과 엔진의 누적 요약이 이 이름으로 어댑터를 만들어
 * 모두 summary로 센다. 업체 어댑터를 그대로 만들려면 createProviderAdapter를 쓴다.
 */
const createAdapter = trackedAdapterFactory("summary");

/**
 * LLM 클라이언트는 모드마다 따로 둔다. 회로 차단기와 통계가 클라이언트 안에 있어서,
 * 하나를 같이 쓰면 1:1 연속 실패가 방송 회로를 연다.
 * 관리자 화면과 기존 라우트가 보는 llm은 방송 것이고, reset만 두 모드에 함께 적용한다.
 */
const llmClients = createModeLlmClients(() => createLlmClient({ onCall: call => usageStore.record({ feature: "reply", ...call }) }));
const llm = { ...llmClients.llmFor("broadcast"), reset: llmClients.resetAll };

/**
 * 설정 파일을 읽는다. 파일이 없으면 기본값으로 시작한다.
 * 값은 PATCH와 같은 검증기로 키마다 보고, 틀린 값은 기본값으로 둔 뒤 원본을 남긴다(점검 D-5).
 */
function loadLlmConfig() {
  const saved = llmConfigFile.read();
  if (!saved) return;

  const savedSettings = isPlainObject(saved.settings) ? saved.settings : {};
  // 키는 settings 밖의 apiKey에만 둔다. settings 안의 키는 설정으로 받지 않는다.
  const picked = pickValidSettings<LlmSettings>(savedSettings, patch => ("apiKey" in patch ? { ok: false, error: "" } : validateLlmSettingsPatch(patch) as PatchResult<LlmSettings>));
  llmSettings = { ...llmSettings, ...picked.patch };
  if (llmSettings.rollingSummaryTurns < 4) llmSettings.rollingSummaryTurns = 4;
  llmConfigFile.rejected([
    ...(saved.settings !== undefined && !isPlainObject(saved.settings) ? ["settings"] : []),
    ...picked.rejected,
    ...(saved.apiKey !== undefined && typeof saved.apiKey !== "string" ? ["apiKey"] : []),
  ]);

  const keyState = llmKey.load(saved.apiKey);
  llmApiKey = llmKey.current();
  // 이전 버전이 평문으로 남긴 키는 즉시 암호문으로 바꿔 저장한다.
  if (keyState === "plaintext") {
    try {
      saveLlmConfig();
      console.log("[bori-server] 평문으로 저장돼 있던 API 키를 암호화했습니다.");
    } catch (error) {
      console.error("[bori-server] 평문 API 키를 암호화해 저장하지 못했습니다:", errorCode(error));
    }
  }
  // 풀지 못한 키는 지우지 않는다. 새 키를 넣거나 지우기 전까지 파일에 그대로 다시 쓴다.
  if (keyState === "unreadable") console.warn("[bori-server] 저장된 API 키를 풀지 못했습니다. 다른 컴퓨터에서 만든 파일일 수 있습니다. 키는 지우지 않고 그대로 둡니다.");
  console.log("[bori-server] LLM 설정을 불러왔습니다.");
}

/** 실패하면 예외를 넘긴다. 부르는 쪽이 바뀐 값을 되돌리고 알린다. */
function saveLlmConfig() {
  // 화면에서 넣은 키만 암호화해서 저장한다. 환경변수 키는 파일에 남기지 않는다.
  llmConfigFile.write({ settings: llmSettings, apiKey: llmKey.stored() });
}

loadLlmConfig();

// ── 음성 합성 ─────────────────────────────────────────────────
let ttsSettings: TtsSettings = { ...defaultTtsSettings };
/** ElevenLabs는 LLM과 다른 키를 쓴다. 이 키도 화면에서 넣은 것만 암호화해 저장한다. */
const elevenLabsKey = createApiKeySlot(process.env.ELEVENLABS_API_KEY);
let elevenLabsApiKey = elevenLabsKey.current();
const ttsConfigPath = resolve(dataRoot, "tts-config.json");
const ttsConfigFile = createConfigFile(ttsConfigPath, "음성 설정");

/** Fish Audio 키는 루트 .env의 FISH_API_KEY로만 받는다(화면 입력·저장 없음). */
const fishApiKey = process.env.FISH_API_KEY ?? "";
const ttsCredentials = () => ({ openAiApiKey: llmApiKey, elevenLabsApiKey, fishApiKey });
/** 지금 설정으로 음성을 만들 수 있는지. */
const ttsHasKey = () => ttsApiKey(ttsCredentials(), ttsSettings.provider).trim().length > 0;
/** 생성한 음성과 그 재생 길이. 방송 화면이 받아가면 되므로 메모리에만 두고 오래된 것부터 버린다. */
const audioCache = new Map<string, { audio: Buffer; durationMs: number }>();
const AUDIO_CACHE_LIMIT = 30;
/**
 * 음성 캐시 총 크기 상한. 전에는 개수만 세서 10MB 음성 30건이 344MB를 붙잡았다(a4 A4-15).
 * 평소 답 음성은 수백 KB라 30건이 10MB 안쪽이다. 50MB면 개수 상한이 먼저 걸리고, 큰 응답만 크기로 밀려난다.
 */
const AUDIO_CACHE_MAX_BYTES = 50 * 1024 * 1024;
let audioCacheBytes = 0;
/**
 * 방송 답 음성의 합성 상한. 음성은 LLM 뒤에 이어 만들어져 말풍선이 그만큼 늦는다(a4 A4-18).
 * 설정 상한(최대 60초)을 그대로 쓰면 업체가 멈출 때 말풍선이 1분 넘게 늦으므로 방송 경로만 6초로 줄인다.
 * 120자 답은 OpenAI·ElevenLabs 모두 보통 1~3초에 온다(추정, 실 업체로 재지 않음). 넘으면 음성 없이 글로 나간다.
 * 1:1은 사용자가 음성을 골라 기다리는 경로라 설정값을 그대로 쓴다.
 */
const BROADCAST_TTS_TIMEOUT_MS = 6000;
/** 목소리 목록 캐시. 관리자 화면이 1.5초마다 부르는 GET /api/tts가 매번 ElevenLabs를 부르지 않게 한다(a4 A4-08). */
const voiceList = createVoiceListCache();
let ttsFailureCount = 0;
let ttsLastError: string | null = null;

/** LLM 설정과 같은 방식으로 읽는다. 목소리는 업체에 따라 달라 업체를 먼저 본다. */
function loadTtsConfig() {
  const saved = ttsConfigFile.read();
  if (!saved) return;

  const { elevenLabsApiKey: storedKey, provider, ...rest } = saved;
  const picked = pickValidSettings<TtsSettings>(
    { ...(provider !== undefined ? { provider } : {}), ...rest },
    (patch, accepted) => validateTtsSettingsPatch(patch, { ...ttsSettings, ...accepted }) as PatchResult<TtsSettings>,
  );
  ttsSettings = { ...ttsSettings, ...picked.patch };
  // 업체만 맞고 목소리가 틀렸으면 PATCH와 같이 기본 목소리로 맞춘다.
  if (!isValidVoice(ttsSettings.provider, ttsSettings.voice)) ttsSettings.voice = defaultTtsSettings.voice;
  ttsConfigFile.rejected([...picked.rejected, ...(storedKey !== undefined && typeof storedKey !== "string" ? ["elevenLabsApiKey"] : [])]);

  const keyState = elevenLabsKey.load(storedKey);
  elevenLabsApiKey = elevenLabsKey.current();
  // LLM 키와 같이, 평문으로 남은 키는 다음 저장을 기다리지 않고 바로 암호문으로 바꾼다.
  if (keyState === "plaintext") {
    try {
      saveTtsConfig();
      console.log("[bori-server] 평문으로 저장돼 있던 ElevenLabs 키를 암호화했습니다.");
    } catch (error) {
      console.error("[bori-server] 평문 ElevenLabs 키를 암호화해 저장하지 못했습니다:", errorCode(error));
    }
  }
  if (keyState === "unreadable") console.warn("[bori-server] 저장된 ElevenLabs 키를 풀지 못했습니다. 키는 지우지 않고 그대로 둡니다.");
}

/** 실패하면 예외를 넘긴다. */
function saveTtsConfig() {
  // 키는 LLM 설정과 같은 방식으로, 화면에서 넣은 것만 암호화해 저장한다.
  ttsConfigFile.write({ ...ttsSettings, elevenLabsApiKey: elevenLabsKey.stored() });
}

/**
 * 답변 음성을 만든다.
 * 실패해도 방송은 그대로 진행하고 음성만 빠진다.
 */
async function prepareAudio(text: string, mode: ConversationMode = "broadcast"): Promise<string | undefined> {
  if (!ttsSettings.enabled || !ttsHasKey()) return undefined;

  // 합성 중에 설정이 바뀔 수 있으므로 부를 때의 모델로 센다. 글자 수만 세고 문장은 넘기지 않는다.
  const usage = { feature: "tts" as const, mode, model: ttsSettings.model };
  const settingsForCall = mode === "broadcast" ? { ...ttsSettings, timeoutMs: Math.min(ttsSettings.timeoutMs, BROADCAST_TTS_TIMEOUT_MS) } : ttsSettings;
  try {
    // 빈 본문·mp3가 아닌 응답은 synthesizeSpeech가 실패로 돌려준다. 화면이 재생 실패를 자동재생 차단으로 오인하지 않게 한다(a4 A4-13).
    const result = await synthesizeSpeech(ttsCredentials(), settingsForCall, text);
    usageStore.record({ ...usage, ok: true, characters: Array.from(text).length });
    const id = randomUUID();
    audioCache.set(id, { audio: result.audio, durationMs: result.durationMs });
    audioCacheBytes += result.audio.length;
    // 개수와 총 크기 상한 안으로 들어올 때까지 오래된 것부터 버린다. 방금 만든 음성은 남긴다.
    while (audioCache.size > AUDIO_CACHE_LIMIT || (audioCacheBytes > AUDIO_CACHE_MAX_BYTES && audioCache.size > 1)) {
      const oldest = audioCache.keys().next().value;
      if (oldest === undefined) break;
      audioCacheBytes -= audioCache.get(oldest)?.audio.length ?? 0;
      audioCache.delete(oldest);
    }
    ttsLastError = null;
    return id;
  } catch (error) {
    usageStore.record({ ...usage, ok: false });
    ttsFailureCount += 1;
    ttsLastError = error instanceof Error ? error.message : String(error);
    console.error("[bori-server] 음성 합성 실패:", ttsLastError);
    return undefined;
  }
}

loadTtsConfig();

// ── 장기 기억 ─────────────────────────────────────────────────
const memoryStore = createMemoryStore(resolve(dataRoot, "memories.json"));
let memorySettings: MemorySettings = { ...defaultMemorySettings };
const memoryConfigFile = createConfigFile(resolve(dataRoot, "memory-config.json"), "기억 설정");

function loadMemoryConfig() {
  const saved = memoryConfigFile.read();
  if (saved) {
    // retentionDays: "abc" 같은 값이 들어가면 기억 저장이 매번 조용히 실패한다. 틀린 값은 기본값으로 둔다.
    const picked = pickValidSettings<MemorySettings>(saved, patch => validateMemorySettingsPatch(patch));
    memorySettings = { ...memorySettings, ...picked.patch };
    memoryConfigFile.rejected(picked.rejected);
  }
  const removed = memoryStore.load();
  console.log(`[bori-server] 기억 ${memoryStore.count()}건 불러옴${removed > 0 ? `, 만료 ${removed}건 정리` : ""}`);
}

/** 실패하면 예외를 넘긴다. */
function saveMemoryConfig() {
  memoryConfigFile.write(memorySettings);
}

/** 임베딩은 LLM과 같은 키를 쓴다. 키가 없으면 검색이 최신·중요도 순으로 떨어진다. */
function currentEmbedding(): EmbeddingProvider | null {
  if (!memorySettings.enabled || llmApiKey.trim().length === 0) return null;
  if (llmSettings.provider !== "openai") return null;
  return trackEmbedding(createOpenAiEmbedding({ apiKey: llmApiKey, model: memorySettings.embeddingModel }), memorySettings.embeddingModel, usageStore.record);
}

loadMemoryConfig();

// ── 키워드 매크로 ─────────────────────────────────────────────
// 고유명사는 벡터 검색보다 키워드 매칭이 정확하고, 임베딩 왕복이 없어 즉시 붙는다.
// 서술형 질문은 기억 검색이 맡고, 철자가 정해진 대상만 이쪽이 맡는다.
const macroConfigPath = resolve(dataRoot, "macros.json");
const MACRO_KEYWORD_LIMIT = 5;
const MACRO_DURATION_LIMIT = 5;

let macros: MacroPrompt[] = [];
let macroLoadError: string | null = null;

/** 매크로 파일을 읽는다. 파일이 없으면 매크로를 쓰지 않는 것으로 본다. */
function loadMacros() {
  macros = [];
  macroLoadError = null;

  let raw: string;
  try {
    raw = readFileSync(macroConfigPath, "utf8");
  } catch {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as { macros?: unknown };
    if (!Array.isArray(parsed.macros)) throw new Error("macros 배열이 없습니다.");

    macros = parsed.macros.flatMap((entry, index) => {
      const item = entry as Partial<MacroPrompt>;
      const keywords = Array.isArray(item.keywords)
        ? item.keywords.filter((word): word is string => typeof word === "string" && word.trim().length > 0).slice(0, MACRO_KEYWORD_LIMIT)
        : [];
      const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
      // 키워드나 본문이 없으면 켜질 수도, 켜져도 쓸모가 없으므로 버린다.
      if (keywords.length === 0 || prompt.length === 0) return [];

      return [{
        id: typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : `macro-${index + 1}`,
        keywords: keywords.map(word => word.trim()),
        prompt,
        priority: Number.isFinite(item.priority) ? Number(item.priority) : 0,
        durationTurns: Math.min(MACRO_DURATION_LIMIT, Math.max(1, Number.isFinite(item.durationTurns) ? Number(item.durationTurns) : 3)),
      }];
    });

    console.log(`[bori-server] 매크로 ${macros.length}건 불러옴`);
  } catch (error) {
    macroLoadError = error instanceof Error ? error.message : String(error);
    console.error("[bori-server] 매크로 파일을 읽지 못했습니다:", macroLoadError);
  }
}

function macroStatus(): MacroStatus {
  return {
    loaded: macros.length,
    active: broadcastSession.activeMacros.map(entry => ({ id: entry.macro.id, remainingTurns: entry.remainingTurns })),
    path: macroConfigPath,
    error: macroLoadError,
  };
}

loadMacros();

// ── 대화 엔진 ─────────────────────────────────────────────────
// 설정은 관리자 화면에서 바뀌므로 getter로 넘겨 엔진이 매번 최신 값을 읽게 한다.
const engine = createConversationEngine({
  llmFor: mode => llmClients.llmFor(mode),
  llmSettings: () => llmSettings,
  apiKey: () => llmApiKey,
  memoryStore,
  memorySettings: () => memorySettings,
  embedding: currentEmbedding,
  macros: () => macros,
  replyCooldownMinutes: () => settings.sameReplyCooldownMinutes,
  // 누적 요약 호출을 사용량에 센다.
  createAdapter,
});
/**
 * 지금 방송의 대화 세션. 방송을 시작할 때마다 새로 만든다.
 * 이전 방송의 늦게 도착한 누적 요약은 버려진 옛 세션에 써질 뿐 이 세션에 닿지 않는다.
 */
let broadcastSession: ConversationSession = engine.createSession("broadcast");

// ── 1:1 대화 ──────────────────────────────────────────────────
// 방송 상태·큐·방송 세션은 넘기지 않는다. 음성은 같은 합성 경로를 쓰되 방송 currentAudioId에는 쓰지 않는다.
const handleCompanionRoute = createCompanionHandler({
  filePath: resolve(dataRoot, "companion-conversations.json"),
  engine,
  memoryStore,
  memorySettings: () => memorySettings,
  embedding: currentEmbedding,
  // 1:1 음성은 사용량에 companion으로 센다.
  prepareAudio: text => prepareAudio(text, "companion"),
  // LLM 기억 정리는 1:1 회로가 열려 있으면 건너뛴다. 방송 회로와는 상관없다.
  digestMemories: createPrivateMemoryDigest({
    llmSettings: () => llmSettings,
    apiKey: () => llmApiKey,
    isCircuitOpen: () => llmClients.llmFor("companion").isCircuitOpen(),
    createAdapter: trackedAdapterFactory("digest"),
  }),
});

// ── 방송 진행 상황 ────────────────────────────────────────────
// 모델은 대화 텍스트만 보고 경과 시간이나 답변 수를 셀 수 없다.
// 세라고 지시하는 대신 서버가 계산한 값을 문장으로 넘긴다.
let sessionStartedAt = 0;
let answeredCount = 0;

/**
 * 보리에게 주는 방송 상황 줄. 코너 안내 줄은 채팅 답에만 넣는다(forChat).
 * 진행 대사·전적 분석에 넣었더니 "!전적 닉네임을 적어 주세요" 안내만 되풀이하고 전적을 정리하지 않았다(2026-10-15 리허설).
 */
function broadcastStatusLines(options: { forChat?: boolean } = {}): string[] {
  if (state.status !== "live" || sessionStartedAt === 0) return [];

  const minutes = Math.floor((Date.now() - sessionStartedAt) / 60_000);
  const lines = [minutes < 1 ? "방송을 막 시작했다." : `방송을 시작한 지 ${minutes}분 지났다.`];
  if (answeredCount > 0) lines.push(`지금까지 채팅 ${answeredCount}개에 답했다.`);
  const corner = options.forChat ? CORNER_LINES[show.view().stage] : undefined;
  if (corner) lines.push(corner);
  // 채팅이 몰릴 때 보리가 분위기를 알고 이끌 수 있게 기다리는 채팅 수를 알려 준다. 다른 시청자의 글은 넣지 않는다.
  if (options.forChat && queue.length > 0) lines.push(`답을 기다리는 다른 채팅이 ${queue.length}개 더 있다. 고른 채팅에 답하되 채팅창 분위기를 짧게 받아도 된다.`);
  return lines;
}

/**
 * 지금 코너를 보리에게 알려 주는 줄. 코너에 맞지 않는 채팅에도 답은 하되 코너로 이끈다.
 * 전적 진단 코너는 전적을 보는 시간이라 캐릭터 질문으로 다루지 않는다(2026-10-15 사용자 결정).
 */
const CORNER_LINES: Partial<Record<ShowStage, string>> = {
  opening: "지금은 방송을 여는 오프닝이다.",
  briefing: "지금은 랭커 데이터 TOP 5를 보는 메타 브리핑 코너다.",
  qna: "지금은 질문 코너다. 캐릭터나 메타 질문에는 [게임 데이터]가 있으면 그 수치로 답한다.",
  diagnosis: "지금은 전적 진단 코너다. 캐릭터를 묻는 채팅에는 짧게만 답하고, 채팅에 '!전적 닉네임'을 적으면 전적을 봐 준다고 안내한다.",
};

/** 캐릭터 질문으로 보고 [게임 데이터]를 붙이는 단계. 전적 진단은 전적을 보는 코너라 넣지 않는다. */
const CHARACTER_QUESTION_STAGES: ReadonlySet<ShowStage> = new Set(["opening", "briefing", "qna"]);

let state: BroadcastState = { status: "idle", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };

/**
 * 이번 방송에서 답하지 않고 버린 채팅 수(이유별). 방송을 시작할 때 0으로 돌린다(a4 A4-04).
 * queueLimit: 큐 상한, viewerLimit: 한 시청자 대기 상한, expired: 오래 기다려 만료, duplicate: 같은 시청자의 같은 문장, blocked: 위험 입력.
 */
type DroppedChats = { queueLimit: number; viewerLimit: number; expired: number; duplicate: number; blocked: number };
const noDroppedChats = (): DroppedChats => ({ queueLimit: 0, viewerLimit: 0, expired: 0, duplicate: 0, blocked: 0 });
let droppedChats = noDroppedChats();

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "").trim();

/**
 * 방송 채팅 최대 길이(글자). 1:1 메시지(MESSAGE_MAX_LENGTH)와 같은 500자다.
 * 전에는 본문 한도(64KB)까지 받아 2만 자 채팅이 방송 화면 상태와 LLM 프롬프트에 그대로 실렸다(a1 M3, a4 A4-11).
 */
const CHAT_MAX_LENGTH = 500;
/** 닉네임 최대 길이(글자). 방송 화면·채팅 창 입력칸의 maxLength와 같다. 넘으면 자르지 않고 거절한다. */
const NICKNAME_MAX_LENGTH = 20;

/** 닉네임 정리. 제어문자를 지우고 줄바꿈·탭은 공백으로, 유니코드는 NFC로 맞춘다. */
const nicknameOf = (value: string) => cleanInputText(value).replace(/[\t\n]/g, " ").normalize("NFC").trim();

/**
 * 닉네임에서 시청자 ID를 만든다. 대소문자와 가운데 공백은 그대로 둔다(B-4).
 * 전에는 소문자로 바꾸고 공백을 지우고 20자로 잘라서 "Byeol"과 "byeol", "달빛"과 "달 빛"이 같은 시청자가 되어
 * 남의 방송 기억이 열렸다(a4 A4-07). 이제 길이를 넘으면 자르지 않고 거절한다.
 * 전과 같은 꼴(소문자, 공백 없음, 20자 이하)의 닉네임은 ID가 그대로라 기존 시청자 기억과 이어진다.
 * 대문자나 공백이 든 닉네임의 예전 기억은 새 ID와 이어지지 않는다. 옛 ID는 정보가 지워진 값이라 되돌릴 수 없다.
 */
const viewerIdOf = (nickname: string) => `local:${nickname}`;
/**
 * 큐에서 기다릴 수 있는 시간. 지나면 답하지 않고 버린다(a4 A4-03).
 * 답 하나에 대기·생성·말풍선으로 10초 남짓이 걸려 분당 5~8건을 답한다. 1분 넘은 채팅은 방송 흐름이 이미 지나가
 * 답이 엉뚱하게 들리고, 만료가 없던 장애 soak에서는 105초 지난 채팅에 답했다.
 * 질문 우선 순서(QUEUE_WAIT_LIMIT_MS 30초)보다 길게 둬서, 오래 기다린 채팅이 맨 앞으로 올라온 뒤 답할 기회가 있다.
 */
const CHAT_TTL_MS = 60_000;
/**
 * 한 시청자가 큐에 둘 수 있는 채팅 수. 넘치면 그 시청자의 가장 오래된 채팅을 버린다(a4 A4-05).
 * 문장만 바꿔 도배하면 큐를 차지해 다른 시청자 채팅이 밀리다 버려졌다. 3건이면 30초 남짓의 답 몫이고,
 * 가장 최근 말은 남긴다. 익명 채팅(관리자 테스트 입력)도 한 시청자로 본다.
 */
const VIEWER_QUEUE_LIMIT = 3;

/** 만료된 채팅을 큐에서 뺀다. 만료는 큐에 들어온 순서라 앞에서부터 본다. */
function dropExpiredChats(now = Date.now()) {
  while (queue.length > 0 && now - Date.parse(queue[0].receivedAt) >= CHAT_TTL_MS) {
    queue.shift();
    droppedChats.expired += 1;
  }
}

/** 같은 문장이 duplicateWindowMinutes 안에 이미 들어왔는지 본다. 창 밖의 같은 문장은 새 채팅으로 받는다. */
function isDuplicateChat(key: string): boolean {
  const windowMs = Math.max(0, settings.duplicateWindowMinutes) * 60_000;
  const now = Date.now();

  // 창을 넘긴 기록은 여기서 같이 지운다. 긴 방송에서 맵이 무한정 커지지 않게 하기 위한 것이다.
  for (const [seen, at] of recentContents) {
    if (now - at >= windowMs) recentContents.delete(seen);
  }

  const last = recentContents.get(key);
  return last !== undefined && now - last < windowMs;
}

/**
 * 채팅이 없을 때 하는 혼잣말. 초기에는 규칙 문장만 쓰고 기억 기반 혼잣말은 나중에 연결한다.
 */
const monologues: readonly { reply: string; emotion: string; motion?: string }[] = [
  { reply: "오늘은 채팅이 조금 조용하네요. 다들 뭐 하고 계실까요.", emotion: "calm" },
  { reply: "이렇게 가만히 있으면 시간이 참 빨리 가요.", emotion: "calm" },
  { reply: "요즘 들을 만한 노래를 찾고 있어요. 좋은 거 있으면 알려주세요.", emotion: "happy", motion: "xingxingyan" },
  { reply: "게임 이야기 하고 싶어지는 날이에요.", emotion: "gaming", motion: "shoushi" },
  { reply: "방송 준비하면서 오늘 무슨 이야기를 할까 계속 생각했어요.", emotion: "curious" },
  { reply: "여러분이 편하게 들를 수 있는 방송이면 좋겠어요.", emotion: "happy", motion: "xingxingyan" },
  { reply: "가끔은 이렇게 조용한 시간도 나쁘지 않네요.", emotion: "calm" },
];

/**
 * 코너별 혼잣말. 채팅이 조용할 때 그 코너에 맞게 참여를 이끈다(2026-10-15 사용자 요청). 없는 코너는 위의 일반 혼잣말을 쓴다.
 * 코너 안내 문장(stages.ts)과 같은 내용을 되풀이하지 않게 표현을 바꿨다.
 */
const cornerMonologues: Partial<Record<ShowStage, readonly { reply: string; emotion: string; motion?: string }[]>> = {
  briefing: [
    { reply: "TOP 5 보니까 요즘 랭커들 취향이 보이는 것 같아요.", emotion: "curious" },
    { reply: "평균 순위랑 픽률을 같이 보면 재밌는 게 많아요.", emotion: "gaming", motion: "shoushi" },
  ],
  qna: [
    { reply: "궁금한 캐릭터 있으면 이름만 적어 주셔도 돼요!", emotion: "happy", motion: "xingxingyan" },
    { reply: "요즘 메타가 궁금하시면 편하게 물어봐 주세요.", emotion: "calm" },
    { reply: "자주 하시는 캐릭터가 요즘 어떤지 같이 봐요!", emotion: "gaming", motion: "shoushi" },
  ],
  diagnosis: [
    { reply: "채팅에 느낌표 전적, 그리고 닉네임을 적어 주시면 바로 봐 드릴게요.", emotion: "happy", motion: "xingxingyan" },
    { reply: "최근 경기가 어땠는지 궁금하시면 전적 명령어로 불러 주세요!", emotion: "curious" },
  ],
};

function makeMonologue(): CharacterResponse {
  const pool = cornerMonologues[show.view().stage] ?? monologues;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return {
    reply: engine.pickReply(broadcastSession, [chosen.reply]),
    emotion: { primary: chosen.emotion, intensity: 0.35, durationSeconds: 7 },
    actions: chosen.motion ? bodyAction(chosen.motion, 1) : [],
    source: "monologue",
  };
}

function syncQueueState() { state = { ...state, queueSize: queue.length }; }

/**
 * 방송이 끝나면 대화에서 기억 후보를 뽑아 저장한다.
 * 규칙으로 먼저 걸러 낸 뒤 저장 직전에 한 번 더 검사한다.
 */
async function persistSessionMemories(session: ConversationSession) {
  // 끝난 방송의 세션을 받는다. 저장하는 사이 방송을 다시 시작해도 새 세션의 대화가 섞이지 않는다.
  // 위기 채팅은 기록하지 않지만, 혹시 남은 위기 대화가 있어도 요약·기억 후보로 넘기지 않는다(S-3).
  const sessionTurns = withoutCrisisTurns(session.sessionTurns);
  if (!memorySettings.enabled || sessionTurns.length === 0) return;
  // 이번 방송 시청자의 닉네임. 요약에 닉네임이 들어가면 특정 시청자에 관한 문장이라 공용 기억으로 남기지 않는다.
  const nicknames = [...new Set(sessionTurns.flatMap(turn => (turn.viewerId?.startsWith("local:") ? [turn.viewerId.slice("local:".length)] : [])))];
  // 소유자 없는 방송 기억으로 남겨도 되는 문장인지. 시청자 개인 사실·주장·기억 요구는 버린다(B-2·B-3).
  const isSharedMemory = (text: string) => isStorableMemory(text) && isBroadcastMemoryText(text, nicknames);

  // 익명 발언은 누구의 기억인지 알 수 없어 후보에서 빠진다.
  const candidates = extractMemoryCandidates(sessionTurns)
    .filter(candidate => isStorableMemory(candidate.text));

  // 방송 전체 요약은 LLM이 만든다. 실패해도 규칙으로 뽑은 후보는 그대로 저장한다.
  if (llmSettings.enabled && llmApiKey.trim().length > 0) {
    const adapter = createAdapter(llmSettings.provider, { apiKey: llmApiKey, model: llmSettings.model });
    if (adapter) {
      try {
        const summary = await summarizeBroadcast(adapter, sessionTurns, { timeoutMs: Math.max(llmSettings.timeoutMs, 15_000) });
        if (summary) {
          // 요약도 저장 직전에 위험 내용을 한 번 더 검사한다.
          if (isSharedMemory(summary.summary)) {
            candidates.push({ text: summary.summary, kind: "broadcast", scope: "broadcast", importance: 0.7, confidence: 0.8 });
          }
          for (const highlight of summary.highlights) {
            if (isSharedMemory(highlight)) {
              candidates.push({ text: highlight, kind: "broadcast", scope: "broadcast", importance: 0.6, confidence: 0.75 });
            }
          }
          console.log(`[bori-server] 방송 요약 생성 (하이라이트 ${summary.highlights.length}건)`);
        }
      } catch (error) {
        console.error("[bori-server] 방송 요약 실패:", error);
      }
    }
  }

  if (candidates.length === 0) {
    console.log("[bori-server] 저장할 기억 후보가 없습니다.");
    return;
  }

  try {
    const saved = await memoryStore.add(candidates, memorySettings, currentEmbedding());
    console.log(`[bori-server] 기억 ${saved}건 저장 (후보 ${candidates.length}건)`);
  } catch (error) {
    console.error("[bori-server] 기억 저장 실패:", error);
  }
}

function cancelMonologue() {
  if (monologueTimer) clearTimeout(monologueTimer);
  monologueTimer = undefined;
}

/**
 * 발화권을 잡고 답변을 화면에 올린다. 표시가 끝나면 다음 발화를 예약한다.
 * 음성이 있으면 말풍선과 같이 시작하도록 audioId를 함께 넘긴다.
 */
function speak(response: CharacterResponse, audioId?: string) {
  speaking = true;
  cancelMonologue();
  // 표정 문제를 되짚을 수 있게 고른 감정·모션 이름만 남긴다. 대사 내용은 남기지 않는다.
  console.log(`[bori-server] 보리 표정: ${response.emotion.primary}, 모션: ${response.actions.map(action => action.name).join(",") || "없음"} (${response.source})`);
  // 음성이 있으면 실제 음성 길이만큼 말풍선을 둔다. 전에는 글자 수로 어림해(글자당 110ms, 최대 15초) 긴 답의 음성이 잘렸다(a4 A4-12).
  const audioMs = audioId ? audioCache.get(audioId)?.durationMs : undefined;
  const displayMs = audioMs !== undefined ? Math.max(RESPONSE_DISPLAY_MS, Math.min(AUDIO_DISPLAY_MAX_MS, audioMs + AUDIO_DISPLAY_TAIL_MS)) : RESPONSE_DISPLAY_MS;
  state = { ...state, currentResponse: response, currentEmotion: response.emotion.primary, currentAudioId: audioId, currentSpeechMs: audioMs ?? displayMs };
  // 표시가 끝나기 전에 방송을 다시 시작하면 이 타이머는 이전 세션 것이다.
  // 세대를 보지 않으면 새 세션이 막 올린 말풍선을 지워 버린다.
  const generation = sessionGeneration;

  setTimeout(() => {
    if (generation !== sessionGeneration) return;
    state = { ...state, currentResponse: undefined, currentAudioId: undefined, currentSpeechMs: undefined };
    speaking = false;
    scheduleNext();
    scheduleMonologue();
  }, displayMs);
}

/** 진행기(오프닝 시작)로 연 방송인지. 진행기 없이 연 방송(/api/session/start)은 대기 단계에서도 예전처럼 답한다. */
let showDriven = false;

/**
 * 대기·엔딩 장면에서는 보리가 채팅에 답하지 않고 혼잣말도 하지 않는다(사용자 결정 2026-10-15).
 * 그 사이 들어온 채팅은 대기열에 남았다가 만료되면 버려진다. 이전 단계로 돌아가면 다시 답한다.
 */
function boriQuiet(): boolean {
  const stage = show.view().stage;
  return stage === "ending" || (stage === "idle" && showDriven) || show.isLeaving();
}

/**
 * 채팅이 없을 때만 혼잣말을 예약한다.
 * 대기 중에 채팅이 들어오면 취소하므로 새 채팅 반응이 항상 우선이다.
 */
function scheduleMonologue() {
  if (monologueTimer || !settings.monologueEnabled) return;
  if (state.status !== "live" || speaking || showHold > 0 || queue.length > 0 || boriQuiet() || autopilot.holding()) return;

  const min = settings.monologueMinSeconds;
  const max = Math.max(min, settings.monologueMaxSeconds);
  const delay = (min + Math.random() * (max - min)) * 1000;

  monologueTimer = setTimeout(() => {
    monologueTimer = undefined;
    // 기다리는 동안 채팅이 들어왔거나 이미 말하고 있으면 혼잣말을 건너뛴다.
    if (state.status !== "live" || speaking || showHold > 0 || queue.length > 0 || boriQuiet() || autopilot.holding()) { scheduleNext(); return; }

    const monologue = makeMonologue();
    const generation = sessionGeneration;
    const session = broadcastSession;
    speaking = true;
    void prepareAudio(monologue.reply)
      .then(audioId => {
        // 기다리는 사이 방송이 끝났거나 다시 시작했으면 버린다. 발화권은 시작·종료가 이미 풀었다.
        // 여기서 풀면 새 세션이 답변을 만드느라 쥔 발화권을 빼앗아 다음 답변이 겹쳐 시작된다.
        if (generation !== sessionGeneration) return;
        if (state.status !== "live") { speaking = false; return; }
        // 혼잣말도 방송에 나간 발화다. 기록하지 않으면 보리가 방금 한 말을 스스로 모른다.
        engine.record(session, { role: "bori", text: monologue.reply });
        speak(monologue, audioId);
      })
      .catch(error => {
        console.error("[bori-server] 혼잣말 처리 실패:", error);
        if (generation !== sessionGeneration) return;
        speaking = false;
        scheduleNext();
      });
  }, delay);
}
/**
 * 다음 답변을 예약한다.
 *
 * 사람처럼 보이려고 두는 5~10초 대기와 LLM·TTS 호출을 겹쳐서 돌린다.
 * 예전에는 대기가 끝난 뒤에야 호출을 시작해서 둘이 그대로 더해졌다.
 * 지금은 둘 중 늦은 쪽만큼만 걸리므로, 대기 시간 안에 끝나는 호출은 지연이 0이 된다.
 *
 * 대신 답변할 채팅을 대기 전에 고르게 되므로, 대기 중에 들어온 채팅은
 * 이번 차례의 후보가 아니라 다음 차례로 넘어간다.
 */
/**
 * 채팅이 들어온 코너(진행기 단계 세대). 코너가 바뀌면 지난 코너 채팅은 읽지 않는다(2026-10-15 사용자 결정).
 * 채팅은 코너 시간에 맞춰 들어오므로 지난 코너 채팅에 늦게 답하면 흐름이 어긋난다.
 */
const chatCorner = new WeakMap<ChatMessage, number>();

/** 지난 코너에 들어온 채팅을 대기열에서 버린다. 만료와 같이 센다. */
function dropPastCornerChats() {
  const epoch = show.epoch();
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (chatCorner.get(queue[index]) === epoch) continue;
    queue.splice(index, 1);
    droppedChats.expired += 1;
  }
}

/** 진행기 방송의 채팅 답 대기(초). 설정값이 더 짧으면 설정값을 쓴다. */
const SHOW_RESPONSE_DELAY_SECONDS = { min: 1, max: 2 };

/** 인사 채팅. 오프닝에서 먼저 받는다. */
const GREETING = /안녕|하이|ㅎㅇ|반가|하잉|방가|\bhi\b|hello/i;

/**
 * 지금 코너에 맞는 채팅일수록 높은 점수. 시끌벅적한 채팅에서 보리가 코너에 맞는 채팅을 골라 흐름을 이끈다(2026-10-15 사용자 요청).
 * 오프닝은 인사, 브리핑·질문은 캐릭터·메타 이야기, 전적 진단은 전적 이야기를 먼저 고른다. 그다음은 질문, 나머지 순이다.
 */
function chatRelevance(content: string): number {
  const question = isQuestion(content) ? 1 : 0;
  const dictionary = erData.dictionary();
  const aboutGame = isMetaQuestion(content) || (dictionary !== null && findCharacter(content, dictionary).match !== null);
  switch (show.view().stage) {
    case "opening": return GREETING.test(content) ? 3 : question;
    case "briefing":
    case "qna": return aboutGame ? 3 + question : question;
    case "diagnosis": return /전적/.test(content) ? 3 : question;
    default: return question;
  }
}

function scheduleNext() {
  // 코너 시간이 다 됐으면 새 답을 시작하지 않는다. 자동 진행이 연결 멘트 뒤 다음 코너로 넘긴다.
  if (responseTimer || speaking || showHold > 0 || state.status !== "live" || boriQuiet() || autopilot.holding()) return;
  dropExpiredChats();
  dropPastCornerChats();
  syncQueueState();
  if (queue.length === 0) return;

  // 질문을 먼저 고르되, 오래 기다린 채팅은 질문에 밀리지 않게 한다.
  const chat = queue.splice(pickNextChatIndex(queue, Date.now(), chatRelevance), 1)[0];
  syncQueueState();

  // 생성이 끝나기 전에 혼잣말이 끼어들지 않도록 발화권을 먼저 잡는다.
  speaking = true;
  cancelMonologue();
  const generation = sessionGeneration;
  const session = broadcastSession;
  answering = { chat, session };
  // 답을 만드는 사이 코너가 바뀌면 이 답은 내보내지 않는다.
  const corner = show.epoch();

  // 진행기 방송은 코너 시간이 정해져 있어 "사람처럼" 기다리는 시간을 1~2초로 줄인다. 5~10초씩 기다리면 질문 코너에서 질문을 다 못 받았다(2026-10-15 리허설).
  const min = showDriven ? Math.min(settings.responseDelayMinSeconds, SHOW_RESPONSE_DELAY_SECONDS.min) : settings.responseDelayMinSeconds;
  const max = Math.max(min, showDriven ? Math.min(settings.responseDelayMaxSeconds, SHOW_RESPONSE_DELAY_SECONDS.max) : settings.responseDelayMaxSeconds);
  const delay = (min + Math.random() * (max - min)) * 1000;
  const waited = new Promise<void>(resolve => {
    finishResponseWait = resolve;
    responseTimer = setTimeout(() => { responseTimer = undefined; finishResponseWait = undefined; resolve(); }, delay);
  });

  // 방송 진행기가 켜져 있으면 채팅에서 캐릭터를 찾아 수치 줄을 붙인다. 진행기를 쓰지 않는 방송(idle)은 지금처럼 답한다.
  const game = CHARACTER_QUESTION_STAGES.has(show.view().stage) ? buildGameData(chat.content, erContext()) : null;

  // 답변과 음성을 대기와 나란히 만든다. 실패는 각 함수가 안에서 처리한다.
  // 익명 채팅은 화자를 모르는 발언으로 넘겨 어떤 시청자의 기억도 꺼내지 않게 한다.
  const prepared = engine.respond(session, {
    content: chat.content,
    speaker: { ownerId: isAnonymousViewer(chat.viewerId) ? null : chat.viewerId },
    statusLines: broadcastStatusLines({ forChat: true }),
    ...(game ? { gameData: game.lines } : {}),
  }).then(async outcome => {
    // 만드는 사이 방송이 끝났거나 다시 시작했으면 음성도 오류 표시도 만들지 않는다. 답변은 아래에서 버린다.
    if (generation !== sessionGeneration) return null;
    // 차단된 채팅에는 보리가 무반응한다.
    if (outcome.kind === "blocked") return null;
    // 실패는 관리자에게만 알리고 방송은 폴백 문장으로 이어간다. LLM이 다시 답하면 지난 실패는 지운다(a4 A4-10).
    if (outcome.failure) state = { ...state, lastError: `LLM 실패: ${outcome.failure.reason}` };
    else if (outcome.response.source === "llm") state = { ...state, lastError: null };
    return { response: outcome.response, crisis: outcome.crisis === true, audioId: await prepareAudio(outcome.response.reply) };
  });

  void Promise.all([prepared, waited])
    .then(([result]) => {
      // 만드는 사이에 방송이 끝났거나 다시 시작했으면 이전 세션의 답변이므로 버린다.
      // 시청자 발언은 방송을 끝낼 때 이미 그 세션에 남겼다(recordUnanswered).
      if (generation !== sessionGeneration) return;
      answering = undefined;
      if (state.status !== "live") { speaking = false; return; }
      if (corner !== show.epoch()) {
        speaking = false;
        droppedChats.expired += 1;
        scheduleNext();
        scheduleMonologue();
        return;
      }

      if (!result) {
        // 차단된 채팅은 조용히 넘기고 다음 후보로 넘어간다.
        speaking = false;
        droppedChats.blocked += 1;
        state = { ...state, unprocessedCount: state.unprocessedCount + 1 };
        scheduleNext();
        scheduleMonologue();
        return;
      }

      // 위기 채팅과 그 안내는 방송 문맥·요약·기억 후보에 남기지 않는다(ADR-022). 공개 자리라 다음 답에서 되풀이하지 않게 한다.
      if (!result.crisis) {
        engine.record(session, { role: "viewer", text: chat.content, viewerId: chat.viewerId });
        engine.record(session, { role: "bori", text: result.response.reply });
      }
      answeredCount += 1;
      // 답변이 실제로 나갔을 때만 매크로 수명을 줄인다.
      engine.tickMacros(session);
      // 캐릭터 질문 단계에서는 답과 함께 캐릭터 카드를 띄운다.
      if (game?.view && !result.crisis && show.view().stage === "qna") show.showCharacter(game.view);

      speak(result.response, result.audioId);
    })
    .catch(error => {
      // 여기까지 온 예외는 예상하지 못한 것이다.
      // 발화권을 놓지 않으면 방송이 그대로 멈추므로 반드시 풀어 준다.
      console.error("[bori-server] 답변 처리 실패:", error);
      // 끝난 방송의 실패는 관리자 화면에 새로 띄우지 않는다.
      if (generation !== sessionGeneration) return;
      answering = undefined;
      state = { ...state, lastError: `답변 처리 실패: ${error instanceof Error ? error.message : String(error)}` };
      speaking = false;
      scheduleNext();
      scheduleMonologue();
    });
}

/** 답변 대기를 취소한다. 대기도 끝내 두어 그 대기를 기다리던 처리가 세대 확인에서 정리되게 한다(a4 A4-16). */
function cancelResponseWait() {
  if (responseTimer) clearTimeout(responseTimer);
  responseTimer = undefined;
  finishResponseWait?.();
  finishResponseWait = undefined;
}

/**
 * 답을 만드는 중에 방송이 끝난 채팅의 시청자 발언을 그 세션 기록에 남긴다(a4 A4-19). 기억 후보는 시청자 발언에서 뽑는다.
 * 답은 화면에 나가지 않았으므로 남기지 않는다. 위험·위기 입력은 답했어도 기록하지 않는 입력이라 여기서도 뺀다.
 * engine.record는 쓰지 않는다. 끝나는 세션에 누적 요약 호출을 새로 걸지 않게 기록만 더한다.
 */
function recordUnanswered() {
  const pending = answering;
  answering = undefined;
  if (!pending || isUnsafeContent(pending.chat.content) || isCrisisContent(pending.chat.content)) return;
  pending.session.sessionTurns.push({ role: "viewer", text: pending.chat.content, viewerId: pending.chat.viewerId });
}

/**
 * 방송을 끝내고 그 세션의 대화로 기억을 저장한다. 방송 중이 아니면 아무것도 하지 않고 false다.
 * 종료를 두 번 부르면 같은 대화를 다시 저장해 repeatCount·importance가 부풀고 요약 LLM을 다시 불렀다(a4 A4-06).
 */
function endBroadcast(): boolean {
  if (state.status !== "live") return false;
  sessionGeneration += 1;
  queue.length = 0;
  speaking = false;
  showDriven = false;
  const endedSession = broadcastSession;
  // 대화 기록은 기억 저장에 써야 하므로 세션은 그대로 두고 매크로만 내린다.
  engine.clearMacros(endedSession);
  cancelResponseWait();
  recordUnanswered();
  cancelMonologue();
  // 채팅 목록도 비운다. 끝난 방송 화면에 지난 채팅이 계속 보였다(a4 A4-23).
  state = { ...state, status: "ended", queueSize: 0, currentResponse: undefined, currentAudioId: undefined, currentSpeechMs: undefined, currentEmotion: "calm", visibleChats: [], visibleChatCount: 0 };
  // 기억 저장은 오래 걸릴 수 있으므로 응답을 막지 않는다.
  void persistSessionMemories(endedSession);
  // 방송이 끝나면 진행기도 처음(대기 장면)으로 돌린다. 진행 중이던 대사는 세대가 바뀌어 버려진다.
  void show.reset();
  return true;
}

/**
 * 방송을 시작한다. 방송 중에 다시 부르면 진행 중인 방송을 먼저 정상 종료해 그 대화를 기억으로 저장한다.
 * 전에는 세션을 바로 갈아 끼워 진행 중이던 대화가 기억 저장 없이 버려졌다(a4 A4-02). 관리자 창 둘·더블클릭·직접 호출에서 생긴다.
 */
function startBroadcast() {
  endBroadcast();
  // 세대를 올려 진행 중이던 이전 세션의 비동기 응답을 무효화한다.
  sessionGeneration += 1;
  queue.length = 0;
  recentContents.clear();
  // 대화 문맥·누적 요약·매크로·문장 쿨다운은 방송 단위다. 세션을 새로 만들어 이전 방송의 흐름을 끌고 오지 않는다.
  broadcastSession = engine.createSession("broadcast");
  // 진행 상황도 방송마다 새로 센다.
  sessionStartedAt = Date.now();
  answeredCount = 0;
  droppedChats = noDroppedChats();
  speaking = false;
  cancelResponseWait();
  cancelMonologue();
  // 지난 방송의 오류는 새 방송에서 지운다. 남아 있으면 지금 일어난 오류처럼 보인다(a4 A4-10).
  state = { ...state, status: "live", currentEmotion: "calm", currentResponse: undefined, currentAudioId: undefined, currentSpeechMs: undefined, visibleChats: [], visibleChatCount: 0, queueSize: 0, unprocessedCount: 0, lastError: null };
  scheduleMonologue();
}

/** 채팅을 받지 않은 이유. 화면·관리자가 이유별로 안내할 수 있게 나눈다(a4 A4-20). */
type ChatRejection = { code: "invalid" | "invalid_text" | "too_long" | "nickname_too_long" | "empty" | "not_live" | "duplicate"; error: string };

/** 방송 화면 채팅 띠에 한 줄 올린다. 화면에 필요한 값만 담는다. */
function pushVisibleChat(visible: VisibleChat) {
  state = { ...state, visibleChats: [...state.visibleChats, visible].slice(-settings.visibleChatLimit), visibleChatCount: Math.min(state.visibleChatCount + 1, settings.visibleChatLimit) };
}

/**
 * 방송 채팅 하나를 검사해 큐에 넣는다. 받지 않으면 이유를 돌려준다.
 * 검사·중복·시청자별 상한·만료·큐 상한을 이 함수 한곳에서 처리한다. 받은 뒤 큐에서 밀려난 채팅은 droppedChats에 센다.
 * 관리자 테스트 채팅(/api/chat)과 치지직 채팅이 같은 함수를 쓴다. source는 서버가 정하고 요청 본문에서 받지 않는다.
 */
function ingestChat(input: { content?: unknown; nickname?: unknown }, source: ChatSource = "manual"): ChatRejection | null {
  if (typeof input.content !== "string" || (input.nickname !== undefined && typeof input.nickname !== "string")) {
    return { code: "invalid", error: "content와 nickname은 문자열이어야 합니다." };
  }
  // 제어문자·방향 바꿈 문자는 화면·프롬프트에 나가기 전에 지운다(B-5).
  const content = cleanInputText(input.content).trim();
  if (lengthOf(content) > CHAT_MAX_LENGTH) return { code: "too_long", error: `채팅은 ${CHAT_MAX_LENGTH}자 이하여야 합니다.` };
  const nickname = nicknameOf(input.nickname ?? "");
  if (lengthOf(nickname) > NICKNAME_MAX_LENGTH) return { code: "nickname_too_long", error: `닉네임은 ${NICKNAME_MAX_LENGTH}자 이하여야 합니다.` };
  if (!content) return { code: "empty", error: "빈 채팅은 받지 않습니다." };
  // 다른 인코딩으로 보낸 한글은 본문을 읽을 때 U+FFFD로 바뀐다. 깨진 글자를 방송 화면·프롬프트에 내보내지 않는다.
  if (content.includes("�")) return { code: "invalid_text", error: "글자가 깨진 채팅은 받지 않습니다. UTF-8로 보내 주세요." };
  if (state.status !== "live") return { code: "not_live", error: "방송 중이 아니라 채팅을 받지 않습니다." };
  // 방송 진행 중의 명령(!전적)은 큐에 넣지 않는다. 화면 채팅 띠에는 명령 처리기가 닉네임을 가린 한 줄만 올린다.
  if (show.view().stage !== "idle" && playerCommand.handle(content)) return null;

  const viewerId = nickname ? viewerIdOf(nickname) : "virtual-viewer";
  // 중복은 같은 시청자의 같은 문장만이다. 다른 시청자가 같은 인사를 하면 각자의 채팅이다(a4 A4-20).
  const key = `${viewerId}\n${normalize(content)}`;
  if (isDuplicateChat(key)) {
    droppedChats.duplicate += 1;
    return { code: "duplicate", error: "같은 채팅이 방금 들어왔습니다." };
  }
  recentContents.set(key, Date.now());

  // 닉네임은 내부 사용자 ID로만 쓴다. 방송 화면에는 내보내지 않는다.
  const chat: ChatMessage = {
    id: randomUUID(),
    viewerId,
    ...(nickname ? { viewerNickname: nickname } : {}),
    content,
    receivedAt: new Date().toISOString(),
    source,
    category: isQuestion(content) ? "question" : "normal",
  };

  // 방송 화면에 넘기는 목록에는 화면에 필요한 값만 담는다.
  // viewerId도 닉네임에서 만든 값이라 함께 빼야 닉네임이 드러나지 않는다.
  pushVisibleChat({ id: chat.id, content: chat.content, receivedAt: chat.receivedAt, ...(chat.category ? { category: chat.category } : {}) });
  // "ㅋㅋㅋ" 같은 반응은 채팅 띠에만 보이고 보리 답 큐에는 넣지 않는다.
  if (isChatter(chat.content)) return null;

  dropExpiredChats();
  // 한 시청자가 큐를 차지하지 못하게, 그 시청자의 대기가 상한이면 가장 오래된 것을 버리고 새 채팅을 받는다.
  const mine = queue.filter(item => item.viewerId === viewerId);
  if (mine.length >= VIEWER_QUEUE_LIMIT) {
    queue.splice(queue.indexOf(mine[0]), 1);
    droppedChats.viewerLimit += 1;
  }
  // 상한을 줄였으면 큐가 이미 넘쳐 있을 수 있으므로 상한 안으로 들어올 때까지 오래된 것부터 버린다.
  while (queue.length >= settings.maxQueueSize) {
    queue.shift();
    droppedChats.queueLimit += 1;
  }
  chatCorner.set(chat, show.epoch());
  queue.push(chat);
  syncQueueState();
  cancelMonologue();
  scheduleNext();
  return null;
}

// ── 방송 진행기와 외부 연동(W4) ──────────────────────────────
// 진행 단계·OBS 장면·대시보드는 show/, OBS 제어는 obs/에 있다. 여기서는 만들고 잇기만 한다.

/** 양의 정수 환경 변수. 없거나 틀리면 기본값. */
const positiveIntEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const erApiKey = process.env.ER_API_KEY ?? "";
/** 메타 집계 규모. 전체는 랭커 100명·3판(개인 키 초당 1회라 몇 분 걸린다). 확인용으로 줄일 수 있다. */
const erData = createErData({
  dataDir: dataRoot,
  client: erApiKey ? createErClient({ apiKey: erApiKey, ...(process.env.BORI_ER_BASE_URL ? { baseUrl: process.env.BORI_ER_BASE_URL } : {}) }) : null,
  rankers: positiveIntEnv("BORI_ER_RANKERS", 100),
  gamesPerRanker: positiveIntEnv("BORI_ER_GAMES_PER_RANKER", 3),
});
erData.load();
const erContext = () => ({ dictionary: erData.dictionary(), stats: erData.stats(), basis: erData.basis() });

// OBS는 비밀번호가 있을 때만 연결한다. 없으면 장면 전환 없이 진행한다(off).
const obsPassword = process.env.OBS_WEBSOCKET_PASSWORD ?? "";
const obs = createObsController({ url: process.env.OBS_WEBSOCKET_URL ?? "ws://127.0.0.1:4455", password: obsPassword });
if (obsPassword) obs.connect();

/** 진행 대사가 지금 답이 끝나기를 기다리는 최대 시간. 넘으면 그 대사는 버린다. */
const SHOW_FLOOR_WAIT_MS = 60_000;
const SHOW_FLOOR_POLL_MS = 100;

/** 지금 말하는 답이 끝날 때까지 기다린다. 그 사이 방송이 끝났거나 단계가 바뀌면 false. */
async function waitForFloor(generation: number, isCurrent: () => boolean): Promise<boolean> {
  const deadline = Date.now() + SHOW_FLOOR_WAIT_MS;
  while (speaking) {
    if (generation !== sessionGeneration || !isCurrent() || Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, SHOW_FLOOR_POLL_MS));
  }
  return generation === sessionGeneration && isCurrent() && state.status === "live";
}

/**
 * 진행 대사를 화면에 올린다. 채팅 답보다 먼저 말하되, 지금 말하는 답은 끊지 않고 끝나기를 기다린다.
 * 기다리는 동안 새 채팅 답·혼잣말은 시작하지 않고, 대기 중인 답은 대기 시간을 건너뛰어 바로 내보낸다.
 */
async function presentShowLine(response: CharacterResponse, isCurrent: () => boolean): Promise<void> {
  const generation = sessionGeneration;
  const session = broadcastSession;
  showHold += 1;
  cancelMonologue();
  cancelResponseWait();
  try {
    const audioId = await prepareAudio(response.reply);
    if (!(await waitForFloor(generation, isCurrent))) return;
    engine.record(session, { role: "bori", text: response.reply });
    speak(response, audioId);
  } finally {
    showHold -= 1;
    // 말하지 못하고 끝났으면 멈춰 둔 답·혼잣말을 다시 잡는다. 말했으면 표시가 끝날 때 speak가 잡는다.
    if (!speaking) { scheduleNext(); scheduleMonologue(); }
  }
}

/** 진행 지시로 대사를 만들어 말한다. 못 만들면 throw하고, 진행기가 고정 문장으로 대신한다. */
async function speakShowDirective(directive: string, gameData: readonly string[], isCurrent: () => boolean): Promise<void> {
  if (state.status !== "live") throw new Error("방송 중이 아니라 진행 대사를 하지 않습니다.");
  const outcome = await engine.direct(broadcastSession, { directive, gameData, statusLines: broadcastStatusLines() });
  if (!outcome.ok) throw new Error(outcome.reason);
  if (!isCurrent()) return;
  await presentShowLine(outcome.response, isCurrent);
}

/** 보리가 지금 하는 말과 기다리는 진행 대사를 다 마칠 때까지 기다린다. 방송이 끝나거나 다시 시작하면 바로 돌아온다. */
async function waitQuiet(): Promise<void> {
  const generation = sessionGeneration;
  while ((speaking || showHold > 0) && generation === sessionGeneration) await new Promise(resolve => setTimeout(resolve, 200));
}

/** 정해진 문장을 그대로 말한다. 진행 고정 문장과 !전적 안내에 쓴다. */
async function sayShowLine(line: string, isCurrent: () => boolean): Promise<void> {
  if (state.status !== "live") return;
  await presentShowLine({ reply: line, emotion: { primary: "happy", intensity: 0.5, durationSeconds: 5 }, actions: [], source: "rule" }, isCurrent);
}

const show = createShowController({
  obs,
  speak: speakShowDirective,
  say: sayShowLine,
  waitQuiet,
  er: { basis: () => erData.basis(), top5: () => erData.top5(), stats: () => erData.stats() },
});
/** OBS 미디어 소스 이름. tools/obs/setup-show.mjs의 이름과 같아야 한다. 소스가 없으면 조용히 넘어간다. */
const OBS_BGM = "보리 배경음악";
const OBS_WAITING_VIDEO = "보리 대기 영상";
/** "방송 켜기"(오프닝 앞 단계)를 눌렀는지. 처음으로 돌아가면 끈다(2026-10-15 사용자 요청). */
let onAir = false;

/** 방송 켜기: 대기 장면으로 가서 대기 영상과 배경음악을 처음부터 튼다. 치지직 송출·녹화는 운영자가 OBS에서 직접 시작한다. */
async function turnOnAir() {
  onAir = true;
  await obs.setScene("보리-대기");
  await Promise.all([obs.media(OBS_WAITING_VIDEO, "restart"), obs.media(OBS_BGM, "restart")]);
}

/**
 * 다음 단계로. 대기에서 넘어가면 방송 세션을 열고(이미 방송 중이면 그 세션), 방송 켜기를 건너뛰었으면 배경음악만 튼다.
 * 스튜디오의 "다음 단계"와 코너 자동 진행이 같이 쓴다.
 */
function advanceShow(): Promise<void> {
  if (show.view().stage === "idle") {
    // 장면은 진행기가 메인으로 바꾸므로 음악만 튼다.
    if (!onAir) { onAir = true; void obs.media(OBS_BGM, "restart"); }
    if (state.status !== "live") startBroadcast();
    showDriven = true;
  }
  return show.next();
}

/** 엔딩 배경음악을 서서히 줄여 멈춘다(약 6초). 멈춘 뒤 볼륨은 원래대로 돌려 둔다(다음 방송 켜기 때 같은 크기로). */
const BGM_FADE_STEPS = 20;
const BGM_FADE_STEP_MS = 300;
const BGM_SILENT_DB = -60;
async function fadeOutBgm(): Promise<void> {
  const original = await obs.volume(OBS_BGM);
  if (original === null) return;
  for (let step = 1; step <= BGM_FADE_STEPS; step += 1) {
    // 처음으로 돌아가는 등 엔딩을 벗어나면 줄이기를 멈추고 볼륨을 돌린다.
    if (show.view().stage !== "ending") break;
    await obs.setVolume(OBS_BGM, original + (BGM_SILENT_DB - original) * (step / BGM_FADE_STEPS));
    await new Promise(resolve => setTimeout(resolve, BGM_FADE_STEP_MS));
  }
  if (show.view().stage === "ending") await obs.media(OBS_BGM, "stop");
  await obs.setVolume(OBS_BGM, original);
}

/**
 * 코너 자동 진행. 시간이 다 되면 하던 말을 마치고 연결 멘트 뒤 다음 코너로 넘어간다(show/autopilot.ts).
 * 기본으로 켜고, BORI_SHOW_AUTO_ADVANCE=0이면 끈다(통합 검사는 직접 넘긴다). 스튜디오에서 켜고 끌 수 있다.
 */
const autopilot = createAutopilot({
  stage: () => show.view().stage,
  epoch: show.epoch,
  onAir: () => onAir,
  ready: () => !speaking && showHold === 0,
  say: sayShowLine,
  waitQuiet,
  next: advanceShow,
  finish: fadeOutBgm,
  // 지금 코너에 들어온 캐릭터·메타 질문(점수 3 이상)이 아직 남아 있는지.
  pendingFocus: () => queue.some(chat => chatCorner.get(chat) === show.epoch() && chatRelevance(chat.content) >= 3),
  enabled: process.env.BORI_SHOW_AUTO_ADVANCE !== "0",
});
setInterval(() => autopilot.tick(), 500).unref();

/**
 * 시연 채팅 대본(show/demo-chats.ts). 켜 두면 코너별 시간에 맞춰 시청자 채팅을 올리고 보리는 LLM으로 답한다.
 * 대본은 docs/broadcast/demo-chats.json(BORI_DEMO_CHATS_FILE로 바꿀 수 있다). 기본은 꺼짐이고 스튜디오에서 켠다.
 */
const demoChatsFile = process.env.BORI_DEMO_CHATS_FILE ? resolve(process.env.BORI_DEMO_CHATS_FILE) : resolve(projectRoot, "docs/broadcast/demo-chats.json");
const demoChats = createDemoChats({
  stage: () => show.view().stage,
  epoch: show.epoch,
  live: () => state.status === "live",
  load: () => {
    try {
      return parseDemoScript(JSON.parse(readFileSync(demoChatsFile, "utf8")));
    } catch (error) {
      console.error("[bori-server] 시연 채팅 대본을 읽지 못했습니다:", error instanceof Error ? error.message : String(error));
      return null;
    }
  },
  post: chat => ingestChat({ content: chat.content, nickname: chat.nickname })?.code ?? null,
});
setInterval(() => demoChats.tick(), 500).unref();

const playerCommand = createPlayerCommand({
  stage: () => show.view().stage,
  epoch: show.epoch,
  available: erData.available,
  lookup: nickname => erData.lookupPlayer(nickname),
  setDashboard: show.setDashboard,
  speak: speakShowDirective,
  say: sayShowLine,
  showChat: text => pushVisibleChat({ id: randomUUID(), content: text, receivedAt: new Date().toISOString(), category: "normal" }),
});

// 치지직 채팅은 관리자 테스트 채팅과 같은 ingestChat으로 들어간다. 내용·닉네임은 로그에 남기지 않는다.
// Redirect URL은 개발자 센터에 등록한 값과 글자까지 같아야 한다(http://localhost:4310/api/chzzk/callback).
const chzzk = createChzzkLink({
  clientId: process.env.CHZZK_CLIENT_ID ?? "",
  clientSecret: process.env.CHZZK_CLIENT_SECRET ?? "",
  redirectUri: `http://localhost:${port}/api/chzzk/callback`,
  tokenFile: resolve(dataRoot, "chzzk-token.json"),
  ...(process.env.BORI_CHZZK_BASE_URL ? { baseUrl: process.env.BORI_CHZZK_BASE_URL } : {}),
  onChat: chat => {
    const rejected = ingestChat({ content: chat.content, nickname: chat.nickname }, "chzzk");
    // 방송 전 채팅(not_live)과 같은 시청자의 반복(duplicate)은 흔해서 남기지 않는다.
    if (rejected && rejected.code !== "not_live" && rejected.code !== "duplicate") console.warn(`[bori-server] 치지직 채팅을 받지 않았습니다: ${rejected.code}`);
  },
});
chzzk.start();
console.log(`[bori-server] 방송 진행기: 이터널리턴 ${erData.connection()}, OBS ${obsPassword ? "연결 시도" : "끔(OBS_WEBSOCKET_PASSWORD 없음)"}, 치지직 ${chzzk.configured() ? chzzk.status().state : "끔(앱 키 없음)"}`);

/** 화면·스튜디오가 읽는 진행 상태. 자막은 보리의 지금 답과 같다. */
function showState(): ShowState {
  return {
    ...show.view(),
    caption: state.currentResponse?.reply ?? "",
    connections: { chzzk: chzzk.status().state, obs: obs.status().state, er: erData.connection() },
    erRefreshProgress: erData.status().progress,
    onAir,
    demoChats: demoChats.status(),
    auto: autopilot.status(),
  };
}

/** 치지직 콜백 화면. 코드·state·토큰은 담지 않는다. */
function sendCallbackPage(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>치지직 연결</title><p>${message}</p></html>`);
}

const callbackFailureMessages: Record<ChzzkCallbackError["kind"], string> = {
  state: "로그인 요청이 만료되었거나 맞지 않습니다. 스튜디오에서 다시 로그인해 주세요.",
  exchange: "치지직에서 토큰을 받지 못했습니다. 스튜디오에서 다시 로그인해 주세요.",
  config: "치지직 앱 키(CHZZK_CLIENT_ID·CHZZK_CLIENT_SECRET)가 설정되지 않았습니다.",
};

/** 방송 진행·ER·치지직·OBS 라우트(구현 계획 1.2). 처리했으면 true. */
function handleShowRoute(request: IncomingMessage, response: ServerResponse, method: string | undefined, path: string): boolean {
  if (method === "GET" && path === "/api/show") { sendJson(response, 200, showState()); return true; }
  if (method === "POST" && path === "/api/show/on-air") {
    if (show.view().stage !== "idle") { sendJson(response, 409, { error: "방송 켜기는 오프닝 전(대기)에만 할 수 있습니다." }); return true; }
    void turnOnAir().finally(() => sendJson(response, 200, showState()));
    return true;
  }
  if (method === "POST" && path === "/api/show/next") {
    // 단계·장면·대시보드는 바로 바뀌고, 대사는 뒤에서 만든다.
    void advanceShow();
    sendJson(response, 200, showState());
    return true;
  }
  if (method === "POST" && path === "/api/show/demo-chats") {
    readBody(request, response, body => {
      try {
        const { enabled } = JSON.parse(body) as { enabled?: unknown };
        if (typeof enabled !== "boolean") { sendJson(response, 400, { error: "enabled는 true 또는 false여야 합니다." }); return; }
        if (!demoChats.setEnabled(enabled)) { sendJson(response, 409, { error: "시연 채팅 대본(docs/broadcast/demo-chats.json)을 읽지 못했습니다." }); return; }
        sendJson(response, 200, showState());
      } catch (error) { sendBodyError(response, error); }
    });
    return true;
  }
  if (method === "POST" && path === "/api/show/auto") {
    readBody(request, response, body => {
      try {
        const { enabled } = JSON.parse(body) as { enabled?: unknown };
        if (typeof enabled !== "boolean") { sendJson(response, 400, { error: "enabled는 true 또는 false여야 합니다." }); return; }
        autopilot.setEnabled(enabled);
        sendJson(response, 200, showState());
      } catch (error) { sendBodyError(response, error); }
    });
    return true;
  }
  if (method === "POST" && path === "/api/show/prev") { void show.prev(); sendJson(response, 200, showState()); return true; }
  if (method === "POST" && path === "/api/show/reset") {
    // 처음으로 돌아가면 배경음악을 멈추고 방송 켜기 전으로 돌린다.
    onAir = false;
    void obs.media(OBS_BGM, "stop");
    void show.reset();
    endBroadcast();
    sendJson(response, 200, showState());
    return true;
  }
  if (method === "POST" && path === "/api/er/refresh") { sendJson(response, 200, { started: erData.refresh() }); return true; }
  if (method === "GET" && path === "/api/er/status") { sendJson(response, 200, erData.status()); return true; }
  if (method === "GET" && path === "/api/chzzk/login") {
    const url = chzzk.loginUrl();
    if (!url) { sendJson(response, 503, { error: "치지직 앱 키(CHZZK_CLIENT_ID·CHZZK_CLIENT_SECRET)가 설정되지 않았습니다." }); return true; }
    response.writeHead(302, { Location: url, "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (method === "GET" && path === "/api/chzzk/callback") {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    void chzzk.callback(query.get("code") ?? "", query.get("state") ?? "")
      .then(() => sendCallbackPage(response, 200, "연결했습니다. 이 창을 닫아도 됩니다."))
      .catch(error => {
        const kind = error instanceof ChzzkCallbackError ? error.kind : "exchange";
        console.warn(`[bori-server] 치지직 콜백 실패: ${kind}`);
        sendCallbackPage(response, kind === "state" ? 400 : kind === "config" ? 503 : 502, callbackFailureMessages[kind]);
      });
    return true;
  }
  if (method === "GET" && path === "/api/chzzk/status") { sendJson(response, 200, chzzk.status()); return true; }
  if (method === "POST" && path === "/api/chzzk/disconnect") { chzzk.disconnect(); sendJson(response, 200, { ok: true }); return true; }
  if (method === "GET" && path === "/api/obs/status") { sendJson(response, 200, obs.status()); return true; }
  return false;
}

/** 라우트를 고를 경로. 쿼리와 끝 슬래시는 뗀다. 전에는 request.url 전체를 비교해 "/api/state?x=1"이 404였다(점검 Q-4). */
function routePathOf(url: string | undefined): string {
  const pathname = new URL(url ?? "/", "http://127.0.0.1").pathname;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

const isLoopbackAddress = (address: string | undefined) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function sendJson(response: ServerResponse, status: number, body: unknown) { response.writeHead(status); response.end(JSON.stringify(body)); }
/** 예상하지 못한 예외. 서버를 내리지 않고 500으로 답한다. 자세한 내용은 로그에만 남긴다(점검 D-2). */
function sendServerError(response: ServerResponse, error: unknown) {
  console.error("[bori-server] 요청 처리 실패:", error);
  if (response.headersSent) { response.end(); return; }
  sendJson(response, 500, { error: "요청을 처리하지 못했습니다." });
}
/** 본문 처리 중 예외. JSON 파싱 실패만 400이고, 나머지는 서버 오류로 알린다(점검 Q-4). */
function sendBodyError(response: ServerResponse, error: unknown) {
  if (error instanceof SyntaxError) { sendJson(response, 400, { error: "Invalid JSON" }); return; }
  sendServerError(response, error);
}
/** 설정 파일 저장 실패. 바뀐 값은 부르기 전에 되돌린다. 이유(오류 코드)는 로그에만 남긴다. */
function sendSaveFailure(response: ServerResponse, label: string, error: unknown) {
  console.error(`[bori-server] ${label}을 저장하지 못했습니다:`, errorCode(error));
  sendJson(response, 500, { error: `${label}을 저장하지 못했습니다. 바뀐 값은 적용하지 않았습니다.` });
}
// 브라우저가 이 서버를 부를 수 있는 Origin. 그 밖의 웹사이트는 응답을 읽지도 상태를 바꾸지도 못한다.
// 이 서버가 내준 화면(/obs/·/studio/ 등)은 서버 자신의 Origin으로 스크립트·API를 부르므로 함께 허용한다.
const guardOptions = { allowedOrigins: new Set([...allowedOriginsFrom(process.env.BORI_ALLOWED_ORIGINS), `http://127.0.0.1:${port}`, `http://localhost:${port}`]) };
// 빌드한 화면. OBS 브라우저 소스와 스튜디오가 Vite 없이 이 서버 주소로 연다.
const broadcastDist = resolve(projectRoot, "apps/broadcast/dist");
const staticRoutes: StaticRoute[] = [
  { prefix: "/obs/", root: broadcastDist, build: "npm run build:broadcast" },
  // OBS character 페이지의 Live2D 모델·Core·셰이더. 빌드가 dist 아래 같은 경로로 복사한다(tools/vite/private-assets.ts).
  { prefix: "/private-model/", root: broadcastDist, build: "npm run build:broadcast" },
  { prefix: "/private-core/", root: broadcastDist, build: "npm run build:broadcast" },
  { prefix: "/private-framework/", root: broadcastDist, build: "npm run build:broadcast" },
  { prefix: "/companion/", root: resolve(projectRoot, "apps/companion/dist"), build: "npm run build:companion", stripPrefix: true },
  { prefix: "/studio/", root: resolve(projectRoot, "apps/admin/dist"), build: "npm run build:admin", stripPrefix: true },
];
function handleRequest(request: IncomingMessage, response: ServerResponse) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  // 보안 경계(Host·Origin·Content-Type·본문 크기). 아래의 모든 라우트가 이 검사를 거친다.
  if (!guardRequest(request, response, guardOptions)) return;
  // 정적 화면은 API 라우트보다 먼저 본다. 응답의 Content-Type은 파일에 맞춰 덮어쓴다.
  if ((request.method === "GET" || request.method === "HEAD") && serveStatic(request, response, staticRoutes)) return;
  const path = routePathOf(request.url);
  // HEAD는 GET 라우트로 처리한다. 본문은 Node가 HEAD 응답에서 빼고 보낸다(a1 L5).
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (method === "GET" && path === "/api/health") { sendJson(response, 200, { ok: true, service: "bori-server" }); return; }
  if (method === "GET" && path === "/api/state") { sendJson(response, 200, { ...state, show: showState(), droppedChats }); return; }
  if (handleShowRoute(request, response, method, path)) return;
  if (method === "GET" && path === "/api/settings") { sendJson(response, 200, settings); return; }
  // 장시간 운영 검사용 진단 값. 서버는 127.0.0.1에만 열리지만 같은 컴퓨터에서 온 요청인지 한 번 더 본다.
  if (method === "GET" && path === "/api/diagnostics") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) { sendJson(response, 403, { error: "같은 컴퓨터에서만 볼 수 있습니다." }); return; }
    const usage = process.memoryUsage();
    sendJson(response, 200, {
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, external: usage.external },
      status: state.status,
      queueSize: queue.length,
      speaking,
      showHold,
      responsePending: responseTimer !== undefined,
      sessionGeneration,
      sessionTurns: broadcastSession.sessionTurns.length,
      recentChatKeys: recentContents.size,
      audioCacheSize: audioCache.size,
      audioCacheBytes,
      droppedChats,
      lastError: state.lastError,
    });
    return;
  }
  // LLM 상태. API 키 자체는 내보내지 않고 설정 여부만 알린다.
  if (method === "GET" && path === "/api/llm") {
    // status는 방송 클라이언트 것이다. 1:1 회로와 통계는 companionStatus로 따로 보여 준다.
    sendJson(response, 200, { settings: llmSettings, status: llm.status(llmSettings, llmApiKey), companionStatus: llmClients.llmFor("companion").status(llmSettings, llmApiKey), storedKeyUnreadable: llmKey.isUnreadable(), providers: supportedProviders, defaultModels, macro: macroStatus(), systemPromptChars: engine.systemPromptChars("broadcast") });
    return;
  }
  // 매크로는 파일로 편집하므로, 서버를 다시 띄우지 않고 다시 읽을 수 있게 한다.
  if (method === "POST" && path === "/api/macros/reload") {
    loadMacros();
    // 파일이 바뀌었으면 지금 켜져 있는 항목도 옛 정의를 들고 있으므로 모두 내린다.
    engine.clearMacros(broadcastSession);
    sendJson(response, macroLoadError ? 400 : 200, macroStatus());
    return;
  }
  if (method === "PATCH" && path === "/api/llm") {
    readBody(request, response, body => {
      try {
        // 키·업체·타입·범위를 먼저 모두 검사한다. 틀리면 키도 설정도 바꾸지 않는다.
        const checked = validateLlmSettingsPatch(JSON.parse(body));
        if (!checked.ok) { sendJson(response, 400, { error: checked.error }); return; }
        const next = checked.patch;
        // 저장에 실패하면 되돌릴 값.
        const previousSettings = llmSettings;
        const restoreKey = llmKey.checkpoint();

        // 키는 설정과 분리해 다룬다. 빈 문자열이 오면 저장한 키를 지우는 뜻이고, 환경변수 키가 있으면 그것으로 돌아간다.
        if (typeof next.apiKey === "string") { llmKey.set(next.apiKey); llmApiKey = llmKey.current(); }
        delete next.apiKey;

        llmSettings = { ...llmSettings, ...next };
        // 업체를 바꿨는데 모델을 함께 보내지 않았으면 기본 모델로 맞춘다.
        if (next.provider && !next.model) llmSettings.model = defaultModels[next.provider as LlmProvider];
        // 주기가 너무 짧으면 요약 호출이 답변 호출만큼 잦아진다. 하한을 둔다.
        if (!Number.isFinite(llmSettings.rollingSummaryTurns) || llmSettings.rollingSummaryTurns < 4) llmSettings.rollingSummaryTurns = 4;

        try {
          saveLlmConfig();
        } catch (error) {
          llmSettings = previousSettings;
          restoreKey();
          llmApiKey = llmKey.current();
          sendSaveFailure(response, "LLM 설정", error);
          return;
        }
        llm.reset();
        sendJson(response, 200, { settings: llmSettings, status: llm.status(llmSettings, llmApiKey), storedKeyUnreadable: llmKey.isUnreadable(), providers: supportedProviders, defaultModels, macro: macroStatus(), systemPromptChars: engine.systemPromptChars("broadcast") });
      } catch (error) { sendBodyError(response, error); }
    });
    return;
  }
  // 호출량과 추정 비용. 숫자만 담고, 단가 파일은 요청마다 다시 읽는다.
  if (method === "GET" && path === "/api/usage") {
    sendJson(response, 200, buildUsageReport(usageStore.days(), loadPriceTable(usagePricesPath), Date.now()));
    return;
  }
  // 1:1 사용 통계. 대화 제목·내용·기억 문장 없이 개수만 보낸다.
  if (method === "GET" && path === "/api/companion/stats") {
    const stats: CompanionStats = {
      ...handleCompanionRoute.stats(),
      privateMemories: memoryStore.all().filter(record => record.scope === "private" && record.ownerId === COMPANION_LOCAL_OWNER).length,
    };
    sendJson(response, 200, stats);
    return;
  }
  // 음성 설정과 재생. 오디오는 방송 화면이 바로 받아 재생한다.
  if (method === "GET" && path === "/api/tts") {
    // 목소리 목록은 업체에 물어봐야 하므로 비동기다. 캐시(10분)와 상한(5초)이 있고, 실패해도 설정은 돌려준다.
    void voiceList.get(ttsCredentials(), ttsSettings.provider)
      .then(voices => sendJson(response, 200, {
        settings: ttsSettings,
        voices,
        providers: ttsProviders,
        defaultModels: defaultTtsModels,
        hasApiKey: ttsHasKey(),
        hasElevenLabsKey: elevenLabsApiKey.trim().length > 0,
        storedElevenLabsKeyUnreadable: elevenLabsKey.isUnreadable(),
        hasFishKey: fishApiKey.trim().length > 0,
        failureCount: ttsFailureCount,
        lastError: ttsLastError,
      }));
    return;
  }
  if (method === "PATCH" && path === "/api/tts") {
    readBody(request, response, body => {
      try {
        // 업체·목소리·범위를 먼저 모두 검사한다. 틀리면 키도 설정도 바꾸지 않는다.
        const checked = validateTtsSettingsPatch(JSON.parse(body), ttsSettings);
        if (!checked.ok) { sendJson(response, 400, { error: checked.error }); return; }
        const next = checked.patch;
        // 저장에 실패하면 되돌릴 값.
        const previousSettings = ttsSettings;
        const restoreKey = elevenLabsKey.checkpoint();

        // 키는 설정과 분리해 다룬다. 빈 문자열이면 저장한 키를 지우는 뜻이고, 환경변수 키가 있으면 그것으로 돌아간다.
        if (typeof next.elevenLabsApiKey === "string") { elevenLabsKey.set(next.elevenLabsApiKey); elevenLabsApiKey = elevenLabsKey.current(); }
        delete next.elevenLabsApiKey;

        ttsSettings = { ...ttsSettings, ...next };
        // 업체를 바꿨는데 모델을 함께 보내지 않았으면 기본 모델로 맞춘다.
        if (next.provider && !next.model) ttsSettings.model = defaultTtsModels[next.provider as TtsProvider];
        // 목소리도 새 업체에서 쓸 수 없으면 기본 목소리로 맞춘다. ElevenLabs voice id는 OpenAI에서 쓸 수 없다.
        if (next.provider && !next.voice && !isValidVoice(ttsSettings.provider, ttsSettings.voice)) ttsSettings.voice = defaultTtsSettings.voice;

        try {
          saveTtsConfig();
        } catch (error) {
          ttsSettings = previousSettings;
          restoreKey();
          elevenLabsApiKey = elevenLabsKey.current();
          sendSaveFailure(response, "음성 설정", error);
          return;
        }
        ttsFailureCount = 0;
        ttsLastError = null;

        // 저장할 때는 목록을 새로 받는다. 업체에서 목소리를 바꾼 뒤 저장으로 다시 읽게 한다.
        voiceList.clear();
        void voiceList.get(ttsCredentials(), ttsSettings.provider)
          .then(voices => sendJson(response, 200, {
            settings: ttsSettings,
            voices,
            providers: ttsProviders,
            defaultModels: defaultTtsModels,
            hasApiKey: ttsHasKey(),
            hasElevenLabsKey: elevenLabsApiKey.trim().length > 0,
            storedElevenLabsKeyUnreadable: elevenLabsKey.isUnreadable(),
            hasFishKey: fishApiKey.trim().length > 0,
            failureCount: ttsFailureCount,
            lastError: ttsLastError,
          }));
      } catch (error) { sendBodyError(response, error); }
    });
    return;
  }
  if (method === "GET" && path.startsWith("/api/tts/")) {
    const audio = audioCache.get(decodeURIComponent(path.slice("/api/tts/".length)))?.audio;
    if (!audio) { sendJson(response, 404, { error: "음성을 찾을 수 없습니다." }); return; }
    response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
    response.end(audio);
    return;
  }
  // 장기 기억. 원문은 관리자만 본다. 공개 범위(scope)와 소유자(ownerId)도 함께 보낸다.
  // 임베딩 배열은 보내지 않는다. 화면이 쓰지 않는데 실임베딩 50건이면 약 1.4MB를 1.5초마다 보냈다(점검 M-13).
  if (method === "GET" && path === "/api/memory") {
    const records = memoryStore.all()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 50)
      .map(({ embedding, ...record }) => ({ ...record, hasEmbedding: embedding !== undefined }));
    sendJson(response, 200, { settings: memorySettings, count: memoryStore.count(), records });
    return;
  }
  if (method === "PATCH" && path === "/api/memory") {
    readBody(request, response, body => {
      try {
        const checked = validateMemorySettingsPatch(JSON.parse(body));
        if (!checked.ok) { sendJson(response, 400, { error: checked.error }); return; }
        const previousSettings = memorySettings;
        memorySettings = { ...memorySettings, ...checked.patch };
        try {
          saveMemoryConfig();
        } catch (error) {
          memorySettings = previousSettings;
          sendSaveFailure(response, "기억 설정", error);
          return;
        }
        sendJson(response, 200, { settings: memorySettings, count: memoryStore.count() });
      } catch (error) { sendBodyError(response, error); }
    });
    return;
  }
  // 기억 삭제는 관리자 수동 조작이다. 계획서의 원문 로그 수동 삭제 원칙을 따른다.
  if (method === "DELETE" && path.startsWith("/api/memory/")) {
    const id = decodeURIComponent(path.slice("/api/memory/".length));
    // 파일에 쓰지 못하면 저장소가 지운 것을 되돌린다. 지웠다고 답하지 않는다(점검 D-3).
    const removal = id === "all" ? memoryStore.clear().then(() => true) : memoryStore.remove(id);
    void removal
      .then(removed => sendJson(response, removed ? 200 : 404, { count: memoryStore.count() }))
      .catch(error => {
        console.error("[bori-server] 기억을 지우지 못했습니다:", errorCode(error));
        sendJson(response, 500, { error: "기억을 지우지 못했습니다. 다시 시도해 주세요." });
      });
    return;
  }
  // 관리자가 확인할 수 있는 표정·모션 목록. 이름은 모델 패키지가 단독으로 소유한다.
  if (method === "GET" && path === "/api/live2d/catalog") { sendJson(response, 200, { expressions: boriExpressionNames, motions: boriMotionGroupNames }); return; }
  if (method === "POST" && path === "/api/live2d/test") {
    readBody(request, response, body => {
      try {
        const input = JSON.parse(body) as { kind?: string; name?: string };
        const name = input.name ?? "";
        // allowlist 밖의 이름은 실행하지 않는다.
        const valid = input.kind === "expression" ? isBoriExpression(name) : input.kind === "motion" ? isBoriMotionGroup(name) : false;
        if (!valid) { sendJson(response, 400, { error: "등록되지 않은 표정·모션입니다." }); return; }
        state = { ...state, lastTestAction: { seq: ++testActionSeq, kind: input.kind as "expression" | "motion", name } };
        sendJson(response, 200, state);
      } catch (error) { sendBodyError(response, error); }
    }); return;
  }
  if (method === "PATCH" && path === "/api/settings") {
    readBody(request, response, body => {
      try {
        // 잘못된 값이 하나라도 있으면 아무것도 병합하지 않는다.
        const checked = validateQueueSettingsPatch(JSON.parse(body), settings);
        if (!checked.ok) { sendJson(response, 400, { error: checked.error }); return; }
        settings = { ...settings, ...checked.patch }; cancelMonologue(); scheduleMonologue(); sendJson(response, 200, settings);
      } catch (error) { sendBodyError(response, error); }
    }); return;
  }
  if (method === "POST" && path === "/api/session/start") {
    startBroadcast();
    sendJson(response, 200, state);
    return;
  }
  // 방송 중이 아니면 아무것도 하지 않고 지금 상태를 돌려준다. 두 번째 종료는 기억을 다시 저장하지 않는다.
  if (method === "POST" && path === "/api/session/end") {
    endBroadcast();
    sendJson(response, 200, state);
    return;
  }
  if (method === "POST" && path === "/api/chat") {
    readBody(request, response, body => {
      try {
        const parsed: unknown = JSON.parse(body);
        // 본문의 다른 키(source 등)는 넘기지 않는다.
        const rejected = ingestChat(isPlainObject(parsed) ? { content: parsed.content, nickname: parsed.nickname } : {});
        if (rejected) { sendJson(response, 400, rejected); return; }
        sendJson(response, 200, state);
      } catch (error) { sendBodyError(response, error); }
    }); return;
  }
  if (handleCompanionRoute(request, response)) return;
  sendJson(response, 404, { error: "Not found" });
}
const server = createServer((request, response) => {
  // 라우트 안의 동기 예외(파일 잠김 EPERM 등)가 프로세스를 내리지 않게 한다.
  try {
    handleRequest(request, response);
  } catch (error) {
    sendServerError(response, error);
  }
});
// tsx watch가 파일 변경으로 재시작할 때, 이전 프로세스가 포트를 놓기 전에 새 프로세스가 뜨는 경우가 있다.
// 여기서 바로 종료하면 서버가 아예 사라지므로 잠시 기다렸다 다시 시도한다.
const LISTEN_RETRY_LIMIT = 10;
const LISTEN_RETRY_DELAY_MS = 1000;
let listenRetries = 0;

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;

  listenRetries += 1;
  if (listenRetries > LISTEN_RETRY_LIMIT) {
    console.error(`[bori-server] 포트 ${port}가 계속 사용 중입니다.`);
    console.error("[bori-server] 이미 실행 중인 서버를 종료하거나 BORI_SERVER_PORT로 다른 포트를 지정하세요.");
    console.error(`[bori-server] 확인: Get-NetTCPConnection -LocalPort ${port} -State Listen`);
    process.exit(1);
  }

  console.warn(`[bori-server] 포트 ${port} 사용 중. ${LISTEN_RETRY_DELAY_MS}ms 후 재시도 (${listenRetries}/${LISTEN_RETRY_LIMIT})`);
  setTimeout(() => server.listen(port, "127.0.0.1"), LISTEN_RETRY_DELAY_MS);
});

server.listen(port, "127.0.0.1", () => {
  listenRetries = 0;
  console.log(`[bori-server] listening on http://127.0.0.1:${port}`);
});
