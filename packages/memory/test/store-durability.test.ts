/**
 * 기억 파일 내구성 단위 검사(점검 D-1, D-2, D-3, D-4, D-7).
 * 손상된 파일을 읽을 때 원본을 남기는지, 깨진 레코드만 버리는지, 쓰기에 실패하면 삭제를 되돌리는지,
 * 저장이 임시 파일 + rename으로 한 번에 하나씩 되는지 본다. 파일은 모두 임시 디렉터리에 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type MemoryStoreOptions } from "../src/store.js";
import type { MemoryCandidate, MemoryRecord, MemorySettings } from "../src/types.js";

const settings: MemorySettings = {
  enabled: true,
  maxMemories: 5,
  minSimilarity: 0.3,
  retentionDays: 30,
  embeddingModel: "test",
  privateDigestEveryMessages: 6,
};

let dir: string;
let filePath: string;
const logs: string[] = [];
const warnings: string[] = [];
const open = (options: MemoryStoreOptions = {}) =>
  createMemoryStore(filePath, { log: message => { logs.push(message); }, warn: message => { warnings.push(message); }, ...options });

function record(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text: `기억 ${id}`,
    kind: "viewer",
    scope: "private",
    ownerId: "companion:local",
    importance: 0.5,
    confidence: 0.5,
    repeatCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...extra,
  };
}

const candidate = (text: string, ownerId = "companion:local"): MemoryCandidate => ({ text, kind: "viewer", scope: "private", ownerId, importance: 0.5, confidence: 0.5 });
const unreadableBackups = () => readdirSync(dir).filter(name => /^memories\.unreadable-.+\.json$/.test(name));
const tempFiles = () => readdirSync(dir).filter(name => name.endsWith(".tmp"));
const savedRecords = () => (JSON.parse(readFileSync(filePath, "utf8")) as { records: MemoryRecord[] }).records;
/** rename을 막아 쓰기 실패(EPERM)를 흉내 낸다. */
const failingRename = () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-memory-durability-"));
  filePath = join(dir, "memories.json");
  logs.length = 0;
  warnings.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("손상된 파일 읽기", () => {
  const broken: [string, string][] = [
    ["빈 파일", ""],
    ["잘린 JSON", JSON.stringify({ version: 2, records: [record("a")] }).slice(0, 60)],
    ["records가 없는 객체", JSON.stringify({ version: 2 })],
    ["배열", "[]"],
    ["숫자", "5"],
  ];

  for (const [name, content] of broken) {
    test(`${name}: 원본을 unreadable 백업으로 남기고 빈 상태로 시작한다`, async () => {
      writeFileSync(filePath, content, "utf8");
      const store = open();
      assert.equal(store.load(), 0);
      assert.equal(store.count(), 0);

      const backups = unreadableBackups();
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(dir, backups[0]), "utf8"), content);
      assert.ok(warnings.some(message => message.includes(backups[0])), "경고에 백업 이름이 있다");

      // 다음 저장이 원본을 덮어써도 백업은 남는다.
      await store.add([candidate("상대는 고양이를 키운다.")], settings, null);
      assert.equal(savedRecords().length, 1);
      assert.equal(readFileSync(join(dir, backups[0]), "utf8"), content);
    });
  }

  test("null 레코드 하나로 시작이 막히지 않고 깨진 레코드만 버린다", () => {
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [null, record("ok"), { ...record("number-text"), text: 5 }, "문자열"] }), "utf8");
    const store = open();
    assert.equal(store.load(), 0);
    assert.deepEqual(store.all().map(entry => entry.id), ["ok"]);
    assert.ok(warnings.some(message => message.includes("3건")), warnings.join(" / "));
    assert.equal(unreadableBackups().length, 1);
  });

  test("필드가 빠진 레코드를 만료로 지우지 않는다. 형식 오류로 백업한 뒤 버린다", () => {
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [{ id: "x" }, record("ok")] }), "utf8");
    const store = open();
    // 만료 정리 건수에 들어가지 않는다.
    assert.equal(store.load(), 0);
    assert.equal(store.count(), 1);
    assert.equal(unreadableBackups().length, 1);
    assert.ok(warnings.some(message => message.includes("형식이 틀린 기억 1건")));
  });

  test("날짜가 틀린 레코드도 형식 오류다", () => {
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [record("bad", { expiresAt: "언젠가" }), record("ok")] }), "utf8");
    const store = open();
    store.load();
    assert.deepEqual(store.all().map(entry => entry.id), ["ok"]);
  });

  test("모르는 버전은 원본을 남기고, 읽히는 레코드는 모르는 필드까지 그대로 쓴다", async () => {
    const original = JSON.stringify({ version: 3, records: [{ ...record("future"), newField: "다음 버전" }] });
    writeFileSync(filePath, original, "utf8");
    const store = open();
    store.load();
    assert.equal(store.count(), 1);
    assert.equal(unreadableBackups().length, 1);
    assert.equal(readFileSync(join(dir, unreadableBackups()[0]), "utf8"), original);
    assert.ok(warnings.some(message => message.includes("버전(3)")));

    await store.add([candidate("상대는 피아노를 친다.")], settings, null);
    const saved = savedRecords() as (MemoryRecord & { newField?: string })[];
    assert.equal(saved.find(entry => entry.id === "future")?.newField, "다음 버전");
  });

  test("있는데 읽지 못한 파일은 덮어쓰지 않는다", async () => {
    // 디렉터리를 파일 자리에 두어 읽기 오류(EISDIR)를 만든다.
    mkdirSync(filePath);
    const store = open();
    assert.equal(store.load(), 0);
    assert.ok(warnings.some(message => message.includes("쓰지 않습니다")));
    await assert.rejects(store.add([candidate("상대는 등산을 좋아한다.")], settings, null));
    await assert.rejects(store.clear());
    assert.deepEqual(readdirSync(filePath), [], "그 자리는 건드리지 않는다");
  });

  test("경고에는 기억 문장을 넣지 않는다", () => {
    writeFileSync(filePath, `{"version":2,"records":[{"id":"x","text":"비밀 문장`, "utf8");
    open().load();
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every(message => !message.includes("비밀 문장")));
  });

  test("서버 시작 때의 저장(만료 정리)이 실패해도 예외를 던지지 않는다", () => {
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [record("old", { expiresAt: "2020-01-01T00:00:00.000Z" }), record("ok")] }), "utf8");
    const store = open({ rename: failingRename });
    assert.equal(store.load(), 1);
    assert.equal(store.count(), 1);
    assert.ok(warnings.some(message => message.includes("저장하지 못했습니다")));
    assert.deepEqual(tempFiles(), []);
  });
});

describe("쓰기 실패와 삭제 되돌리기", () => {
  async function seeded(options: MemoryStoreOptions = {}) {
    writeFileSync(filePath, JSON.stringify({ version: 2, records: [record("a"), record("b"), record("other", { ownerId: "companion:other" })] }), "utf8");
    const store = open(options);
    store.load();
    return store;
  }

  test("remove: 파일에 쓰지 못하면 지운 기억을 되돌리고 예외를 넘긴다", async () => {
    let fail = true;
    const store = await seeded({ rename: (from, to) => (fail ? failingRename() : renameSync(from, to)) });
    const before = readFileSync(filePath, "utf8");

    await assert.rejects(store.remove("a"));
    assert.deepEqual(store.all().map(entry => entry.id).sort(), ["a", "b", "other"]);
    assert.equal(readFileSync(filePath, "utf8"), before);
    assert.deepEqual(tempFiles(), [], "임시 파일을 남기지 않는다");

    fail = false;
    assert.equal(await store.remove("a"), true);
    assert.deepEqual(savedRecords().map(entry => entry.id).sort(), ["b", "other"]);
  });

  test("저장이 실패하면 잠시 뒤 지금 상태를 다시 쓴다", async () => {
    let fail = true;
    const store = await seeded({ rename: (from, to) => (fail ? failingRename() : renameSync(from, to)), retryDelaysMs: [20] });
    await assert.rejects(store.add([candidate("상대는 비 오는 날을 좋아한다.")], settings, null));
    assert.ok(!savedRecords().some(entry => entry.text.includes("비 오는 날")), "실패한 저장은 파일에 없다");

    fail = false;
    // 다음 저장 요청이 없어도 예약된 다시 시도가 메모리 상태를 파일에 쓴다.
    for (let tries = 0; tries < 50 && !savedRecords().some(entry => entry.text.includes("비 오는 날")); tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(savedRecords().some(entry => entry.text.includes("비 오는 날")), "다시 시도로 저장됐다");
  });

  test("removeByOwner와 clear도 실패하면 되돌린다", async () => {
    const store = await seeded({ rename: failingRename });
    await assert.rejects(store.removeByOwner("companion:local"));
    assert.equal(store.count(), 3);
    await assert.rejects(store.clear());
    assert.equal(store.count(), 3);
  });

  test("같은 쓰기로 묶인 저장은 함께 실패하고, 다음 저장은 되돌린 기억까지 담는다", async () => {
    let calls = 0;
    const store = await seeded({ rename: (from, to) => { calls += 1; if (calls === 1) failingRename(); renameSync(from, to); } });
    const removing = store.remove("a");
    // 아직 시작하지 않은 쓰기에 묶인다. 그 쓰기가 실패하면 이 저장도 실패로 알린다.
    const adding = store.add([candidate("상대는 바다를 좋아한다.")], settings, null);
    await assert.rejects(removing);
    await assert.rejects(adding);
    assert.ok(store.all().some(entry => entry.id === "a"), "삭제는 되돌렸다");

    await store.save();
    assert.deepEqual(savedRecords().map(entry => entry.id).sort(), store.all().map(entry => entry.id).sort());
    assert.ok(savedRecords().some(entry => entry.id === "a"));
  });

  test("add가 저장에 실패하면 예외를 넘기고 임시 파일을 남기지 않는다", async () => {
    const store = open({ rename: failingRename });
    await assert.rejects(store.add([candidate("상대는 커피를 좋아한다.")], settings, null));
    assert.deepEqual(tempFiles(), []);
  });
});

describe("저장 방식", () => {
  test("들여쓰기 없이 쓰고 다시 읽으면 같다", async () => {
    const store = open();
    await store.add([candidate("상대는 고양이를 키운다."), candidate("상대는 재즈를 좋아한다.")], settings, null);
    const raw = readFileSync(filePath, "utf8");
    assert.ok(!raw.includes("\n"), "줄바꿈이 없다");
    const reopened = open();
    reopened.load();
    assert.deepEqual(reopened.all(), store.all());
  });

  test("조각 크기보다 많은 기억도 올바른 JSON으로 쓴다", async () => {
    const records = Array.from({ length: 450 }, (_, index) => record(`r${index}`, { embedding: [index, 0.5] }));
    writeFileSync(filePath, JSON.stringify({ version: 2, records }), "utf8");
    const store = open();
    store.load();
    await store.save();
    assert.deepEqual(savedRecords(), records);
  });

  test("기다리는 동안 들어온 저장은 한 번으로 묶는다", async () => {
    let renames = 0;
    const store = open({ rename: (from, to) => { renames += 1; renameSync(from, to); } });
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.add([candidate(`상대는 취미 ${index}번을 즐긴다.`)], settings, null)));
    // 첫 저장이 도는 동안 들어온 네 번은 다음 저장 하나로 묶인다.
    assert.ok(renames <= 2, `rename ${renames}회`);
    assert.equal(savedRecords().length, 5);
  });

  test("removeLeftovers는 다른 프로세스의 임시 파일만 지운다", () => {
    const store = open();
    writeFileSync(`${filePath}.99999999.0b0f6d3e-0000-4000-8000-000000000000.tmp`, "{}", "utf8");
    writeFileSync(`${filePath}.${process.pid}.0b0f6d3e-0000-4000-8000-000000000001.tmp`, "{}", "utf8");
    writeFileSync(join(dir, "memories.unreadable-2026-10-01T00-00-00-000Z.json"), "{}", "utf8");
    assert.deepEqual(store.removeLeftovers(), { removed: 1, failed: 0 });
    assert.deepEqual(tempFiles(), [`memories.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000001.tmp`]);
    // 기억 백업에는 방송 기억도 섞여 있어 여기서 지우지 않는다.
    assert.equal(unreadableBackups().length, 1);
  });
});
