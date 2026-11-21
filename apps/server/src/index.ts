// 루트 .env를 가장 먼저 읽는다. 아래 모듈 일부가 import 시점에 환경 변수를 읽는다.
import "./load-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmProvider, LlmSettings } from "@bori/shared";
import { boriExpressionNames, boriMotionGroupNames } from "@bori/live2d";
import { createLlmClient, createVoiceListCache, defaultModels, defaultTtsModels, defaultTtsSettings, supportedProviders, synthesizeSpeech, ttsApiKey, type TtsProvider, type TtsSettings } from "@bori/llm";
import { createApiKeySlot } from "./secret-store.js";
import { createConfigFile } from "./config-file.js";
import { allowedOriginsFrom, guardRequest, readBody } from "./http/guard.js";
import { serveStatic } from "./http/static.js";
import { staticRoutesFor } from "./http/static-routes.js";
import { isValidVoice, pickValidSettings, ttsProviders, validateLlmSettingsPatch, validateTtsSettingsPatch, withoutLegacyLlmKeys, type PatchResult } from "./http/settings.js";
import { buildUsageReport, createUsageStore, loadPriceTable } from "./usage/index.js";
import { BACKUP_RETENTION_DAYS, purgeExpiredBackups } from "./retention.js";
import { createErClient } from "@bori/er";
import { createErData } from "./er/er-data.js";
import { createDashboardSettings } from "./er/dashboard-settings.js";
import { createDashboardData } from "./er/dashboard-state.js";
import { createNarrationStore, createNarrator } from "./narration/index.js";
import { narrationLlmFrom } from "./narration-llm.js";
import { handleDashboardRoute } from "./http/dashboard-routes.js";

/**
 * 보리 서버. 이터널리턴 메타 대시보드(apps/companion)와 스튜디오(apps/admin)가 쓰는 로컬 API다.
 * 2026-11-21에 치지직 방송·1:1 대화·대화 엔진·장기 기억을 지웠다(docs/decisions.md).
 * 대시보드 상태(/api/dashboard)는 er/, 보리 읽어 주기는 narration/이 만들고 이 파일은 잇기만 한다.
 */
const port = Number(process.env.BORI_SERVER_PORT ?? 4310);

// 놓친 비동기 오류가 있어도 서버를 내리지 않고 기록만 남긴다. 알려진 경로는 모두 각자 catch가 있다(점검 X-3).
process.on("unhandledRejection", reason => {
  console.error("[bori-server] 처리되지 않은 비동기 오류:", reason);
});

// ── LLM 설정과 API 키 ─────────────────────────────────────────
// 키는 data/ 아래에만 둔다. data/는 .gitignore 대상이다.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/**
 * 설정·사용량·이터널리턴 데이터가 들어가는 디렉터리.
 * 환경변수로 옮길 수 있게 해서, 실제 데이터를 건드리지 않고 서버를 띄워 볼 수 있다.
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
};
// 환경변수로도 키를 넣을 수 있다. 저장된 키가 없을 때만 쓰고, 환경변수 키는 파일에 쓰지 않는다.
const llmKey = createApiKeySlot(process.env.OPENAI_API_KEY);
/** 지금 쓰는 키. llmKey가 바뀔 때마다 맞춘다. */
let llmApiKey = llmKey.current();

// ── API 사용량 ────────────────────────────────────────────────
// 기능·모드·모델별 호출 수와 토큰·글자 수만 날짜별로 센다. 대사 내용·닉네임은 넘기지 않는다(ADR-018).
const usageStore = createUsageStore(resolve(dataRoot, "usage.json"));
usageStore.load();
const usagePricesPath = resolve(dataRoot, "usage-prices.json");

/** LLM 클라이언트. 회로 차단기와 호출 통계가 안에 있다. 업체를 부를 때마다 사용량에 센다(모드는 클라이언트 기본값 narration). */
const llm = createLlmClient({ onCall: call => usageStore.record({ feature: "reply", ...call }) });

/**
 * 설정 파일을 읽는다. 파일이 없으면 기본값으로 시작한다.
 * 값은 PATCH와 같은 검증기로 키마다 보고, 틀린 값은 기본값으로 둔 뒤 원본을 남긴다(점검 D-5).
 */
function loadLlmConfig() {
  const saved = llmConfigFile.read();
  if (!saved) return;

  // 1:1 대화를 쓰던 때의 칸(누적 요약·매크로)은 잘못된 값으로 보지 않고 조용히 뺀다.
  const savedSettings = isPlainObject(saved.settings) ? withoutLegacyLlmKeys(saved.settings) : {};
  // 키는 settings 밖의 apiKey에만 둔다. settings 안의 키는 설정으로 받지 않는다.
  const picked = pickValidSettings<LlmSettings>(savedSettings, patch => ("apiKey" in patch ? { ok: false, error: "" } : validateLlmSettingsPatch(patch) as PatchResult<LlmSettings>));
  llmSettings = { ...llmSettings, ...picked.patch };
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
/** 생성한 음성과 그 재생 길이. 대시보드가 받아가면 되므로 메모리에만 두고 오래된 것부터 버린다. */
const audioCache = new Map<string, { audio: Buffer; durationMs: number }>();
const AUDIO_CACHE_LIMIT = 30;
/**
 * 음성 캐시 총 크기 상한. 전에는 개수만 세서 10MB 음성 30건이 344MB를 붙잡았다(a4 A4-15).
 * 평소 답 음성은 수백 KB라 30건이 10MB 안쪽이다. 50MB면 개수 상한이 먼저 걸리고, 큰 응답만 크기로 밀려난다.
 */
const AUDIO_CACHE_MAX_BYTES = 50 * 1024 * 1024;
let audioCacheBytes = 0;
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
 * 대사 음성을 만들어 캐시에 넣고 id를 돌려준다. 대시보드가 /api/tts/:id로 받아 재생한다.
 * 실패하면 undefined이고 그 줄은 자막만 보인다. 보리 읽어 주기(narration/)가 줄마다 부른다.
 */
async function prepareAudio(text: string): Promise<string | undefined> {
  if (!ttsSettings.enabled || !ttsHasKey()) return undefined;

  // 합성 중에 설정이 바뀔 수 있으므로 부를 때의 모델로 센다. 글자 수만 세고 문장은 넘기지 않는다.
  const usage = { feature: "tts" as const, mode: "narration" as const, model: ttsSettings.model };
  try {
    // 빈 본문·mp3가 아닌 응답은 synthesizeSpeech가 실패로 돌려준다. 화면이 재생 실패를 자동재생 차단으로 오인하지 않게 한다(a4 A4-13).
    const result = await synthesizeSpeech(ttsCredentials(), ttsSettings, text);
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

// ── 이터널리턴 데이터 ─────────────────────────────────────────

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
console.log(`[bori-server] 이터널리턴 데이터: ${erData.connection()}${erApiKey ? "" : " (ER_API_KEY 없음)"}`);

// ── 대시보드와 보리 읽어 주기 ─────────────────────────────────
/** 대시보드 상태(연결·갱신·기준·조합·내 전적). 닉네임은 data/dashboard-settings.json에 둔다. */
const dashboard = createDashboardData({ erData, settings: createDashboardSettings(dataRoot) });
/**
 * 갱신 결과를 보리가 읽는다. LLM은 위 클라이언트(회로 차단·사용량 narration)를 쓰고, 꺼짐·실패면 정해진 문장이다.
 * 음성은 prepareAudio(사용량 narration)로 만들고, 다시 듣기 때 캐시에서 사라진 음성만 다시 만든다.
 */
const narrator = createNarrator({
  llm: narrationLlmFrom(llm.complete, () => ({ settings: llmSettings, apiKey: llmApiKey })),
  prepareAudio,
  hasAudio: id => audioCache.has(id),
  store: createNarrationStore(resolve(dataRoot, "narration.json")),
  dictionary: () => erData.dictionary(),
  maxLineLength: () => llmSettings.maxReplyLength,
});
// 켤 때 마지막 대사(data/narration.json)를 읽어 둔다. 갱신 없이도 지난 분석을 보여 준다.
const startupNarration = narrator.latest();
console.log(startupNarration ? `[bori-server] 지난 보리 대사를 불러왔습니다 (${startupNarration.lines.length}줄, ${startupNarration.source})` : "[bori-server] 저장된 보리 대사가 없습니다.");
// 갱신이 끝나고 전적까지 다시 조회하면 새 집계로 대사를 만든다. 닉네임은 사실 목록에 들어가지 않는다(narration/facts.ts).
dashboard.onRefreshed(state => {
  narrator.narrate({ basis: state.basis, combos: state.combos, player: state.player.summary })
    .then(narration => console.log(`[bori-server] 보리 대사 ${narration.lines.length}줄을 만들었습니다 (${narration.source})`))
    .catch(error => console.error("[bori-server] 보리 대사를 만들지 못했습니다:", error instanceof Error ? error.message : "알 수 없는 오류"));
});

/** 라우트를 고를 경로. 쿼리와 끝 슬래시는 뗀다. 전에는 request.url 전체를 비교해 "/api/state?x=1"이 404였다(점검 Q-4). */
function routePathOf(url: string | undefined): string {
  const pathname = new URL(url ?? "/", "http://127.0.0.1").pathname;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

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
// 이 서버가 내준 화면(/companion/·/studio/)은 서버 자신의 Origin으로 스크립트·API를 부르므로 함께 허용한다.
const guardOptions = { allowedOrigins: new Set([...allowedOriginsFrom(process.env.BORI_ALLOWED_ORIGINS), `http://127.0.0.1:${port}`, `http://localhost:${port}`]) };
// 빌드한 화면. 스튜디오와 브라우저가 Vite 없이 이 서버 주소로 연다.
const staticRoutes = staticRoutesFor(projectRoot);

/** LLM 상태 응답. API 키 자체는 내보내지 않고 설정 여부만 알린다. */
const llmView = () => ({ settings: llmSettings, status: llm.status(llmSettings, llmApiKey), storedKeyUnreadable: llmKey.isUnreadable(), providers: supportedProviders, defaultModels });

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
  // 대시보드·이터널리턴 갱신·게임 닉네임·다시 듣기(http/dashboard-routes.ts)
  if (handleDashboardRoute(method, path, request, response, { dashboard, narrator })) return;
  if (method === "GET" && path === "/api/llm") { sendJson(response, 200, llmView()); return; }
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
        sendJson(response, 200, llmView());
      } catch (error) { sendBodyError(response, error); }
    });
    return;
  }
  // 호출량과 추정 비용. 숫자만 담고, 단가 파일은 요청마다 다시 읽는다.
  if (method === "GET" && path === "/api/usage") {
    sendJson(response, 200, buildUsageReport(usageStore.days(), loadPriceTable(usagePricesPath), Date.now()));
    return;
  }
  // 음성 설정과 재생. 오디오는 대시보드가 바로 받아 재생한다.
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
  // 표정·모션 목록. 이름은 모델 패키지가 단독으로 소유한다.
  if (method === "GET" && path === "/api/live2d/catalog") { sendJson(response, 200, { expressions: boriExpressionNames, motions: boriMotionGroupNames }); return; }
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
