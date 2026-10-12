/**
 * 1:1 대화 화면의 화면 밖 규칙 단위 검사.
 * 오류 응답을 어떤 안내로 바꾸는지, LLM이 준 감정·모션 이름을 allowlist로 거르는지,
 * 개발용 가짜 API가 계약대로 답하는지 본다. 브라우저와 네트워크를 쓰지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, errorKindForStatus, readResponse } from "../src/api";
import { planReaction } from "../src/live2d/reaction";
import { createMockStore } from "../dev/mock-store";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function kindOf(response: Response) {
  try { await readResponse(response); } catch (error) { return error instanceof ApiError ? error.kind : "unknown"; }
  return "ok";
}

describe("오류 응답 분류", () => {
  test("상태 코드별 종류", () => {
    assert.equal(errorKindForStatus(400), "badRequest");
    assert.equal(errorKindForStatus(404), "notFound");
    assert.equal(errorKindForStatus(409), "conflict");
    assert.equal(errorKindForStatus(500), "server");
    assert.equal(errorKindForStatus(503), "server");
  });

  test("서버가 준 { error } 5xx는 서버 오류, JSON이 아닌 5xx는 연결 끊김", async () => {
    assert.equal(await kindOf(json(500, { error: "내부 오류" })), "server");
    assert.equal(await kindOf(new Response("proxy error", { status: 502 })), "disconnected");
    assert.equal(await kindOf(new Response("", { status: 500 })), "disconnected");
  });

  test("4xx는 본문이 없어도 상태 코드로 분류하고 서버 원문을 보관한다", async () => {
    assert.equal(await kindOf(new Response("", { status: 409 })), "conflict");
    await assert.rejects(readResponse(json(400, { error: "빈 메시지" })), (error: unknown) => error instanceof ApiError && error.serverMessage === "빈 메시지");
  });

  test("성공 응답은 본문을 그대로 돌려주고, JSON이 아니면 서버 오류로 본다", async () => {
    assert.deepEqual(await readResponse(json(200, { deleted: true })), { deleted: true });
    assert.equal(await kindOf(new Response("<html>", { status: 200 })), "server");
  });
});

describe("표정·모션 계획", () => {
  test("allowlist 안의 body 모션은 짝 표정과 함께 실행한다", () => {
    const plan = planReaction({ primary: "gaming", intensity: 0.7, durationSeconds: 4 }, [{ name: "shoushi", layer: "body", priority: 2 }]);
    assert.deepEqual(plan.motion, { group: "shoushi", priority: 2 });
    assert.equal(plan.expression, "shoushi");
    assert.equal(plan.holdMs, 4000);
  });

  test("allowlist 밖 이름은 버리고, 모르는 감정은 표정을 켜지 않는다", () => {
    const plan = planReaction({ primary: "ecstatic", intensity: 2, durationSeconds: 999 }, [
      { name: "backflip", layer: "body", priority: 99 },
      { name: "../../etc", layer: "body", priority: 3 },
    ]);
    assert.equal(plan.motion, null);
    assert.equal(plan.expression, null);
    // 지속 시간도 LLM 값이라 상한으로 자른다.
    assert.equal(plan.holdMs, 15000);
  });

  test("모션 우선순위는 SDK 범위(1~3)로 맞춘다", () => {
    assert.equal(planReaction({ primary: "calm", intensity: 0, durationSeconds: 1 }, [{ name: "kuqi", layer: "body", priority: 99 }]).motion?.priority, 3);
    assert.equal(planReaction({ primary: "calm", intensity: 0, durationSeconds: 1 }, [{ name: "kuqi", layer: "body", priority: -5 }]).motion?.priority, 1);
  });

  test("감정·actions가 없으면 기본 얼굴을 유지한다", () => {
    const plan = planReaction(undefined, undefined);
    assert.equal(plan.motion, null);
    assert.equal(plan.expression, null);
    assert.equal(plan.holdMs, 4000);
  });

  test("actions가 없으면 감정 매핑의 모션을 쓴다", () => {
    const plan = planReaction({ primary: "happy", intensity: 0.5, durationSeconds: 3 }, []);
    assert.equal(plan.motion?.group, "xingxingyan");
    assert.equal(plan.expression, "xingxingyan");
  });
});

describe("개발용 가짜 API 계약", () => {
  test("대화 생성 → 메시지 → 목록 갱신 → 삭제", () => {
    const store = createMockStore();
    const created = store.createConversation({ title: "첫 대화" });
    assert.equal(created.status, 201);
    const { conversation } = created.body as { conversation: { id: string } };

    const pending = store.sendMessage(conversation.id, { content: "안녕", tts: true });
    assert.ok(pending.finish);
    const sent = pending.finish!();
    const body = sent.body as { userMessage: { role: string }; reply: { role: string; source: string }; audioId?: string };
    assert.equal(body.userMessage.role, "user");
    assert.equal(body.reply.role, "bori");
    assert.equal(body.reply.source, "llm");
    assert.ok(body.audioId);

    const list = store.listConversations().body as { conversations: { id: string; messageCount: number }[] };
    assert.equal(list.conversations[0].messageCount, 2);
    assert.equal((store.getMessages(conversation.id).body as { messages: unknown[] }).messages.length, 2);

    assert.equal(store.deleteConversation(conversation.id).status, 200);
    assert.equal(store.getMessages(conversation.id).status, 404);
  });

  test("빈 내용·500자 초과 400, 없는 대화 404, 답변 생성 중 409", () => {
    const store = createMockStore();
    const { conversation } = store.createConversation({}).body as { conversation: { id: string } };
    assert.equal(store.sendMessage(conversation.id, { content: "   " }).status, 400);
    assert.equal(store.sendMessage(conversation.id, { content: "가".repeat(501) }).status, 400);
    assert.equal(store.sendMessage("missing", { content: "안녕" }).status, 404);

    const first = store.sendMessage(conversation.id, { content: "안녕" });
    assert.equal(store.sendMessage(conversation.id, { content: "또 안녕" }).status, 409);
    first.finish!();
    assert.ok(store.sendMessage(conversation.id, { content: "이제 돼요" }).finish);
  });

  test("LLM 실패 흉내는 폴백 답변과 failure를 함께 준다", () => {
    const store = createMockStore();
    const { conversation } = store.createConversation({}).body as { conversation: { id: string } };
    const body = store.sendMessage(conversation.id, { content: "#fail" }).finish!().body as { reply: { source: string }; failure?: { kind: string } };
    assert.equal(body.reply.source, "fallback");
    assert.deepEqual(body.failure, { kind: "llm_error" });
  });

  test("기억 개별 삭제는 없는 id면 404, 전체 삭제는 지운 개수를 준다", () => {
    const store = createMockStore();
    const { memories } = store.listMemories().body as { memories: { id: string }[] };
    assert.equal(store.deleteMemory(memories[0].id).status, 200);
    assert.equal(store.deleteMemory(memories[0].id).status, 404);
    assert.deepEqual(store.deleteAllMemories().body, { deleted: memories.length - 1 });
    assert.equal((store.listMemories().body as { memories: unknown[] }).memories.length, 0);
  });
});
