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
    content: transcript,
    recentTurns: [],
    memories: [],
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
