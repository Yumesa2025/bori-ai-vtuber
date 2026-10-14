/**
 * 1:1 기록 전체 삭제 단위 검사.
 * 대화·메시지·요약·세션·개인 기억을 한 번에 지우는지, 방송 기억과 남의 기록은 남는지,
 * 삭제 전에 시작한 기억 저장·LLM 기억 정리 결과가 삭제 뒤에 저장되지 않는지 본다.
 * LLM은 가짜 객체이고 저장소는 임시 디렉터리의 실제 파일을 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type EmbeddingProvider, type MemoryStore } from "@bori/memory";
import { createCompanionService, createConversationStore, type DigestMemories } from "../src/companion/index.js";
import { createConversationEngine } from "../src/conversation/index.js";
import { createFakeEngineHarness, testMemorySettings, type FakeEngineHarness } from "./fakes.js";

const OWNER = "companion:local";
const OTHER = "companion:other";
const silent = () => {};

let dir: string;
let h: FakeEngineHarness;
let memoryStore: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-companion-clear-"));
  h = createFakeEngineHarness();
  memoryStore = createMemoryStore(join(dir, "memories.json"), { log: silent });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 밖에서 풀어 주는 약속. 비동기 작업을 삭제 요청 사이에 멈춰 두는 데 쓴다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function boot(options: { digestMemories?: DigestMemories; embedding?: EmbeddingProvider | null } = {}) {
  const store = createConversationStore(join(dir, "companion-conversations.json"), { log: silent });
  store.load();
  const service = createCompanionService({
    engine: createConversationEngine(h.deps),
    store,
    memoryStore,
    memorySettings: () => testMemorySettings,
    embedding: () => options.embedding ?? null,
    prepareAudio: async () => undefined,
    ...(options.digestMemories ? { digestMemories: options.digestMemories } : {}),
  });
  return { store, service };
}

/** 방송 요약·방송 시청자 기억·다른 1:1 사용자의 기억을 깔아 둔다. 지우면 안 되는 것들이다. */
async function seedOthers() {
  await memoryStore.add([
    { text: "지난 방송에서 리듬 게임 이야기를 했다.", kind: "broadcast", scope: "broadcast", importance: 0.5, confidence: 0.5 },
    { text: "민지 시청자는 고양이를 키운다.", kind: "viewer", scope: "broadcast", ownerId: "local:민지", importance: 0.5, confidence: 0.5 },
    { text: "상대는 등산을 좋아한다.", kind: "viewer", scope: "private", ownerId: OTHER, importance: 0.5, confidence: 0.5 },
  ], testMemorySettings, null);
}

const ownedPrivate = () => memoryStore.all().filter(record => record.ownerId === OWNER);
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `메시지 ${index + 1}`);

describe("1:1 기록 모두 지우기", () => {
  test("대화·메시지·요약·개인 기억을 지우고 지운 개수를 돌려준다", async () => {
    await seedOthers();
    const { store, service } = boot();
    const first = store.create(OWNER, "첫 대화");
    const second = store.create(OWNER, "둘째 대화");
    await service.sendMessage(OWNER, first.id, "저는 퇴근하고 재즈 피아노 듣는 걸 좋아해요", { tts: false });
    await service.sendMessage(OWNER, second.id, "안녕", { tts: false });
    store.setSummary(OWNER, first.id, "상대가 재즈 이야기를 했다.");
    const others = store.create(OTHER, "남의 대화");
    assert.ok(ownedPrivate().length > 0, "개인 기억이 생겨 있어야 검사가 의미 있다");

    const privateCount = ownedPrivate().length;
    const result = await service.clearAll(OWNER);

    assert.deepEqual(result, { conversations: 2, messages: 4, memories: privateCount });
    assert.deepEqual(store.list(OWNER), []);
    assert.deepEqual(store.activity(OWNER), [], "지난 대화 요약에 쓰는 기록도 남지 않는다");
    assert.equal(store.summaryOf(OWNER, first.id), "");
    assert.deepEqual(ownedPrivate(), []);
    // 남의 대화와 방송 기억은 그대로다.
    assert.equal(store.get(OTHER, others.id)?.id, others.id);
    assert.deepEqual(
      memoryStore.all().map(record => record.text).sort(),
      ["민지 시청자는 고양이를 키운다.", "상대는 등산을 좋아한다.", "지난 방송에서 리듬 게임 이야기를 했다."],
    );
  });

  test("파일에서도 지워져 재시작 뒤에 되살아나지 않는다", async () => {
    const first = boot();
    const conversation = first.store.create(OWNER, "제목");
    await first.service.sendMessage(OWNER, conversation.id, "첫 메시지", { tts: false });
    await first.service.clearAll(OWNER);

    const second = boot();
    assert.deepEqual(second.store.list(OWNER), []);
    assert.equal(second.store.messages(OWNER, conversation.id), null);
  });

  test("지울 것이 없으면 0을 돌려준다", async () => {
    const { service } = boot();
    assert.deepEqual(await service.clearAll(OWNER), { conversations: 0, messages: 0, memories: 0 });
  });

  test("지운 뒤 새 대화의 최근 대화에 이전 대화가 들어가지 않는다", async () => {
    const { store, service } = boot();
    const old = store.create(OWNER, "옛 대화");
    await service.sendMessage(OWNER, old.id, "옛 대화 메시지", { tts: false });
    store.setSummary(OWNER, old.id, "옛 대화에서 고양이 이야기를 했다.");
    await service.clearAll(OWNER);

    const fresh = store.create(OWNER, "새 대화");
    await service.sendMessage(OWNER, fresh.id, "새 메시지", { tts: false });
    const request = h.llmRequests.at(-1)?.request;
    assert.deepEqual(request?.recentTurns.map(turn => turn.text), []);
    const status = request?.broadcastStatus ?? [];
    assert.ok(!status.some(line => line.includes("지난 대화") || line.includes("번째 대화")), `관계 맥락에 지운 대화가 남지 않는다: ${status.join(" / ")}`);
  });
});

describe("삭제 전에 시작한 작업", () => {
  test("LLM 기억 정리가 끝나기 전에 모두 지우면 정리 결과를 버린다", async () => {
    const pending = deferred<string[] | null>();
    const { store, service } = boot({ digestMemories: () => pending.promise });
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(testMemorySettings.privateDigestEveryMessages)) await service.sendMessage(OWNER, conversation.id, content, { tts: false });

    await service.clearAll(OWNER);
    pending.resolve(["상대는 재즈 피아노를 좋아한다."]);
    await service.settle();
    assert.deepEqual(ownedPrivate(), []);
  });

  test("기억만 지운 경우에도 진행 중이던 정리 결과를 버린다", async () => {
    const pending = deferred<string[] | null>();
    const { store, service } = boot({ digestMemories: () => pending.promise });
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(testMemorySettings.privateDigestEveryMessages)) await service.sendMessage(OWNER, conversation.id, content, { tts: false });

    await service.clearMemories(OWNER);
    pending.resolve(["상대는 재즈 피아노를 좋아한다."]);
    await service.settle();
    assert.deepEqual(ownedPrivate(), []);
    // 기억만 지웠으므로 대화는 남는다.
    assert.equal(store.list(OWNER).length, 1);
  });

  test("지운 뒤 다시 시작한 정리는 정상으로 저장한다", async () => {
    const { store, service } = boot({ digestMemories: async () => ["상대는 고양이를 키운다."] });
    await service.clearAll(OWNER);
    const conversation = store.create(OWNER, "제목");
    for (const content of numbered(testMemorySettings.privateDigestEveryMessages)) await service.sendMessage(OWNER, conversation.id, content, { tts: false });
    await service.settle();
    assert.deepEqual(ownedPrivate().map(record => record.text), ["상대는 고양이를 키운다."]);
  });

  test("임베딩을 기다리는 사이 모두 지우면 그 메시지의 개인 기억은 저장하지 않는다", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const embedding: EmbeddingProvider = {
      name: "test",
      isConfigured: () => true,
      embed: async texts => { entered.resolve(); await gate.promise; return texts.map(() => [1, 0]); },
    };
    const { store, service } = boot({ embedding });
    const conversation = store.create(OWNER, "제목");

    const sending = service.sendMessage(OWNER, conversation.id, "저는 퇴근하고 재즈 피아노 듣는 걸 좋아해요", { tts: false });
    await entered.promise;
    const clearing = service.clearAll(OWNER);
    gate.resolve();
    // 답변이 삭제 전에 저장됐는지는 타이밍에 달렸다. 어느 쪽이든 삭제 뒤에 남는 것은 없어야 한다.
    await sending;
    await clearing;

    assert.deepEqual(ownedPrivate(), []);
    assert.deepEqual(store.list(OWNER), []);
  });
});
