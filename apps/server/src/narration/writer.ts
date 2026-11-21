/**
 * 사실 목록으로 보리 대사를 쓰는 LLM 호출(설계 3절 2).
 * packages/llm을 직접 부르지 않고 좁은 함수(NarrationLlm)를 주입받는다. 마무리 단계에서 서버가 이 함수를
 * packages/llm 어댑터(overrideSystemPrompt·overrideUserPrompt·overrideSchema 경로)와 사용량 기록(모드 narration)에 잇는다.
 * LLM 출력은 여기서는 모양만 본다. 숫자·이름 검사는 check.ts가 한다.
 */
import { boriEmotionDescriptions, boriEmotionNames } from "@bori/live2d";
import type { RawLine } from "./check.js";
import type { NarrationFact } from "./facts.js";

export type NarrationLlmRequest = { systemPrompt: string; userPrompt: string; schema: object; timeoutMs: number; maxOutputTokens?: number };

/**
 * 구조화 출력 한 번. raw는 모델이 준 JSON 문자열이거나 이미 푼 값이다.
 * 꺼짐·키 없음·회로 열림·호출 실패는 { ok: false }로 돌려준다(던져도 실패로 받는다).
 */
export type NarrationLlm = (request: NarrationLlmRequest) => Promise<{ ok: true; raw: unknown } | { ok: false; reason: string }>;

/** 5줄 × 80자 한국어 JSON이 넉넉히 들어가는 출력 상한 */
export const NARRATION_MAX_OUTPUT_TOKENS = 1024;

/**
 * 시스템 지시. 말투는 packages/character 보리 프로필(한국어 존댓말만, 감정 표현이 풍부하고 귀엽다, 좋아하는 게임 이터널리턴)과 맞춘다.
 * 1:1 대화도 방송도 아니므로 여러분·시청자 같은 방송 호칭은 쓰지 않게 한다. [초안 · 검토 필요]
 */
export const NARRATION_SYSTEM_PROMPT = [
  "너는 보리다. 이터널리턴을 좋아하는 AI 캐릭터로, 화면 앞의 한 사람에게 오늘의 이터널리턴 메타 분석을 읽어 준다.",
  "[말투]",
  "- 한국어 존댓말만 쓴다. 감정 표현이 풍부하고 귀엽지만 수치는 정확하게 말한다.",
  "- 여러분·시청자·채팅 같은 방송 말은 쓰지 않는다.",
  "[지켜야 할 것]",
  "- [사실 목록]에 있는 수치와 캐릭터·무기 이름만 말한다. 목록에 없는 숫자를 만들거나 계산하지 않고, 숫자는 목록에 적힌 모양 그대로 쓴다.",
  "- 무기 특성, 스킬, 빌드 효과, 패치 내용, 강해지거나 약해진 이유는 지어내지 않는다.",
  "- 수치를 말한 뒤에 '좋아 보이는 것 같아요'처럼 '~같아요' 꼴의 짧은 생각을 한마디 붙여도 된다.",
  "- 3~5줄로 말한다. 한 줄은 한두 문장이고 80자 안쪽이다.",
  "- 줄마다 근거가 된 사실의 id(f1 등)를 factIds에 넣는다. 수치나 이름을 말하지 않는 줄은 빈 배열이다.",
  "[감정] emotion은 아래 중 하나를 고른다. 대부분 gaming·happy·calm·curious이면 된다.",
  ...boriEmotionNames.map(name => `- ${name}: ${boriEmotionDescriptions[name] ?? ""}`),
].join("\n");

/** { lines: [{ text, emotion, factIds }] }. OpenAI strict 모드에 맞게 모든 키를 required로 두고 추가 키를 막는다. */
export function narrationSchema(): object {
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            emotion: { type: "string", enum: [...boriEmotionNames] },
            factIds: { type: "array", items: { type: "string" } },
          },
          required: ["text", "emotion", "factIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["lines"],
    additionalProperties: false,
  };
}

export function narrationUserPrompt(facts: readonly NarrationFact[]): string {
  return `[사실 목록]\n${facts.map(fact => `${fact.id}: ${fact.text}`).join("\n")}`;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === "string");

function parseLines(raw: unknown): RawLine[] | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  const lines = (value as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return null;
  const parsed: RawLine[] = [];
  for (const line of lines) {
    const { text, emotion, factIds } = (line ?? {}) as Record<string, unknown>;
    if (typeof text !== "string" || typeof emotion !== "string" || !isStringArray(factIds)) return null;
    parsed.push({ text, emotion, factIds });
  }
  return parsed;
}

/** LLM으로 대사를 쓴다. 실패 이유는 로그용이며 대사 본문은 담지 않는다. */
export async function writeLines(llm: NarrationLlm, facts: readonly NarrationFact[], timeoutMs: number): Promise<{ ok: true; lines: RawLine[] } | { ok: false; reason: string }> {
  let result: Awaited<ReturnType<NarrationLlm>>;
  try {
    result = await llm({ systemPrompt: NARRATION_SYSTEM_PROMPT, userPrompt: narrationUserPrompt(facts), schema: narrationSchema(), timeoutMs, maxOutputTokens: NARRATION_MAX_OUTPUT_TOKENS });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  const lines = parseLines(result.raw);
  return lines ? { ok: true, lines } : { ok: false, reason: "대사 응답 모양이 맞지 않습니다." };
}
