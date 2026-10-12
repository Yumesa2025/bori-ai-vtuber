import type { LlmTokenUsage } from "./types.js";

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * 업체 응답의 토큰 수를 공통 형태로 바꾼다.
 * OpenAI는 prompt_tokens·completion_tokens, Anthropic은 input_tokens·output_tokens로 준다.
 * 둘 중 하나라도 없거나 숫자가 아니면 undefined다. 모르는 값을 0으로 채우면 비용이 실제보다 적게 보인다.
 */
export function tokenUsageFrom(input: unknown, output: unknown): LlmTokenUsage | undefined {
  return isCount(input) && isCount(output) ? { inputTokens: input, outputTokens: output } : undefined;
}
