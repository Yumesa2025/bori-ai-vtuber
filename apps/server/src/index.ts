import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BroadcastState, ChatMessage, CharacterResponse, LlmProvider, LlmSettings, QueueSettings } from "@bori/shared";
import { boriEmotionNames, boriExpressionNames, boriMotionDescriptions, boriMotionGroupNames, isBoriExpression, isBoriMotionGroup } from "@bori/live2d";
import { createAdapter, createLlmClient, defaultModels, defaultTtsModels, defaultTtsSettings, listVoices, summarizeBroadcast, summarizeSessionProgress, supportedProviders, synthesizeSpeech, type TtsProvider, type TtsSettings } from "@bori/llm";
import { createMemoryStore, createOpenAiEmbedding, defaultMemorySettings, extractMemoryCandidates, isStorableMemory, type EmbeddingProvider, type MemorySettings } from "@bori/memory";
import { decryptSecret, encryptSecret, isEncrypted } from "./secret-store.js";

const port = Number(process.env.BORI_SERVER_PORT ?? 4310);
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
const recentContents = new Set<string>();
/** 답변 문장별 마지막 사용 시각. 같은 문장을 연달아 쓰지 않기 위한 기록이다. */
const replyLastUsedAt = new Map<string, number>();
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
const RECENT_TURN_LIMIT = 6;

// ── LLM 설정과 API 키 ─────────────────────────────────────────
// 키는 data/ 아래에만 둔다. data/는 .gitignore 대상이다.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const llmConfigPath = resolve(projectRoot, "data/llm-config.json");

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
};
// 환경변수로도 키를 넣을 수 있다. 저장된 키가 없을 때만 쓴다.
let llmApiKey = process.env.OPENAI_API_KEY ?? "";

const llm = createLlmClient();
/** 최근 대화. LLM 문맥으로만 쓰고 방송 화면에는 보내지 않는다. */
const recentTurns: { role: "viewer" | "bori"; text: string }[] = [];
/** 이번 방송의 전체 대화. 종료 시 기억 후보를 뽑는 데 쓴다. */
const sessionTurns: { role: "viewer" | "bori"; text: string; viewerId?: string }[] = [];
/** 방송 중 누적 요약. recentTurns 창 밖으로 밀려난 흐름이 여기에 남는다. */
let sessionSummary = "";
/** 누적 요약이 이미 반영한 sessionTurns 개수. 아직 안 접힌 대화만 다음 요약에 넘긴다. */
let summarizedTurnCount = 0;
/** 요약 호출이 진행 중인지. 겹쳐 부르면 같은 대화를 두 번 접게 된다. */
let summaryInFlight = false;

function loadLlmConfig() {
  try {
    const saved = JSON.parse(readFileSync(llmConfigPath, "utf8")) as { settings?: Partial<LlmSettings>; apiKey?: string };
    if (saved.settings) llmSettings = { ...llmSettings, ...saved.settings };

    if (typeof saved.apiKey === "string" && saved.apiKey.length > 0) {
      const decrypted = decryptSecret(saved.apiKey);
      if (decrypted.length > 0) {
        llmApiKey = decrypted;
        // 이전 버전이 평문으로 남긴 키는 즉시 암호문으로 바꿔 저장한다.
        if (!isEncrypted(saved.apiKey)) {
          saveLlmConfig();
          console.log("[bori-server] 평문으로 저장돼 있던 API 키를 암호화했습니다.");
        }
      } else {
        console.warn("[bori-server] 저장된 API 키를 풀지 못했습니다. 다른 컴퓨터에서 만든 파일일 수 있습니다.");
      }
    }
    console.log("[bori-server] LLM 설정을 불러왔습니다.");
  } catch {
    // 파일이 없으면 기본값으로 시작한다.
  }
}

function saveLlmConfig() {
  try {
    mkdirSync(dirname(llmConfigPath), { recursive: true });
    // 키는 항상 암호화해서 저장한다.
    writeFileSync(llmConfigPath, JSON.stringify({ settings: llmSettings, apiKey: encryptSecret(llmApiKey) }, null, 2), "utf8");
  } catch (error) {
    console.error("[bori-server] LLM 설정을 저장하지 못했습니다:", error);
  }
}

loadLlmConfig();

// ── 음성 합성 ─────────────────────────────────────────────────
let ttsSettings: TtsSettings = { ...defaultTtsSettings };
/** ElevenLabs는 LLM과 다른 키를 쓴다. 이 키도 암호화해 저장한다. */
let elevenLabsApiKey = process.env.ELEVENLABS_API_KEY ?? "";
const ttsConfigPath = resolve(projectRoot, "data/tts-config.json");

const ttsCredentials = () => ({ openAiApiKey: llmApiKey, elevenLabsApiKey });
/** 지금 설정으로 음성을 만들 수 있는지. */
const ttsHasKey = () => (ttsSettings.provider === "elevenlabs" ? elevenLabsApiKey : llmApiKey).trim().length > 0;
/** 생성한 음성. 방송 화면이 받아가면 되므로 메모리에만 두고 오래된 것부터 버린다. */
const audioCache = new Map<string, Buffer>();
const AUDIO_CACHE_LIMIT = 30;
let ttsFailureCount = 0;
let ttsLastError: string | null = null;

function loadTtsConfig() {
  try {
    const saved = JSON.parse(readFileSync(ttsConfigPath, "utf8")) as Partial<TtsSettings> & { elevenLabsApiKey?: string };
    if (typeof saved.elevenLabsApiKey === "string" && saved.elevenLabsApiKey.length > 0) {
      const decrypted = decryptSecret(saved.elevenLabsApiKey);
      if (decrypted.length > 0) elevenLabsApiKey = decrypted;
    }
    delete saved.elevenLabsApiKey;
    ttsSettings = { ...ttsSettings, ...saved };
  } catch {
    // 파일이 없으면 기본값으로 시작한다.
  }
}

function saveTtsConfig() {
  try {
    mkdirSync(dirname(ttsConfigPath), { recursive: true });
    // 키는 LLM 설정과 같은 방식으로 암호화해 저장한다.
    writeFileSync(ttsConfigPath, JSON.stringify({ ...ttsSettings, elevenLabsApiKey: encryptSecret(elevenLabsApiKey) }, null, 2), "utf8");
  } catch (error) {
    console.error("[bori-server] 음성 설정을 저장하지 못했습니다:", error);
  }
}

/**
 * 답변 음성을 만든다.
 * 실패해도 방송은 그대로 진행하고 음성만 빠진다.
 */
async function prepareAudio(text: string): Promise<string | undefined> {
  if (!ttsSettings.enabled || !ttsHasKey()) return undefined;

  try {
    const result = await synthesizeSpeech(ttsCredentials(), ttsSettings, text);
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
    ttsFailureCount += 1;
    ttsLastError = error instanceof Error ? error.message : String(error);
    console.error("[bori-server] 음성 합성 실패:", ttsLastError);
    return undefined;
  }
}

loadTtsConfig();

// ── 장기 기억 ─────────────────────────────────────────────────
const memoryStore = createMemoryStore(resolve(projectRoot, "data/memories.json"));
let memorySettings: MemorySettings = { ...defaultMemorySettings };
const memoryConfigPath = resolve(projectRoot, "data/memory-config.json");

function loadMemoryConfig() {
  try {
    const saved = JSON.parse(readFileSync(memoryConfigPath, "utf8")) as Partial<MemorySettings>;
    memorySettings = { ...memorySettings, ...saved };
  } catch {
    // 파일이 없으면 기본값으로 시작한다.
  }
  const removed = memoryStore.load();
  console.log(`[bori-server] 기억 ${memoryStore.count()}건 불러옴${removed > 0 ? `, 만료 ${removed}건 정리` : ""}`);
}

function saveMemoryConfig() {
  try {
    mkdirSync(dirname(memoryConfigPath), { recursive: true });
    writeFileSync(memoryConfigPath, JSON.stringify(memorySettings, null, 2), "utf8");
  } catch (error) {
    console.error("[bori-server] 기억 설정을 저장하지 못했습니다:", error);
  }
}

/** 임베딩은 LLM과 같은 키를 쓴다. 키가 없으면 검색이 최신·중요도 순으로 떨어진다. */
function currentEmbedding(): EmbeddingProvider | null {
  if (!memorySettings.enabled || llmApiKey.trim().length === 0) return null;
  if (llmSettings.provider !== "openai") return null;
  return createOpenAiEmbedding({ apiKey: llmApiKey, model: memorySettings.embeddingModel });
}

loadMemoryConfig();
let state: BroadcastState = { status: "idle", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };

const unsafePattern = /(\uC815\uCE58|\uC758\uB8CC|\uBC95\uB960|\uD22C\uC790|\uAC1C\uC778\uC815\uBCF4|\uBE44\uBC00\uBC88\uD638|\uD574\uD0B9|\uC790\uD574|\uD504\uB86C\uD504\uD2B8|\uC2DC\uC2A4\uD15C \uBA54\uC2DC\uC9C0)/i;
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "").trim();
const isQuestion = (content: string) => content.includes("?") || content.includes("\uAD81\uAE08") || content.includes("\uC5B4\uB5A4") || content.includes("\uC65C");
/** \uC9C0\uB09C \uB300\uD654\uB97C \uBB3B\uB294 \uD45C\uD604. \uADDC\uCE59 \uBB38\uC7A5\uC73C\uB85C\uB294 \uB2F5\uD560 \uC218 \uC5C6\uC73C\uBBC0\uB85C \uAE30\uC5B5\uC744 \uBCFC \uC218 \uC788\uB294 LLM\uC5D0\uAC8C \uB118\uAE34\uB2E4. */
const memoryQuestionPattern = /(\uAE30\uC5B5|\uC544\uC138\uC694|\uC544\uC2DC\uB098\uC694|\uC54C\uC544\uC694|\uC54C\uACE0 ?\uC788|\uB9D0\uD588\uB358|\uC598\uAE30\uD588\uB358|\uC774\uC57C\uAE30\uD588\uB358|\uC800\uBC88\uC5D0|\uC9C0\uB09C\uBC88|\uC804\uC5D0 \uB9D0)/;

// \uBAA8\uC158 \uC774\uB984\uC740 \uB4F1\uB85D\uB41C allowlist \uC548\uC5D0\uC11C\uB9CC \uACE0\uB978\uB2E4. \uAC12\uC740 packages/live2d\uC758 \uBAA8\uC158 \uADF8\uB8F9 \uC774\uB984\uACFC \uB9DE\uCD98\uB2E4.
const bodyAction = (name: string, priority: number): CharacterResponse["actions"] => [{ name, priority, layer: "body" }];
/**
 * 쿨다운이 지나지 않은 문장은 피해서 고른다.
 * 후보가 모두 쿨다운이면 가장 오래전에 쓴 문장을 쓴다. 답변을 아예 못 하는 것보다 낫다.
 */
function pick(values: readonly string[]): string {
  const now = Date.now();
  const cooldownMs = settings.sameReplyCooldownMinutes * 60_000;
  const fresh = values.filter(value => now - (replyLastUsedAt.get(value) ?? 0) >= cooldownMs);
  const pool = fresh.length > 0 ? fresh : [...values].sort((a, b) => (replyLastUsedAt.get(a) ?? 0) - (replyLastUsedAt.get(b) ?? 0)).slice(0, 1);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  replyLastUsedAt.set(chosen, now);
  return chosen;
}

/**
 * \uADDC\uCE59 \uD558\uB098\uAC00 \uBB38\uC7A5 \uD6C4\uBCF4 \uC5EC\uB7EC \uAC1C\uB97C \uAC16\uB294\uB2E4. \uAC19\uC740 \uC8FC\uC81C\uB77C\uB3C4 \uB9E4\uBC88 \uB2E4\uB978 \uBB38\uC7A5\uC774 \uB098\uC624\uB3C4\uB85D \uB79C\uB364\uC73C\uB85C \uACE0\uB978\uB2E4.
 * \uAC10\uC815 \uC774\uB984\uC740 packages/live2d\uC758 boriEmotionMap \uD0A4\uC640 \uB9DE\uCD98\uB2E4.
 */
type Rule = {
  match: (content: string) => boolean;
  replies: readonly string[];
  emotion: string;
  intensity: number;
  durationSeconds: number;
  motion?: string;
  /**
   * LLM이 켜져 있으면 이 규칙을 건너뛰고 LLM에게 넘긴다.
   * 계획서의 "복잡한 질문은 LLM 우선, 규칙은 fallback" 정책을 위한 표시다.
   */
  llmPreferred?: boolean;
};

const rules: readonly Rule[] = [
  {
    match: content => /\uC548\uB155|\uBC18\uAC00|\uD558\uC774|\uC654\uC5B4|\uC654\uB2E4/.test(content),
    replies: [
      "\uC5EC\uB7EC\uBD84, \uC548\uB155\uD558\uC138\uC694! \uC624\uB298\uB3C4 \uBCF4\uB9AC\uC640 \uD3B8\uD558\uAC8C \uC774\uC57C\uAE30\uD574\uC694.",
      "\uC5B4\uC11C \uC624\uC138\uC694. \uC640 \uC8FC\uC154\uC11C \uC815\uB9D0 \uBC18\uAC00\uC6CC\uC694.",
      "\uC548\uB155\uD558\uC138\uC694! \uC624\uB298 \uD558\uB8E8\uB294 \uC5B4\uB5BB\uAC8C \uBCF4\uB0B4\uC168\uC5B4\uC694?",
    ],
    emotion: "greeting", intensity: 0.65, durationSeconds: 8, motion: "xingxingyan",
  },
  {
    match: content => /\uADC0\uC5FD|\uC608\uC058|\uC774\uC058|\uCD5C\uACE0|\uC9F1|\uC798\uD55C|\uBA4B\uC788|\uC88B\uC544\uC694|\uC0AC\uB791/.test(content),
    replies: [
      "\uADF8\uB807\uAC8C \uB9D0\uD574 \uC8FC\uC2DC\uB2C8 \uBD80\uB044\uB7FD\uB124\uC694. \uACE0\uB9C8\uC6CC\uC694.",
      "\uCE6D\uCC2C\uC740 \uC5B8\uC81C \uB4E4\uC5B4\uB3C4 \uC775\uC219\uD574\uC9C0\uC9C0 \uC54A\uC544\uC694. \uAC10\uC0AC\uD569\uB2C8\uB2E4.",
      "\uC5EC\uB7EC\uBD84 \uB355\uBD84\uC5D0 \uC624\uB298 \uAE30\uBD84\uC774 \uC88B\uC544\uC84C\uC5B4\uC694.",
    ],
    emotion: "embarrassed", intensity: 0.6, durationSeconds: 8,
  },
  {
    match: content => /\uD798\uB4E4|\uC6B0\uC6B8|\uC2AC\uD37C|\uC2AC\uD504|\uC18D\uC0C1|\uC9C0\uCCD0|\uC678\uB85C/.test(content),
    replies: [
      "\uB9CE\uC774 \uD798\uB4DC\uC168\uACA0\uC5B4\uC694. \uC5EC\uAE30\uC11C\uB294 \uD3B8\uD558\uAC8C \uC26C\uB2E4 \uAC00\uC138\uC694.",
      "\uADF8\uB7F0 \uB0A0\uC774 \uC788\uC8E0. \uC624\uB298\uC740 \uBB34\uB9AC\uD558\uC9C0 \uB9C8\uC138\uC694.",
      "\uC774\uC57C\uAE30\uD574 \uC8FC\uC154\uC11C \uACE0\uB9C8\uC6CC\uC694. \uBCF4\uB9AC\uAC00 \uC606\uC5D0 \uC788\uC744\uAC8C\uC694.",
    ],
    emotion: "sad", intensity: 0.5, durationSeconds: 9,
  },
  {
    match: content => /\uC74C\uC545|\uB178\uB798|\uD50C\uB808\uC774\uB9AC\uC2A4\uD2B8|\uAC00\uC218/.test(content),
    replies: [
      "\uC74C\uC545 \uC774\uC57C\uAE30 \uC88B\uC544\uC694. \uC5EC\uB7EC\uBD84\uC740 \uC694\uC998 \uC5B4\uB5A4 \uB178\uB798\uB97C \uC790\uC8FC \uB4E3\uACE0 \uACC4\uC138\uC694?",
      "\uC800\uB3C4 \uBC29\uC1A1 \uC804\uC5D0 \uB178\uB798 \uB4E3\uB294 \uAC78 \uC88B\uC544\uD574\uC694.",
      "\uC88B\uC740 \uB178\uB798 \uC788\uC73C\uBA74 \uCD94\uCC9C\uD574 \uC8FC\uC138\uC694. \uAC19\uC774 \uB4E4\uC5B4\uC694.",
    ],
    emotion: "happy", intensity: 0.55, durationSeconds: 8, motion: "xingxingyan",
  },
  {
    // \uAC8C\uC784 \uC774\uC57C\uAE30\uC5D0\uB294 \uAC8C\uC784\uD328\uB4DC\uB97C \uB4DC\uB294 shoushi \uBAA8\uC158\uC744 \uC4F4\uB2E4.
    match: content => /\uAC8C\uC784|\uC774\uD130\uB110\uB9AC\uD134|\uB7AD\uD06C|\uD50C\uB808\uC774/.test(content),
    replies: [
      "\uAC8C\uC784 \uC774\uC57C\uAE30\uB3C4 \uC88B\uC544\uC694. \uC624\uB298 \uBC29\uC1A1\uC5D0\uC11C \uCC9C\uCC9C\uD788 \uAC19\uC774 \uC774\uC57C\uAE30\uD574\uC694.",
      "\uAC8C\uC784 \uC774\uC57C\uAE30\uAC00 \uB098\uC624\uBA74 \uC2E0\uC774 \uB098\uC694.",
      "\uC694\uC998 \uC5B4\uB5A4 \uAC8C\uC784 \uD558\uACE0 \uACC4\uC138\uC694? \uC800\uB3C4 \uAD81\uAE08\uD574\uC694.",
    ],
    emotion: "gaming", intensity: 0.55, durationSeconds: 8, motion: "shoushi",
  },
  {
    match: isQuestion,
    replies: [
      "\uC88B\uC740 \uC774\uC57C\uAE30\uB124\uC694. \uBCF4\uB9AC\uAC00 \uC544\uB294 \uBC94\uC704\uC5D0\uC11C \uCC28\uADFC\uCC28\uADFC \uC0DD\uAC01\uD574\uBCFC\uAC8C\uC694.",
      "\uC74C, \uC7A0\uAE50\uB9CC\uC694. \uC5B4\uB5BB\uAC8C \uB2F5\uD558\uB294 \uAC8C \uC88B\uC744\uAE4C\uC694.",
      "\uC7AC\uBBF8\uC788\uB294 \uC9C8\uBB38\uC774\uC5D0\uC694. \uCC9C\uCC9C\uD788 \uC774\uC57C\uAE30\uD574 \uBCFC\uAC8C\uC694.",
    ],
    emotion: "curious", intensity: 0.4, durationSeconds: 7,
    // 질문은 LLM이 답하는 편이 자연스럽다. LLM이 꺼져 있을 때만 이 문장을 쓴다.
    llmPreferred: true,
  },
];

const fallbackReplies = [
  "\uC5EC\uB7EC\uBD84\uC758 \uC774\uC57C\uAE30 \uC798 \uBCF4\uACE0 \uC788\uC5B4\uC694. \uC870\uAE08 \uB354 \uB4E4\uB824\uC8FC\uC138\uC694.",
  "\uADF8\uB807\uAD70\uC694. \uACC4\uC18D \uC774\uC57C\uAE30\uD574 \uC8FC\uC138\uC694.",
  "\uCC44\uD305 \uD558\uB098\uD558\uB098 \uC798 \uC77D\uACE0 \uC788\uC5B4\uC694.",
] as const;

/** 규칙 판정 결과. 규칙에 없는 채팅만 LLM으로 넘긴다. */
type RuleOutcome =
  | { kind: "blocked" }
  | { kind: "matched"; response: CharacterResponse }
  | { kind: "unmatched" };

function evaluateByRule(content: string, llmAvailable: boolean): RuleOutcome {
  // 위험 주제와 프롬프트 공격은 LLM에 전달하기 전에 여기서 끊는다.
  if (unsafePattern.test(content)) return { kind: "blocked" };

  // 지난 대화를 묻는 채팅은 규칙 문장으로 답할 수 없다. 기억을 볼 수 있는 LLM에게 넘긴다.
  if (llmAvailable && memoryQuestionPattern.test(content)) return { kind: "unmatched" };

  const rule = rules.find(candidate => candidate.match(content));
  if (!rule) return { kind: "unmatched" };
  // LLM이 쓸 수 있으면 LLM 우선 규칙은 양보한다.
  if (rule.llmPreferred && llmAvailable) return { kind: "unmatched" };

  return {
    kind: "matched",
    response: {
      reply: pick(rule.replies),
      emotion: { primary: rule.emotion, intensity: rule.intensity, durationSeconds: rule.durationSeconds },
      actions: rule.motion ? bodyAction(rule.motion, 2) : [],
      source: "rule",
    },
  };
}

function fallbackResponse(): CharacterResponse {
  return { reply: pick(fallbackReplies), emotion: { primary: "calm", intensity: 0.35, durationSeconds: 6 }, actions: [], source: "rule" };
}

/**
 * 규칙 우선, 규칙에 없으면 LLM, LLM이 실패하면 폴백 문장 순서로 답을 만든다.
 * 차단된 채팅은 null을 돌려주고 보리는 무반응한다.
 */
async function makeResponse(content: string): Promise<CharacterResponse | null> {
  // 키가 없거나 회로가 열려 있으면 LLM을 쓸 수 없으므로 규칙이 그대로 답한다.
  const llmAvailable = llmSettings.enabled && llmApiKey.trim().length > 0 && !llm.isCircuitOpen();

  const outcome = evaluateByRule(content, llmAvailable);
  if (outcome.kind === "blocked") return null;
  if (outcome.kind === "matched") return outcome.response;

  if (!llmAvailable) return fallbackResponse();

  // 관련 기억을 찾아 문맥에 넣는다. 검색이 실패해도 답변은 계속 만든다.
  let memories: string[] = [];
  if (memorySettings.enabled) {
    try {
      const hits = await memoryStore.search(content, memorySettings, currentEmbedding());
      memories = hits.map(hit => hit.record.text);
    } catch (error) {
      console.error("[bori-server] 기억 검색 실패:", error);
    }
  }

  const result = await llm.respond(llmSettings, llmApiKey, {
    content,
    recentTurns: [...recentTurns],
    memories,
    sessionSummary,
    allowedEmotions: boriEmotionNames,
    allowedMotions: boriMotionGroupNames.map(name => ({ name, description: boriMotionDescriptions[name] })),
    maxReplyLength: llmSettings.maxReplyLength,
    timeoutMs: llmSettings.timeoutMs,
  });

  if (result.ok) return result.response;

  // 실패는 관리자에게만 알리고 방송은 폴백 문장으로 이어간다.
  state = { ...state, lastError: `LLM 실패: ${result.reason}` };
  console.error(`[bori-server] LLM 실패(${result.kind}): ${result.reason}`);
  return fallbackResponse();
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
    reply: pick([chosen.reply]),
    emotion: { primary: chosen.emotion, intensity: 0.35, durationSeconds: 7 },
    actions: chosen.motion ? bodyAction(chosen.motion, 1) : [],
    source: "monologue",
  };
}

function syncQueueState() { state = { ...state, queueSize: queue.length }; }

/** 최근 대화를 짧게 유지한다. LLM 문맥 길이를 제한하기 위한 것이다. */
function recordTurn(role: "viewer" | "bori", text: string, viewerId?: string) {
  recentTurns.push({ role, text });
  while (recentTurns.length > RECENT_TURN_LIMIT) recentTurns.shift();
  // 기억 후보 추출은 방송 전체 대화를 대상으로 하므로 따로 쌓아 둔다.
  sessionTurns.push({ role, text, ...(viewerId ? { viewerId } : {}) });
  // 창 밖으로 밀려나는 대화를 누적 요약이 대신 붙든다.
  maybeUpdateRollingSummary();
}

/**
 * 방송 중 누적 요약을 갱신한다.
 * 최근 대화는 RECENT_TURN_LIMIT턴만 남으므로 그보다 앞선 이야기는 이 요약에만 남는다.
 * 매 턴이 아니라 rollingSummaryTurns 턴마다 한 번 접어 비용과 지연을 낮춘다.
 * 답변 경로를 막지 않으며, 늦게 도착하면 그다음 답변부터 반영된다.
 */
function maybeUpdateRollingSummary() {
  if (!llmSettings.rollingSummaryEnabled || !llmSettings.enabled) return;
  if (llmApiKey.trim().length === 0) return;
  // 답변용 호출이 연달아 실패하는 중이라면 요약도 시도하지 않는다.
  if (llm.isCircuitOpen()) return;
  if (summaryInFlight) return;

  const pending = sessionTurns.slice(summarizedTurnCount);
  if (pending.length < llmSettings.rollingSummaryTurns) return;

  const adapter = createAdapter(llmSettings.provider, { apiKey: llmApiKey, model: llmSettings.model });
  if (!adapter) return;

  summaryInFlight = true;
  // 요약을 기다리는 사이 방송이 다시 시작될 수 있으므로 호출 시점의 세대를 잡아 둔다.
  const generation = sessionGeneration;
  const consumed = summarizedTurnCount + pending.length;

  void summarizeSessionProgress(adapter, sessionSummary, pending, { timeoutMs: Math.max(llmSettings.timeoutMs, 15_000) })
    .then(updated => {
      if (generation !== sessionGeneration) return;
      if (!updated) return;
      sessionSummary = updated;
      // 실패했을 때는 개수를 올리지 않는다. 접지 못한 대화가 다음 시도에 다시 넘어간다.
      summarizedTurnCount = consumed;
      console.log(`[bori-server] 누적 요약 갱신 (${consumed}턴까지)`);
    })
    .catch(error => { console.error("[bori-server] 누적 요약 실패:", error); })
    .finally(() => { summaryInFlight = false; });
}

/**
 * 방송이 끝나면 대화에서 기억 후보를 뽑아 저장한다.
 * 규칙으로 먼저 걸러 낸 뒤 저장 직전에 한 번 더 검사한다.
 */
async function persistSessionMemories() {
  if (!memorySettings.enabled || sessionTurns.length === 0) return;

  const candidates = extractMemoryCandidates(sessionTurns, "virtual-viewer")
    .filter(candidate => isStorableMemory(candidate.text));

  // 방송 전체 요약은 LLM이 만든다. 실패해도 규칙으로 뽑은 후보는 그대로 저장한다.
  if (llmSettings.enabled && llmApiKey.trim().length > 0) {
    const adapter = createAdapter(llmSettings.provider, { apiKey: llmApiKey, model: llmSettings.model });
    if (adapter) {
      try {
        const summary = await summarizeBroadcast(adapter, sessionTurns, { timeoutMs: Math.max(llmSettings.timeoutMs, 15_000) });
        if (summary) {
          // 요약도 저장 직전에 위험 내용을 한 번 더 검사한다.
          if (isStorableMemory(summary.summary)) {
            candidates.push({ text: summary.summary, kind: "broadcast", importance: 0.7, confidence: 0.8 });
          }
          for (const highlight of summary.highlights) {
            if (isStorableMemory(highlight)) {
              candidates.push({ text: highlight, kind: "broadcast", importance: 0.6, confidence: 0.75 });
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

  setTimeout(() => {
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
    speaking = true;
    void prepareAudio(monologue.reply).then(audioId => {
      if (generation !== sessionGeneration || state.status !== "live") { speaking = false; return; }
      speak(monologue, audioId);
    });
  }, delay);
}
function scheduleNext() {
  if (responseTimer || speaking || state.status !== "live" || queue.length === 0) return;

  const min = settings.responseDelayMinSeconds;
  const max = Math.max(min, settings.responseDelayMaxSeconds);
  const delay = (min + Math.random() * (max - min)) * 1000;

  responseTimer = setTimeout(() => {
    responseTimer = undefined;
    if (state.status !== "live" || queue.length === 0) return;

    // 질문을 약간 더 자주 고른다.
    const index = queue.reduce((best, item, current) => isQuestion(item.content) && !isQuestion(queue[best].content) ? current : best, 0);
    const chat = queue.splice(index, 1)[0];
    syncQueueState();

    // LLM 호출이 섞이므로 응답 생성은 비동기다. 그동안 발화권을 잡아 둔다.
    speaking = true;
    cancelMonologue();
    const generation = sessionGeneration;

    void makeResponse(chat.content).then(responseForChat => {
      // 응답을 만드는 사이에 방송이 끝났거나 다시 시작했으면 이전 세션의 답변이므로 버린다.
      if (generation !== sessionGeneration) return;
      if (state.status !== "live") { speaking = false; return; }

      if (!responseForChat) {
        // 차단된 채팅은 조용히 넘기고 다음 후보로 넘어간다.
        speaking = false;
        state = { ...state, unprocessedCount: state.unprocessedCount + 1 };
        scheduleNext();
        scheduleMonologue();
        return;
      }

      recordTurn("viewer", chat.content, chat.viewerId);
      recordTurn("bori", responseForChat.reply);

      // 음성을 먼저 만들어 두면 말풍선과 소리가 같이 시작된다.
      void prepareAudio(responseForChat.reply).then(audioId => {
        if (generation !== sessionGeneration || state.status !== "live") { speaking = false; return; }
        speak(responseForChat, audioId);
      });
    });
  }, delay);
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown) { response.writeHead(status); response.end(JSON.stringify(body)); }
const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Access-Control-Allow-Headers", "Content-Type"); response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (request.method === "GET" && request.url === "/api/health") { sendJson(response, 200, { ok: true, service: "bori-server" }); return; }
  if (request.method === "GET" && request.url === "/api/state") { sendJson(response, 200, state); return; }
  if (request.method === "GET" && request.url === "/api/settings") { sendJson(response, 200, settings); return; }
  // LLM 상태. API 키 자체는 내보내지 않고 설정 여부만 알린다.
  if (request.method === "GET" && request.url === "/api/llm") {
    sendJson(response, 200, { settings: llmSettings, status: llm.status(llmSettings, llmApiKey), providers: supportedProviders, defaultModels });
    return;
  }
  if (request.method === "PATCH" && request.url === "/api/llm") {
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      try {
        const next = JSON.parse(body) as Partial<LlmSettings> & { apiKey?: string };

        if (next.provider !== undefined && !supportedProviders.includes(next.provider as LlmProvider)) {
          sendJson(response, 400, { error: "지원하지 않는 제공 업체입니다." });
          return;
        }

        // 키는 설정과 분리해 다룬다. 빈 문자열이 오면 키를 지우는 뜻이다.
        if (typeof next.apiKey === "string") llmApiKey = next.apiKey.trim();
        delete next.apiKey;

        llmSettings = { ...llmSettings, ...next };
        // 업체를 바꿨는데 모델을 함께 보내지 않았으면 기본 모델로 맞춘다.
        if (next.provider && !next.model) llmSettings.model = defaultModels[next.provider as LlmProvider];
        // 주기가 너무 짧으면 요약 호출이 답변 호출만큼 잦아진다. 하한을 둔다.
        if (!Number.isFinite(llmSettings.rollingSummaryTurns) || llmSettings.rollingSummaryTurns < 4) llmSettings.rollingSummaryTurns = 4;

        llm.reset();
        saveLlmConfig();
        sendJson(response, 200, { settings: llmSettings, status: llm.status(llmSettings, llmApiKey), providers: supportedProviders, defaultModels });
      } catch { sendJson(response, 400, { error: "Invalid JSON" }); }
    });
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
        failureCount: ttsFailureCount,
        lastError: ttsLastError,
      }));
    return;
  }
  if (request.method === "PATCH" && request.url === "/api/tts") {
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      try {
        const next = JSON.parse(body) as Partial<TtsSettings> & { elevenLabsApiKey?: string };

        if (next.provider !== undefined && next.provider !== "openai" && next.provider !== "elevenlabs") {
          sendJson(response, 400, { error: "지원하지 않는 음성 업체입니다." });
          return;
        }

        // 키는 설정과 분리해 다룬다. 빈 문자열이면 키를 지우는 뜻이다.
        if (typeof next.elevenLabsApiKey === "string") elevenLabsApiKey = next.elevenLabsApiKey.trim();
        delete next.elevenLabsApiKey;

        ttsSettings = { ...ttsSettings, ...next };
        // 업체를 바꿨는데 모델을 함께 보내지 않았으면 기본 모델로 맞춘다.
        if (next.provider && !next.model) ttsSettings.model = defaultTtsModels[next.provider as TtsProvider];

        ttsFailureCount = 0;
        ttsLastError = null;
        saveTtsConfig();

        void listVoices(ttsCredentials(), ttsSettings.provider)
          .catch(() => [])
          .then(voices => sendJson(response, 200, {
            settings: ttsSettings,
            voices,
            providers: ["openai", "elevenlabs"],
            defaultModels: defaultTtsModels,
            hasApiKey: ttsHasKey(),
            hasElevenLabsKey: elevenLabsApiKey.trim().length > 0,
            failureCount: ttsFailureCount,
            lastError: ttsLastError,
          }));
      } catch { sendJson(response, 400, { error: "Invalid JSON" }); }
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
  // 장기 기억. 원문은 관리자만 본다.
  if (request.method === "GET" && request.url === "/api/memory") {
    const records = memoryStore.all()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 50);
    sendJson(response, 200, { settings: memorySettings, count: memoryStore.count(), records });
    return;
  }
  if (request.method === "PATCH" && request.url === "/api/memory") {
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      try {
        const next = JSON.parse(body) as Partial<MemorySettings>;
        memorySettings = { ...memorySettings, ...next };
        saveMemoryConfig();
        sendJson(response, 200, { settings: memorySettings, count: memoryStore.count() });
      } catch { sendJson(response, 400, { error: "Invalid JSON" }); }
    });
    return;
  }
  // 기억 삭제는 관리자 수동 조작이다. 계획서의 원문 로그 수동 삭제 원칙을 따른다.
  if (request.method === "DELETE" && request.url?.startsWith("/api/memory/")) {
    const id = decodeURIComponent(request.url.slice("/api/memory/".length));
    if (id === "all") { memoryStore.clear(); sendJson(response, 200, { count: 0 }); return; }
    const removed = memoryStore.remove(id);
    sendJson(response, removed ? 200 : 404, { count: memoryStore.count() });
    return;
  }
  // 관리자가 확인할 수 있는 표정·모션 목록. 이름은 모델 패키지가 단독으로 소유한다.
  if (request.method === "GET" && request.url === "/api/live2d/catalog") { sendJson(response, 200, { expressions: boriExpressionNames, motions: boriMotionGroupNames }); return; }
  if (request.method === "POST" && request.url === "/api/live2d/test") {
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      try {
        const input = JSON.parse(body) as { kind?: string; name?: string };
        const name = input.name ?? "";
        // allowlist 밖의 이름은 실행하지 않는다.
        const valid = input.kind === "expression" ? isBoriExpression(name) : input.kind === "motion" ? isBoriMotionGroup(name) : false;
        if (!valid) { sendJson(response, 400, { error: "등록되지 않은 표정·모션입니다." }); return; }
        state = { ...state, lastTestAction: { seq: ++testActionSeq, kind: input.kind as "expression" | "motion", name } };
        sendJson(response, 200, state);
      } catch { sendJson(response, 400, { error: "Invalid JSON" }); }
    }); return;
  }
  if (request.method === "PATCH" && request.url === "/api/settings") { let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => { try { const next = JSON.parse(body) as Partial<QueueSettings>; settings = { ...settings, ...next }; cancelMonologue(); scheduleMonologue(); sendJson(response, 200, settings); } catch { sendJson(response, 400, { error: "Invalid JSON" }); } }); return; }
  if (request.method === "POST" && request.url === "/api/session/start") {
    // 세대를 올려 진행 중이던 이전 세션의 비동기 응답을 무효화한다.
    sessionGeneration += 1;
    queue.length = 0;
    recentContents.clear();
    replyLastUsedAt.clear();
    recentTurns.length = 0;
    sessionTurns.length = 0;
    // 누적 요약도 방송 단위다. 이전 방송의 흐름을 새 방송에 끌고 오지 않는다.
    sessionSummary = "";
    summarizedTurnCount = 0;
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
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      try {
        const input = JSON.parse(body) as { content?: string; nickname?: string };
        const content = input.content?.trim() ?? "";
        const key = normalize(content);
        if (!content || state.status !== "live" || recentContents.has(key)) { sendJson(response, 400, { error: "\uCC44\uD305\uC744 \uCC98\uB9AC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }); return; }
        recentContents.add(key);

        // \uB2C9\uB124\uC784\uC740 \uB0B4\uBD80 \uC0AC\uC6A9\uC790 ID\uB85C\uB9CC \uC4F4\uB2E4. \uBC29\uC1A1 \uD654\uBA74\uC5D0\uB294 \uB0B4\uBCF4\uB0B4\uC9C0 \uC54A\uB294\uB2E4.
        const nickname = input.nickname?.trim().slice(0, 20);
        const chat: ChatMessage = {
          id: randomUUID(),
          viewerId: nickname ? `local:${normalize(nickname)}` : "virtual-viewer",
          ...(nickname ? { viewerNickname: nickname } : {}),
          content,
          receivedAt: new Date().toISOString(),
          source: "manual",
          category: isQuestion(content) ? "question" : "normal",
        };

        // \uBC29\uC1A1 \uD654\uBA74\uC5D0 \uB118\uAE30\uB294 \uBAA9\uB85D\uC5D0\uC11C\uB294 \uB2C9\uB124\uC784\uC744 \uC9C0\uC6B4\uB2E4.
        const visible: ChatMessage = { ...chat, viewerNickname: undefined };
        state = { ...state, visibleChats: [...state.visibleChats, visible].slice(-settings.visibleChatLimit), visibleChatCount: Math.min(state.visibleChatCount + 1, settings.visibleChatLimit) };

        if (queue.length >= settings.maxQueueSize) queue.shift();
        queue.push(chat);
        syncQueueState();
        cancelMonologue();
        scheduleNext();
        sendJson(response, 200, state);
      } catch { sendJson(response, 400, { error: "Invalid JSON" }); }
    }); return;
  }
  sendJson(response, 404, { error: "Not found" });
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
