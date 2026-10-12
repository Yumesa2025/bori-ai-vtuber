import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareResults, formatComparison, sanitizeLabel, timestampForFile } from "../src/results.js";
import { countStatuses, type EvalResultFile, type ScenarioResult } from "../src/types.js";

function scenarioResult(id: string, status: ScenarioResult["status"], checks: ScenarioResult["checks"] = []): ScenarioResult {
  return { id, title: id, mode: "broadcast", status, checks };
}

function resultFile(scenarios: ScenarioResult[], overrides: Partial<EvalResultFile> = {}): EvalResultFile {
  return {
    version: 1,
    label: "test",
    createdAt: "2026-10-12T00:00:00.000Z",
    commit: null,
    promptFingerprints: { broadcast: "aaa", companion: "bbb" },
    scenarioCount: scenarios.length,
    static: { counts: countStatuses(scenarios), scenarios },
    ...overrides,
  };
}

describe("결과 비교", () => {
  const passing = [
    scenarioResult("B-01", "pass", [{ id: "memory.leak", label: "", status: "pass" }]),
    scenarioResult("B-09", "out_of_scope"),
  ];

  test("같은 결과끼리는 변화가 0건이다", () => {
    const comparison = compareResults(resultFile(passing), resultFile(passing));
    assert.equal(comparison.statusChangeCount, 0);
    assert.deepEqual(comparison.changes, []);
    assert.deepEqual(comparison.promptChanged, []);
    assert.match(formatComparison(comparison, "a", "b"), /상태 변화: 0건/);
  });

  test("통과 → 실패를 시나리오와 검사 단위로 보여 준다", () => {
    const after = [scenarioResult("B-01", "fail", [{ id: "memory.leak", label: "", status: "fail" }]), passing[1]];
    const comparison = compareResults(resultFile(passing), resultFile(after));
    assert.equal(comparison.statusChangeCount, 1);
    assert.deepEqual(comparison.changes[0], {
      section: "static", id: "B-01", before: "pass", after: "fail", checkChanges: ["memory.leak: pass → fail"], replyChanged: false,
    });
  });

  test("한쪽에만 있는 시나리오도 변화로 센다", () => {
    const comparison = compareResults(resultFile(passing), resultFile([passing[0]]));
    assert.deepEqual(comparison.changes.map(change => [change.id, change.before, change.after]), [["B-09", "out_of_scope", null]]);
  });

  test("프롬프트 지문이 다르면 알린다", () => {
    const comparison = compareResults(resultFile(passing), resultFile(passing, { promptFingerprints: { broadcast: "aaa", companion: "ccc" } }));
    assert.deepEqual(comparison.promptChanged, [{ mode: "companion", before: "bbb", after: "ccc" }]);
  });

  test("실모델 답변이 바뀌면 상태가 같아도 세부 변화로 남긴다", () => {
    const withReply = (reply: string): ScenarioResult => ({
      ...scenarioResult("B-06", "pass"),
      response: { reply, emotion: "happy", actions: [], displayedMotion: "xingxingyan", latencyMs: 100 },
    });
    const model = (scenario: ScenarioResult) => ({
      provider: "openai" as const, model: "m", baseUrl: null, counts: countStatuses([scenario]), scenarios: [scenario],
    });
    const comparison = compareResults(
      resultFile([], { model: model(withReply("좋아요.")) }),
      resultFile([], { model: model(withReply("좋죠!")) }),
    );
    assert.equal(comparison.statusChangeCount, 0);
    assert.equal(comparison.changes[0].replyChanged, true);
    assert.match(formatComparison(comparison, "a", "b"), /답변 문장이 달라짐/);
  });
});

describe("결과 파일 이름", () => {
  test("라벨에서 파일 이름에 못 쓰는 문자를 바꾼다", () => {
    assert.equal(sanitizeLabel("프롬프트 v2/수정"), "프롬프트-v2-수정");
    assert.equal(sanitizeLabel("  "), "run");
  });

  test("타임스탬프는 이름순 = 시간순이 되는 형식이다", () => {
    assert.equal(timestampForFile(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
  });
});
