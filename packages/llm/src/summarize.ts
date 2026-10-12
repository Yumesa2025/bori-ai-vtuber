import type { ConversationMode } from "@bori/character";
import type { LlmAdapter } from "./types.js";

export type SummaryTurn = { role: "viewer" | "bori"; text: string };

export type BroadcastSummary = {
  /** 방송 전체를 한두 문장으로 정리한 기억. */
  summary: string;
  /** 다음 방송에서 쓸 만한 짧은 기억들. */
  highlights: string[];
};

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "highlights"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  "너는 방송 기록을 정리하는 도우미다.",
  "보리라는 버추얼 스트리머의 방송 대화를 읽고 다음 방송에서 쓸 기억을 만든다.",
  "",
  "[규칙]",
  "- summary는 이번 방송의 주요 주제와 분위기를 한국어 두 문장 이내로 적는다.",
  "- highlights는 다음 방송에서 다시 꺼낼 만한 내용만 짧은 문장으로 담는다. 최대 5개.",
  "- 시청자의 취향, 경험, 보리와 나눈 중요한 이야기를 우선한다.",
  "- 단순 인사와 일회성 반응은 넣지 않는다.",
  "- 정치, 의료, 법률, 투자, 개인정보는 절대 넣지 않는다.",
  "- 시청자 닉네임이나 실명은 넣지 않는다.",
  "- 대화에서 확인되지 않은 내용을 지어내지 않는다. 남길 것이 없으면 highlights를 빈 배열로 둔다.",
].join("\n");

/**
 * 방송 대화를 요약한다.
 * 어댑터 인터페이스를 그대로 쓰되 스키마가 달라 별도 함수로 둔다.
 */
export async function summarizeBroadcast(
  adapter: LlmAdapter,
  turns: readonly SummaryTurn[],
  options: { timeoutMs: number },
): Promise<BroadcastSummary | null> {
  if (turns.length === 0) return null;

  const transcript = turns.map(turn => `${turn.role === "viewer" ? "시청자" : "보리"}: ${turn.text}`).join("\n");

  const result = await adapter.complete({
    // 방송 대화를 정리하는 작업이다. 프롬프트는 아래 override로 통째로 바뀌어 모드 정책은 쓰이지 않는다.
    mode: "broadcast",
    content: transcript,
    recentTurns: [],
    memories: [],
    sessionSummary: "",
    macroPrompts: [],
    broadcastStatus: [],
    allowedEmotions: [],
    allowedMotions: [],
    maxReplyLength: 400,
    timeoutMs: options.timeoutMs,
    // 요약 전용 프롬프트와 스키마로 바꿔 끼운다.
    overrideSystemPrompt: SYSTEM_PROMPT,
    overrideUserPrompt: `[방송 대화]\n${transcript}`,
    overrideSchema: SUMMARY_SCHEMA,
  });

  try {
    const parsed = JSON.parse(result.raw) as Partial<BroadcastSummary>;
    if (typeof parsed.summary !== "string") return null;

    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 5)
      : [];

    return { summary: parsed.summary.trim(), highlights: highlights.map(entry => entry.trim()) };
  } catch {
    return null;
  }
}

// ── 방송 중 누적 요약 ─────────────────────────────────────────
// 방송이 끝난 뒤 만드는 위쪽 요약과 목적이 다르다.
// 이쪽은 진행 중인 방송의 흐름을 붙들기 위한 것이라 스키마와 프롬프트를 따로 둔다.

const PROGRESS_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
} as const;

const PROGRESS_SYSTEM_PROMPT = [
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

/**
 * 1:1 대화의 누적 요약 지시문. 방송 지시문과 달리 한 사람과 나눈 이야기를 붙든다.
 * 이 요약은 재시작 뒤 같은 대화를 이어갈 때와 다음 대화의 "지난 대화 요약"에도 쓰이므로,
 * 상대가 직접 말한 것만 남기고 지어내지 않게 한다. (검토 필요: 문구 초안)
 */
const COMPANION_PROGRESS_SYSTEM_PROMPT = [
  "너는 1:1 대화의 흐름을 정리하는 도우미다.",
  "보리와 한 사람이 나눈 대화에서 이전 요약과 그 뒤에 오간 대화를 읽고, 둘을 합친 갱신된 요약 하나를 만든다.",
  "",
  "[규칙]",
  "- summary는 지금까지 무슨 이야기를 나눴는지를 한국어 세 문장 이내로 적는다.",
  "- 이전 요약에서 아직 유효한 내용은 유지하고, 새 대화에서 생긴 내용을 더한다.",
  "- 상대가 직접 말한 사실, 취향, 경험과 보리와 나눈 약속을 우선해서 남긴다.",
  "- 단순 인사와 일회성 반응은 넣지 않는다.",
  "- 상대의 닉네임이나 실명은 넣지 않는다.",
  "- 정치, 의료, 법률, 투자, 개인정보 같은 민감한 내용은 넣지 않는다.",
  "- 대화에 없는 내용을 지어내거나 추측해서 넣지 않는다.",
].join("\n");

/** 모드별 누적 요약 지시문과 대화 기록에서 상대를 가리키는 이름. */
const progressPrompts: Record<ConversationMode, { system: string; user: string }> = {
  broadcast: { system: PROGRESS_SYSTEM_PROMPT, user: "시청자" },
  companion: { system: COMPANION_PROGRESS_SYSTEM_PROMPT, user: "상대" },
};

/**
 * 대화 중 누적 요약을 갱신한다.
 * 요약 목록을 계속 쌓으면 긴 방송에서 문맥이 무한정 늘어나므로,
 * 이전 요약과 새 대화를 매번 한 문단으로 접어 길이를 일정하게 유지한다.
 * mode를 주지 않으면 방송 지시문을 쓴다.
 */
export async function summarizeSessionProgress(
  adapter: LlmAdapter,
  previousSummary: string,
  turns: readonly SummaryTurn[],
  options: { timeoutMs: number; mode?: ConversationMode },
): Promise<string | null> {
  if (turns.length === 0) return null;

  const mode = options.mode ?? "broadcast";
  const prompts = progressPrompts[mode];
  // 모드를 모르면 다른 모드 지시문으로 대신하지 않는다.
  if (!prompts) throw new Error(`알 수 없는 대화 모드입니다: ${String(mode)}`);

  const transcript = turns.map(turn => `${turn.role === "viewer" ? prompts.user : "보리"}: ${turn.text}`).join("\n");
  const previous = previousSummary.trim();
  const userPrompt = [
    previous.length > 0 ? `[이전 요약]\n${previous}\n` : "[이전 요약]\n(아직 없음)\n",
    `[새로 오간 대화]\n${transcript}`,
  ].join("\n");

  const result = await adapter.complete({
    // 대화를 정리하는 작업이다. 프롬프트는 아래 override로 통째로 바뀌어 모드 정책은 쓰이지 않는다.
    mode,
    content: transcript,
    recentTurns: [],
    memories: [],
    sessionSummary: "",
    macroPrompts: [],
    broadcastStatus: [],
    allowedEmotions: [],
    allowedMotions: [],
    maxReplyLength: 300,
    timeoutMs: options.timeoutMs,
    overrideSystemPrompt: prompts.system,
    overrideUserPrompt: userPrompt,
    overrideSchema: PROGRESS_SCHEMA,
  });

  try {
    const parsed = JSON.parse(result.raw) as { summary?: unknown };
    if (typeof parsed.summary !== "string") return null;
    const summary = parsed.summary.trim();
    return summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
}

// ── 1:1 개인 기억 정리 ────────────────────────────────────────
// 규칙 추출은 정해진 표현("좋아해" 등)만 잡아서 놓치는 것이 많다.
// 최근 대화를 LLM에 넘겨 상대가 직접 말한 사실만 한 문장씩 뽑는다. 저장 여부는 호출하는 쪽이 한 번 더 거른다.

/** 한 번에 뽑을 최대 기억 수. */
export const PRIVATE_MEMORY_DIGEST_LIMIT = 5;

const MEMORY_DIGEST_SCHEMA = {
  type: "object",
  properties: { memories: { type: "array", items: { type: "string" } } },
  required: ["memories"],
  additionalProperties: false,
} as const;

/** (검토 필요: 문구 초안) */
const MEMORY_DIGEST_SYSTEM_PROMPT = [
  "너는 1:1 대화에서 오래 기억할 내용을 고르는 도우미다.",
  "보리와 한 사람이 나눈 대화를 읽고, 다음 대화에서도 기억해 둘 만한 내용을 고른다.",
  "",
  "[규칙]",
  "- 상대가 자기 자신에 대해 직접 말한 사실, 취향, 경험만 고른다. 보리가 한 말은 고르지 않는다.",
  "- 한 항목에 한 문장씩, '상대는 ~' 형태의 짧은 한국어 문장으로 적는다.",
  `- 최대 ${PRIVATE_MEMORY_DIGEST_LIMIT}개까지 고른다.`,
  "- 대화에 없는 내용을 추측하거나 지어내지 않는다. 확실하지 않으면 넣지 않는다.",
  "- 단순 인사, 일회성 반응, 질문만 한 내용은 넣지 않는다.",
  "- 닉네임, 실명, 연락처, 주소, 계좌 같은 개인정보와 정치, 의료, 법률, 투자 같은 민감한 내용은 넣지 않는다.",
  "- 남길 것이 없으면 memories를 빈 배열로 둔다.",
].join("\n");

/**
 * 1:1 대화에서 개인 기억 후보 문장을 뽑는다. 상대의 발언이 없거나 응답 형식이 틀리면 null이다.
 * 뽑은 문장을 그대로 저장하지 않는다. 호출하는 쪽이 민감 정보 검사를 다시 거친다.
 */
export async function digestPrivateMemories(
  adapter: LlmAdapter,
  turns: readonly SummaryTurn[],
  options: { timeoutMs: number },
): Promise<string[] | null> {
  if (!turns.some(turn => turn.role === "viewer")) return null;

  const transcript = turns.map(turn => `${turn.role === "viewer" ? "상대" : "보리"}: ${turn.text}`).join("\n");
  const result = await adapter.complete({
    // 1:1 대화를 정리하는 작업이다. 프롬프트는 아래 override로 통째로 바뀌어 모드 정책은 쓰이지 않는다.
    mode: "companion",
    content: transcript,
    recentTurns: [],
    memories: [],
    sessionSummary: "",
    macroPrompts: [],
    broadcastStatus: [],
    allowedEmotions: [],
    allowedMotions: [],
    maxReplyLength: 400,
    timeoutMs: options.timeoutMs,
    overrideSystemPrompt: MEMORY_DIGEST_SYSTEM_PROMPT,
    overrideUserPrompt: `[1:1 대화]\n${transcript}`,
    overrideSchema: MEMORY_DIGEST_SCHEMA,
  });

  try {
    const parsed = JSON.parse(result.raw) as { memories?: unknown };
    if (!Array.isArray(parsed.memories)) return null;
    const texts = parsed.memories
      .filter((entry): entry is string => typeof entry === "string")
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
    return [...new Set(texts)].slice(0, PRIVATE_MEMORY_DIGEST_LIMIT);
  } catch {
    return null;
  }
}
