import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { modelExpectation, runModelEvaluation } from "../src/model.js";
import { buildScenarioRequest, selectMemories } from "../src/request.js";
import { loadScenarioSet, type Scenario } from "../src/scenarios.js";
import { evaluateScenarioStatic, fabricationDataCheck, promptChecks, reactionDataCheck, runStaticEvaluation } from "../src/static.js";
import { buildSystemPrompt, buildUserPrompt } from "@bori/llm";
import { boriCrisisLines } from "@bori/character";

const set = loadScenarioSet();
const byId = (id: string): Scenario => {
  const found = set.scenarios.find(entry => entry.id === id);
  if (!found) throw new Error(`${id} 없음`);
  return structuredClone(found);
};

describe("정적 평가", () => {
  // 시나리오는 여러 작업이 나란히 더하므로 개수를 고정하지 않고 데이터 개수와 맞춘다.
  test("시나리오 전부에 결과가 나온다", () => {
    const section = runStaticEvaluation(set);
    assert.equal(section.scenarios.length, set.scenarios.length);
    const { pass, fail, out_of_scope: outOfScope } = section.counts;
    assert.equal(pass + fail + outOfScope, set.scenarios.length);
  });

  test("위기 시나리오는 서버처럼 위기 지침을 붙이고 기억을 넘기지 않는다(ADR-022)", () => {
    const crisis = buildScenarioRequest(byId("C-90"));
    assert.deepEqual(crisis.crisisGuidance, boriCrisisLines);
    assert.deepEqual(crisis.memories, []);
    assert.ok(buildSystemPrompt(crisis).includes("[위기 대응]"));
    assert.equal(buildScenarioRequest(byId("C-02")).crisisGuidance, undefined);
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
    assert.equal(section.counts.skipped, set.scenarios.length);
  });

  test("경로별로 평가 대상을 가른다", () => {
    assert.ok("outOfScope" in modelExpectation(byId("B-01")));
    assert.ok("outOfScope" in modelExpectation(byId("B-09")));
    assert.ok("outOfScope" in modelExpectation(byId("B-17")));
    // 규칙 경로라도 LLM 기대값이 있으면 그 값으로 평가한다.
    assert.deepEqual(modelExpectation(byId("B-02")), { reactions: byId("B-02").llmReactions });
    assert.ok("reactions" in modelExpectation(byId("C-07")));
  });

  test("관계 시나리오는 상황 문장을 모델에 보내고 지어내기 판정을 붙인다", async () => {
    const bodies: string[] = [];
    // 고정 답변을 돌려주는 가짜 OpenAI. 기억에 없는 여행지를 지어낸 답을 준다.
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        bodies.push(body);
        const content = JSON.stringify({
          reply: "지난번에 제주도 가신다고 하셨죠! 재밌으셨어요?",
          emotion: { primary: "happy", intensity: 0.6, durationSeconds: 3 },
          actions: [],
        });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const only = { ...set, scenarios: [byId("C-15")] };
      const section = await runModelEvaluation(only, { apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` });
      const result = section.scenarios[0];
      assert.equal(result.status, "fail");
      const fabrication = result.checks.find(check => check.id === "fabrication");
      assert.equal(fabrication?.status, "fail");
      assert.match(fabrication?.detail ?? "", /제주/);
      // 기대 감정 밖(happy)이라 감정 판정도 실패한다.
      assert.equal(result.checks.find(check => check.id === "reaction")?.status, "fail");
      const sent = JSON.parse(bodies[0]) as { messages: { role: string; content: string }[] };
      const user = sent.messages.find(message => message.role === "user")?.content ?? "";
      assert.ok(user.includes("[대화 상황]\n- 이 사람과는 4번째 대화다. 처음 대화한 지 12일 지났다."));
    } finally {
      server.close();
    }
  });
});

describe("관계 맥락 정적 평가", () => {
  const relationshipIds = set.scenarios.filter(entry => entry.statusLines).map(entry => entry.id);
  const checkOf = (result: ReturnType<typeof evaluateScenarioStatic>, id: string) => result.checks.find(check => check.id === id);

  test("관계 시나리오 10건은 statusLines가 1:1 상황 섹션에 그대로 들어간다", () => {
    assert.deepEqual(relationshipIds, ["C-11", "C-12", "C-13", "C-14", "C-15", "C-16", "C-17", "C-18", "C-19", "C-20"]);
    for (const id of relationshipIds) {
      const scenario = byId(id);
      const result = evaluateScenarioStatic(scenario);
      assert.equal(result.status, "pass", id);
      assert.equal(checkOf(result, "status.lines")?.status, "pass", id);
      const user = buildUserPrompt(buildScenarioRequest(scenario));
      assert.ok(user.includes(`[대화 상황]\n${scenario.statusLines!.map(line => `- ${line}`).join("\n")}`), id);
    }
  });

  test("상황 섹션에 관계 문장이 없으면 status.lines가 실패한다", () => {
    const scenario = byId("C-16");
    // 관계 문장 주입이 빠진 서버처럼 상황 칸을 비운 프롬프트로 검사한다.
    const request = { ...buildScenarioRequest(scenario), broadcastStatus: [] };
    const checks = promptChecks(scenario, buildSystemPrompt(request), buildUserPrompt(request));
    assert.equal(checks.find(check => check.id === "status.lines")?.status, "fail");
  });

  test("관계 문장이 system 프롬프트에 들어가면 status.lines가 실패한다", () => {
    const scenario = byId("C-11");
    const request = buildScenarioRequest(scenario);
    const checks = promptChecks(scenario, `${buildSystemPrompt(request)}\n${scenario.statusLines![0]}`, buildUserPrompt(request));
    assert.equal(checks.find(check => check.id === "status.lines")?.status, "fail");
  });

  test("방송 시나리오는 고정값이 없으면 상황 섹션이 비고 관계 문장이 없다", () => {
    const broadcast = set.scenarios.filter(entry => entry.mode === "broadcast" && entry.path !== "blocked" && entry.path !== "monologue");
    assert.ok(broadcast.length > 0);
    for (const scenario of broadcast) {
      const result = evaluateScenarioStatic(structuredClone(scenario));
      assert.equal(checkOf(result, "status.empty")?.status, "pass", scenario.id);
      assert.ok(!buildUserPrompt(buildScenarioRequest(scenario)).includes("[방송 상황]"), scenario.id);
    }
  });

  test("본문이 섹션 이름을 언급하기만 하면 status.empty는 통과한다", () => {
    const scenario = byId("C-04");
    const request = buildScenarioRequest(scenario);
    const user = `${buildUserPrompt(request)}\n- 지난 대화를 물으면 [대화 상황]의 지난 대화 요약에 있는 내용만 말한다.`;
    const result = promptChecks(scenario, buildSystemPrompt(request), user).find(check => check.id === "status.empty");
    assert.equal(result?.status, "pass", result?.detail);
  });

  test("방송 프롬프트에 관계 문장이 들어가면 status.empty가 실패한다", () => {
    const scenario = byId("B-18");
    const request = { ...buildScenarioRequest(scenario), broadcastStatus: byId("C-13").statusLines! };
    const result = promptChecks(scenario, buildSystemPrompt(request), buildUserPrompt(request)).find(check => check.id === "status.empty");
    assert.equal(result?.status, "fail");
    assert.match(result?.detail ?? "", /\[방송 상황\] 섹션이 있습니다/);
    assert.match(result?.detail ?? "", /관계 문장: 이 사람과는 5번째 대화다/);
  });

  test("B-18: 1:1 private 기억은 소유자 id가 발언자와 같아도 방송 프롬프트에 들어가지 않는다", () => {
    const result = evaluateScenarioStatic(byId("B-18"));
    assert.equal(result.status, "pass");
    assert.equal(checkOf(result, "memory.access")?.status, "pass");
    assert.equal(checkOf(result, "memory.leak")?.label, "접근 불가 기억 미포함 (2건)");
  });

  test("기억 고정값이 없는 관계 시나리오에는 기억 없음 문장이 들어간다", () => {
    for (const id of ["C-11", "C-12", "C-13", "C-16", "C-17", "C-18", "C-19"]) {
      const result = evaluateScenarioStatic(byId(id));
      assert.equal(checkOf(result, "memory.content")?.label, "기억 없음 문장", id);
      assert.equal(checkOf(result, "memory.content")?.status, "pass", id);
    }
    // 고정값이 있는 C-14는 자기 기억만 들어가고 다른 사용자의 기억은 빠진다.
    const c14 = evaluateScenarioStatic(byId("C-14"));
    assert.equal(checkOf(c14, "memory.content")?.label, "접근 가능한 기억 포함");
    assert.equal(checkOf(c14, "memory.leak")?.status, "pass");
  });

  test("지어내기 판정 자료가 고정값과 어긋나면 data.fabrication이 실패한다", () => {
    for (const entry of set.scenarios.filter(item => item.fabricationGuard)) {
      assert.equal(fabricationDataCheck(entry).status, "pass", entry.id);
    }
    // 고정값의 "14일"을 근거에서 빼면 고정값 자체가 후보에 걸린다.
    const c13 = byId("C-13");
    c13.fabricationGuard!.grounded = c13.fabricationGuard!.grounded.filter(term => term !== "14일");
    assert.match(fabricationDataCheck(c13).detail ?? "", /고정값이 지어내기 후보에 걸림: 고정값과 다른 기간\("14일"\)/);
    // 고정값에 없는 말을 언급 기대값으로 두면 잡는다.
    const c14 = byId("C-14");
    c14.fabricationGuard!.mentions = ["김치찌개"];
    assert.match(fabricationDataCheck(c14).detail ?? "", /언급 기대 말이 고정값에 없음: 김치찌개/);
  });
});
