import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { modelExpectation, runModelEvaluation } from "../src/model.js";
import { buildScenarioRequest, selectMemories } from "../src/request.js";
import { loadScenarioSet, type Scenario } from "../src/scenarios.js";
import { evaluateScenarioStatic, promptChecks, reactionDataCheck, runStaticEvaluation } from "../src/static.js";
import { buildSystemPrompt, buildUserPrompt } from "@bori/llm";

const set = loadScenarioSet();
const byId = (id: string): Scenario => {
  const found = set.scenarios.find(entry => entry.id === id);
  if (!found) throw new Error(`${id} 없음`);
  return structuredClone(found);
};

describe("정적 평가", () => {
  test("시나리오 27건 전부에 결과가 나온다", () => {
    const section = runStaticEvaluation(set);
    assert.equal(section.scenarios.length, 27);
    const { pass, fail, out_of_scope: outOfScope } = section.counts;
    assert.equal(pass + fail + outOfScope, 27);
  });

  test("서버 차단 시나리오는 범위 밖으로 표시한다", () => {
    const result = evaluateScenarioStatic(byId("B-09"));
    assert.equal(result.status, "out_of_scope");
    assert.equal(result.reason, "서버 차단 대상, 정적 평가 범위 밖");
  });

  test("방송 기억 격리: B 발언에는 A 소유 기억이 들어가지 않는다", () => {
    const scenario = byId("B-14");
    assert.deepEqual(selectMemories(scenario).visible, []);
    assert.equal(buildScenarioRequest(scenario).memories.length, 0);
    assert.equal(evaluateScenarioStatic(scenario).status, "pass");
  });

  test("1:1 기억 격리: 같은 사람의 방송 기억도, 다른 사용자의 1:1 기억도 들어가지 않는다", () => {
    for (const id of ["C-05", "C-06"]) {
      const result = evaluateScenarioStatic(byId(id));
      assert.equal(result.checks.find(check => check.id === "memory.leak")?.status, "pass", id);
      assert.equal(result.checks.find(check => check.id === "memory.content")?.label, "기억 없음 문장", id);
    }
  });

  test("기대 접근 결과가 확정 규칙과 다르면 memory.access가 실패한다", () => {
    const scenario = byId("B-14");
    scenario.memoryFixture!.expectedVisible = ["b14-a"];
    const result = evaluateScenarioStatic(scenario);
    assert.equal(result.status, "fail");
    assert.equal(result.checks.find(check => check.id === "memory.access")?.status, "fail");
  });

  test("접근 불가 기억이 프롬프트에 있으면 memory.leak가 실패한다", () => {
    const scenario = byId("C-06");
    const request = buildScenarioRequest(scenario);
    // 격리를 거치지 않고 다른 사용자의 기억을 넣은 경우를 흉내 낸다.
    const leakedUser = buildUserPrompt({ ...request, memories: ["지난주에 제주도 여행을 다녀왔다고 했다."] });
    const checks = promptChecks(scenario, buildSystemPrompt(request), leakedUser);
    assert.equal(checks.find(check => check.id === "memory.leak")?.status, "fail");
  });

  test("다른 모드 정책이 섞이면 policy.isolation이 실패한다", () => {
    const scenario = byId("C-10");
    const request = buildScenarioRequest(scenario);
    const broadcastSystem = buildSystemPrompt({ ...request, mode: "broadcast" });
    const checks = promptChecks(scenario, `${buildSystemPrompt(request)}\n${broadcastSystem}`, buildUserPrompt(request));
    assert.equal(checks.find(check => check.id === "policy.isolation")?.status, "fail");
  });

  test("기억이 없는데 기억 없음 문장이 빠지면 실패한다", () => {
    const scenario = byId("B-08");
    const request = buildScenarioRequest(scenario);
    const user = buildUserPrompt(request).replace(/- 이 채팅과 관련해 저장된 기억이 없다.*/, "");
    const checks = promptChecks(scenario, buildSystemPrompt(request), user);
    assert.equal(checks.find(check => check.id === "memory.content")?.status, "fail");
  });

  test("데이터의 기대 감정이 allowlist 밖이면 잡는다", () => {
    const scenario = byId("B-06");
    scenario.expectedReactions = [{ emotions: ["sleepy"], motions: ["dance"] }];
    assert.equal(reactionDataCheck(scenario).status, "fail");
  });
});

describe("실모델 평가", () => {
  test("키가 없으면 호출 없이 전부 건너뛴다", async () => {
    const section = await runModelEvaluation(set, { apiKey: undefined });
    assert.match(section.skippedReason ?? "", /OPENAI_API_KEY/);
    assert.equal(section.counts.skipped, 27);
  });

  test("경로별로 평가 대상을 가른다", () => {
    assert.ok("outOfScope" in modelExpectation(byId("B-01")));
    assert.ok("outOfScope" in modelExpectation(byId("B-09")));
    assert.ok("outOfScope" in modelExpectation(byId("B-17")));
    // 규칙 경로라도 LLM 기대값이 있으면 그 값으로 평가한다.
    assert.deepEqual(modelExpectation(byId("B-02")), { reactions: byId("B-02").llmReactions });
    assert.ok("reactions" in modelExpectation(byId("C-07")));
  });
});
