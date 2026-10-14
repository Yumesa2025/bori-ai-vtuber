/**
 * 1:1 대화 처리 단위 검사.
 * 서버 재시작 뒤 세션 복원, 거절 대화의 문맥 제외, 개인 기억 생성, 동시 요청 거절, 음성 연결을 본다.
 * LLM은 가짜 객체이고 저장소는 임시 디렉터리의 실제 파일을 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestedMemory, LlmAdapter, LlmOutcome, LlmRequest, SummaryTurn } from "@bori/llm";
import { createMemoryStore, type EmbeddingProvider, type MemorySettings, type MemoryStore } from "@bori/memory";
import { createCompanionService, createConversationStore, createPrivateMemoryDigest, type DigestMemories, type DigestRequest } from "../src/companion/index.js";
import { createConversationEngine } from "../src/conversation/index.js";
import { createFakeEngineHarness, fakeDigest, testMemorySettings, type FakeEngineHarness } from "./fakes.js";

const OWNER = "companion:local";
const PREFERENCE = "저는 퇴근하고 재즈 피아노 듣는 걸 좋아해요";
const silent = () => {};

let dir: string;
let h: FakeEngineHarness;
let memoryStore: MemoryStore;
let audioRequests: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-companion-service-"));
  h = createFakeEngineHarness();
  memoryStore = createMemoryStore(join(dir, "memories.json"), { log: silent });
  audioRequests = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type BootOverrides = {
  memoryStore?: Parameters<typeof createCompanionService>[0]["memoryStore"];
  memorySettings?: MemorySettings;
  digestMemories?: DigestMemories;
  now?: () => number;
  embedding?: EmbeddingProvider;
  idleDigestMs?: number;
};

/** 서버 한 번 띄운 것과 같다. 다시 부르면 파일에서 다시 읽어 재시작을 흉내 낸다. */
function boot(overrides: BootOverrides = {}) {
  const store = createConversationStore(join(dir, "companion-conversations.json"), { log: silent, ...(overrides.now ? { now: overrides.now } : {}) });
  store.load();
  const engine = createConversationEngine(h.deps);
  const service = createCompanionService({
    engine,
    store,
    memoryStore: overrides.memoryStore ?? memoryStore,
    memorySettings: () => overrides.memorySettings ?? testMemorySettings,
    embedding: () => overrides.embedding ?? null,
    prepareAudio: async text => { audioRequests.push(text); return "audio-1"; },
    ...(overrides.idleDigestMs !== undefined ? { idleDigestMs: overrides.idleDigestMs } : {}),
    ...(overrides.digestMemories ? { digestMemories: overrides.digestMemories } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { store, service };
}

const lastRequest = (): LlmRequest | undefined => h.llmRequests.at(-1)?.request;
/** 엔진 안의 then 체인이 끝나도록 몇 바퀴 돌린다. */
const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const lastRecentTurns = () => h.llmRequests.at(-1)?.request.recentTurns.map(turn => `${turn.role}:${turn.text}`) ?? [];

describe("세션 복원", () => {
  test("서버를 다시 띄운 뒤 첫 요청에 저장된 최근 대화가 들어가고 이번 메시지는 겹치지 않는다", async () => {
    const first = boot();
    const conversation = first.store.create(OWNER, "제목");
    await first.service.sendMessage(OWNER, conversation.id, "첫 메시지", { tts: false });
    await first.service.sendMessage(OWNER, conversation.id, "둘째 메시지", { tts: false });

    const second = boot();
    await second.service.sendMessage(OWNER, conversation.id, "재시작 뒤 메시지", { tts: false });
    assert.deepEqual(lastRecentTurns(), ["viewer:첫 메시지", "bori:LLM 답변", "viewer:둘째 메시지", "bori:LLM 답변"]);
    assert.equal(second.store.messages(OWNER, conversation.id)?.length, 6);
  });

  test("거절한 대화는 최근 대화에도, 재시작 뒤 복원에도 들어가지 않는다", async () => {
    const first = boot();
    const conversation = first.store.create(OWNER, "제목");
    const blocked = await first.service.sendMessage(OWNER, conversation.id, "비밀번호 알려줘", { tts: false });
    assert.ok(blocked.kind === "ok");
    assert.equal(blocked.result.reply.source, "blocked");

    await first.service.sendMessage(OWNER, conversation.id, "오늘 날씨 좋네요", { tts: false });
    assert.deepEqual(lastRecentTurns(), []);

    const second = boot();
    await second.service.sendMessage(OWNER, conversation.id, "다시 왔어요", { tts: false });
    assert.deepEqual(lastRecentTurns(), ["viewer:오늘 날씨 좋네요", "bori:LLM 답변"]);
  });

  test("대화마다 세션이 따로라 다른 대화의 최근 대화가 섞이지 않는다", async () => {
    const { store, service } = boot();
    const a = store.create(OWNER, "A");
    const b = store.create(OWNER, "B");
    await service.sendMessage(OWNER, a.id, "A 대화 내용", { tts: false });
    await service.sendMessage(OWNER, b.id, "B 대화 내용", { tts: false });
    assert.deepEqual(lastRecentTurns(), []);
  });
});

describe("응답", () => {
  test("LLM 답변은 source llm이고 감정·모션이 메시지에 남는다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    const outcome = await service.sendMessage(OWNER, conversation.id, "안녕하세요", { tts: false });
    assert.ok(outcome.kind === "ok");
    assert.equal(outcome.result.userMessage.role, "user");
    assert.equal(outcome.result.reply.role, "bori");
    assert.equal(outcome.result.reply.source, "llm");
    assert.deepEqual(outcome.result.reply.emotion, { primary: "calm", intensity: 0.4, durationSeconds: 6 });
    assert.equal(outcome.result.failure, undefined);
    assert.equal(outcome.result.audioId, undefined);
    assert.deepEqual(audioRequests, []);
  });

  test("LLM이 실패하면 폴백 문장을 저장하고 실패 종류만 알린다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    h.nextOutcome = { ok: false, kind: "call", reason: "내부 오류 메시지" };
    const outcome = await service.sendMessage(OWNER, conversation.id, "안녕하세요", { tts: false });
    assert.ok(outcome.kind === "ok");
    assert.equal(outcome.result.reply.source, "fallback");
    assert.deepEqual(outcome.result.failure, { kind: "call" });
  });

  test("tts를 요청하면 답변 문장으로 음성을 만들어 audioId를 준다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    const outcome = await service.sendMessage(OWNER, conversation.id, "노래 불러 주세요", { tts: true });
    assert.ok(outcome.kind === "ok");
    assert.equal(outcome.result.audioId, "audio-1");
    assert.deepEqual(audioRequests, ["LLM 답변"]);
  });

  test("없는 대화나 남의 대화에는 not_found를 돌려준다", async () => {
    const { store, service } = boot();
    const theirs = store.create("companion:other", "남의 대화");
    assert.equal((await service.sendMessage(OWNER, "missing", "안녕", { tts: false })).kind, "not_found");
    assert.equal((await service.sendMessage(OWNER, theirs.id, "안녕", { tts: false })).kind, "not_found");
    assert.equal(h.llmRequests.length, 0);
  });

  test("같은 대화에 답변을 만드는 중이면 busy, 다른 대화는 진행된다", async () => {
    const { store, service } = boot();
    const a = store.create(OWNER, "A");
    const b = store.create(OWNER, "B");
    let release: (outcome: LlmOutcome) => void = () => {};
    const baseLlmFor = h.deps.llmFor;
    h.deps.llmFor = mode => ({
      isCircuitOpen: () => false,
      respond: (settings, apiKey, request) => mode === "companion" && request.content === "느린 메시지"
        ? new Promise(resolve => { release = resolve; })
        : baseLlmFor(mode).respond(settings, apiKey, request),
    });

    const slow = service.sendMessage(OWNER, a.id, "느린 메시지", { tts: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await service.sendMessage(OWNER, a.id, "끼어들기", { tts: false })).kind, "busy");
    assert.equal((await service.sendMessage(OWNER, b.id, "다른 대화", { tts: false })).kind, "ok");

    release({ ok: true, response: { reply: "늦은 답변", emotion: { primary: "calm", intensity: 0.4, durationSeconds: 6 }, actions: [], source: "llm" }, latencyMs: 1 });
    assert.equal((await slow).kind, "ok");
    assert.equal((await service.sendMessage(OWNER, a.id, "이제 보내요", { tts: false })).kind, "ok");
  });

  test("답변을 만드는 사이 대화를 지우면 답변을 저장하지 않고 not_found를 돌려준다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    let release: (outcome: LlmOutcome) => void = () => {};
    h.deps.llmFor = () => ({ isCircuitOpen: () => false, respond: () => new Promise(resolve => { release = resolve; }) });

    const pending = service.sendMessage(OWNER, conversation.id, "지워질 대화", { tts: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.deleteConversation(OWNER, conversation.id), true);
    release({ ok: true, response: { reply: "늦은 답변", emotion: { primary: "calm", intensity: 0.4, durationSeconds: 6 }, actions: [], source: "llm" }, latencyMs: 1 });

    assert.equal((await pending).kind, "not_found");
    assert.equal(store.get(OWNER, conversation.id), null);
  });
});

describe("개인 기억", () => {
  test("LLM 정리를 못 쓰면 사용자 메시지의 취향을 누가 한 말인지 붙여 본인 소유 private 기억으로 저장한다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
    await service.settle();

    const records = memoryStore.all();
    assert.equal(records.length, 1);
    assert.equal(records[0].scope, "private");
    assert.equal(records[0].ownerId, OWNER);
    // 점검 M-14: 1인칭 원문이 그대로 [기억]에 들어가 보리 자신의 기억으로 읽힐 수 있었다.
    assert.deepEqual(service.listMemories(OWNER).map(memory => memory.text), [`상대가 한 말: "${PREFERENCE}"`]);
    assert.deepEqual(Object.keys(service.listMemories(OWNER)[0]).sort(), ["createdAt", "expiresAt", "id", "text"]);
  });

  test("LLM 정리를 쓸 수 있으면 규칙 추출로는 저장하지 않는다(점검 M-2)", async () => {
    const digest = fakeDigest(async () => []);
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
    await service.settle();
    assert.equal(memoryStore.count(), 0);
  });

  test("상대적인 날짜가 든 규칙 기억에는 들은 날(한국 시간)을 붙인다(점검 M-7)", async () => {
    // 2026-10-15 01:00 UTC = 한국 시간 10월 15일 오전 10시
    const { store, service } = boot({ now: () => Date.UTC(2026, 9, 15, 1) });
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, "다음 주 토요일에 친구랑 제주도 여행 가요", { tts: false });
    await service.settle();
    assert.deepEqual(service.listMemories(OWNER).map(memory => memory.text), ['상대가 10월 15일에 한 말: "다음 주 토요일에 친구랑 제주도 여행 가요"']);
  });

  test("질문·떠보기·다른 사람 이야기는 규칙 추출로도 기억이 되지 않는다(점검 M-3)", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    for (const content of ["제가 키우는 고양이 이름은 기억나요?", "내 취미 뭐였더라", "친구가 고양이를 좋아해요", "제가 저번에 여행 간다고 했던 거 기억나요? 어디였죠?"]) {
      await service.sendMessage(OWNER, conversation.id, content, { tts: false });
    }
    await service.settle();
    assert.equal(memoryStore.count(), 0);
  });

  test("답변은 기억 저장(임베딩)을 기다리지 않는다(점검 M-8)", async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const embedding = { name: "slow", isConfigured: () => true, embed: async (texts: readonly string[]) => { await gate; return texts.map(() => [1, 0]); } };
    const { store, service } = boot({ embedding });
    const conversation = store.create(OWNER, "제목");

    const outcome = await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
    assert.equal(outcome.kind, "ok", "임베딩이 끝나기 전에 답이 나온다");
    assert.equal(memoryStore.count(), 0);
    release();
    await service.settle();
    assert.equal(memoryStore.count(), 1);
  });

  test("차단한 메시지는 기억으로 남기지 않는다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, "해킹하는 걸 좋아해요", { tts: false });
    await service.settle();
    assert.equal(memoryStore.count(), 0);
  });

  test("기억 저장이 실패해도 답변은 나간다", async () => {
    const failing = { ...memoryStore, add: async () => { throw new Error("디스크 오류"); } };
    const { store, service } = boot({ memoryStore: failing });
    const conversation = store.create(OWNER, "제목");
    const outcome = await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
    assert.equal(outcome.kind, "ok");
    await service.settle();
  });

  test("대화를 지워도 그 대화에서 생긴 개인 기억은 남는다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
    await service.settle();
    service.deleteConversation(OWNER, conversation.id);
    assert.equal(service.listMemories(OWNER).length, 1);
  });

  test("본인 private 기억만 지울 수 있고, 전체 삭제도 본인 것만 지운다", async () => {
    await memoryStore.add([
      { text: "방송 시청자의 취향", kind: "viewer", scope: "broadcast", ownerId: "local:a", importance: 0.5, confidence: 0.5 },
      { text: "다른 사용자의 취향", kind: "viewer", scope: "private", ownerId: "companion:other", importance: 0.5, confidence: 0.5 },
      { text: "내 취향", kind: "viewer", scope: "private", ownerId: OWNER, importance: 0.5, confidence: 0.5 },
    ], testMemorySettings, null);
    const { service } = boot();
    const others = memoryStore.all().filter(record => record.ownerId !== OWNER);

    assert.deepEqual(service.listMemories(OWNER).map(memory => memory.text), ["내 취향"]);
    for (const record of others) assert.equal(await service.deleteMemory(OWNER, record.id), false);
    assert.equal(await service.clearMemories(OWNER), 1);
    assert.deepEqual(memoryStore.all().map(record => record.text).sort(), ["다른 사용자의 취향", "방송 시청자의 취향"]);
  });
});

describe("관계 맥락", () => {
  /** 2026년 10월 day일 hour시(로컬). */
  const local = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();

  test("첫 대화의 요청에는 오늘 처음 대화한다는 문장이 [대화 상황]으로 들어간다", async () => {
    const { store, service } = boot({ now: () => local(12) });
    const conversation = store.create(OWNER, "첫 대화");
    await service.sendMessage(OWNER, conversation.id, "안녕하세요", { tts: false });
    assert.deepEqual(lastRequest()?.broadcastStatus, ["이 사람과는 오늘 처음 대화한다."]);
  });

  test("첫 대화의 첫 답에만 처음이라는 문장이 들어가고, 이어지는 메시지에는 인사를 이미 나눴다는 문장이 들어간다", async () => {
    // 점검 C-5: 첫날 매 턴 "오늘 처음 대화한다"가 들어가 반복 인사를 불렀다.
    const { store, service } = boot({ now: () => local(12) });
    const conversation = store.create(OWNER, "첫 대화");
    await service.sendMessage(OWNER, conversation.id, "안녕하세요", { tts: false });
    assert.deepEqual(lastRequest()?.broadcastStatus, ["이 사람과는 오늘 처음 대화한다."]);
    for (const content of ["요즘 날이 좀 춥네요", "오늘은 일찍 잘까 봐요"]) {
      await service.sendMessage(OWNER, conversation.id, content, { tts: false });
      assert.deepEqual(lastRequest()?.broadcastStatus, ["이 사람과는 첫 대화를 이어 가는 중이다. 인사는 이미 나눴다."]);
    }
  });

  test("며칠 뒤 새 대화에는 몇 번째 대화인지와 지난 대화 요약이 들어간다", async () => {
    let clock = local(9);
    const first = boot({ now: () => clock });
    const a = first.store.create(OWNER, "A");
    await first.service.sendMessage(OWNER, a.id, "고양이 이야기", { tts: false });
    first.store.setSummary(OWNER, a.id, "고양이 이야기를 나눴다.");

    clock = local(12);
    const b = first.store.create(OWNER, "B");
    await first.service.sendMessage(OWNER, b.id, "다시 왔어요", { tts: false });
    assert.deepEqual(lastRequest()?.broadcastStatus, [
      "이 사람과는 2번째 대화다. 처음 대화한 지 3일 지났다.",
      "마지막 대화는 3일 전이었다.",
      "지난 대화 요약: (3일 전) 고양이 이야기를 나눴다.",
    ]);
  });

  test("다른 소유자의 대화는 관계 계산에 들어가지 않는다", async () => {
    const { store, service } = boot({ now: () => local(12) });
    const theirs = store.create("companion:other", "남의 대화");
    store.append("companion:other", theirs.id, { role: "user", content: "남의 메시지" });
    store.setSummary("companion:other", theirs.id, "남의 요약");

    const mine = store.create(OWNER, "내 대화");
    await service.sendMessage(OWNER, mine.id, "처음이에요", { tts: false });
    assert.deepEqual(lastRequest()?.broadcastStatus, ["이 사람과는 오늘 처음 대화한다."]);
  });
});

describe("누적 요약 영속화", () => {
  let summaryRequests: LlmRequest[];

  beforeEach(() => {
    summaryRequests = [];
    h.llmSettings.rollingSummaryEnabled = true;
    h.llmSettings.rollingSummaryTurns = 4;
    const adapter: LlmAdapter = {
      name: "fake-summary",
      isConfigured: () => true,
      complete: async request => {
        summaryRequests.push(request);
        return { raw: JSON.stringify({ summary: `요약 ${summaryRequests.length}` }), latencyMs: 1 };
      },
    };
    h.deps.createAdapter = () => adapter;
  });

  test("1:1 누적 요약은 1:1 지시문으로 만들고 대화 레코드에 저장한다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, "첫 메시지", { tts: false });
    await service.sendMessage(OWNER, conversation.id, "둘째 메시지", { tts: false });
    await flush();

    assert.equal(summaryRequests.length, 1);
    assert.ok(summaryRequests[0].overrideSystemPrompt?.includes("1:1 대화의 흐름"));
    assert.ok(!summaryRequests[0].overrideSystemPrompt?.includes("방송"));
    assert.ok(summaryRequests[0].overrideUserPrompt?.includes('상대: "첫 메시지'));
    assert.equal(store.summaryOf(OWNER, conversation.id), "요약 1");
  });

  test("서버를 다시 띄우면 저장된 요약이 세션에 되살아나 [지금까지의 대화]로 들어간다", async () => {
    const first = boot();
    const conversation = first.store.create(OWNER, "제목");
    await first.service.sendMessage(OWNER, conversation.id, "첫 메시지", { tts: false });
    await first.service.sendMessage(OWNER, conversation.id, "둘째 메시지", { tts: false });
    await flush();

    const second = boot();
    await second.service.sendMessage(OWNER, conversation.id, "재시작 뒤 메시지", { tts: false });
    assert.equal(lastRequest()?.sessionSummary, "요약 1");
  });

  test("요약이 늦게 도착했는데 대화가 지워졌으면 저장하지 않는다", async () => {
    const slow: { release?: (raw: string) => void } = {};
    // 엔진은 만들 때 어댑터 생성기를 잡으므로 boot 전에 바꾼다.
    h.deps.createAdapter = () => ({ name: "slow", isConfigured: () => true, complete: () => new Promise(resolve => { slow.release = raw => resolve({ raw, latencyMs: 1 }); }) });
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, "첫 메시지", { tts: false });
    await service.sendMessage(OWNER, conversation.id, "둘째 메시지", { tts: false });
    await flush();
    assert.equal(summaryRequests.length, 0, "느린 어댑터가 쓰였다");
    assert.ok(slow.release, "요약을 요청했다");
    service.deleteConversation(OWNER, conversation.id);
    slow.release(JSON.stringify({ summary: "늦은 요약" }));
    await flush();
    assert.equal(store.summaryOf(OWNER, conversation.id), "");
    assert.ok(!readFileSync(join(dir, "companion-conversations.json"), "utf8").includes("늦은 요약"));
  });
});

describe("LLM 개인 기억 정리", () => {
  let nextTexts: (string | DigestedMemory)[] | null;
  let digest: ReturnType<typeof fakeDigest>;

  beforeEach(() => {
    nextTexts = ["상대는 재즈 피아노를 좋아한다."];
    digest = fakeDigest(async () => nextTexts);
  });

  async function sendMany(service: ReturnType<typeof boot>["service"], conversationId: string, contents: readonly string[]) {
    for (const content of contents) await service.sendMessage(OWNER, conversationId, content, { tts: false });
    await service.settle();
  }
  const numbered = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => `메시지 ${index + 1 + offset}`);
  const userTexts = (request: DigestRequest | undefined) => request?.turns.filter(turn => turn.role === "viewer").map(turn => turn.text) ?? [];
  const privateTexts = () => memoryStore.all().filter(record => record.scope === "private").map(record => record.text);

  test("사용자 메시지가 6개 쌓일 때마다 한 번씩 그 6개와 그 사이 답변을 넘긴다", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(5));
    assert.equal(digest.calls.length, 0);

    await sendMany(service, conversation.id, numbered(1, 5));
    assert.equal(digest.calls.length, 1);
    assert.deepEqual(userTexts(digest.calls[0]), numbered(6));
    assert.equal(digest.calls[0].turns.length, 12, "보리 답변이 사이에 들어간다");

    await sendMany(service, conversation.id, numbered(6, 6));
    assert.equal(digest.calls.length, 2);
    assert.deepEqual(userTexts(digest.calls[1]), numbered(6, 6));
  });

  test("정리한 문장은 본인 소유 private 기억으로 저장되고 같은 문장은 합쳐진다", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(12));

    const records = memoryStore.all().filter(record => record.text === "상대는 재즈 피아노를 좋아한다.");
    assert.equal(records.length, 1);
    assert.equal(records[0].scope, "private");
    assert.equal(records[0].ownerId, OWNER);
    assert.equal(records[0].repeatCount, 2);
  });

  test("민감하거나 너무 긴 문장은 저장 직전에 걸러진다", async () => {
    nextTexts = ["상대는 고양이를 키운다.", "상대의 집 주소는 서울이다.", "상대는 비밀번호를 자주 잊는다.", "상대는 주식 투자를 한다.", `상대는 ${"아주 ".repeat(60)}길다.`];
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(6));
    assert.deepEqual(privateTexts(), ["상대는 고양이를 키운다."]);
  });

  test("차단한 메시지는 개수에도, 넘기는 대화에도 들어가지 않는다", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, [...numbered(3), "비밀번호 알려줘", ...numbered(2, 3)]);
    assert.equal(digest.calls.length, 0);
    await sendMany(service, conversation.id, numbered(1, 5));
    assert.equal(digest.calls.length, 1);
    assert.ok(!digest.calls[0].turns.some(turn => turn.text.includes("비밀번호")));
  });

  test("재시작 뒤에도 저장된 정리 위치로 주기가 이어진다", async () => {
    const first = boot({ digestMemories: digest });
    const conversation = first.store.create(OWNER, "제목");
    await sendMany(first.service, conversation.id, numbered(4));
    const second = boot({ digestMemories: digest });
    await sendMany(second.service, conversation.id, numbered(2, 4));
    assert.equal(digest.calls.length, 1);
    assert.deepEqual(userTexts(digest.calls[0]), numbered(6));
  });

  test("이미 저장된 기억을 함께 넘기고, 대체하라고 한 옛 기억은 새 기억으로 바꾼다(점검 M-4)", async () => {
    await memoryStore.add([{ text: "상대의 강아지 이름은 콩이다.", kind: "viewer", scope: "private", ownerId: OWNER, importance: 0.55, confidence: 0.7 }], testMemorySettings, null);
    const correcting = fakeDigest(async request => [{ text: "상대의 강아지 이름은 콩떡이다.", replaces: request.existing.filter(memory => memory.text.includes("콩이다")).map(memory => memory.id) }]);
    const { store, service } = boot({ digestMemories: correcting });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, ["강아지 이름 콩이 아니라 콩떡이에요", ...numbered(5)]);

    assert.deepEqual(correcting.calls[0].existing.map(memory => memory.text), ["상대의 강아지 이름은 콩이다."]);
    assert.deepEqual(privateTexts(), ["상대의 강아지 이름은 콩떡이다."]);
  });

  test("남의 기억이나 방송 기억은 대체하라고 해도 지우지 않는다", async () => {
    await memoryStore.add([
      { text: "다른 사용자의 강아지는 콩이다.", kind: "viewer", scope: "private", ownerId: "companion:other", importance: 0.5, confidence: 0.5 },
      { text: "방송 시청자의 강아지는 콩이다.", kind: "viewer", scope: "broadcast", ownerId: "local:a", importance: 0.5, confidence: 0.5 },
    ], testMemorySettings, null);
    const ids = memoryStore.all().map(record => record.id);
    const rogue = fakeDigest(async () => [{ text: "상대의 강아지 이름은 콩떡이다.", replaces: ids }]);
    const { store, service } = boot({ digestMemories: rogue });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(6));
    assert.equal(memoryStore.count(), 3);
  });

  test("새 대화를 만들면 앞 대화의 남은 메시지를 정리한다(점검 M-6)", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const a = store.create(OWNER, "A");
    await sendMany(service, a.id, numbered(2));
    assert.equal(digest.calls.length, 0);

    const b = store.create(OWNER, "B");
    service.conversationStarted(OWNER, b.id);
    await service.settle();
    assert.equal(digest.calls.length, 1);
    assert.deepEqual(userTexts(digest.calls[0]), numbered(2));
    assert.equal(store.digestCursor(OWNER, a.id), 4);
    assert.deepEqual(privateTexts(), ["상대는 재즈 피아노를 좋아한다."]);

    // 남은 메시지가 없으면 다시 부르지 않는다.
    service.conversationStarted(OWNER, store.create(OWNER, "C").id);
    await service.settle();
    assert.equal(digest.calls.length, 1);
  });

  test("서버를 다시 띄운 뒤 다른 대화에 처음 보내면 앞 대화의 남은 메시지를 정리한다", async () => {
    const first = boot({ digestMemories: digest });
    const a = first.store.create(OWNER, "A");
    await sendMany(first.service, a.id, numbered(3));

    const second = boot({ digestMemories: digest });
    const b = second.store.create(OWNER, "B");
    await sendMany(second.service, b.id, ["새 대화 메시지"]);
    assert.equal(digest.calls.length, 1);
    assert.deepEqual(userTexts(digest.calls[0]), numbered(3));
  });

  test("기억을 떠보는 질문과 그 답은 정리에 넘기지 않고, 떠보기뿐인 구간은 LLM을 부르지 않는다(점검 M-3)", async () => {
    // 실모델 재현에서 "제가 키우는 고양이 이름은 기억나요?"와 그 답에서 "상대는 고양이를 키운다"가 만들어졌다.
    const { store, service } = boot({ digestMemories: digest });
    const a = store.create(OWNER, "A");
    await sendMany(service, a.id, ["저는 주말마다 등산을 가요", "제가 키우는 고양이 이름은 기억나요?", "어제 새 등산화를 샀어요"]);
    const b = store.create(OWNER, "B");
    await sendMany(service, b.id, ["제 강아지 이름 기억나요?", "제가 뭐라고 했었죠"]);
    service.conversationStarted(OWNER, store.create(OWNER, "C").id);
    await service.settle();

    assert.equal(digest.calls.length, 1, "떠보기뿐인 대화 B는 부르지 않는다");
    assert.deepEqual(userTexts(digest.calls[0]), ["저는 주말마다 등산을 가요", "어제 새 등산화를 샀어요"]);
    assert.equal(digest.calls[0].turns.length, 4, "떠보기 바로 뒤 보리의 답도 뺀다");
    assert.equal(store.digestCursor(OWNER, b.id), 4, "떠보기만 있던 구간도 정리한 것으로 표시한다");
  });

  test("새 대화의 첫 메시지는 앞 대화의 정리가 끝나기를 잠깐 기다린다", async () => {
    let release!: (texts: string[]) => void;
    const slow = fakeDigest(() => new Promise<string[]>(done => { release = done; }));
    const { store, service } = boot({ digestMemories: slow });
    const a = store.create(OWNER, "A");
    await service.sendMessage(OWNER, a.id, "강아지 이름 콩이 아니라 콩떡이에요", { tts: false });
    const b = store.create(OWNER, "B");
    const sending = service.sendMessage(OWNER, b.id, "제 강아지 이름 기억나요?", { tts: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.llmRequests.filter(entry => entry.request.content === "제 강아지 이름 기억나요?").length, 0, "정리가 끝나기 전에는 답을 만들지 않는다");
    release(["상대의 강아지 이름은 콩떡이다."]);
    assert.equal((await sending).kind, "ok");
    await service.settle();
    assert.deepEqual(privateTexts(), ["상대의 강아지 이름은 콩떡이다."]);
  });

  test("일정 시간 새 메시지가 없으면 남은 메시지를 정리한다", async () => {
    const { store, service } = boot({ digestMemories: digest, idleDigestMs: 20 });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(2));
    assert.equal(digest.calls.length, 0);
    await new Promise(resolve => setTimeout(resolve, 60));
    await service.settle();
    assert.equal(digest.calls.length, 1);
    assert.deepEqual(userTexts(digest.calls[0]), numbered(2));
  });

  test("정리가 실패하면 다음 기회에 같은 구간을 다시 넘기고, 3번 실패하면 그 구간은 건너뛴다(점검 M-6)", async () => {
    let failures = 3;
    const flaky = fakeDigest(async () => {
      if (failures > 0) { failures -= 1; throw new Error("정리 실패"); }
      return ["상대는 등산을 좋아한다."];
    });
    const { store, service } = boot({ digestMemories: flaky });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(8));
    assert.equal(flaky.calls.length, 3, "6·7·8번째 메시지마다 같은 구간을 다시 시도한다");
    for (const call of flaky.calls) assert.deepEqual(userTexts(call), numbered(6));

    await sendMany(service, conversation.id, numbered(1, 8));
    assert.equal(flaky.calls.length, 3, "건너뛴 뒤 남은 3개는 주기를 채우지 않았다");
    service.conversationStarted(OWNER, store.create(OWNER, "다음").id);
    await service.settle();
    assert.equal(flaky.calls.length, 4);
    assert.deepEqual(userTexts(flaky.calls[3]), numbered(3, 6));
    assert.deepEqual(privateTexts(), ["상대는 등산을 좋아한다."]);
  });

  test("LLM을 못 써서 건너뛰면 정리 위치를 그대로 두고 나중에 정리한다", async () => {
    const unavailable = fakeDigest(async () => null, false);
    const { store, service } = boot({ digestMemories: unavailable });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(6));
    assert.equal(store.digestCursor(OWNER, conversation.id), 0);
  });

  test("정리하는 사이 기억을 모두 지우면 결과를 버리고, 지우기 전 메시지는 다시 정리하지 않는다(점검 M-9·M-11)", async () => {
    let release!: (texts: string[]) => void;
    let calls = 0;
    const slow = fakeDigest(() => {
      calls += 1;
      return calls === 1 ? new Promise<string[]>(done => { release = done; }) : Promise.resolve(["상대는 등산을 좋아한다."]);
    });
    const { store, service } = boot({ digestMemories: slow });
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(6)) await service.sendMessage(OWNER, conversation.id, content, { tts: false });

    await service.clearMemories(OWNER);
    release(["상대는 보사노바를 즐겨 듣는다."]);
    await service.settle();
    assert.deepEqual(privateTexts(), []);

    await sendMany(service, conversation.id, numbered(2, 6));
    service.conversationStarted(OWNER, store.create(OWNER, "다음").id);
    await service.settle();
    assert.equal(slow.calls.length, 2);
    assert.deepEqual(userTexts(slow.calls[1]), numbered(2, 6), "삭제 전 메시지는 넘기지 않는다");
  });

  test("관리자 전체 삭제도 진행 중인 정리 결과를 막는다(점검 M-9)", async () => {
    let release!: (texts: string[]) => void;
    const slow = fakeDigest(() => new Promise<string[]>(done => { release = done; }));
    const { store, service } = boot({ digestMemories: slow });
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(6)) await service.sendMessage(OWNER, conversation.id, content, { tts: false });

    // 관리자 경로는 서비스를 거치지 않고 저장소를 직접 지운다.
    await memoryStore.clear();
    release(["상대는 보사노바를 즐겨 듣는다."]);
    await service.settle();
    assert.equal(memoryStore.count(), 0);
    assert.equal(store.digestCursor(OWNER, conversation.id), 12);
  });

  test("기억 하나를 지우면 그 전 메시지는 다시 정리하지 않는다(점검 M-11)", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(6));
    await sendMany(service, conversation.id, ["나는 보사노바 음악을 즐겨 들어", "메시지 8"]);
    const [memory] = service.listMemories(OWNER);
    assert.equal(await service.deleteMemory(OWNER, memory.id), true);

    await sendMany(service, conversation.id, numbered(1, 8));
    service.conversationStarted(OWNER, store.create(OWNER, "다음").id);
    await service.settle();
    assert.equal(digest.calls.length, 2);
    assert.deepEqual(userTexts(digest.calls[1]), numbered(1, 8));
  });

  test("정리하는 사이 대화를 지우면 그 대화의 정리 결과를 저장하지 않는다(점검 M-18)", async () => {
    let release!: (texts: string[]) => void;
    const slow = fakeDigest(() => new Promise<string[]>(done => { release = done; }));
    const { store, service } = boot({ digestMemories: slow });
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(6)) await service.sendMessage(OWNER, conversation.id, content, { tts: false });

    assert.equal(service.deleteConversation(OWNER, conversation.id), true);
    release(["상대는 보사노바를 즐겨 듣는다."]);
    await service.settle();
    assert.equal(memoryStore.count(), 0);
  });

  test("상대적인 날짜가 남은 정리 문장에는 들은 날을 붙인다(점검 M-7)", async () => {
    nextTexts = ["상대는 다음 주 토요일에 제주도로 여행을 간다."];
    const { store, service } = boot({ digestMemories: digest, now: () => Date.UTC(2026, 9, 15, 1) });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(6));
    assert.equal(digest.calls[0].now, Date.UTC(2026, 9, 15, 1));
    assert.deepEqual(privateTexts(), ["상대는 다음 주 토요일에 제주도로 여행을 간다. (10월 15일에 들음)"]);
  });

  test("정리 위치 기록이 없는 예전 대화는 예전 규칙대로 이미 정리한 만큼을 건너뛴다", async () => {
    const first = boot();
    const conversation = first.store.create(OWNER, "예전 대화");
    for (const content of numbered(7)) {
      first.store.append(OWNER, conversation.id, { role: "user", content });
      first.store.append(OWNER, conversation.id, { role: "bori", content: "답", source: "llm" });
    }
    // 이 기능 전에 저장된 파일처럼 정리 위치를 지운다.
    const file = join(dir, "companion-conversations.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { conversations: { digestedCount?: number }[] };
    for (const entry of saved.conversations) delete entry.digestedCount;
    writeFileSync(file, JSON.stringify(saved));

    const { store, service } = boot({ digestMemories: digest });
    assert.equal(store.digestCursor(OWNER, conversation.id), null);
    service.conversationStarted(OWNER, store.create(OWNER, "새 대화").id);
    await service.settle();
    assert.equal(digest.calls.length, 1);
    assert.deepEqual(userTexts(digest.calls[0]), numbered(1, 6));
  });

  test("정리가 실패해도 답변은 나가고 기억은 생기지 않는다", async () => {
    const failing = fakeDigest(async () => { throw new Error("정리 실패"); });
    const { store, service } = boot({ digestMemories: failing });
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(6)) {
      assert.equal((await service.sendMessage(OWNER, conversation.id, content, { tts: false })).kind, "ok");
    }
    await service.settle();
    assert.equal(memoryStore.count(), 0);
  });

  test("주기가 0이거나 기억이 꺼져 있으면 정리하지 않는다", async () => {
    for (const settings of [{ ...testMemorySettings, privateDigestEveryMessages: 0 }, { ...testMemorySettings, enabled: false }]) {
      const { store, service } = boot({ digestMemories: digest, memorySettings: settings });
      const conversation = store.create(OWNER, "제목");
      await sendMany(service, conversation.id, numbered(6));
      service.conversationStarted(OWNER, store.create(OWNER, "다음").id);
      await service.settle();
    }
    assert.equal(digest.calls.length, 0);
  });
});

describe("LLM 개인 기억 정리기", () => {
  const turns: SummaryTurn[] = [{ role: "viewer", text: "저는 재즈를 좋아해요" }, { role: "bori", text: "좋네요" }];
  const request = (existing: DigestRequest["existing"] = []): DigestRequest => ({ turns, existing, now: Date.UTC(2026, 9, 15, 1) });

  function makeDigest(options: { circuitOpen?: boolean; enabled?: boolean; apiKey?: string; raw?: string }) {
    const requests: LlmRequest[] = [];
    let adapters = 0;
    const digestMemories = createPrivateMemoryDigest({
      llmSettings: () => ({ ...h.llmSettings, enabled: options.enabled ?? true }),
      apiKey: () => options.apiKey ?? "fake-key",
      isCircuitOpen: () => options.circuitOpen ?? false,
      createAdapter: () => {
        adapters += 1;
        return {
          name: "fake",
          isConfigured: () => true,
          complete: async request => {
            requests.push(request);
            return { raw: options.raw ?? JSON.stringify({ memories: [{ text: "상대는 재즈를 좋아한다.", replaces: [] }] }), latencyMs: 1 };
          },
        };
      },
    });
    return { digestMemories, requests, adapters: () => adapters };
  }

  test("1:1 회로가 열려 있으면 쓸 수 없다고 알리고 LLM을 부르지 않는다", async () => {
    const fake = makeDigest({ circuitOpen: true });
    assert.equal(fake.digestMemories.isAvailable(), false);
    assert.equal(await fake.digestMemories.digest(request()), null);
    assert.equal(fake.adapters(), 0);
  });

  test("LLM이 꺼져 있거나 키가 없으면 건너뛴다", async () => {
    for (const options of [{ enabled: false }, { apiKey: " " }]) {
      const fake = makeDigest(options);
      assert.equal(fake.digestMemories.isAvailable(), false);
      assert.equal(await fake.digestMemories.digest(request()), null);
      assert.equal(fake.adapters(), 0);
    }
  });

  test("상대가 직접 말한 것만, 한 문장씩, 추측 없이 뽑으라는 지시로 부르고 오늘 날짜와 저장된 기억을 함께 넘긴다", async () => {
    const fake = makeDigest({});
    assert.equal(fake.digestMemories.isAvailable(), true);
    assert.deepEqual(await fake.digestMemories.digest(request([{ id: "real-id-1", text: "상대는 재즈를 좋아한다." }])), [{ text: "상대는 재즈를 좋아한다.", replaces: [] }]);
    const system = fake.requests[0].overrideSystemPrompt ?? "";
    for (const phrase of ["직접 말한 사실, 취향, 경험만", "한 문장씩", "추측하거나 지어내지 않는다", "개인정보", "물어본 말은 사실이 아니다", "다른 사람에 관한 이야기", "replaces"]) {
      assert.ok(system.includes(phrase), phrase);
    }
    const user = fake.requests[0].overrideUserPrompt ?? "";
    assert.ok(user.includes('상대: "저는 재즈를 좋아해요"'));
    assert.ok(user.includes("[오늘 날짜]\n지금은 한국 시간으로 2026년 10월 15일 목요일 오전 10시 무렵이다."), user);
    // 실제 ID 대신 짧은 번호만 보여 준다.
    assert.ok(user.includes('- m1: "상대는 재즈를 좋아한다."') && !user.includes("real-id-1"), user);
  });

  test("replaces의 번호를 실제 기억 ID로 되돌리고 모르는 번호는 버린다", async () => {
    const fake = makeDigest({ raw: JSON.stringify({ memories: [{ text: "상대는 서울에 산다.", replaces: ["m2", "m9", "real-a"] }] }) });
    const result = await fake.digestMemories.digest(request([{ id: "real-a", text: "상대는 재즈를 좋아한다." }, { id: "real-b", text: "상대는 부산에 산다." }]));
    assert.deepEqual(result, [{ text: "상대는 서울에 산다.", replaces: ["real-b"] }]);
  });

  test("형식이 틀린 응답은 실패로 알린다(점검 M-6·M-15)", async () => {
    await assert.rejects(makeDigest({ raw: JSON.stringify({ memories: "문자열" }) }).digestMemories.digest(request()));
    await assert.rejects(makeDigest({ raw: "깨진 응답" }).digestMemories.digest(request()));
  });
});
