/**
 * 누적 요약·개인 기억 정리 단위 검사.
 * 가짜 어댑터로 받은 요청을 보고, 방송 지시문이 바뀌지 않았는지와 1:1 분기를 확인한다. 네트워크를 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { digestPrivateMemories, PRIVATE_MEMORY_DIGEST_LIMIT, summarizeSessionProgress } from "../src/summarize.js";
import type { LlmAdapter, LlmRequest } from "../src/types.js";

function fakeAdapter(raw: string) {
  const requests: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    name: "fake",
    isConfigured: () => true,
    complete: async request => {
      requests.push(request);
      return { raw, latencyMs: 1 };
    },
  };
  return { adapter, requests };
}

const turns = [
  { role: "viewer" as const, text: "오늘 시험 끝났어요" },
  { role: "bori" as const, text: "고생 많으셨어요" },
];

/** Phase 6 전의 방송 누적 요약 지시문. 한 글자도 바뀌면 안 된다. */
const legacyBroadcastProgressPrompt = [
  "너는 진행 중인 방송의 흐름을 정리하는 도우미다.",
  "이전 요약과 그 뒤에 오간 대화를 읽고, 둘을 합친 갱신된 요약 하나를 만든다.",
  "",
  "[규칙]",
  "- summary는 지금까지 방송에서 무슨 이야기가 오갔는지를 한국어 세 문장 이내로 적는다.",
  "- 이전 요약에서 아직 유효한 내용은 유지하고, 새 대화에서 생긴 흐름을 더한다.",
  "- 시청자가 꺼낸 화제와 보리가 하기로 한 약속을 우선해서 남긴다.",
  "- 단순 인사와 일회성 반응은 넣지 않는다.",
  "- 시청자 닉네임이나 실명은 넣지 않는다.",
  "- 정치, 의료, 법률, 투자, 개인정보는 넣지 않는다.",
  "- 대화에 없는 내용을 지어내지 않는다.",
].join("\n");

describe("누적 요약 지시문", () => {
  test("모드를 주지 않으면 기존 방송 지시문과 화자 이름을 그대로 쓴다", async () => {
    const { adapter, requests } = fakeAdapter(JSON.stringify({ summary: " 요약 " }));
    assert.equal(await summarizeSessionProgress(adapter, "", turns, { timeoutMs: 1000 }), "요약");
    assert.equal(requests[0].overrideSystemPrompt, legacyBroadcastProgressPrompt);
    assert.equal(requests[0].mode, "broadcast");
    assert.ok(requests[0].overrideUserPrompt?.includes("시청자: 오늘 시험 끝났어요"));
  });

  test("broadcast를 명시해도 같은 지시문이다", async () => {
    const { adapter, requests } = fakeAdapter(JSON.stringify({ summary: "요약" }));
    await summarizeSessionProgress(adapter, "", turns, { timeoutMs: 1000, mode: "broadcast" });
    assert.equal(requests[0].overrideSystemPrompt, legacyBroadcastProgressPrompt);
  });

  test("companion은 1:1 지시문을 쓴다: 사실·취향·약속 위주, 닉네임·민감 정보 제외, 지어내지 않기", async () => {
    const { adapter, requests } = fakeAdapter(JSON.stringify({ summary: "요약" }));
    await summarizeSessionProgress(adapter, "이전 요약", turns, { timeoutMs: 1000, mode: "companion" });
    const system = requests[0].overrideSystemPrompt ?? "";
    assert.equal(requests[0].mode, "companion");
    for (const phrase of ["1:1 대화", "직접 말한 사실, 취향, 경험", "약속", "닉네임이나 실명은 넣지 않는다", "개인정보", "지어내거나 추측해서 넣지 않는다"]) {
      assert.ok(system.includes(phrase), phrase);
    }
    assert.ok(!system.includes("방송") && !system.includes("시청자"));
    assert.ok(requests[0].overrideUserPrompt?.includes("상대: 오늘 시험 끝났어요"));
    assert.ok(requests[0].overrideUserPrompt?.includes("[이전 요약]\n이전 요약"));
  });
});

describe("개인 기억 정리", () => {
  test("빈 문장과 같은 문장을 빼고 최대 개수까지 돌려준다", async () => {
    const many = ["상대는 재즈를 좋아한다.", " ", "상대는 재즈를 좋아한다.", ...Array.from({ length: 8 }, (_, index) => `상대는 취미 ${index}가 있다.`)];
    const { adapter, requests } = fakeAdapter(JSON.stringify({ memories: many }));
    const result = await digestPrivateMemories(adapter, turns, { timeoutMs: 1000 });
    assert.equal(result?.length, PRIVATE_MEMORY_DIGEST_LIMIT);
    assert.equal(result?.[0], "상대는 재즈를 좋아한다.");
    assert.equal(new Set(result).size, result?.length);
    assert.equal(requests[0].mode, "companion");
    assert.ok(requests[0].overrideUserPrompt?.includes("상대: 오늘 시험 끝났어요\n보리: 고생 많으셨어요"));
  });

  test("상대의 발언이 없으면 부르지 않는다", async () => {
    const { adapter, requests } = fakeAdapter(JSON.stringify({ memories: ["x"] }));
    assert.equal(await digestPrivateMemories(adapter, [{ role: "bori", text: "혼잣말" }], { timeoutMs: 1000 }), null);
    assert.equal(requests.length, 0);
  });

  test("형식이 틀리면 null이다", async () => {
    assert.equal(await digestPrivateMemories(fakeAdapter("{").adapter, turns, { timeoutMs: 1000 }), null);
    assert.equal(await digestPrivateMemories(fakeAdapter(JSON.stringify({ memories: "x" })).adapter, turns, { timeoutMs: 1000 }), null);
  });
});
