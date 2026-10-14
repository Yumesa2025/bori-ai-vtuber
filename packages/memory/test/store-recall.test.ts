/**
 * 기억 검색 단위 검사(점검 M-5·M-7·M-8).
 * 1:1 개인 기억이 적으면 모두 넣는지, 만료된 기억이 실행 중에도 빠지는지,
 * 임베딩 없이 저장된 기억이 문자열 유사도로 검색되고 나중에 임베딩이 채워지는지 본다.
 * 파일은 임시 디렉터리에 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, PRIVATE_RECALL_ALL_LIMIT } from "../src/store.js";
import { textSimilarity } from "../src/similar.js";
import type { EmbeddingProvider, MemoryAccess, MemoryCandidate, MemoryRecord, MemorySettings } from "../src/types.js";

const settings: MemorySettings = { enabled: true, maxMemories: 5, minSimilarity: 0.3, retentionDays: 30, embeddingModel: "test", privateDigestEveryMessages: 6 };
const OWNER = "companion:local";
const me: MemoryAccess = { mode: "private", userId: OWNER };
const mine = (text: string): MemoryCandidate => ({ text, kind: "viewer", scope: "private", ownerId: OWNER, importance: 0.5, confidence: 0.5 });

let dir: string;
let filePath: string;
const open = () => createMemoryStore(filePath, { log: () => {}, warn: () => {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-memory-recall-"));
  filePath = join(dir, "memories.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 물음표로 끝나는 질문과 기억 문장에 서로 직교하는 벡터를 준다. 유사도로는 어떤 기억도 임계값을 넘지 못한다. */
function orthogonalEmbedding(): EmbeddingProvider {
  return {
    name: "orthogonal",
    isConfigured: () => true,
    embed: async texts => texts.map(text => (text.endsWith("?") ? [1, 0] : [0, 1])),
  };
}

/** 정해 둔 문장은 그 벡터, 나머지는 [0, 0, 1]을 돌려준다. 받은 입력을 남긴다. */
function fixedEmbedding(vectors: Record<string, number[]>): EmbeddingProvider & { inputs: string[][] } {
  const inputs: string[][] = [];
  return {
    name: "fixed",
    inputs,
    isConfigured: () => true,
    embed: async texts => {
      inputs.push([...texts]);
      return texts.map(text => vectors[text] ?? [0, 0, 1]);
    },
  };
}

describe("1:1 개인 기억 모두 넣기(점검 M-5)", () => {
  test(`개인 기억이 ${PRIVATE_RECALL_ALL_LIMIT}건 이하면 유사도·상한과 상관없이 모두 돌려준다`, async () => {
    const store = open();
    const texts = Array.from({ length: 8 }, (_, index) => `상대는 취미 ${index}번을 즐긴다.`);
    const embedding = orthogonalEmbedding();
    await store.add(texts.map(mine), settings, embedding);
    // "저 누군지 기억나요?"에 이름 기억이 유사도 0.3 아래로 빠졌던 경우다.
    const hits = await store.search("저 누군지 기억나요?", settings, embedding, me);
    assert.equal(hits.length, 8);
    assert.deepEqual(hits.map(hit => hit.record.text).sort(), [...texts].sort());
  });

  test("넘으면 예전처럼 유사도와 상한으로 고른다", async () => {
    const store = open();
    const embedding = orthogonalEmbedding();
    await store.add(Array.from({ length: PRIVATE_RECALL_ALL_LIMIT + 1 }, (_, index) => mine(`상대는 취미 ${index}번을 즐긴다.`)), settings, embedding);
    assert.deepEqual(await store.search("저 누군지 기억나요?", settings, embedding, me), []);
  });

  test("방송 검색은 기억이 적어도 유사도와 상한을 그대로 쓴다", async () => {
    const store = open();
    const embedding = orthogonalEmbedding();
    await store.add([{ text: "방송에서 리듬 게임 이야기를 했다.", kind: "broadcast", scope: "broadcast", importance: 0.5, confidence: 0.5 }], settings, embedding);
    assert.deepEqual(await store.search("오늘 뭐 해요?", settings, embedding, { mode: "broadcast" }), []);
  });

  test("임베딩이 없을 때도 개인 기억이 적으면 모두 돌려준다", async () => {
    const store = open();
    await store.add(Array.from({ length: 7 }, (_, index) => mine(`상대는 취미 ${index}번을 즐긴다.`)), settings, null);
    assert.equal((await store.search("뭐 좋아했죠?", settings, null, me)).length, 7);
  });
});

describe("실행 중 만료(점검 M-7)", () => {
  test("만료된 기억은 서버를 다시 띄우지 않아도 검색과 목록에서 빠진다", async () => {
    const store = open();
    await store.add([mine("상대는 재즈를 좋아한다."), mine("상대는 고양이를 키운다.")], settings, null);
    const [expired] = store.all();
    // 실행 중에 시간이 지나 만료된 것처럼 만료 시각을 과거로 바꾼다.
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    const hits = await store.search("재즈", settings, null, me);
    assert.deepEqual(hits.map(hit => hit.record.text), ["상대는 고양이를 키운다."]);
    assert.equal(store.all().length, 1);
  });

  test("만료된 기억과는 합치지 않고 새로 저장한다", async () => {
    const store = open();
    await store.add([mine("상대는 재즈를 좋아한다.")], settings, null);
    store.all()[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(await store.add([mine("상대는 재즈를 좋아한다")], settings, null), 1);
    assert.equal(store.all()[0].repeatCount, 1);
  });
});

describe("임베딩 없는 기억(점검 M-8)", () => {
  test("임베딩이 없는 기억은 문자열 유사도로 점수를 받고, 다음에 임베딩이 채워진다", async () => {
    const store = open();
    // 임베딩 없이 저장한 기억(키가 없었거나 임베딩이 실패한 경우).
    const texts = Array.from({ length: PRIVATE_RECALL_ALL_LIMIT + 1 }, (_, index) => (index === 0 ? "상대의 강아지 이름은 콩떡이다." : `상대는 취미 ${index}번을 즐긴다.`));
    await store.add(texts.map(mine), settings, null);
    const embedding = fixedEmbedding({ "강아지 이름 기억나요?": [1, 0, 0] });

    const hits = await store.search("강아지 이름 기억나요?", settings, embedding, me);
    assert.equal(hits[0]?.record.text, "상대의 강아지 이름은 콩떡이다.", "예전에는 점수 0으로 영구히 빠졌다");
    assert.ok(hits[0].score >= settings.minSimilarity);

    await store.flush();
    assert.equal(embedding.inputs.length, 2, "검색 질문 한 번과 채우기 한 번");
    assert.equal(embedding.inputs[1].length, Math.min(texts.length, 20));
    const saved = JSON.parse(readFileSync(filePath, "utf8")) as { records: MemoryRecord[] };
    assert.ok(saved.records.every(record => Array.isArray(record.embedding)), "채운 임베딩은 파일에도 남는다");
  });

  test("임베딩 길이가 다른 기억(모델을 바꾼 경우)도 다시 채운다", async () => {
    const store = open();
    await store.add([mine("상대는 재즈를 좋아한다.")], settings, fixedEmbedding({ "상대는 재즈를 좋아한다.": [1, 0] }));
    await store.search("재즈?", settings, fixedEmbedding({}), me);
    await store.flush();
    assert.deepEqual(store.all()[0].embedding, [0, 0, 1]);
  });

  test("채우기가 실패하면 다음 검색 때 바로 다시 부르지 않는다", async () => {
    const store = open();
    await store.add([mine("상대는 재즈를 좋아한다."), mine("상대는 고양이를 키운다.")], settings, null);
    let calls = 0;
    const failing: EmbeddingProvider = {
      name: "failing-fill",
      isConfigured: () => true,
      embed: async texts => {
        calls += 1;
        if (texts.length > 1) throw new Error("채우기 실패");
        return [[1, 0]];
      },
    };
    await store.search("재즈?", settings, failing, me);
    await store.flush();
    await store.search("재즈?", settings, failing, me);
    await store.flush();
    assert.equal(calls, 3, "질문 두 번 + 채우기 한 번");
    assert.ok(store.all().every(record => record.embedding === undefined));
  });

  test("채우는 사이 지운 기억에는 붙이지 않는다", async () => {
    const store = open();
    await store.add([mine("상대는 재즈를 좋아한다.")], settings, null);
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const slow: EmbeddingProvider = { name: "slow-fill", isConfigured: () => true, embed: async texts => { if (texts.length === 1 && texts[0].startsWith("상대는")) await gate; return texts.map(() => [1, 0]); } };
    await store.search("재즈?", settings, slow, me);
    await store.removeByOwner(OWNER);
    release();
    await store.flush();
    assert.deepEqual(store.all(), []);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).records, []);
  });

  test("문자열 유사도는 두 글자 조각의 겹침이다", () => {
    assert.equal(textSimilarity("강아지 이름", "강아지 이름"), 1);
    assert.equal(textSimilarity("강아지", "고양이"), 0);
    assert.ok(textSimilarity("강아지 이름 기억나요?", "상대의 강아지 이름은 콩떡이다.") > 0.3);
  });
});

test("파일에서 읽은 기억도 같은 규칙으로 검색한다", async () => {
  const record: MemoryRecord = { id: "a", text: "상대는 재즈를 좋아한다.", kind: "viewer", scope: "private", ownerId: OWNER, importance: 0.5, confidence: 0.5, repeatCount: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  writeFileSync(filePath, JSON.stringify({ version: 2, records: [record] }));
  const store = open();
  store.load();
  assert.deepEqual((await store.search("아무 질문", settings, null, me)).map(hit => hit.record.id), ["a"]);
});
