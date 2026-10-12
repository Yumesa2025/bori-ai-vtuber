/**
 * 1:1 대화 처리 단위 검사.
 * 서버 재시작 뒤 세션 복원, 거절 대화의 문맥 제외, 개인 기억 생성, 동시 요청 거절, 음성 연결을 본다.
 * LLM은 가짜 객체이고 저장소는 임시 디렉터리의 실제 파일을 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmOutcome } from "@bori/llm";
import { createMemoryStore, type MemoryStore } from "@bori/memory";
import { createCompanionService, createConversationStore } from "../src/companion/index.js";
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

/** 서버 한 번 띄운 것과 같다. 다시 부르면 파일에서 다시 읽어 재시작을 흉내 낸다. */
function boot(overrides: { memoryStore?: Parameters<typeof createCompanionService>[0]["memoryStore"] } = {}) {
  const store = createConversationStore(join(dir, "companion-conversations.json"), { log: silent });
  store.load();
  const engine = createConversationEngine(h.deps);
  const service = createCompanionService({
    engine,
    store,
    memoryStore: overrides.memoryStore ?? memoryStore,
    memorySettings: () => testMemorySettings,
    embedding: () => null,
    prepareAudio: async text => { audioRequests.push(text); return "audio-1"; },
  });
  return { store, service };
}

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
