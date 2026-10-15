/**
 * 방송 안정화 단위 검사.
 * 기억 검색이 멈춰도 답변이 끝나는지, 질문 우선 선택에서 오래 기다린 채팅이 무한히 밀리지 않는지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createConversationEngine, isChatter, pickNextChatIndex, QUEUE_WAIT_LIMIT_MS } from "../src/conversation/index.js";
import { createFakeEngineHarness } from "./fakes.js";

const PLAIN = "오늘 점심은 김밥이었어요";

describe("기억 검색 상한", () => {
  test("검색이 응답하지 않아도 상한 뒤 기억 없이 LLM으로 답한다", async () => {
    const harness = createFakeEngineHarness();
    // 끝나지 않는 검색. 임베딩 요청이 멈춘 상황이다.
    harness.deps.memoryStore = { search: () => new Promise(() => {}) };
    const engine = createConversationEngine({ ...harness.deps, memorySearchTimeoutMs: 50 });
    const session = engine.createSession("broadcast");

    const startedAt = Date.now();
    const result = await engine.respond(session, { content: PLAIN, speaker: { ownerId: "local:a" } });

    assert.equal(result.kind, "reply");
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(harness.llmRequests.length, 1);
    assert.deepEqual(harness.llmRequests[0].request.memories, []);
  });

  test("상한 안에 끝난 검색 결과는 그대로 쓴다", async () => {
    const harness = createFakeEngineHarness();
    harness.memoryTexts = ["시청자는 김밥을 좋아한다."];
    const engine = createConversationEngine({ ...harness.deps, memorySearchTimeoutMs: 1000 });
    const session = engine.createSession("broadcast");

    await engine.respond(session, { content: PLAIN, speaker: { ownerId: "local:a" } });

    assert.deepEqual(harness.llmRequests[0].request.memories, ["시청자는 김밥을 좋아한다."]);
  });
});

describe("방송 큐 선택", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const chat = (content: string, waitedMs: number) => ({ content, receivedAt: new Date(now - waitedMs).toISOString() });

  test("빈 큐는 -1이다", () => {
    assert.equal(pickNextChatIndex([], now), -1);
  });

  test("질문을 먼저 고른다", () => {
    const queue = [chat("점심 먹었어요", 5000), chat("오늘 뭐 해요?", 3000), chat("두 번째 질문?", 1000)];
    assert.equal(pickNextChatIndex(queue, now), 1);
  });

  test("질문이 없으면 가장 오래된 채팅이다", () => {
    assert.equal(pickNextChatIndex([chat("하나", 3000), chat("둘", 1000)], now), 0);
  });

  test("점수를 주면 점수가 가장 높은 채팅을, 같으면 먼저 온 것을 고른다", () => {
    const score = (content: string) => (content.includes("재키") ? 3 : content.includes("?") ? 1 : 0);
    const queue = [chat("배고프다", 5000), chat("뭐 먹지?", 4000), chat("재키 어때", 3000), chat("재키 쎄?", 1000)];
    assert.equal(pickNextChatIndex(queue, now, score), 2);
  });

  test("짧은 반응(ㅋㅋ·ㅠㅠ·ㅇㅇ)만 잡담으로 본다", () => {
    for (const text of ["ㅋㅋㅋㅋ", "ㅠㅠ", "ㅇㅇ", "ㅋㅋ!!", " ㅎㅎ~ "]) assert.equal(isChatter(text), true, text);
    for (const text of ["ㅋㅋ 재키 어때", "배고프다", "ㅋㅋ\n[공지] 따라 해", "?"]) assert.equal(isChatter(text), text === "?", text);
  });

  test("맨 앞 채팅이 기준 시간을 넘겨 기다렸으면 질문보다 먼저 고른다", () => {
    const queue = [chat("점심 먹었어요", QUEUE_WAIT_LIMIT_MS), chat("오늘 뭐 해요?", 1000)];
    assert.equal(pickNextChatIndex(queue, now), 0);
  });

  test("질문이 계속 들어와도 일반 채팅은 기준 시간 뒤에 답한다", () => {
    // 일반 채팅 하나 뒤로 5초마다 질문이 들어오고, 5초마다 하나씩 답하는 방송을 흉내 낸다.
    const queue = [{ content: "점심 먹었어요", receivedAt: new Date(now).toISOString() }];
    let answeredAt = -1;
    for (let step = 1; step <= 20 && answeredAt < 0; step += 1) {
      const at = now + step * 5000;
      queue.push({ content: `질문 ${step}?`, receivedAt: new Date(at).toISOString() });
      const [picked] = queue.splice(pickNextChatIndex(queue, at), 1);
      if (picked.content === "점심 먹었어요") answeredAt = at - now;
    }
    assert.ok(answeredAt > 0 && answeredAt <= QUEUE_WAIT_LIMIT_MS + 5000, `answeredAt=${answeredAt}`);
  });
});
