/**
 * 임베딩 요청 상한 단위 검사.
 * 업체가 응답하지 않아도 임베딩이 정해진 시간 안에 실패로 끝나고, 기억 저장은 임베딩 없이 이어지는지 본다.
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다. 파일은 임시 디렉터리에 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAiEmbedding, EMBEDDING_TIMEOUT_MS } from "../src/embedding.js";
import { createMemoryStore } from "../src/store.js";
import type { MemorySettings } from "../src/types.js";

const settings: MemorySettings = { enabled: true, maxMemories: 5, minSimilarity: 0.3, retentionDays: 30, embeddingModel: "test", privateDigestEveryMessages: 6 };
const realFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-embedding-timeout-"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

/** 응답하지 않는 업체. 신호가 끊기면 그 이유로 실패한다. 신호를 받지 못했는지도 기록한다. */
function hangingFetch() {
  const seen = { signal: false };
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    seen.signal = true;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;
  return seen;
}

describe("임베딩 요청 상한", () => {
  test("기본 상한은 10초다", () => {
    assert.equal(EMBEDDING_TIMEOUT_MS, 10_000);
  });

  test("응답이 없으면 상한 뒤에 시간 초과 오류로 끝난다", async () => {
    const seen = hangingFetch();
    const embedding = createOpenAiEmbedding({ apiKey: "fake", model: "test", timeoutMs: 50 });
    const startedAt = Date.now();
    await assert.rejects(embedding.embed(["문장"]), /임베딩 응답이 50ms 안에 오지 않았습니다/);
    assert.ok(seen.signal, "fetch에 중단 신호를 넘긴다");
    assert.ok(Date.now() - startedAt < 2_000);
  });

  test("업체 오류는 지금처럼 상태 코드와 함께 실패한다", async () => {
    globalThis.fetch = (async () => new Response("server error", { status: 500 })) as typeof fetch;
    const embedding = createOpenAiEmbedding({ apiKey: "fake", model: "test", timeoutMs: 50 });
    await assert.rejects(embedding.embed(["문장"]), /임베딩 500: server error/);
  });

  test("시간 초과여도 기억은 임베딩 없이 저장한다", async () => {
    hangingFetch();
    const store = createMemoryStore(join(dir, "memories.json"), { log: () => {} });
    const embedding = createOpenAiEmbedding({ apiKey: "fake", model: "test", timeoutMs: 50 });
    const saved = await store.add([{ text: "상대는 재즈를 좋아한다.", kind: "viewer", scope: "private", ownerId: "companion:local", importance: 0.5, confidence: 0.5 }], settings, embedding);
    assert.equal(saved, 1);
    assert.equal(store.all()[0].embedding, undefined);
  });

  test("시간 초과여도 검색은 최신·중요도 순으로 결과를 돌려준다", async () => {
    const store = createMemoryStore(join(dir, "memories.json"), { log: () => {} });
    await store.add([{ text: "방송에서 리듬 게임 이야기를 했다.", kind: "broadcast", scope: "broadcast", importance: 0.5, confidence: 0.5 }], settings, null);
    hangingFetch();
    const embedding = createOpenAiEmbedding({ apiKey: "fake", model: "test", timeoutMs: 50 });
    const hits = await store.search("게임", settings, embedding, { mode: "broadcast" });
    assert.deepEqual(hits.map(hit => hit.record.text), ["방송에서 리듬 게임 이야기를 했다."]);
  });
});
