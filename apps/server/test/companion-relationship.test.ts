/**
 * 1:1 관계 맥락 문장 단위 검사.
 * 문구는 평가 워커와 함께 쓰는 계약이라 문자열을 그대로 비교한다.
 * 시각은 로컬 날짜로 만들어 실행 환경의 시간대와 상관없이 같은 결과가 나오게 한다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore, PREVIOUS_SUMMARY_COUNT, relationshipStatusLines, type ConversationActivity } from "../src/companion/index.js";

/** 2026년 10월 day일 hour:minute(로컬). */
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(12, 15);

const record = (id: string, first: number | null, last: number | null = first, summary = ""): ConversationActivity =>
  ({ id, firstMessageAt: first, lastMessageAt: last, summary });

describe("관계 맥락 문장", () => {
  test("처음 대화하는 사람: 첫 메시지면 오늘 처음 대화한다는 문장 하나다", () => {
    assert.deepEqual(relationshipStatusLines({ conversations: [record("now", null)], currentId: "now", now: NOW }), ["이 사람과는 오늘 처음 대화한다."]);
  });

  test("첫 대화를 오늘 이어가는 중이면 처음이라는 문장 대신 인사를 이미 나눴다는 문장을 넣는다", () => {
    // 둘째 메시지부터 "오늘 처음 대화한다"가 들어가면 매 턴 인사를 되풀이한다(점검 C-5).
    assert.deepEqual(
      relationshipStatusLines({ conversations: [record("now", at(12, 9), at(12, 14, 50))], currentId: "now", now: NOW }),
      ["이 사람과는 첫 대화를 이어 가는 중이다. 인사는 이미 나눴다."],
    );
  });

  test("같은 날 다른 대화로 다시 오면 2번째 대화이고 첫날이 오늘이며, 새 방문이라 간격 줄이 붙는다", () => {
    const lines = relationshipStatusLines({ conversations: [record("a", at(12, 9), at(12, 14, 50)), record("now", null)], currentId: "now", now: NOW });
    assert.deepEqual(lines, ["이 사람과는 2번째 대화다. 처음 대화한 날이 오늘이다.", "마지막 대화는 오늘 앞서 있었다."]);
  });

  test("N일 뒤 다시 오면 처음 대화부터의 일 수와 마지막 대화 간격을 날짜 기준으로 센다", () => {
    const lines = relationshipStatusLines({
      conversations: [record("a", at(1, 20), at(1, 21)), record("b", at(9, 23, 50), at(9, 23, 55)), record("now", null)],
      currentId: "now",
      now: at(12, 0, 10),
    });
    // 9일 23시 55분과 12일 0시 10분은 24시간 남짓이지만 날짜로는 3일 차이다.
    assert.deepEqual(lines, ["이 사람과는 3번째 대화다. 처음 대화한 지 11일 지났다.", "마지막 대화는 3일 전이었다."]);
  });

  test("만들기만 하고 메시지가 없는 대화는 세지 않는다", () => {
    const lines = relationshipStatusLines({ conversations: [record("a", at(12, 9)), record("empty", null), record("now", null)], currentId: "now", now: NOW });
    assert.equal(lines[0], "이 사람과는 2번째 대화다. 처음 대화한 날이 오늘이다.");
  });

  test("다른 대화 없이 같은 대화를 며칠 뒤 이어가면 1번째 대화 형식과 간격 줄을 넣는다", () => {
    const lines = relationshipStatusLines({ conversations: [record("now", at(9, 10), at(9, 11))], currentId: "now", now: NOW });
    assert.deepEqual(lines, ["이 사람과는 1번째 대화다. 처음 대화한 지 3일 지났다.", "마지막 대화는 3일 전이었다."]);
  });

  test("같은 대화에서 직전 메시지와 30분 미만이면 이어지는 중이라 간격 줄이 없다", () => {
    const lines = relationshipStatusLines({ conversations: [record("a", at(10, 9)), record("now", at(12, 14, 0), at(12, 14, 31))], currentId: "now", now: NOW });
    assert.deepEqual(lines, ["이 사람과는 2번째 대화다. 처음 대화한 지 2일 지났다."]);
  });

  test("같은 대화라도 직전 메시지와 30분 이상 떨어지면 새 방문으로 보고 간격 줄을 넣는다", () => {
    const lines = relationshipStatusLines({ conversations: [record("a", at(10, 9)), record("now", at(12, 14, 0), at(12, 14, 30))], currentId: "now", now: NOW });
    assert.deepEqual(lines, ["이 사람과는 2번째 대화다. 처음 대화한 지 2일 지났다.", "마지막 대화는 오늘 앞서 있었다."]);
  });

  test("간격은 다른 대화가 아니라 직전 메시지 기준이다", () => {
    // 다른 대화는 사흘 전이지만 지금 대화의 직전 메시지는 이틀 전이다.
    const lines = relationshipStatusLines({ conversations: [record("a", at(9, 9)), record("now", at(10, 8))], currentId: "now", now: NOW });
    assert.equal(lines[1], "마지막 대화는 2일 전이었다.");
  });
});

describe("지난 대화 요약", () => {
  test("현재 대화를 뺀 최근 대화들의 요약을 오래된 것부터, 언제 대화인지 붙여 넣는다", () => {
    const lines = relationshipStatusLines({
      conversations: [record("old", at(5), at(5), "오래된 요약"), record("recent", at(10), at(11), "최근 요약"), record("now", at(12, 9), at(12, 9), "지금 대화 요약")],
      currentId: "now",
      now: NOW,
    });
    assert.equal(lines.at(-1), "지난 대화 요약: (7일 전) 오래된 요약 / (1일 전) 최근 요약");
    assert.ok(!lines.some(line => line.includes("지금 대화 요약")), "현재 대화의 요약은 [지금까지의 대화]가 맡는다");
  });

  test("가장 최근 대화에 요약이 없어도 그 전 대화 요약은 남는다(점검 M-10)", () => {
    // 직전 대화가 짧아(누적 요약 전) 요약이 없으면 예전에는 지난 대화 요약이 통째로 사라졌다.
    const lines = relationshipStatusLines({ conversations: [record("old", at(5), at(5), "오래된 요약"), record("recent", at(10)), record("now", null)], currentId: "now", now: NOW });
    assert.equal(lines.at(-1), "지난 대화 요약: (7일 전) 오래된 요약");
  });

  test(`요약이 있는 대화는 최근 ${PREVIOUS_SUMMARY_COUNT}개까지만 넣는다`, () => {
    const conversations = [1, 2, 3, 4, 5].map(day => record(`d${day}`, at(day), at(day), `${day}일 요약`));
    const lines = relationshipStatusLines({ conversations: [...conversations, record("now", null)], currentId: "now", now: NOW });
    assert.equal(lines.at(-1), "지난 대화 요약: (9일 전) 3일 요약 / (8일 전) 4일 요약 / (7일 전) 5일 요약");
  });

  test("오늘 앞서 나눈 대화는 (오늘)로 적는다", () => {
    const lines = relationshipStatusLines({ conversations: [record("a", at(12, 9), at(12, 9), "아침 요약"), record("now", null)], currentId: "now", now: NOW });
    assert.equal(lines.at(-1), "지난 대화 요약: (오늘) 아침 요약");
  });

  test("요약이 있는 지난 대화가 없으면 넣지 않는다", () => {
    const lines = relationshipStatusLines({ conversations: [record("old", at(5)), record("recent", at(10)), record("now", null)], currentId: "now", now: NOW });
    assert.ok(!lines.some(line => line.startsWith("지난 대화 요약")), lines.join(" / "));
  });

  test("첫 대화에는 지난 대화 요약이 없다", () => {
    assert.deepEqual(relationshipStatusLines({ conversations: [record("now", null, null, "요약")], currentId: "now", now: NOW }), ["이 사람과는 오늘 처음 대화한다."]);
  });

  test("요약이 상한을 넘으면 자르고 말줄임표를 붙인다. 글자 수는 한글 기준으로 센다", () => {
    const long = "가".repeat(30);
    const lines = relationshipStatusLines({ conversations: [record("a", at(10), at(10), long), record("now", null)], currentId: "now", now: NOW, summaryMaxLength: 10 });
    assert.equal(lines.at(-1), `지난 대화 요약: (2일 전) ${"가".repeat(9)}…`);

    const exact = relationshipStatusLines({ conversations: [record("a", at(10), at(10), "가".repeat(10)), record("now", null)], currentId: "now", now: NOW, summaryMaxLength: 10 });
    assert.equal(exact.at(-1), `지난 대화 요약: (2일 전) ${"가".repeat(10)}`);
  });

  test("기본 상한은 요약 하나에 200자다", () => {
    const lines = relationshipStatusLines({ conversations: [record("a", at(10), at(10), "나".repeat(300)), record("now", null)], currentId: "now", now: NOW });
    assert.equal(Array.from(lines.at(-1)!.replace("지난 대화 요약: (2일 전) ", "")).length, 200);
  });
});

describe("저장소 기록에서 계산", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bori-relationship-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("다른 소유자의 대화는 활동 기록에 섞이지 않는다", () => {
    let clock = at(10);
    const store = createConversationStore(join(dir, "c.json"), { log: () => {}, now: () => clock });
    const theirs = store.create("companion:other", "남의 대화");
    store.append("companion:other", theirs.id, { role: "user", content: "남의 메시지" });
    store.setSummary("companion:other", theirs.id, "남의 요약");

    clock = at(12);
    const mine = store.create("companion:local", "내 대화");
    const lines = relationshipStatusLines({ conversations: store.activity("companion:local"), currentId: mine.id, now: NOW });
    assert.deepEqual(lines, ["이 사람과는 오늘 처음 대화한다."]);
    assert.deepEqual(store.activity("companion:local").map(entry => entry.id), [mine.id]);
  });
});
