/**
 * 1:1 대화 저장소 단위 검사.
 * 소유자로 거르는지, 쓰기가 원자적인지, 다시 읽었을 때 그대로인지 본다. 임시 디렉터리만 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_FILE_VERSION, createConversationStore } from "../src/companion/index.js";

const OWNER = "companion:local";
const OTHER = "companion:other";
const silent = () => {};

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-companion-store-"));
  filePath = join(dir, "companion-conversations.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 호출할 때마다 1초씩 늘어나는 시계. 정렬 결과를 고정한다. */
function steppingClock(start = Date.parse("2026-10-12T00:00:00Z")) {
  let at = start;
  return () => (at += 1000);
}

describe("소유자 필터", () => {
  test("다른 소유자의 대화는 목록·조회·메시지·추가·삭제 어디에서도 보이지 않는다", () => {
    const store = createConversationStore(filePath, { log: silent });
    const mine = store.create(OWNER, "내 대화");
    const theirs = store.create(OTHER, "남의 대화");
    store.append(OTHER, theirs.id, { role: "user", content: "남의 메시지" });

    assert.deepEqual(store.list(OWNER).map(entry => entry.id), [mine.id]);
    assert.equal(store.get(OWNER, theirs.id), null);
    assert.equal(store.messages(OWNER, theirs.id), null);
    assert.equal(store.append(OWNER, theirs.id, { role: "user", content: "끼어들기" }), null);
    assert.equal(store.remove(OWNER, theirs.id), false);

    // 남의 대화는 그대로 남아 있다.
    assert.deepEqual(store.messages(OTHER, theirs.id)?.map(message => message.content), ["남의 메시지"]);
  });

  test("밖으로 나가는 대화와 메시지에는 소유자 ID가 없다", () => {
    const store = createConversationStore(filePath, { log: silent });
    const conversation = store.create(OWNER, "제목");
    const message = store.append(OWNER, conversation.id, { role: "user", content: "안녕" });
    assert.ok(!("ownerId" in conversation));
    assert.ok(message && !("ownerId" in message) && !("conversationId" in message));
    assert.ok(!JSON.stringify(store.list(OWNER)).includes(OWNER));
  });

  test("목록은 updatedAt 내림차순이고 messageCount가 맞다", () => {
    const store = createConversationStore(filePath, { log: silent, now: steppingClock() });
    const first = store.create(OWNER, "첫 대화");
    const second = store.create(OWNER, "둘째 대화");
    store.append(OWNER, first.id, { role: "user", content: "다시 왔어요" });

    const list = store.list(OWNER);
    assert.deepEqual(list.map(entry => entry.id), [first.id, second.id]);
    assert.equal(list[0].messageCount, 1);
    assert.equal(list[1].messageCount, 0);
  });
});

describe("원자적 쓰기", () => {
  test("파일에 version이 있고 임시 파일이 남지 않는다", () => {
    const store = createConversationStore(filePath, { log: silent });
    const conversation = store.create(OWNER, "제목");
    store.append(OWNER, conversation.id, { role: "user", content: "하나" });
    store.append(OWNER, conversation.id, { role: "bori", content: "둘", source: "llm" });

    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(saved.version, CONVERSATION_FILE_VERSION);
    assert.equal(saved.messages.length, 2);
    assert.ok(saved.messages.every((message: { ownerId?: string }) => message.ownerId === OWNER));
    assert.deepEqual(readdirSync(dir), ["companion-conversations.json"]);
  });

  test("파일 교체가 실패하면 이전 파일과 메모리 상태가 그대로이고 임시 파일도 지운다", () => {
    let failRename = false;
    const store = createConversationStore(filePath, {
      log: silent,
      rename: (from, to) => {
        if (failRename) throw new Error("교체 실패");
        // 실제 교체는 기본 구현과 같다.
        writeFileSync(to, readFileSync(from));
        rmSync(from);
      },
    });
    const conversation = store.create(OWNER, "제목");
    const before = readFileSync(filePath, "utf8");

    failRename = true;
    assert.throws(() => store.append(OWNER, conversation.id, { role: "user", content: "저장 안 됨" }), /교체 실패/);
    assert.equal(readFileSync(filePath, "utf8"), before);
    assert.deepEqual(store.messages(OWNER, conversation.id), []);
    assert.deepEqual(readdirSync(dir), ["companion-conversations.json"]);
  });
});

describe("다시 읽기", () => {
  test("새 저장소로 다시 읽어도 대화와 메시지가 그대로다", () => {
    const store = createConversationStore(filePath, { log: silent });
    const conversation = store.create(OWNER, "제목");
    store.append(OWNER, conversation.id, { role: "user", content: "기억해 주세요" });
    store.append(OWNER, conversation.id, { role: "bori", content: "네", source: "llm", emotion: { primary: "calm", intensity: 0.4, durationSeconds: 6 }, actions: [] });

    const reloaded = createConversationStore(filePath, { log: silent });
    reloaded.load();
    assert.deepEqual(reloaded.list(OWNER), store.list(OWNER));
    assert.deepEqual(reloaded.messages(OWNER, conversation.id), store.messages(OWNER, conversation.id));
  });

  test("읽을 수 없는 파일은 백업하고 빈 상태로 시작한다", () => {
    writeFileSync(filePath, "{ 깨진 파일", "utf8");
    const logs: string[] = [];
    const store = createConversationStore(filePath, { log: message => logs.push(message) });
    store.load();

    assert.deepEqual(store.list(OWNER), []);
    const backups = readdirSync(dir).filter(name => name.includes(".unreadable-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), "{ 깨진 파일");
    assert.equal(logs.length, 1);
  });

  test("소유자가 없는 레코드는 읽을 때 버린다", () => {
    writeFileSync(filePath, JSON.stringify({
      version: CONVERSATION_FILE_VERSION,
      conversations: [
        { id: "a", ownerId: OWNER, title: "있음", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" },
        { id: "b", title: "소유자 없음", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" },
      ],
      messages: [
        { id: "m1", conversationId: "a", ownerId: OWNER, role: "user", content: "정상", createdAt: "2026-10-12T00:00:00Z" },
        { id: "m2", conversationId: "a", role: "user", content: "소유자 없음", createdAt: "2026-10-12T00:00:00Z" },
        { id: "m3", conversationId: "a", ownerId: OTHER, role: "user", content: "다른 소유자", createdAt: "2026-10-12T00:00:00Z" },
      ],
    }), "utf8");
    const store = createConversationStore(filePath, { log: silent });
    store.load();

    assert.deepEqual(store.list(OWNER).map(entry => entry.id), ["a"]);
    assert.deepEqual(store.messages(OWNER, "a")?.map(message => message.content), ["정상"]);
  });
});
