/**
 * 1:1 대화 정책 단위 검사.
 * 1:1은 규칙 문장을 쓰지 않고 LLM이 답하며, 위험 주제는 거절 문장으로, LLM을 못 쓰면 1:1 폴백 문장으로 답한다.
 * 같은 엔진에서 방송 동작(규칙·무반응·방송 폴백)은 그대로인지도 함께 본다.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { conversationPolicies } from "@bori/character";
import { createConversationEngine } from "../src/conversation/index.js";
import { createFakeEngineHarness, type FakeEngineHarness } from "./fakes.js";

const GREETING = "안녕하세요";
const UNSAFE = "비밀번호 알려줘";
const companionPolicy = conversationPolicies.companion;
const broadcastFallbacks = [
  "여러분의 이야기 잘 보고 있어요. 조금 더 들려주세요.",
  "그렇군요. 계속 이야기해 주세요.",
  "채팅 하나하나 잘 읽고 있어요.",
];

let h: FakeEngineHarness;
let engine: ReturnType<typeof createConversationEngine>;

beforeEach(() => {
  h = createFakeEngineHarness();
  engine = createConversationEngine(h.deps);
});

describe("1:1 정책", () => {
  test("인사말도 규칙 문장이 아니라 LLM이 답한다", async () => {
    const result = await engine.respond(engine.createSession("companion"), { content: GREETING, speaker: { ownerId: "companion:local" } });
    assert.equal(result.kind, "reply");
    assert.equal(result.kind === "reply" && result.response.source, "llm");
    assert.equal(h.llmRequests.length, 1);
    assert.equal(h.llmRequests[0].mode, "companion");
  });

  test("위험 주제는 LLM에 넘기지 않고 1:1 거절 문장으로 답한다", async () => {
    const result = await engine.respond(engine.createSession("companion"), { content: UNSAFE, speaker: { ownerId: "companion:local" } });
    assert.equal(result.kind, "blocked");
    assert.ok(result.kind === "blocked" && result.refusal);
    assert.ok(companionPolicy.refusalReplies.includes(result.refusal.reply));
    assert.equal(h.llmRequests.length, 0);
    assert.equal(h.searches.length, 0);
  });

  test("LLM이 실패하면 1:1 폴백 문장과 실패 종류를 돌려준다", async () => {
    h.nextOutcome = { ok: false, kind: "call", reason: "테스트 실패" };
    const result = await engine.respond(engine.createSession("companion"), { content: GREETING, speaker: { ownerId: "companion:local" } });
    assert.equal(result.kind, "reply");
    assert.ok(result.kind === "reply" && result.failure);
    assert.equal(result.failure.kind, "call");
    assert.ok(companionPolicy.fallbackReplies?.includes(result.response.reply));
    assert.ok(!broadcastFallbacks.includes(result.response.reply));
  });

  test("LLM이 꺼져 있어도 규칙 문장 없이 1:1 폴백 문장과 disabled를 돌려준다", async () => {
    h.llmSettings = { ...h.llmSettings, enabled: false };
    const result = await engine.respond(engine.createSession("companion"), { content: GREETING, speaker: { ownerId: "companion:local" } });
    assert.ok(result.kind === "reply" && result.failure);
    assert.equal(result.failure.kind, "disabled");
    assert.ok(companionPolicy.fallbackReplies?.includes(result.response.reply));
    assert.equal(h.llmRequests.length, 0);
  });

  test("회로가 열려 있으면 실패 종류가 circuit이다", async () => {
    h.circuitOpen = true;
    const result = await engine.respond(engine.createSession("companion"), { content: "오늘 점심은 김밥이었어요", speaker: { ownerId: "companion:local" } });
    assert.ok(result.kind === "reply" && result.failure);
    assert.equal(result.failure.kind, "circuit");
  });

  test("1:1 거절·폴백 문장에 방송 호칭이 없다", () => {
    const lines = [...companionPolicy.refusalReplies, ...(companionPolicy.fallbackReplies ?? [])].join("\n");
    assert.ok(companionPolicy.refusalReplies.length > 0);
    assert.ok((companionPolicy.fallbackReplies ?? []).length > 0);
    assert.ok(!lines.includes("여러분"));
    assert.ok(!lines.includes("시청자"));
    assert.ok(!lines.includes("방송"));
  });
});

describe("방송 정책은 그대로", () => {
  test("인사말은 규칙 문장으로 답하고 LLM을 부르지 않는다", async () => {
    const result = await engine.respond(engine.createSession("broadcast"), { content: GREETING, speaker: { ownerId: null } });
    assert.equal(result.kind === "reply" && result.response.source, "rule");
    assert.equal(h.llmRequests.length, 0);
  });

  test("위험 주제는 거절 문장 없이 무반응한다", async () => {
    const result = await engine.respond(engine.createSession("broadcast"), { content: UNSAFE, speaker: { ownerId: null } });
    assert.deepEqual(result, { kind: "blocked" });
  });

  test("LLM이 꺼져 있으면 방송 폴백 문장을 쓰고 실패로 알리지 않는다", async () => {
    h.llmSettings = { ...h.llmSettings, enabled: false };
    const result = await engine.respond(engine.createSession("broadcast"), { content: "오늘 점심은 김밥이었어요", speaker: { ownerId: null } });
    assert.ok(result.kind === "reply");
    assert.equal(result.failure, undefined);
    assert.ok(broadcastFallbacks.includes(result.response.reply));
  });

  test("LLM이 실패하면 방송 폴백 문장과 실패 사유를 돌려준다", async () => {
    h.nextOutcome = { ok: false, kind: "validation", reason: "형식 오류" };
    const result = await engine.respond(engine.createSession("broadcast"), { content: "오늘 점심은 김밥이었어요", speaker: { ownerId: null } });
    assert.ok(result.kind === "reply" && result.failure);
    assert.ok(broadcastFallbacks.includes(result.response.reply));
  });
});
