import { boriPersonaLines, boriScopeLines, conversationPolicies, type ConversationMode, type ConversationPolicy } from "@bori/character";
import type { LlmRequest } from "./types.js";

/**
 * 답변 프롬프트의 계층. 위에서 아래 순서로 쌓는다. 제공 업체가 달라도 같은 프롬프트를 쓴다.
 *
 *   1. persona  공통 보리 페르소나와 역할 범위
 *   2. policy   모드별 대화 정책(방송 / 1:1)
 *   3. session  현재 세션 정보(방송 상황, 지금까지의 방송)
 *   4. memory   접근 가능한 기억. 없으면 없다고 적는다
 *   5. context  참고 정보(매크로)와 최근 대화
 *   6. input    답할 입력
 *   7. output   응답 형식과 감정·모션 출력 규칙
 *
 * 매 턴 같은 1·2·7은 system 메시지에, 턴마다 바뀌는 3~6은 user 메시지에 넣는다.
 * 출력 규칙은 순서상 마지막 계층이지만 바뀌지 않는 지시라 system 메시지 끝에 둔다.
 */
export type PromptLayerId = "persona" | "policy" | "session" | "memory" | "context" | "input" | "output";

export type PromptLayer = {
  id: PromptLayerId;
  message: "system" | "user";
  /** 빈 배열이면 이번 턴에 넣을 내용이 없는 계층이다. */
  lines: string[];
};

export const promptLayerOrder: readonly PromptLayerId[] = ["persona", "policy", "session", "memory", "context", "input", "output"];

function policyFor(mode: ConversationMode): ConversationPolicy {
  const policy = conversationPolicies[mode];
  // 모드를 모르면 다른 모드 정책으로 대신하지 않는다. 방송 규칙이 1:1 대화로 새거나 그 반대가 된다.
  if (!policy) throw new Error(`알 수 없는 대화 모드입니다: ${String(mode)}`);
  return policy;
}

/** 계층을 순서대로 만든다. 테스트와 프롬프트 크기 계산이 같은 구조를 본다. */
export function buildPromptLayers(request: LlmRequest): PromptLayer[] {
  const policy = policyFor(request.mode);
  const layers: Record<PromptLayerId, PromptLayer> = {
    persona: { id: "persona", message: "system", lines: personaLayer() },
    policy: { id: "policy", message: "system", lines: [`[대화 정책: ${policy.title}]`, ...policy.rules] },
    session: { id: "session", message: "user", lines: sessionLayer(request, policy) },
    memory: { id: "memory", message: "user", lines: memoryLayer(request, policy) },
    context: { id: "context", message: "user", lines: contextLayer(request, policy) },
    input: { id: "input", message: "user", lines: [`[${policy.sectionTitles.input}]`, request.content] },
    output: { id: "output", message: "system", lines: outputLayer(request, policy) },
  };
  return promptLayerOrder.map(id => layers[id]);
}

function joinLayers(layers: readonly PromptLayer[], message: PromptLayer["message"]): string {
  return layers
    .filter(layer => layer.message === message && layer.lines.length > 0)
    .map(layer => layer.lines.join("\n"))
    .join("\n\n");
}

export function buildSystemPrompt(request: LlmRequest): string {
  return joinLayers(buildPromptLayers(request), "system");
}

export function buildUserPrompt(request: LlmRequest): string {
  return joinLayers(buildPromptLayers(request), "user");
}

function personaLayer(): string[] {
  return ["[페르소나]", ...boriPersonaLines, "", "[역할 범위]", ...boriScopeLines];
}

function sessionLayer(request: LlmRequest, policy: ConversationPolicy): string[] {
  const lines: string[] = [];

  // 경과 시간이나 답변 수는 모델이 대화만 보고 셀 수 없다.
  // 모델에게 세라고 시키는 대신 서버가 계산한 값을 그대로 준다.
  if (request.broadcastStatus.length > 0) {
    lines.push(`[${policy.sectionTitles.status}]`, ...request.broadcastStatus.map(line => `- ${line}`));
  }

  // 최근 대화 창 밖으로 밀려난 흐름. 긴 방송에서 초반 이야기를 잊지 않기 위한 문맥이다.
  const summary = request.sessionSummary.trim();
  if (summary.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${policy.sectionTitles.summary}]`, summary);
  }

  return lines;
}

function memoryLayer(request: LlmRequest, policy: ConversationPolicy): string[] {
  // 기억이 없어도 섹션을 지우지 않는다.
  // 섹션이 통째로 사라지면 모델은 "기억이 없다"와 "기억을 찾아보지 않았다"를 구분할 수 없고,
  // 지난 대화를 묻는 채팅에 아는 척 지어내게 된다. 없다는 사실을 명시적으로 알린다.
  if (request.memories.length > 0) {
    return ["[기억]", ...request.memories.map(memory => `- ${memory}`)];
  }
  return ["[기억]", `- ${policy.noMemoryLine}`];
}

function contextLayer(request: LlmRequest, policy: ConversationPolicy): string[] {
  const lines: string[] = [];

  // 채팅에 나온 키워드로 켜진 정보. 기억 검색과 달리 임베딩 왕복이 없다.
  if (request.macroPrompts.length > 0) {
    lines.push("[참고 정보]", ...request.macroPrompts.map(entry => `- ${entry}`));
  }

  if (request.recentTurns.length > 0) {
    if (lines.length > 0) lines.push("");
    const { user, bori } = policy.speakerLabels;
    lines.push("[최근 대화]", ...request.recentTurns.map(turn => `${turn.role === "viewer" ? user : bori}: ${turn.text}`));
  }

  return lines;
}

function outputLayer(request: LlmRequest, policy: ConversationPolicy): string[] {
  return [
    "[출력 규칙]",
    `- reply는 ${request.maxReplyLength}자 이내의 한국어 존댓말 ${policy.replySentences}이다.`,
    `- emotion.primary는 다음 중 하나여야 한다: ${request.allowedEmotions.join(", ")}`,
    "- emotion.intensity는 0과 1 사이, durationSeconds는 1과 60 사이다.",
    "- 이모지와 마크다운을 쓰지 않는다.",
    "",
    "[모션 선택]",
    "보리는 말할 때 몸으로도 표현한다. 아래 설명을 보고 답변 분위기에 맞는 모션을 고른다.",
    ...request.allowedMotions.map(motion => `- ${motion.name}: ${motion.description}`),
    "",
    // 점검 A6-17: "감정이 조금이라도 드러나면 모션"이라 맞는 모션이 없을 때도 아무거나 골랐다. 빈 배열을 허용한다.
    "- 답변 분위기에 꼭 맞는 모션이 있을 때만 하나 넣는다. 위 설명에서 쓰지 않는다고 한 상황에는 넣지 않는다.",
    "- 인사, 기쁨, 칭찬에 대한 반응, 신나는 이야기, 게임 이야기에는 대개 모션을 넣는다.",
    "- 모션은 한 번에 하나만 고른다.",
    "- actions의 layer는 body, priority는 2로 고정한다.",
    "- 어울리는 모션이 없으면 actions를 빈 배열로 둔다. 맞지 않는 모션보다 빈 배열이 낫다.",
  ];
}

/** 구조화된 출력 스키마. 어댑터가 제공 업체 형식에 맞춰 감싼다. */
export const responseJsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    emotion: {
      type: "object",
      properties: {
        primary: { type: "string" },
        intensity: { type: "number" },
        durationSeconds: { type: "number" },
      },
      required: ["primary", "intensity", "durationSeconds"],
      additionalProperties: false,
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          layer: { type: "string" },
          priority: { type: "integer" },
        },
        required: ["name", "layer", "priority"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "emotion", "actions"],
  additionalProperties: false,
} as const;
