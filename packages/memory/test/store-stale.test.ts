/**
 * 기억 저장 중 삭제 단위 검사.
 * 임베딩을 기다리는 사이 소유자의 기억을 지우면, 그 전에 시작한 저장이 지운 것을 되살리지 않는지 본다.
 * 파일은 임시 디렉터리에 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "../src/store.js";
import type { EmbeddingProvider, MemoryCandidate, MemorySettings } from "../src/types.js";

const settings: MemorySettings = { enabled: true, maxMemories: 5, minSimilarity: 0.3, retentionDays: 30, embeddingModel: "test", privateDigestEveryMessages: 6 };
const OWNER = "companion:local";
const candidate = (text: string): MemoryCandidate => ({ text, kind: "viewer", scope: "private", ownerId: OWNER, importance: 0.5, confidence: 0.5 });

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-memory-stale-"));
  filePath = join(dir, "memories.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** embed가 불리면 entered를 풀고, release가 풀릴 때까지 기다린다. */
function gatedEmbedding() {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { markEntered = done; });
  const provider: EmbeddingProvider = {
    name: "gated",
    isConfigured: () => true,
    embed: async texts => { markEntered(); await gate; return texts.map(() => [1, 0]); },
  };
  return { provider, release, entered };
}

describe("isStale", () => {
  test("임베딩을 기다리는 사이 소유자 기억을 지우면 저장하지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    let generation = 0;
    const started = generation;
    const embedding = gatedEmbedding();

    const adding = store.add([candidate("상대는 재즈를 좋아한다.")], settings, embedding.provider, { isStale: () => generation !== started });
    await embedding.entered;
    generation += 1;
    await store.removeByOwner(OWNER);
    embedding.release();

    assert.equal(await adding, 0);
    assert.deepEqual(store.all(), []);
  });

  test("이미 있는 기억의 반복 횟수만 올리는 경우에도 지운 기억을 되살리지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    await store.add([candidate("상대는 재즈를 좋아한다.")], settings, null);
    let stale = false;
    const embedding = gatedEmbedding();

    const adding = store.add([candidate("상대는 재즈를 좋아한다."), candidate("상대는 고양이를 키운다.")], settings, embedding.provider, { isStale: () => stale });
    await embedding.entered;
    stale = true;
    await store.removeByOwner(OWNER);
    embedding.release();

    assert.equal(await adding, 0);
    assert.deepEqual(store.all(), []);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).records, []);
  });

  test("처음부터 isStale이면 아무것도 바꾸지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    assert.equal(await store.add([candidate("상대는 재즈를 좋아한다.")], settings, null, { isStale: () => true }), 0);
    assert.deepEqual(store.all(), []);
  });

  test("isStale을 주지 않거나 false면 지금처럼 저장한다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    assert.equal(await store.add([candidate("상대는 재즈를 좋아한다.")], settings, null), 1);
    assert.equal(await store.add([candidate("상대는 고양이를 키운다.")], settings, null, { isStale: () => false }), 1);
    assert.equal(store.count(), 2);
  });
});

describe("저장소 삭제 세대(점검 M-9)", () => {
  // 관리자 DELETE /api/memory/all·/:id는 저장소를 직접 부른다. isStale을 넘기지 않아도 막혀야 한다.
  test("임베딩을 기다리는 사이 관리자가 전체 삭제하면 저장하지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    const embedding = gatedEmbedding();
    const adding = store.add([candidate("상대는 재즈를 좋아한다.")], settings, embedding.provider);
    await embedding.entered;
    await store.clear();
    embedding.release();

    assert.equal(await adding, 0);
    assert.deepEqual(store.all(), []);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).records, []);
  });

  test("임베딩을 기다리는 사이 그 소유자의 기억 한 건을 지워도 저장하지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    await store.add([candidate("상대는 보사노바를 즐겨 듣는다.")], settings, null);
    const [deleted] = store.all();
    const embedding = gatedEmbedding();
    const adding = store.add([candidate("상대는 보사노바를 좋아한다.")], settings, embedding.provider);
    await embedding.entered;
    await store.remove(deleted.id);
    embedding.release();

    assert.equal(await adding, 0);
    assert.deepEqual(store.all(), []);
  });

  test("다른 소유자의 기억을 지운 것은 저장을 막지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    const embedding = gatedEmbedding();
    const adding = store.add([candidate("상대는 재즈를 좋아한다.")], settings, embedding.provider);
    await embedding.entered;
    await store.removeByOwner("local:viewer");
    embedding.release();
    assert.equal(await adding, 1);
  });

  test("watchRemovals는 그 뒤에 소유자의 기억이 지워졌는지 알려 준다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    await store.add([candidate("상대는 재즈를 좋아한다."), { text: "방송 요약", kind: "broadcast", scope: "broadcast", importance: 0.5, confidence: 0.5 }], settings, null);
    const mine = store.watchRemovals(OWNER);
    await store.removeByOwner("local:viewer");
    assert.equal(mine(), false);
    const broadcast = store.all().find(record => record.scope === "broadcast");
    assert.ok(broadcast);
    await store.remove(broadcast.id);
    assert.equal(mine(), false, "소유자 없는 기억을 지운 것은 1:1과 상관없다");
    await store.clear();
    assert.equal(mine(), true);
  });

  test("onRemoved는 지운 범위를 알려 주고, 대체(replaces)로 지운 것은 알리지 않는다", async () => {
    const store = createMemoryStore(filePath, { log: () => {} });
    const scopes: unknown[] = [];
    const stop = store.onRemoved(scope => { scopes.push(scope); });
    await store.add([candidate("상대는 부산에 산다.")], settings, null);
    const [old] = store.all();
    await store.add([{ ...candidate("상대는 서울로 이사했다."), replaces: [old.id] }], settings, null);
    assert.deepEqual(scopes, []);

    const [current] = store.all();
    await store.remove(current.id);
    await store.removeByOwner(OWNER);
    await store.clear();
    stop();
    await store.clear();
    assert.deepEqual(scopes, [[OWNER], [OWNER], "all"]);
  });
});
