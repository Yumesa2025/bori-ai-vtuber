import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkScenarioDoc, compareDocWithData, loadScenarioSet, parseScenarioDoc, parseScenarioSet, type Scenario } from "../src/scenarios.js";

const sampleDoc = [
  "# 보리 대화 시나리오",
  "",
  "## 1. 방송 모드",
  "",
  "### B-01 인사",
  "",
  "| 필드 | 내용 |",
  "|---|---|",
  "| 모드 | broadcast |",
  "| 입력 | \"보리 안녕!\" |",
  "| 처리 경로 | 규칙 (인사) |",
  "",
  "### B-17 혼잣말",
  "",
  "| 모드 | broadcast |",
  "| 입력 | (없음) |",
  "",
  "## 3. 자동 검사로 이미 확인하는 것",
  "",
  "| 모드 | companion |",
].join("\n");

function scenario(overrides: Partial<Scenario>): Scenario {
  return {
    id: "B-01", title: "인사", mode: "broadcast", premise: "없음", input: "보리 안녕!", path: "rule", pathNote: "",
    expectedFeatures: "", forbiddenText: "", reactionNote: "", expectedReactions: [],
    ...overrides,
  };
}

describe("시나리오 문서 파서", () => {
  test("제목의 id·제목과 표의 모드·입력을 읽는다", () => {
    assert.deepEqual(parseScenarioDoc(sampleDoc), [
      { id: "B-01", title: "인사", mode: "broadcast", input: "보리 안녕!" },
      { id: "B-17", title: "혼잣말", mode: "broadcast", input: null },
    ]);
  });

  test("시나리오가 아닌 제목 아래의 표는 읽지 않는다", () => {
    const parsed = parseScenarioDoc(sampleDoc);
    assert.equal(parsed.at(-1)?.mode, "broadcast");
  });

  test("CRLF 줄바꿈도 읽는다", () => {
    assert.equal(parseScenarioDoc(sampleDoc.replace(/\n/g, "\r\n")).length, 2);
  });
});

describe("문서와 데이터 대조", () => {
  const doc = parseScenarioDoc(sampleDoc);

  test("같으면 문제가 없다", () => {
    const data = [scenario({}), scenario({ id: "B-17", title: "혼잣말", input: null, path: "monologue" })];
    assert.deepEqual(compareDocWithData(doc, data), []);
  });

  test("한쪽에만 있는 id를 찾는다", () => {
    const problems = compareDocWithData(doc, [scenario({}), scenario({ id: "B-99", title: "없는 것" })]);
    assert.ok(problems.some(problem => problem.startsWith("B-17: 문서에는 있고")));
    assert.ok(problems.some(problem => problem.startsWith("B-99: 데이터에는 있고")));
  });

  test("입력·모드·제목이 다르면 알린다", () => {
    const data = [
      scenario({ input: "보리 안녕" }),
      scenario({ id: "B-17", title: "독백", mode: "companion", input: null, path: "monologue" }),
    ];
    const problems = compareDocWithData(doc, data);
    assert.ok(problems.some(problem => problem.startsWith("B-01: 입력이 다릅니다")));
    assert.ok(problems.some(problem => problem.startsWith("B-17: 모드가 다릅니다")));
    assert.ok(problems.some(problem => problem.startsWith("B-17: 제목이 다릅니다")));
  });

  test("실제 문서와 시나리오 데이터가 일치한다", () => {
    const set = loadScenarioSet();
    assert.deepEqual(checkScenarioDoc(set), []);
    assert.equal(set.scenarios.filter(entry => entry.mode === "broadcast").length, 17);
    assert.equal(set.scenarios.filter(entry => entry.mode === "companion").length, 10);
  });
});

describe("시나리오 데이터 형식 검사", () => {
  const valid = { version: 1, source: "", commonForbiddenPatterns: [], scenarios: [scenario({})] };

  test("올바른 데이터는 그대로 돌려준다", () => {
    assert.equal(parseScenarioSet(valid).scenarios.length, 1);
  });

  test("중복 id, 알 수 없는 모드·경로, 잘못된 정규식을 잡는다", () => {
    const broken = {
      ...valid,
      scenarios: [
        scenario({}),
        scenario({ mode: "dm" as Scenario["mode"], path: "magic" as Scenario["path"], forbiddenPatterns: [{ label: "깨진 패턴", pattern: "(" }] }),
      ],
    };
    assert.throws(() => parseScenarioSet(broken), (error: Error) =>
      /중복/.test(error.message) && /알 수 없는 모드/.test(error.message) && /알 수 없는 처리 경로/.test(error.message) && /깨진 패턴/.test(error.message));
  });

  test("입력이 없는데 혼잣말 경로가 아니면 막는다", () => {
    assert.throws(() => parseScenarioSet({ ...valid, scenarios: [scenario({ input: null, path: "llm" })] }), /혼잣말 경로/);
  });

  test("기억 고정 자료의 expectedVisible이 records에 없거나 접근 모드가 어긋나면 막는다", () => {
    const fixture = { access: { mode: "private" as const, userId: "user-a" }, records: [], expectedVisible: ["ghost"] };
    assert.throws(() => parseScenarioSet({ ...valid, scenarios: [scenario({ memoryFixture: fixture })] }),
      (error: Error) => /ghost/.test(error.message) && /모드가 시나리오 모드와 다릅니다/.test(error.message));
  });
});
