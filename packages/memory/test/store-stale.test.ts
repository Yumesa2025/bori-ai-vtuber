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
