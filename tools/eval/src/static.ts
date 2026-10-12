import { boriPersonaLines, boriScopeLines, conversationModes, conversationPolicies } from "@bori/character";
import { boriEmotionNames, isBoriMotionGroup } from "@bori/live2d";
import { buildSystemPrompt, buildUserPrompt } from "@bori/llm";
import { buildScenarioRequest, evalAllowedMotions, evalReplyLimit, selectMemories } from "./request.js";
import type { Scenario, ScenarioSet } from "./scenarios.js";
import { countStatuses, statusFromChecks, type CheckResult, type ScenarioResult, type SectionResult } from "./types.js";

/** 정적 평가로 볼 수 없는 경로와 그 이유. 서버 내부 규칙은 import하지 않는다. */
const outOfScopeReasons: Partial<Record<Scenario["path"], string>> = {
  blocked: "서버 차단 대상, 정적 평가 범위 밖",
  monologue: "혼잣말은 서버 규칙 문장이라 프롬프트 빌더를 거치지 않는다. 정적 평가 범위 밖",
};

/** 키 없이 돌릴 수 있는 평가. 시나리오마다 실제 프롬프트 빌더로 프롬프트를 만들고 들어가야 할 것과 빠져야 할 것을 본다. */
export function runStaticEvaluation(set: ScenarioSet): SectionResult {
  const scenarios = set.scenarios.map(evaluateScenarioStatic);
  return { counts: countStatuses(scenarios), scenarios };
}

export function evaluateScenarioStatic(scenario: Scenario): ScenarioResult {
  const base = { id: scenario.id, title: scenario.title, mode: scenario.mode };
  const outOfScope = outOfScopeReasons[scenario.path];
  if (outOfScope) {
    return { ...base, status: "out_of_scope", reason: outOfScope, checks: [reactionDataCheck(scenario)] };
  }

  let system: string;
  let user: string;
  try {
    const request = buildScenarioRequest(scenario);
    system = buildSystemPrompt(request);
    user = buildUserPrompt(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...base, status: "fail", checks: [{ id: "prompt.build", label: "프롬프트 생성", status: "fail", detail }] };
  }

  const checks: CheckResult[] = [
    { id: "prompt.build", label: "프롬프트 생성", status: "pass" },
    ...promptChecks(scenario, system, user),
    reactionDataCheck(scenario),
  ];
  const result: ScenarioResult = { ...base, status: statusFromChecks(checks), checks };
  if (scenario.path === "rule") {
    result.reason = "규칙 경로: 실제 방송에서는 서버 규칙이 답한다. 프롬프트 검사는 LLM이 답할 경우의 기준이다";
  } else if (scenario.path === "undecided") {
    result.reason = "처리 방식 미결정: LLM이 답한다고 보고 프롬프트를 검사했다";
  }
  return result;
}

function check(id: string, label: string, ok: boolean, detail?: string): CheckResult {
  return ok ? { id, label, status: "pass" } : { id, label, status: "fail", ...(detail ? { detail } : {}) };
}

function missingFrom(text: string, fragments: readonly string[]): string[] {
  return fragments.filter(fragment => !text.includes(fragment));
}

export function promptChecks(scenario: Scenario, system: string, user: string): CheckResult[] {
  const policy = conversationPolicies[scenario.mode];
  const checks: CheckResult[] = [];

  // 공통 페르소나와 역할 범위. 시스템 프롬프트 비공개 규칙도 여기에 들어 있다.
  const personaMissing = missingFrom(system, [...boriPersonaLines, ...boriScopeLines]);
  checks.push(check("persona", "페르소나·역할 범위 문장", personaMissing.length === 0, `빠짐: ${personaMissing.join(" / ")}`));

  // 모드 정책 규칙
  const policyMissing = missingFrom(system, [`[대화 정책: ${policy.title}]`, ...policy.rules]);
  checks.push(check("policy.rules", `${policy.title} 정책 규칙`, policyMissing.length === 0, `빠짐: ${policyMissing.join(" / ")}`));

  // 다른 모드의 정책이 새지 않는지. 두 모드가 같이 쓰는 문장은 제외한다.
  const leaked = conversationModes
    .filter(mode => mode !== scenario.mode)
    .flatMap(mode => {
      const other = conversationPolicies[mode];
      const ownRules = new Set(policy.rules);
      return [`[대화 정책: ${other.title}]`, ...other.rules.filter(rule => !ownRules.has(rule))];
    })
    .filter(fragment => system.includes(fragment) || user.includes(fragment));
  checks.push(check("policy.isolation", "다른 모드 정책 미포함", leaked.length === 0, `섞임: ${leaked.join(" / ")}`));

  // 답할 입력
  const inputBlock = `[${policy.sectionTitles.input}]\n${scenario.input}`;
  checks.push(check("input", "입력 섹션", user.includes(inputBlock), `"${inputBlock}"가 user 프롬프트에 없습니다.`));

  // 기억 섹션. 기억이 없으면 섹션을 지우지 않고 기억 없음 문장을 넣어야 한다.
  const selection = selectMemories(scenario);
  checks.push(check("memory.section", "[기억] 섹션", user.includes("[기억]"), "[기억] 섹션이 없습니다."));
  const noMemoryLine = `- ${policy.noMemoryLine}`;
  if (selection.visible.length === 0) {
    checks.push(check("memory.content", "기억 없음 문장", user.includes(noMemoryLine), "기억이 0건인데 기억 없음 문장이 없습니다."));
  } else {
    const memoryMissing = missingFrom(user, selection.visible.map(memory => `- ${memory.text}`));
    const problems = [
      ...memoryMissing.map(line => `빠짐: ${line}`),
      ...(user.includes(noMemoryLine) ? ["기억이 있는데 기억 없음 문장이 들어갔습니다."] : []),
    ];
    checks.push(check("memory.content", "접근 가능한 기억 포함", problems.length === 0, problems.join(" / ")));
  }

  // 기억 격리. 고정 자료가 있는 시나리오만 본다.
  const fixture = scenario.memoryFixture;
  if (fixture) {
    const visibleIds = selection.visible.map(memory => memory.id).sort();
    const expectedIds = [...fixture.expectedVisible].sort();
    checks.push(check(
      "memory.access",
      "canAccessMemory 결과 = 확정 접근 규칙",
      visibleIds.join(",") === expectedIds.join(","),
      `기대 ${expectedIds.join(",") || "(없음)"}, 실제 ${visibleIds.join(",") || "(없음)"}`,
    ));
    const leakedMemories = selection.hidden.filter(memory => system.includes(memory.text) || user.includes(memory.text));
    checks.push(check(
      "memory.leak",
      `접근 불가 기억 미포함 (${selection.hidden.length}건)`,
      leakedMemories.length === 0,
      `새어 들어감: ${leakedMemories.map(memory => memory.id).join(", ")}`,
    ));
  }

  // 감정·모션 allowlist
  const emotionLine = `- emotion.primary는 다음 중 하나여야 한다: ${boriEmotionNames.join(", ")}`;
  checks.push(check("allowlist.emotions", `감정 allowlist (${boriEmotionNames.length}개)`, system.includes(emotionLine), "감정 허용 목록 문장이 없습니다."));
  const motionMissing = missingFrom(system, evalAllowedMotions.map(motion => `- ${motion.name}: ${motion.description}`));
  checks.push(check("allowlist.motions", `모션 allowlist·설명 (${evalAllowedMotions.length}개)`, motionMissing.length === 0, `빠짐: ${motionMissing.join(" / ")}`));

  // 길이·문장 수·존댓말 출력 규칙
  const lengthLine = `- reply는 ${evalReplyLimit}자 이내의 한국어 존댓말 ${policy.replySentences}이다.`;
  checks.push(check("output.length", "길이·존댓말 출력 규칙", system.includes(lengthLine), `"${lengthLine}"가 없습니다.`));

  return checks;
}

/** 시나리오 데이터의 기대 감정·모션이 허용 목록 안에 있는지. 데이터 오타를 잡는다. */
export function reactionDataCheck(scenario: Scenario): CheckResult {
  const reactions = [...scenario.expectedReactions, ...(scenario.llmReactions ?? [])];
  const unknown = reactions.flatMap(reaction => [
    ...reaction.emotions.filter(emotion => !boriEmotionNames.includes(emotion)),
    ...(reaction.motions ?? []).filter((motion): motion is string => motion !== null && !isBoriMotionGroup(motion)),
  ]);
  return check("data.reactions", "기대 감정·모션이 allowlist 안", unknown.length === 0, `허용 목록 밖: ${unknown.join(", ")}`);
}
