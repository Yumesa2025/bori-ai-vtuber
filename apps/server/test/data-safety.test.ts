/**
 * 서버 데이터 파일 안전 저장 단위 검사(점검 D-1, D-3, D-5, D-6, L-4, M-10, M-19, L8).
 * 풀지 못한 키를 지우지 않는지, 키에 섞인 개행을 지우는지, 읽지 못한 대화·사용량 파일을 덮어쓰지 않는지,
 * 1:1 기록 전체 삭제가 실패하면 실패로 알리고 남은 원문 조각까지 지우는지, 오래된 임시 파일을 정리하는지 본다.
 * 키 값은 테스트용 가짜 문자열만 쓰고, 파일은 임시 디렉터리에만 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type MemoryStore } from "@bori/memory";
import { createCompanionService, createConversationStore } from "../src/companion/index.js";
import { PartialDeletionError } from "../src/companion/service.js";
import { createConversationEngine } from "../src/conversation/index.js";
import { validateLlmSettingsPatch, validateTtsSettingsPatch } from "../src/http/settings.js";
import { isLeftoverTempFile, purgeExpiredBackups } from "../src/retention.js";
import { createApiKeySlot, encryptSecret, normalizeApiKey } from "../src/secret-store.js";
import { createUsageStore } from "../src/usage/index.js";
import { defaultTtsSettings } from "@bori/llm";
import { createFakeEngineHarness, testMemorySettings } from "./fakes.js";

const OWNER = "companion:local";
const silent = () => {};
const OTHER_PID_TEMP = "companion-conversations.json.99999999.0b0f6d3e-0000-4000-8000-000000000000.tmp";
const eperm = () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-data-safety-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("풀지 못한 저장 키", () => {
  // 형식은 맞지만 이 컴퓨터의 키로 풀리지 않는 암호문.
  const foreign = "enc.v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";

  test("지우지 않고 원문 그대로 다시 저장하며, 풀 수 없음 상태를 알린다", () => {
    const slot = createApiKeySlot(undefined);
    assert.equal(slot.load(foreign), "unreadable");
    assert.equal(slot.current(), "");
    assert.equal(slot.stored(), foreign);
    assert.equal(slot.isUnreadable(), true);
  });

  test("새 키를 넣거나 지우면 그때 원문을 버린다", () => {
    const replaced = createApiKeySlot(undefined);
    replaced.load(foreign);
    replaced.set("new-fake-key");
    assert.notEqual(replaced.stored(), foreign);
    assert.equal(replaced.isUnreadable(), false);

    const cleared = createApiKeySlot(undefined);
    cleared.load(foreign);
    cleared.set("");
    assert.equal(cleared.stored(), undefined);
  });

  test("checkpoint로 저장 실패 전 상태로 되돌린다", () => {
    const slot = createApiKeySlot(undefined);
    slot.load(foreign);
    const restore = slot.checkpoint();
    slot.set("new-fake-key");
    restore();
    assert.equal(slot.stored(), foreign);
    assert.equal(slot.current(), "");

    const plain = createApiKeySlot(undefined);
    plain.load(encryptSecret("old-fake-key"));
    const back = plain.checkpoint();
    plain.set("");
    back();
    assert.equal(plain.current(), "old-fake-key");
  });
});

describe("키에 섞인 개행·공백(L-4)", () => {
  test("공백·개행·제로폭 문자를 지운다", () => {
    assert.equal(normalizeApiKey(" sk-fake-0123\nTAIL\r\n"), "sk-fake-0123TAIL");
    assert.equal(normalizeApiKey(`sk-fake${String.fromCharCode(0x200b)}-tail`), "sk-fake-tail");
    assert.equal(normalizeApiKey(""), "");
  });

  test("그 밖의 보이지 않는 문자나 ASCII 밖 문자는 거부한다", () => {
    assert.equal(normalizeApiKey("sk-fake\u0000tail"), null);
    assert.equal(normalizeApiKey("sk-가짜키"), null);
  });

  test("PATCH 검증은 다듬은 키를 넘기고, 거부할 때 오류 문장에 키를 넣지 않는다", () => {
    const llm = validateLlmSettingsPatch({ apiKey: "sk-fake-0123\nTAILSECRET" });
    assert.ok(llm.ok && llm.patch.apiKey === "sk-fake-0123TAILSECRET");
    const rejected = validateLlmSettingsPatch({ apiKey: "sk-fake\u0001TAILSECRET" });
    assert.ok(!rejected.ok && !rejected.error.includes("TAILSECRET"));

    const tts = validateTtsSettingsPatch({ elevenLabsApiKey: "eleven fake\nkey" }, defaultTtsSettings);
    assert.ok(tts.ok && tts.patch.elevenLabsApiKey === "elevenfakekey");
  });
});

describe("대화·사용량 파일 읽기 실패", () => {
  test("대화 파일이 있는데 읽지 못하면 덮어쓰지 않는다", () => {
    const filePath = join(dir, "companion-conversations.json");
    mkdirSync(filePath);
    const logs: string[] = [];
    const store = createConversationStore(filePath, { log: message => logs.push(message) });
    store.load();
    assert.throws(() => store.create(OWNER, "제목"));
    assert.deepEqual(store.list(OWNER), []);
    assert.ok(logs.some(message => message.includes("저장하지 않습니다")));
  });

  test("대화 파일은 들여쓰기 없이 쓴다", () => {
    const filePath = join(dir, "companion-conversations.json");
    const store = createConversationStore(filePath, { log: silent });
    store.create(OWNER, "제목");
    assert.ok(!readFileSync(filePath, "utf8").includes("\n"));
  });

  test("깨진 사용량 파일은 원본을 남기고, 읽지 못한 사용량 파일은 덮어쓰지 않는다", () => {
    const broken = join(dir, "usage.json");
    writeFileSync(broken, "{ 깨진", "utf8");
    const store = createUsageStore(broken, { log: silent });
    store.load();
    const backups = readdirSync(dir).filter(name => name.startsWith("usage.unreadable-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), "{ 깨진");

    const locked = join(dir, "locked.json");
    mkdirSync(locked);
    const second = createUsageStore(locked, { log: silent });
    second.load();
    second.record({ feature: "reply", mode: "broadcast", model: "gpt-4o-mini", ok: true });
    assert.deepEqual(readdirSync(locked), []);
  });
});

describe("1:1 기록 전체 삭제 실패(D-3)", () => {
  function boot(options: { memoryRename?: (from: string, to: string) => void; storeRename?: (from: string, to: string) => void } = {}) {
    const h = createFakeEngineHarness();
    const memoryStore: MemoryStore = createMemoryStore(join(dir, "memories.json"), { log: silent, warn: silent, ...(options.memoryRename ? { rename: options.memoryRename } : {}) });
    const store = createConversationStore(join(dir, "companion-conversations.json"), { log: silent, ...(options.storeRename ? { rename: options.storeRename } : {}) });
    store.load();
    const service = createCompanionService({
      engine: createConversationEngine(h.deps),
      store,
      memoryStore,
      memorySettings: () => testMemorySettings,
      embedding: () => null,
      prepareAudio: async () => undefined,
    });
    return { memoryStore, store, service };
  }

  async function seed(memoryStore: MemoryStore) {
    await memoryStore.add([
      { text: "상대는 재즈를 좋아한다.", kind: "viewer", scope: "private", ownerId: OWNER, importance: 0.5, confidence: 0.5 },
      { text: "지난 방송에서 리듬 게임 이야기를 했다.", kind: "broadcast", scope: "broadcast", importance: 0.5, confidence: 0.5 },
    ], testMemorySettings, null);
  }

  test("기억 파일에 쓰지 못하면 아무것도 지우지 않은 채 실패한다", async () => {
    let failMemory = false;
    const { memoryStore, store, service } = boot({ memoryRename: (from, to) => (failMemory ? eperm() : renameSync(from, to)) });
    await seed(memoryStore);
    store.create(OWNER, "제목");

    failMemory = true;
    await assert.rejects(service.clearAll(OWNER));
    assert.equal(store.list(OWNER).length, 1, "대화는 남는다");
    assert.equal(memoryStore.all().filter(record => record.ownerId === OWNER).length, 1, "기억은 되돌렸다");
    assert.equal(service.listMemories(OWNER).length, 1, "화면에도 지워진 것으로 보이지 않는다");

    // 재시작해도 같다. 지웠다고 보였다가 되살아나는 일이 없다.
    const reopened = createMemoryStore(join(dir, "memories.json"), { log: silent, warn: silent });
    reopened.load();
    assert.equal(reopened.all().filter(record => record.ownerId === OWNER).length, 1);
  });

  test("대화 파일에 쓰지 못하면 일부 삭제로 알린다", async () => {
    let failStore = false;
    const { memoryStore, store, service } = boot({ storeRename: (from, to) => (failStore ? eperm() : renameSync(from, to)) });
    await seed(memoryStore);
    store.create(OWNER, "제목");

    failStore = true;
    const error = await service.clearAll(OWNER).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof PartialDeletionError);
    assert.deepEqual(error.failed, ["conversations"]);
    assert.equal(error.deleted.memories, 1);
  });

  test("개별 기억 삭제도 쓰지 못하면 예외를 넘기고 기억이 남는다", async () => {
    let failMemory = false;
    const { memoryStore, service } = boot({ memoryRename: (from, to) => (failMemory ? eperm() : renameSync(from, to)) });
    await seed(memoryStore);
    const [mine] = service.listMemories(OWNER);
    failMemory = true;
    await assert.rejects(service.deleteMemory(OWNER, mine.id));
    assert.equal(service.listMemories(OWNER).length, 1);
  });

  test("성공하면 읽지 못한 대화 파일 백업과 이전 실행의 임시 파일도 지운다(M-10, M-19)", async () => {
    writeFileSync(join(dir, "companion-conversations.json"), "{ 깨진 1:1 원문", "utf8");
    writeFileSync(join(dir, OTHER_PID_TEMP), "{}", "utf8");
    const { service } = boot();
    assert.equal(readdirSync(dir).filter(name => name.includes(".unreadable-")).length, 1);

    await service.clearAll(OWNER);
    assert.deepEqual(readdirSync(dir).filter(name => name.includes(".unreadable-") || name.endsWith(".tmp")), []);
  });
});

describe("남은 임시 파일 정리(L8)", () => {
  const NOW = Date.parse("2026-10-12T00:00:00.000Z");
  function file(name: string, ageMs: number) {
    const path = join(dir, name);
    writeFileSync(path, "{}", "utf8");
    const at = new Date(NOW - ageMs);
    utimesSync(path, at, at);
    return path;
  }

  test("한 시간 지난 다른 프로세스의 임시 파일만 지운다", () => {
    const old = file(OTHER_PID_TEMP, 2 * 3_600_000);
    const fresh = file("memories.json.99999998.0b0f6d3e-0000-4000-8000-000000000001.tmp", 60_000);
    const own = file(`usage.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000002.tmp`, 2 * 3_600_000);
    const unrelated = file("notes.tmp", 2 * 3_600_000);

    assert.deepEqual(purgeExpiredBackups(dir, { now: NOW }), [OTHER_PID_TEMP]);
    assert.equal(existsSync(old), false);
    assert.ok(existsSync(fresh) && existsSync(own) && existsSync(unrelated));
  });

  test("임시 파일 이름 형식", () => {
    assert.equal(isLeftoverTempFile(OTHER_PID_TEMP), true);
    assert.equal(isLeftoverTempFile(`memories.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000000.tmp`), false);
    assert.equal(isLeftoverTempFile("usage.json.1234.abcd.tmp"), false);
    assert.equal(isLeftoverTempFile("memories.json"), false);
  });
});
