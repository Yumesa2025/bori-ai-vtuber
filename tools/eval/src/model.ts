import { boriEmotionNames, boriMotionGroupNames, resolveMotion } from "@bori/live2d";
import { createAdapter, defaultModels, validateLlmOutput, type LlmAdapter } from "@bori/llm";
import { judgeAllowlist, judgeFabrication, judgeForbidden, judgeHonorific, judgeLength, judgeReaction } from "./judge.js";
import { buildScenarioRequest, evalReplyLimit } from "./request.js";
import type { ExpectedReaction, Scenario, ScenarioSet } from "./scenarios.js";
import { countStatuses, statusFromChecks, type CheckResult, type EvalResultFile, type ScenarioResult } from "./types.js";

export type ModelSection = NonNullable<EvalResultFile["model"]>;

export type ModelOptions = {
  apiKey: string | undefined;
  model?: string;
  /** 비우면 어댑터 기본값(BORI_OPENAI_BASE_URL 또는 OpenAI 주소)을 쓴다. */
  baseUrl?: string;
  timeoutMs?: number;
  /** 진행 상황 출력. */
  log?: (line: string) => void;
};

/**
 * 실모델 평가에서 이 시나리오를 볼 기대값. null이면 실모델 평가 범위 밖이다.
 * 규칙 경로는 서버 규칙이 답하므로, LLM이 답할 경우의 기대값이 따로 적힌 시나리오만 돌린다.
 */
export function modelExpectation(scenario: Scenario): { reactions: ExpectedReaction[] } | { outOfScope: string } {
  switch (scenario.path) {
    case "llm":
    case "undecided":
      return { reactions: scenario.expectedReactions };
    case "rule":
      return scenario.llmReactions
        ? { reactions: scenario.llmReactions }
        : { outOfScope: "서버 규칙 응답 경로, 실모델 평가 범위 밖" };
    case "blocked":
      return { outOfScope: "서버 차단 대상, 실모델 평가 범위 밖" };
    case "monologue":
      return { outOfScope: "혼잣말 규칙 문장, 실모델 평가 범위 밖" };
  }
}

/** 키가 없으면 아무것도 호출하지 않고 건너뛴 결과를 돌려준다. */
export async function runModelEvaluation(set: ScenarioSet, options: ModelOptions): Promise<ModelSection> {
  const model = options.model ?? defaultModels.openai;
  const baseUrl = options.baseUrl ?? process.env.BORI_OPENAI_BASE_URL ?? null;
  const apiKey = options.apiKey?.trim() ?? "";

  if (apiKey.length === 0) {
    const scenarios: ScenarioResult[] = set.scenarios.map(scenario => ({
      id: scenario.id, title: scenario.title, mode: scenario.mode, status: "skipped", reason: "OPENAI_API_KEY 없음", checks: [],
    }));
    return { provider: "openai", model, baseUrl, skippedReason: "OPENAI_API_KEY가 없어 실모델 평가를 건너뛰었습니다.", counts: countStatuses(scenarios), scenarios };
  }

  const adapter = createAdapter("openai", { apiKey, model, ...(baseUrl ? { baseUrl } : {}) });
  if (!adapter) throw new Error("OpenAI 어댑터를 만들 수 없습니다.");

  const scenarios: ScenarioResult[] = [];
  for (const scenario of set.scenarios) {
    const result = await evaluateScenarioWithModel(scenario, set, adapter, options.timeoutMs ?? 20_000);
    options.log?.(`  ${scenario.id} ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
    scenarios.push(result);
  }
  return { provider: "openai", model, baseUrl, counts: countStatuses(scenarios), scenarios };
}

async function evaluateScenarioWithModel(scenario: Scenario, set: ScenarioSet, adapter: LlmAdapter, timeoutMs: number): Promise<ScenarioResult> {
  const base = { id: scenario.id, title: scenario.title, mode: scenario.mode };
  const expectation = modelExpectation(scenario);
  if ("outOfScope" in expectation) return { ...base, status: "out_of_scope", reason: expectation.outOfScope, checks: [] };

  const request = buildScenarioRequest(scenario, { timeoutMs });
  let raw: string;
  let latencyMs: number;
  try {
    ({ raw, latencyMs } = await adapter.complete(request));
  } catch (error) {
    return { ...base, status: "error", reason: error instanceof Error ? error.message : String(error), checks: [] };
  }

  // 서버와 같은 검증을 그대로 쓴다. 검증에 걸리면 방송에서는 무반응이 된다.
  const validated = validateLlmOutput(raw, request);
  if (!validated.ok) {
    const checks: CheckResult[] = [
      { id: "validation", label: "출력 검증 통과", status: "fail", detail: validated.reason },
      ...manualChecks(scenario),
    ];
    return { ...base, status: "fail", checks, raw: raw.slice(0, 2000) };
  }

  const response = validated.response;
  const actionNames = response.actions.map(action => action.name);
  const displayedMotion = resolveMotion(response.actions, response.emotion.primary)?.group ?? null;
  const checks: CheckResult[] = [
    { id: "validation", label: "출력 검증 통과", status: "pass" },
    judgeAllowlist(response.emotion.primary, actionNames, boriEmotionNames, boriMotionGroupNames),
    judgeLength(response.reply, evalReplyLimit),
    judgeForbidden(response.reply, [...set.commonForbiddenPatterns, ...(scenario.forbiddenPatterns ?? [])]),
    judgeHonorific(response.reply),
    judgeReaction(response.emotion.primary, displayedMotion, expectation.reactions),
    ...(scenario.fabricationGuard ? [judgeFabrication(response.reply, scenario.fabricationGuard)] : []),
    ...manualChecks(scenario),
  ];

  return {
    ...base,
    status: statusFromChecks(checks),
    checks,
    response: { reply: response.reply, emotion: response.emotion.primary, actions: actionNames, displayedMotion, latencyMs },
  };
}

/** 문자열로 판정할 수 없는 기대값. 평가자가 답변을 읽고 채운다. */
function manualChecks(scenario: Scenario): CheckResult[] {
  return [
    { id: "manual.features", label: "기대 반응 특징", status: "manual", detail: scenario.expectedFeatures },
    { id: "manual.forbidden", label: "금지 반응(문자열 판정 밖)", status: "manual", detail: scenario.forbiddenText },
  ];
}
