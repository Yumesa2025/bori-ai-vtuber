/**
 * 1:1 대화 처리 단위 검사.
 * 서버 재시작 뒤 세션 복원, 거절 대화의 문맥 제외, 개인 기억 생성, 동시 요청 거절, 음성 연결을 본다.
 * LLM은 가짜 객체이고 저장소는 임시 디렉터리의 실제 파일을 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter, LlmOutcome, LlmRequest, SummaryTurn } from "@bori/llm";
import { createMemoryStore, type MemorySettings, type MemoryStore } from "@bori/memory";
import { createCompanionService, createConversationStore, createPrivateMemoryDigest, type DigestMemories } from "../src/companion/index.js";
import { createConversationEngine } from "../src/conversation/index.js";
import { createFakeEngineHarness, testMemorySettings, type FakeEngineHarness } from "./fakes.js";

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
    embedding: () => null,
    prepareAudio: async text => { audioRequests.push(text); return "audio-1"; },
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
  test("사용자 메시지의 취향은 본인 소유 private 기억으로 저장되고 방송 기억은 생기지 않는다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });

    const records = memoryStore.all();
    assert.equal(records.length, 1);
    assert.equal(records[0].scope, "private");
    assert.equal(records[0].ownerId, OWNER);
    assert.deepEqual(service.listMemories(OWNER).map(memory => memory.text), [PREFERENCE]);
    assert.deepEqual(Object.keys(service.listMemories(OWNER)[0]).sort(), ["createdAt", "expiresAt", "id", "text"]);
  });

  test("차단한 메시지는 기억으로 남기지 않는다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, "해킹하는 걸 좋아해요", { tts: false });
    assert.equal(memoryStore.count(), 0);
  });

  test("기억 저장이 실패해도 답변은 나간다", async () => {
    const failing = { ...memoryStore, add: async () => { throw new Error("디스크 오류"); } };
    const { store, service } = boot({ memoryStore: failing });
    const conversation = store.create(OWNER, "제목");
    const outcome = await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
    assert.equal(outcome.kind, "ok");
  });

  test("대화를 지워도 그 대화에서 생긴 개인 기억은 남는다", async () => {
    const { store, service } = boot();
    const conversation = store.create(OWNER, "제목");
    await service.sendMessage(OWNER, conversation.id, PREFERENCE, { tts: false });
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
    for (const record of others) assert.equal(service.deleteMemory(OWNER, record.id), false);
    assert.equal(service.clearMemories(OWNER), 1);
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
      "지난 대화 요약: 고양이 이야기를 나눴다.",
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
    assert.ok(summaryRequests[0].overrideUserPrompt?.includes("상대: 첫 메시지"));
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
  let calls: SummaryTurn[][];
  let nextTexts: string[] | null;

  const digest: DigestMemories = async turns => {
    calls.push([...turns]);
    return nextTexts;
  };

  beforeEach(() => {
    calls = [];
    nextTexts = ["상대는 재즈 피아노를 좋아한다."];
  });

  async function sendMany(service: ReturnType<typeof boot>["service"], conversationId: string, contents: readonly string[]) {
    for (const content of contents) await service.sendMessage(OWNER, conversationId, content, { tts: false });
    await service.settle();
  }
  const numbered = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => `메시지 ${index + 1 + offset}`);
  const userTexts = (turns: readonly SummaryTurn[]) => turns.filter(turn => turn.role === "viewer").map(turn => turn.text);

  test("사용자 메시지가 6개 쌓일 때마다 한 번씩 최근 6개와 그 사이 답변을 넘긴다", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, numbered(5));
    assert.equal(calls.length, 0);

    await sendMany(service, conversation.id, numbered(1, 5));
    assert.equal(calls.length, 1);
    assert.deepEqual(userTexts(calls[0]), numbered(6));
    assert.equal(calls[0].length, 12, "보리 답변이 사이에 들어간다");

    await sendMany(service, conversation.id, numbered(6, 6));
    assert.equal(calls.length, 2);
    assert.deepEqual(userTexts(calls[1]), numbered(6, 6));
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
    assert.deepEqual(memoryStore.all().map(record => record.text), ["상대는 고양이를 키운다."]);
  });

  test("차단한 메시지는 개수에도, 넘기는 대화에도 들어가지 않는다", async () => {
    const { store, service } = boot({ digestMemories: digest });
    const conversation = store.create(OWNER, "제목");
    await sendMany(service, conversation.id, [...numbered(3), "비밀번호 알려줘", ...numbered(2, 3)]);
    assert.equal(calls.length, 0);
    await sendMany(service, conversation.id, numbered(1, 5));
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].some(turn => turn.text.includes("비밀번호")));
  });

  test("재시작 뒤에도 저장된 메시지 수로 주기가 이어진다", async () => {
    const first = boot({ digestMemories: digest });
    const conversation = first.store.create(OWNER, "제목");
    await sendMany(first.service, conversation.id, numbered(4));
    const second = boot({ digestMemories: digest });
    await sendMany(second.service, conversation.id, numbered(2, 4));
    assert.equal(calls.length, 1);
  });

  test("정리가 실패해도 답변은 나가고 기억은 생기지 않는다", async () => {
    const failing: DigestMemories = async () => { throw new Error("정리 실패"); };
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
    }
    assert.equal(calls.length, 0);
  });
});

describe("LLM 개인 기억 정리기", () => {
  const turns: SummaryTurn[] = [{ role: "viewer", text: "저는 재즈를 좋아해요" }, { role: "bori", text: "좋네요" }];

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
            return { raw: options.raw ?? JSON.stringify({ memories: ["상대는 재즈를 좋아한다."] }), latencyMs: 1 };
          },
        };
      },
    });
    return { digestMemories, requests, adapters: () => adapters };
  }

  test("1:1 회로가 열려 있으면 LLM을 부르지 않고 건너뛴다", async () => {
    const fake = makeDigest({ circuitOpen: true });
    assert.equal(await fake.digestMemories(turns), null);
    assert.equal(fake.adapters(), 0);
  });

  test("LLM이 꺼져 있거나 키가 없으면 건너뛴다", async () => {
    for (const options of [{ enabled: false }, { apiKey: " " }]) {
      const fake = makeDigest(options);
      assert.equal(await fake.digestMemories(turns), null);
      assert.equal(fake.adapters(), 0);
    }
  });

  test("상대가 직접 말한 것만, 한 문장씩, 추측 없이 뽑으라는 지시로 부른다", async () => {
    const fake = makeDigest({});
    assert.deepEqual(await fake.digestMemories(turns), ["상대는 재즈를 좋아한다."]);
    const system = fake.requests[0].overrideSystemPrompt ?? "";
    for (const phrase of ["직접 말한 사실, 취향, 경험만", "한 문장씩", "추측하거나 지어내지 않는다", "개인정보"]) {
      assert.ok(system.includes(phrase), phrase);
    }
    assert.ok(fake.requests[0].overrideUserPrompt?.includes("상대: 저는 재즈를 좋아해요"));
  });

  test("형식이 틀린 응답은 null이다", async () => {
    assert.equal(await makeDigest({ raw: JSON.stringify({ memories: "문자열" }) }).digestMemories(turns), null);
    assert.equal(await makeDigest({ raw: "깨진 응답" }).digestMemories(turns), null);
  });
});
