import { boriPersonaLines, boriScopeLines, conversationModes, conversationPolicies } from "@bori/character";
import { boriEmotionNames, isBoriMotionGroup } from "@bori/live2d";
import { buildSystemPrompt, buildUserPrompt } from "@bori/llm";
import { ungroundedHits } from "./judge.js";
import { findRelationshipFragments } from "./relationship.js";
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
    return { ...base, status: "out_of_scope", reason: outOfScope, checks: dataChecks(scenario) };
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
    ...dataChecks(scenario),
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

  // 상황 섹션. 관계 맥락 문장은 서버가 계산한 사실이라 user 메시지의 상황 섹션에 그대로 들어가야 한다.
  // 정책 지침 문구는 바뀌는 중이라 단언하지 않고, 섹션 제목은 정책 데이터에서 읽는다.
  const statusTitle = `[${policy.sectionTitles.status}]`;
  const statusLines = scenario.statusLines ?? [];
  if (statusLines.length > 0) {
    const statusBlock = [statusTitle, ...statusLines.map(line => `- ${line}`)].join("\n");
    const problems = [
      ...(user.includes(statusBlock) ? [] : [`"${statusBlock}"가 user 프롬프트에 없습니다.`]),
      ...statusLines.filter(line => system.includes(line)).map(line => `system 프롬프트에 들어감: ${line}`),
    ];
    checks.push(check("status.lines", `상황 섹션의 고정 문장 (${statusLines.length}줄)`, problems.length === 0, problems.join(" / ")));
  } else {
    // 고정값이 없으면 섹션이 비어야 한다. 방송 프롬프트에 관계 문장이 새지 않는지도 여기서 본다.
    const leakedLines = findRelationshipFragments(`${system}\n${user}`);
    // 섹션은 제목이 한 줄로 따로 있을 때만 있다고 본다. 지침 문장이 본문에서 "[대화 상황]의 지난 대화 요약"처럼
    // 섹션 이름을 언급하는 것은 섹션이 아니다.
    const hasStatusSection = user.split("\n").some(line => line.trim() === statusTitle);
    const problems = [
      ...(hasStatusSection ? [`${statusTitle} 섹션이 있습니다.`] : []),
      ...leakedLines.map(fragment => `관계 문장: ${fragment}`),
    ];
    checks.push(check("status.empty", "상황 고정값 없음 → 상황 섹션·관계 문장 없음", problems.length === 0, problems.join(" / ")));
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

/** 프롬프트 없이 시나리오 데이터만으로 보는 검사. 범위 밖 시나리오도 돌린다. */
export function dataChecks(scenario: Scenario): CheckResult[] {
  return [reactionDataCheck(scenario), ...(scenario.fabricationGuard ? [fabricationDataCheck(scenario)] : [])];
}

/**
 * 지어내기 판정 자료가 고정값과 맞는지. 고정값(입력·관계 문장·보이는 기억) 자체가 지어내기 후보에 걸리는데
 * 근거 말로 설명되지 않거나, 언급을 기대한 말이 고정값에 없으면 실모델 판정이 맞는 답을 실패시킨다.
 * 보리 자기 설정을 묻는 시나리오는 근거가 페르소나 문장에 있으므로, 언급 기대 말은 페르소나에서도 찾는다.
 */
export function fabricationDataCheck(scenario: Scenario): CheckResult {
  const guard = scenario.fabricationGuard!;
  const fixtureText = [
    scenario.input ?? "",
    ...(scenario.statusLines ?? []),
    ...selectMemories(scenario).visible.map(memory => memory.text),
  ].join("\n");
  const groundingText = [fixtureText, ...boriPersonaLines].join("\n");
  const problems = [
    ...ungroundedHits(fixtureText, guard).map(hit => `고정값이 지어내기 후보에 걸림: ${hit}`),
    ...(guard.mentions ?? []).filter(term => !groundingText.includes(term)).map(term => `언급 기대 말이 고정값에 없음: ${term}`),
  ];
  return check("data.fabrication", "지어내기 판정 자료가 고정값과 맞음", problems.length === 0, problems.join(" / "));
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
