/**
 * 기억 저장소 단위 검사.
 * 접근 필터가 순위 계산보다 먼저 걸리는지, 예전 파일을 안전하게 옮기는지, 중복 병합 키를 본다.
 * 파일은 모두 임시 디렉터리에 만든다. 실제 data/는 건드리지 않는다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "../src/store.js";
import type { EmbeddingProvider, MemoryCandidate, MemoryRecord, MemorySettings } from "../src/types.js";

const settings: MemorySettings = {
  enabled: true,
  maxMemories: 1,
  minSimilarity: 0.3,
  retentionDays: 30,
  embeddingModel: "test",
  privateDigestEveryMessages: 6,
};

/** 질문은 항상 [1, 0]으로 임베딩한다. 기억 쪽 벡터로 유사도를 조절한다. */
const fixedEmbedding: EmbeddingProvider = {
  name: "fixed",
  isConfigured: () => true,
  embed: async texts => texts.map(() => [1, 0]),
};

let dir: string;
let filePath: string;
const logs: string[] = [];
const open = () => createMemoryStore(filePath, { log: message => { logs.push(message); } });

function record(id: string, scope: MemoryRecord["scope"], ownerId: string | undefined, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text: `기억 ${id}`,
    kind: ownerId ? "viewer" : "broadcast",
    scope,
    ...(ownerId ? { ownerId } : {}),
    importance: 0.5,
    confidence: 0.5,
    repeatCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...extra,
  };
}

function writeFile(content: unknown) {
  writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
}

const backups = () => readdirSync(dir).filter(name => name.startsWith("memories.v1-backup-"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-memory-test-"));
  filePath = join(dir, "memories.json");
  logs.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("검색 접근 필터", () => {
  // A의 기억이 유사도·중요도 모두 가장 높다. 필터가 순위 뒤에 걸리면 top-1이 A 것이라 B에게 아무것도 안 나가거나 A 것이 나간다.
  const records = [
    record("a-private", "broadcast", "local:a", { importance: 1, createdAt: "2026-06-01T00:00:00.000Z", embedding: [1, 0] }),
    record("shared", "broadcast", undefined, { importance: 0.1, embedding: [0.8, 0.6] }),
    record("b-own", "broadcast", "local:b", { importance: 0.2, embedding: [0.7, 0.71] }),
  ];

  test("임베딩 경로: 다른 시청자의 기억은 순위 계산 전에 빠진다", async () => {
    writeFile({ version: 2, records });
    const store = open();
    store.load();

    const forB = await store.search("질문", { ...settings, maxMemories: 5 }, fixedEmbedding, { mode: "broadcast", speakerId: "local:b" });
    assert.deepEqual(forB.map(hit => hit.record.id).sort(), ["b-own", "shared"]);

    const topForB = await store.search("질문", settings, fixedEmbedding, { mode: "broadcast", speakerId: "local:b" });
    assert.deepEqual(topForB.map(hit => hit.record.id), ["shared"]);

    const forA = await store.search("질문", settings, fixedEmbedding, { mode: "broadcast", speakerId: "local:a" });
    assert.deepEqual(forA.map(hit => hit.record.id), ["a-private"]);
  });

  test("임베딩 없는 폴백 경로: 다른 시청자의 기억은 정렬 전에 빠진다", async () => {
    writeFile({ version: 2, records });
    const store = open();
    store.load();

    const anonymous = await store.search("질문", settings, null, { mode: "broadcast" });
    assert.deepEqual(anonymous.map(hit => hit.record.id), ["shared"]);

    const forB = await store.search("질문", { ...settings, maxMemories: 5 }, null, { mode: "broadcast", speakerId: "local:b" });
    assert.deepEqual(forB.map(hit => hit.record.id), ["b-own", "shared"]);

    const forA = await store.search("질문", settings, null, { mode: "broadcast", speakerId: "local:a" });
    assert.deepEqual(forA.map(hit => hit.record.id), ["a-private"]);
  });

  test("임베딩 호출이 실패해도 폴백 경로에서 필터가 걸린다", async () => {
    writeFile({ version: 2, records });
    const store = open();
    store.load();
    const broken: EmbeddingProvider = { name: "broken", isConfigured: () => true, embed: async () => { throw new Error("실패"); } };

    const hits = await store.search("질문", { ...settings, maxMemories: 5 }, broken, { mode: "broadcast" });
    assert.deepEqual(hits.map(hit => hit.record.id), ["shared"]);
  });

  test("1:1 검색은 방송 기억을 쓰지 않고 본인 private과 character만 본다", async () => {
    writeFile({
      version: 2,
      records: [
        ...records,
        record("character", "character", undefined, { embedding: [1, 0] }),
        record("a-1on1", "private", "local:a", { embedding: [1, 0] }),
        record("b-1on1", "private", "local:b", { embedding: [1, 0] }),
      ],
    });
    const store = open();
    store.load();

    for (const embedding of [fixedEmbedding, null]) {
      const hits = await store.search("질문", { ...settings, maxMemories: 10 }, embedding, { mode: "private", userId: "local:a" });
      assert.deepEqual(hits.map(hit => hit.record.id).sort(), ["a-1on1", "character"], embedding ? "임베딩" : "폴백");
    }
  });

  test("알 수 없는 scope 기억은 두 경로 모두에서 빠진다", async () => {
    writeFile({ version: 2, records: [record("odd", "public" as MemoryRecord["scope"], undefined, { importance: 1, embedding: [1, 0] })] });
    const store = open();
    store.load();

    assert.deepEqual(await store.search("질문", settings, fixedEmbedding, { mode: "broadcast" }), []);
    assert.deepEqual(await store.search("질문", settings, null, { mode: "broadcast" }), []);
  });

  test("볼 수 있는 기억이 없으면 임베딩을 부르지 않는다", async () => {
    writeFile({ version: 2, records: [record("a-private", "broadcast", "local:a", { embedding: [1, 0] })] });
    const store = open();
    store.load();
    let calls = 0;
    const counting: EmbeddingProvider = { ...fixedEmbedding, embed: async texts => { calls += 1; return texts.map(() => [1, 0]); } };

    assert.deepEqual(await store.search("질문", settings, counting, { mode: "broadcast", speakerId: "local:b" }), []);
    assert.equal(calls, 0);
  });
});

describe("마이그레이션", () => {
  const legacy = {
    records: [
      { ...record("summary", "broadcast", undefined), scope: undefined, kind: "broadcast" },
      { ...record("named", "broadcast", undefined), scope: undefined, kind: "viewer", viewerId: "local:철수" },
      { ...record("virtual", "broadcast", undefined), scope: undefined, kind: "viewer", viewerId: "virtual-viewer" },
      { ...record("unknown-prefix", "broadcast", undefined), scope: undefined, kind: "viewer", viewerId: "chzzk:123" },
      { ...record("viewer-no-id", "broadcast", undefined), scope: undefined, kind: "viewer" },
    ].map(({ scope: _scope, ...rest }) => rest),
  };

  test("버전 없는 파일을 v2로 옮기고 소유자 불명 기억은 지운다", () => {
    writeFile(legacy);
    const original = readFileSync(filePath, "utf8");
    const store = open();
    store.load();

    const saved = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; records: MemoryRecord[] };
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.records.map(entry => [entry.id, entry.scope, entry.ownerId]), [
      ["summary", "broadcast", undefined],
      ["named", "broadcast", "local:철수"],
    ]);
    // 예전 필드는 남기지 않는다.
    assert.ok(saved.records.every(entry => !("viewerId" in entry)));
    assert.equal(store.count(), 2);

    // 원본 백업이 같은 디렉터리에 그대로 남는다. 파일 이름에 콜론이 없다.
    const created = backups();
    assert.equal(created.length, 1);
    assert.ok(!created[0].includes(":"));
    assert.match(created[0], /^memories\.v1-backup-.+\.json$/);
    assert.equal(readFileSync(join(dir, created[0]), "utf8"), original);

    // 변환·삭제 건수를 남긴다.
    assert.equal(logs.length, 1);
    assert.match(logs[0], /변환 2건/);
    assert.match(logs[0], /삭제 3건/);
  });

  test("version: 1 파일도 같은 방식으로 옮긴다", () => {
    writeFile({ version: 1, ...legacy });
    const store = open();
    store.load();
    assert.equal(store.count(), 2);
    assert.equal(backups().length, 1);
  });

  test("두 번 불러도 결과가 같고 백업을 또 만들지 않는다", () => {
    writeFile(legacy);
    open().load();
    const first = readFileSync(filePath, "utf8");

    const again = open();
    again.load();
    assert.equal(readFileSync(filePath, "utf8"), first);
    assert.equal(again.count(), 2);
    assert.equal(backups().length, 1);
    assert.equal(logs.length, 1);
  });

  test("파일이 없으면 아무것도 만들지 않는다", () => {
    const store = open();
    assert.equal(store.load(), 0);
    assert.equal(store.count(), 0);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(logs.length, 0);
  });

  test("v2 파일은 그대로 읽고 백업하지 않는다", () => {
    writeFile({ version: 2, records: [record("kept", "broadcast", "local:a")] });
    const before = readFileSync(filePath, "utf8");
    const store = open();
    store.load();
    assert.equal(store.count(), 1);
    assert.equal(readFileSync(filePath, "utf8"), before);
    assert.deepEqual(backups(), []);
  });
});

describe("저장과 삭제", () => {
  const base = { kind: "viewer" as const, importance: 0.5, confidence: 0.5 };

  test("같은 문장이라도 scope나 소유자가 다르면 합치지 않는다", async () => {
    const store = open();
    const candidates: MemoryCandidate[] = [
      { ...base, text: "고양이를 키운다", scope: "broadcast", ownerId: "local:a" },
      { ...base, text: "고양이를 키운다", scope: "broadcast", ownerId: "local:b" },
      { ...base, text: "고양이를 키운다", scope: "private", ownerId: "local:a" },
      { ...base, text: "고양이를 키운다", scope: "broadcast" },
    ];
    assert.equal(await store.add(candidates, settings, null), 4);
    assert.equal(store.count(), 4);
  });

  test("scope와 소유자까지 같으면 반복 횟수만 올린다", async () => {
    const store = open();
    const candidate: MemoryCandidate = { ...base, text: "고양이를 키운다", scope: "broadcast", ownerId: "local:a" };
    await store.add([candidate], settings, null);
    assert.equal(await store.add([candidate], settings, null), 0);
    assert.equal(store.count(), 1);
    assert.equal(store.all()[0].repeatCount, 2);
  });

  test("저장한 기억은 scope와 ownerId를 갖고 v2 형식으로 쓰인다", async () => {
    const store = open();
    await store.add([{ ...base, text: "기타를 배운다", scope: "broadcast", ownerId: "local:a" }], settings, null);
    const saved = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; records: MemoryRecord[] };
    assert.equal(saved.version, 2);
    assert.equal(saved.records[0].scope, "broadcast");
    assert.equal(saved.records[0].ownerId, "local:a");
  });

  test("removeByOwner는 그 소유자의 기억만 지운다", async () => {
    const store = open();
    await store.add([
      { ...base, text: "A의 기억", scope: "broadcast", ownerId: "local:a" },
      { ...base, text: "A의 1:1 기억", scope: "private", ownerId: "local:a" },
      { ...base, text: "B의 기억", scope: "broadcast", ownerId: "local:b" },
      { ...base, text: "방송 요약", kind: "broadcast", scope: "broadcast" },
    ], settings, null);

    assert.equal(await store.removeByOwner("local:a"), 2);
    assert.deepEqual(store.all().map(entry => entry.text).sort(), ["B의 기억", "방송 요약"]);
    assert.equal(await store.removeByOwner(""), 0);
    assert.equal(await store.removeByOwner("local:없음"), 0);

    // 지운 결과가 파일에도 남는다.
    const reopened = open();
    reopened.load();
    assert.equal(reopened.count(), 2);
  });
});
