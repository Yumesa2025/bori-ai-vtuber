/**
 * 방송 운영 단위 검사(점검 L-2, O-3).
 * 누적 요약이 실패할 때 매 턴 다시 부르지 않고 물러나는지, 게임·음악 낱말 규칙이 LLM에 양보하는지 본다.
 * 큐·세션·음성처럼 서버 상태가 얽힌 것은 통합 검사(tools/test/operations.mjs)가 본다. 네트워크를 쓰지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LlmAdapter } from "@bori/llm";
import { createConversationEngine, ROLLING_SUMMARY_MAX_FAILURES } from "../src/conversation/engine.js";
import { evaluateRules } from "../src/conversation/rules.js";
import { createFakeEngineHarness } from "./fakes.js";

/** 마이크로태스크와 타이머 한 바퀴를 넘긴다. 가짜 요약 호출의 then·finally가 돌게 한다. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** 요약 요청을 세는 가짜 어댑터. results를 앞에서부터 쓰고, 다 쓰면 실패한다. */
function summaryAdapter(results: (string | Error)[]) {
  const calls: number[] = [];
  const adapter: LlmAdapter = {
    name: "fake",
    isConfigured: () => true,
    complete: async request => {
      calls.push((request.overrideUserPrompt ?? "").length);
      const next = results.shift() ?? new Error("요약 실패");
      if (next instanceof Error) throw next;
      return { raw: next, latencyMs: 1 };
    },
  };
  return { adapter, calls };
}

function summaryEngine(results: (string | Error)[]) {
  const harness = createFakeEngineHarness();
  harness.llmSettings.rollingSummaryEnabled = true;
  harness.llmSettings.rollingSummaryTurns = 10;
  const fake = summaryAdapter(results);
  const engine = createConversationEngine({ ...harness.deps, createAdapter: () => fake.adapter });
  return { engine, session: engine.createSession("broadcast"), calls: fake.calls };
}

async function recordTurns(engine: ReturnType<typeof createConversationEngine>, session: ReturnType<ReturnType<typeof createConversationEngine>["createSession"]>, count: number) {
  for (let i = 0; i < count; i += 1) {
    engine.record(session, { role: i % 2 === 0 ? "viewer" : "bori", text: `${i}번 오늘 저녁 메뉴 이야기`, viewerId: "local:a" });
    await settle();
  }
}

describe("누적 요약 실패 백오프(L-2, a3 F5)", () => {
  test("계속 실패하면 300발언에 4번만 부르고, 최대 횟수에서 멈춘다(전에는 300발언에 296회)", async () => {
    const { engine, session, calls } = summaryEngine([]);
    await recordTurns(engine, session, 300);
    assert.equal(calls.length, 4);
    await recordTurns(engine, session, 700);
    assert.equal(calls.length, ROLLING_SUMMARY_MAX_FAILURES);
  });

  test("실패 뒤 다음 시도는 2배씩 늦어진다", async () => {
    const { engine, session, calls } = summaryEngine([]);
    // 10번째 발언에서 첫 시도, 실패 1번이면 10 + 10×2 = 30번째, 2번이면 30 + 10×4 = 70번째에 다시 부른다.
    await recordTurns(engine, session, 29);
    assert.equal(calls.length, 1);
    await recordTurns(engine, session, 1);
    assert.equal(calls.length, 2);
    await recordTurns(engine, session, 39);
    assert.equal(calls.length, 2);
    await recordTurns(engine, session, 1);
    assert.equal(calls.length, 3);
  });

  test("실패 뒤 성공하면 평소 주기로 돌아오고 쌓인 대화는 상한만큼만 보낸다", async () => {
    const { engine, session, calls } = summaryEngine([new Error("429"), JSON.stringify({ summary: "저녁 메뉴 이야기" })]);
    await recordTurns(engine, session, 30);
    assert.equal(calls.length, 2);
    assert.equal(session.summary, "저녁 메뉴 이야기");
    assert.equal(session.summarizedTurnCount, 30);
    // 성공 뒤에는 rollingSummaryTurns(10)발언마다 다시 부른다.
    await recordTurns(engine, session, 10);
    assert.equal(calls.length, 3);
  });

  test("요약 응답 형식이 틀린 것(null)도 실패로 센다", async () => {
    const { engine, session, calls } = summaryEngine(Array.from({ length: 10 }, () => "{\"oops\":1}"));
    await recordTurns(engine, session, 400);
    assert.equal(calls.length, ROLLING_SUMMARY_MAX_FAILURES);
  });

  test("실패 기록은 세션마다 따로다. 새 방송 세션은 처음부터 다시 시도한다", async () => {
    const { engine, session, calls } = summaryEngine([]);
    await recordTurns(engine, session, 400);
    const next = engine.createSession("broadcast");
    await recordTurns(engine, next, 10);
    assert.equal(calls.length, ROLLING_SUMMARY_MAX_FAILURES + 1);
  });
});

describe("주제 낱말 규칙(O-3, a4 A4-14)", () => {
  const pick = (values: readonly string[]) => values[0];

  test("LLM을 쓸 수 있으면 게임·음악 이야기는 LLM이 답한다", () => {
    for (const content of ["나 요즘 리듬 게임에 완전 빠졌어", "요즘 리듬게임에 푹 빠져 살아", "아이유 노래 자주 들어요"]) {
      assert.equal(evaluateRules(content, true, pick).kind, "unmatched", content);
    }
  });

  test("LLM을 못 쓰면 전처럼 규칙 문장으로 답한다", () => {
    const game = evaluateRules("나 요즘 리듬 게임에 완전 빠졌어", false, pick);
    assert.equal(game.kind, "matched");
    if (game.kind === "matched") assert.deepEqual(game.response.actions, [{ name: "shoushi", priority: 2, layer: "body" }]);
    assert.equal(evaluateRules("노래 추천해 주세요", false, pick).kind, "matched");
  });

  test("인사·칭찬·힘듦 규칙은 그대로 규칙이 먼저다", () => {
    for (const content of ["안녕하세요", "보리 너무 귀엽다", "오늘 너무 힘들어"]) {
      assert.equal(evaluateRules(content, true, pick).kind, "matched", content);
    }
  });
});
