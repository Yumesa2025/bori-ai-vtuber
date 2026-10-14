// 루트 .env를 가장 먼저 읽는다. 아래 모듈 일부가 import 시점에 환경 변수를 읽는다.
import "./load-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BroadcastState, ChatMessage, CharacterResponse, CompanionStats, LlmProvider, LlmSettings, MacroPrompt, MacroStatus, QueueSettings, VisibleChat } from "@bori/shared";
import type { ConversationMode } from "@bori/character";
import { boriExpressionNames, boriMotionGroupNames, isBoriExpression, isBoriMotionGroup } from "@bori/live2d";
import { createAdapter as createProviderAdapter, createLlmClient, defaultModels, defaultTtsModels, defaultTtsSettings, isBroadcastMemoryText, listVoices, summarizeBroadcast, supportedProviders, synthesizeSpeech, type TtsProvider, type TtsSettings } from "@bori/llm";
import { createMemoryStore, createOpenAiEmbedding, defaultMemorySettings, extractMemoryCandidates, isAnonymousViewer, isStorableMemory, type EmbeddingProvider, type MemorySettings } from "@bori/memory";
import { bodyAction, createConversationEngine, createModeLlmClients, isQuestion, pickNextChatIndex, withoutCrisisTurns, type ConversationSession } from "./conversation/index.js";
import { cleanInputText, lengthOf } from "./input-text.js";
import { COMPANION_LOCAL_OWNER, createCompanionHandler, createPrivateMemoryDigest } from "./companion/index.js";
import { createApiKeySlot } from "./secret-store.js";
import { createConfigFile } from "./config-file.js";
import { allowedOriginsFrom, guardRequest, readBody } from "./http/guard.js";
import { serveStatic, type StaticRoute } from "./http/static.js";
import { isValidVoice, pickValidSettings, validateLlmSettingsPatch, validateMemorySettingsPatch, validateQueueSettingsPatch, validateTtsSettingsPatch, type PatchResult } from "./http/settings.js";
import { buildUsageReport, createUsageStore, loadPriceTable, trackAdapter, trackEmbedding } from "./usage/index.js";
import { BACKUP_RETENTION_DAYS, purgeExpiredBackups } from "./retention.js";

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
let monologueTimer: NodeJS.Timeout | undefined;
/** 발화권. 답변을 말하는 동안에는 다음 답변도 혼잣말도 시작하지 않는다. */
let speaking = false;
/**
 * 방송 세션 세대. 시작할 때마다 증가한다.
 * LLM 호출은 비동기라 응답이 늦게 오는데, 그 사이 방송을 다시 시작했다면
 * 이전 세션의 답변이므로 화면에 올리지 않는다. status만 봐서는 구분할 수 없다.
 */
let sessionGeneration = 0;
let testActionSeq = 0;

const RESPONSE_DISPLAY_MS = 5000;

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

const ttsCredentials = () => ({ openAiApiKey: llmApiKey, elevenLabsApiKey });
/** 지금 설정으로 음성을 만들 수 있는지. */
const ttsHasKey = () => (ttsSettings.provider === "elevenlabs" ? elevenLabsApiKey : llmApiKey).trim().length > 0;
/** 생성한 음성. 방송 화면이 받아가면 되므로 메모리에만 두고 오래된 것부터 버린다. */
const audioCache = new Map<string, Buffer>();
const AUDIO_CACHE_LIMIT = 30;
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
  try {
    const result = await synthesizeSpeech(ttsCredentials(), ttsSettings, text);
    usageStore.record({ ...usage, ok: true, characters: Array.from(text).length });
    const id = randomUUID();
    audioCache.set(id, result.audio);
    while (audioCache.size > AUDIO_CACHE_LIMIT) {
      const oldest = audioCache.keys().next().value;
      if (oldest === undefined) break;
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

function broadcastStatusLines(): string[] {
  if (state.status !== "live" || sessionStartedAt === 0) return [];

  const minutes = Math.floor((Date.now() - sessionStartedAt) / 60_000);
  const lines = [minutes < 1 ? "방송을 막 시작했다." : `방송을 시작한 지 ${minutes}분 지났다.`];
  if (answeredCount > 0) lines.push(`지금까지 채팅 ${answeredCount}개에 답했다.`);
  return lines;
}

let state: BroadcastState = { status: "idle", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };

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

function makeMonologue(): CharacterResponse {
  const chosen = monologues[Math.floor(Math.random() * monologues.length)];
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
async function persistSessionMemories() {
  // 끝난 방송의 세션을 잡아 둔다. 저장하는 사이 방송을 다시 시작해도 새 세션의 대화가 섞이지 않는다.
  // 위기 채팅은 기록하지 않지만, 혹시 남은 위기 대화가 있어도 요약·기억 후보로 넘기지 않는다(S-3).
  const sessionTurns = withoutCrisisTurns(broadcastSession.sessionTurns);
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
  state = { ...state, currentResponse: response, currentEmotion: response.emotion.primary, currentAudioId: audioId };

  // 음성이 있으면 재생 시간을 감안해 말풍선을 조금 더 오래 둔다.
  const displayMs = audioId ? Math.max(RESPONSE_DISPLAY_MS, Math.min(15_000, response.reply.length * 110)) : RESPONSE_DISPLAY_MS;
  // 표시가 끝나기 전에 방송을 다시 시작하면 이 타이머는 이전 세션 것이다.
  // 세대를 보지 않으면 새 세션이 막 올린 말풍선을 지워 버린다.
  const generation = sessionGeneration;

  setTimeout(() => {
    if (generation !== sessionGeneration) return;
    state = { ...state, currentResponse: undefined, currentAudioId: undefined };
    speaking = false;
    scheduleNext();
    scheduleMonologue();
  }, displayMs);
}

/**
 * 채팅이 없을 때만 혼잣말을 예약한다.
 * 대기 중에 채팅이 들어오면 취소하므로 새 채팅 반응이 항상 우선이다.
 */
function scheduleMonologue() {
  if (monologueTimer || !settings.monologueEnabled) return;
  if (state.status !== "live" || speaking || queue.length > 0) return;

  const min = settings.monologueMinSeconds;
  const max = Math.max(min, settings.monologueMaxSeconds);
  const delay = (min + Math.random() * (max - min)) * 1000;

  monologueTimer = setTimeout(() => {
    monologueTimer = undefined;
    // 기다리는 동안 채팅이 들어왔거나 이미 말하고 있으면 혼잣말을 건너뛴다.
    if (state.status !== "live" || speaking || queue.length > 0) { scheduleNext(); return; }

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
function scheduleNext() {
  if (responseTimer || speaking || state.status !== "live" || queue.length === 0) return;

  // 질문을 먼저 고르되, 오래 기다린 채팅은 질문에 밀리지 않게 한다.
  const chat = queue.splice(pickNextChatIndex(queue), 1)[0];
  syncQueueState();

  // 생성이 끝나기 전에 혼잣말이 끼어들지 않도록 발화권을 먼저 잡는다.
  speaking = true;
  cancelMonologue();
  const generation = sessionGeneration;
  const session = broadcastSession;

  const min = settings.responseDelayMinSeconds;
  const max = Math.max(min, settings.responseDelayMaxSeconds);
  const delay = (min + Math.random() * (max - min)) * 1000;
  const waited = new Promise<void>(resolve => {
    responseTimer = setTimeout(() => { responseTimer = undefined; resolve(); }, delay);
  });

  // 답변과 음성을 대기와 나란히 만든다. 실패는 각 함수가 안에서 처리한다.
  // 익명 채팅은 화자를 모르는 발언으로 넘겨 어떤 시청자의 기억도 꺼내지 않게 한다.
  const prepared = engine.respond(session, {
    content: chat.content,
    speaker: { ownerId: isAnonymousViewer(chat.viewerId) ? null : chat.viewerId },
    statusLines: broadcastStatusLines(),
  }).then(async outcome => {
    // 만드는 사이 방송이 끝났거나 다시 시작했으면 음성도 오류 표시도 만들지 않는다. 답변은 아래에서 버린다.
    if (generation !== sessionGeneration) return null;
    // 차단된 채팅에는 보리가 무반응한다.
    if (outcome.kind === "blocked") return null;
    // 실패는 관리자에게만 알리고 방송은 폴백 문장으로 이어간다.
    if (outcome.failure) state = { ...state, lastError: `LLM 실패: ${outcome.failure.reason}` };
    return { response: outcome.response, crisis: outcome.crisis === true, audioId: await prepareAudio(outcome.response.reply) };
  });

  void Promise.all([prepared, waited])
    .then(([result]) => {
      // 만드는 사이에 방송이 끝났거나 다시 시작했으면 이전 세션의 답변이므로 버린다.
      if (generation !== sessionGeneration) return;
      if (state.status !== "live") { speaking = false; return; }

      if (!result) {
        // 차단된 채팅은 조용히 넘기고 다음 후보로 넘어간다.
        speaking = false;
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

      speak(result.response, result.audioId);
    })
    .catch(error => {
      // 여기까지 온 예외는 예상하지 못한 것이다.
      // 발화권을 놓지 않으면 방송이 그대로 멈추므로 반드시 풀어 준다.
      console.error("[bori-server] 답변 처리 실패:", error);
      // 끝난 방송의 실패는 관리자 화면에 새로 띄우지 않는다.
      if (generation !== sessionGeneration) return;
      state = { ...state, lastError: `답변 처리 실패: ${error instanceof Error ? error.message : String(error)}` };
      speaking = false;
      scheduleNext();
      scheduleMonologue();
    });
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
  if (request.method === "GET" && request.url === "/api/health") { sendJson(response, 200, { ok: true, service: "bori-server" }); return; }
  if (request.method === "GET" && request.url === "/api/state") { sendJson(response, 200, state); return; }
  if (request.method === "GET" && request.url === "/api/settings") { sendJson(response, 200, settings); return; }
  // 장시간 운영 검사용 진단 값. 서버는 127.0.0.1에만 열리지만 같은 컴퓨터에서 온 요청인지 한 번 더 본다.
  if (request.method === "GET" && request.url === "/api/diagnostics") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) { sendJson(response, 403, { error: "같은 컴퓨터에서만 볼 수 있습니다." }); return; }
    const usage = process.memoryUsage();
    sendJson(response, 200, {
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, external: usage.external },
      status: state.status,
      queueSize: queue.length,
      speaking,
      responsePending: responseTimer !== undefined,
      sessionGeneration,
      sessionTurns: broadcastSession.sessionTurns.length,
      recentChatKeys: recentContents.size,
      audioCacheSize: audioCache.size,
    });
    return;
  }
  // LLM 상태. API 키 자체는 내보내지 않고 설정 여부만 알린다.
  if (request.method === "GET" && request.url === "/api/llm") {
    // status는 방송 클라이언트 것이다. 1:1 회로와 통계는 companionStatus로 따로 보여 준다.
    sendJson(response, 200, { settings: llmSettings, status: llm.status(llmSettings, llmApiKey), companionStatus: llmClients.llmFor("companion").status(llmSettings, llmApiKey), storedKeyUnreadable: llmKey.isUnreadable(), providers: supportedProviders, defaultModels, macro: macroStatus(), systemPromptChars: engine.systemPromptChars("broadcast") });
    return;
  }
  // 매크로는 파일로 편집하므로, 서버를 다시 띄우지 않고 다시 읽을 수 있게 한다.
  if (request.method === "POST" && request.url === "/api/macros/reload") {
    loadMacros();
    // 파일이 바뀌었으면 지금 켜져 있는 항목도 옛 정의를 들고 있으므로 모두 내린다.
    engine.clearMacros(broadcastSession);
    sendJson(response, macroLoadError ? 400 : 200, macroStatus());
    return;
  }
  if (request.method === "PATCH" && request.url === "/api/llm") {
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
  if (request.method === "GET" && request.url === "/api/usage") {
    sendJson(response, 200, buildUsageReport(usageStore.days(), loadPriceTable(usagePricesPath), Date.now()));
    return;
  }
  // 1:1 사용 통계. 대화 제목·내용·기억 문장 없이 개수만 보낸다.
  if (request.method === "GET" && request.url === "/api/companion/stats") {
    const stats: CompanionStats = {
      ...handleCompanionRoute.stats(),
      privateMemories: memoryStore.all().filter(record => record.scope === "private" && record.ownerId === COMPANION_LOCAL_OWNER).length,
    };
    sendJson(response, 200, stats);
    return;
  }
  // 음성 설정과 재생. 오디오는 방송 화면이 바로 받아 재생한다.
  if (request.method === "GET" && request.url === "/api/tts") {
    // 목소리 목록은 업체에 물어봐야 하므로 비동기다. 실패해도 설정은 돌려준다.
    void listVoices(ttsCredentials(), ttsSettings.provider)
      .catch(() => [])
      .then(voices => sendJson(response, 200, {
        settings: ttsSettings,
        voices,
        providers: ["openai", "elevenlabs"],
        defaultModels: defaultTtsModels,
        hasApiKey: ttsHasKey(),
        hasElevenLabsKey: elevenLabsApiKey.trim().length > 0,
        storedElevenLabsKeyUnreadable: elevenLabsKey.isUnreadable(),
        failureCount: ttsFailureCount,
        lastError: ttsLastError,
      }));
    return;
  }
  if (request.method === "PATCH" && request.url === "/api/tts") {
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

        void listVoices(ttsCredentials(), ttsSettings.provider)
          .catch(() => [])
          .then(voices => sendJson(response, 200, {
            settings: ttsSettings,
            voices,
            providers: ["openai", "elevenlabs"],
            defaultModels: defaultTtsModels,
            hasApiKey: ttsHasKey(),
            hasElevenLabsKey: elevenLabsApiKey.trim().length > 0,
            storedElevenLabsKeyUnreadable: elevenLabsKey.isUnreadable(),
            failureCount: ttsFailureCount,
            lastError: ttsLastError,
          }));
      } catch (error) { sendBodyError(response, error); }
    });
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/api/tts/")) {
    const audio = audioCache.get(decodeURIComponent(request.url.slice("/api/tts/".length)));
    if (!audio) { sendJson(response, 404, { error: "음성을 찾을 수 없습니다." }); return; }
    response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
    response.end(audio);
    return;
  }
  // 장기 기억. 원문은 관리자만 본다. 공개 범위(scope)와 소유자(ownerId)도 함께 보낸다.
  if (request.method === "GET" && request.url === "/api/memory") {
    const records = memoryStore.all()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 50);
    sendJson(response, 200, { settings: memorySettings, count: memoryStore.count(), records });
    return;
  }
  if (request.method === "PATCH" && request.url === "/api/memory") {
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
  if (request.method === "DELETE" && request.url?.startsWith("/api/memory/")) {
    const id = decodeURIComponent(request.url.slice("/api/memory/".length));
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
  if (request.method === "GET" && request.url === "/api/live2d/catalog") { sendJson(response, 200, { expressions: boriExpressionNames, motions: boriMotionGroupNames }); return; }
  if (request.method === "POST" && request.url === "/api/live2d/test") {
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
  if (request.method === "PATCH" && request.url === "/api/settings") {
    readBody(request, response, body => {
      try {
        // 잘못된 값이 하나라도 있으면 아무것도 병합하지 않는다.
        const checked = validateQueueSettingsPatch(JSON.parse(body), settings);
        if (!checked.ok) { sendJson(response, 400, { error: checked.error }); return; }
        settings = { ...settings, ...checked.patch }; cancelMonologue(); scheduleMonologue(); sendJson(response, 200, settings);
      } catch (error) { sendBodyError(response, error); }
    }); return;
  }
  if (request.method === "POST" && request.url === "/api/session/start") {
    // 세대를 올려 진행 중이던 이전 세션의 비동기 응답을 무효화한다.
    sessionGeneration += 1;
    queue.length = 0;
    recentContents.clear();
    // 대화 문맥·누적 요약·매크로·문장 쿨다운은 방송 단위다. 세션을 새로 만들어 이전 방송의 흐름을 끌고 오지 않는다.
    broadcastSession = engine.createSession("broadcast");
    // 진행 상황도 방송마다 새로 센다.
    sessionStartedAt = Date.now();
    answeredCount = 0;
    speaking = false;
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = undefined;
    cancelMonologue();
    state = { ...state, status: "live", currentEmotion: "calm", currentResponse: undefined, visibleChats: [], visibleChatCount: 0, queueSize: 0, unprocessedCount: 0 };
    scheduleMonologue();
    sendJson(response, 200, state);
    return;
  }
  if (request.method === "POST" && request.url === "/api/session/end") {
    sessionGeneration += 1;
    queue.length = 0;
    speaking = false;
    // 대화 기록은 기억 저장에 써야 하므로 세션은 그대로 두고 매크로만 내린다.
    engine.clearMacros(broadcastSession);
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = undefined;
    cancelMonologue();
    state = { ...state, status: "ended", queueSize: 0, currentResponse: undefined, currentEmotion: "calm" };
    // 기억 저장은 오래 걸릴 수 있으므로 응답을 막지 않는다.
    void persistSessionMemories();
    sendJson(response, 200, state);
    return;
  }
  if (request.method === "POST" && request.url === "/api/chat") {
    readBody(request, response, body => {
      try {
        const input = JSON.parse(body) as { content?: unknown; nickname?: unknown };
        if (typeof input.content !== "string" || (input.nickname !== undefined && typeof input.nickname !== "string")) {
          sendJson(response, 400, { error: "content와 nickname은 문자열이어야 합니다." }); return;
        }
        // 제어문자·방향 바꿈 문자는 화면·프롬프트에 나가기 전에 지운다(B-5).
        const content = cleanInputText(input.content).trim();
        if (lengthOf(content) > CHAT_MAX_LENGTH) { sendJson(response, 400, { error: `채팅은 ${CHAT_MAX_LENGTH}자 이하여야 합니다.` }); return; }
        const nickname = nicknameOf(input.nickname ?? "");
        if (lengthOf(nickname) > NICKNAME_MAX_LENGTH) { sendJson(response, 400, { error: `닉네임은 ${NICKNAME_MAX_LENGTH}자 이하여야 합니다.` }); return; }
        const key = normalize(content);
        if (!content || state.status !== "live" || isDuplicateChat(key)) { sendJson(response, 400, { error: "채팅을 처리할 수 없습니다." }); return; }
        recentContents.set(key, Date.now());

        // 닉네임은 내부 사용자 ID로만 쓴다. 방송 화면에는 내보내지 않는다.
        const chat: ChatMessage = {
          id: randomUUID(),
          viewerId: nickname ? viewerIdOf(nickname) : "virtual-viewer",
          ...(nickname ? { viewerNickname: nickname } : {}),
          content,
          receivedAt: new Date().toISOString(),
          source: "manual",
          category: isQuestion(content) ? "question" : "normal",
        };

        // 방송 화면에 넘기는 목록에는 화면에 필요한 값만 담는다.
        // viewerId도 닉네임에서 만든 값이라 함께 빼야 닉네임이 드러나지 않는다.
        const visible: VisibleChat = { id: chat.id, content: chat.content, receivedAt: chat.receivedAt, ...(chat.category ? { category: chat.category } : {}) };
        state = { ...state, visibleChats: [...state.visibleChats, visible].slice(-settings.visibleChatLimit), visibleChatCount: Math.min(state.visibleChatCount + 1, settings.visibleChatLimit) };

        // 상한을 줄였으면 큐가 이미 넘쳐 있을 수 있으므로 상한 안으로 들어올 때까지 오래된 것부터 버린다.
        while (queue.length >= settings.maxQueueSize) queue.shift();
        queue.push(chat);
        syncQueueState();
        cancelMonologue();
        scheduleNext();
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
