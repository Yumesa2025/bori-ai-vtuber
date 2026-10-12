import { buildSystemPrompt, buildUserPrompt, responseJsonSchema } from "./prompt.js";
import { redactSecrets } from "./redact.js";
import type { LlmAdapter, LlmAdapterConfig, LlmRawResult, LlmRequest } from "./types.js";
import { tokenUsageFrom } from "./usage.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const TOOL_NAME = "bori_response";

/**
 * Anthropic Messages 어댑터.
 * 구조화 출력은 도구 호출로 받는다. 도구 입력 스키마가 OpenAI의 json_schema와 같은 모양이다.
 *
 * 주의: 아직 실제 키로 검증하지 않았다. 구조 교체가 되는지 확인하기 위한 두 번째 어댑터다.
 */
export function createAnthropicAdapter(config: LlmAdapterConfig): LlmAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    name: "anthropic",

    isConfigured: () => config.apiKey.trim().length > 0,

    async complete(request: LlmRequest): Promise<LlmRawResult> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 512,
            system: request.overrideSystemPrompt ?? buildSystemPrompt(request),
            messages: [{ role: "user", content: request.overrideUserPrompt ?? buildUserPrompt(request) }],
            tools: [{ name: TOOL_NAME, description: "보리의 답변과 감정, 행동", input_schema: request.overrideSchema ?? responseJsonSchema }],
            tool_choice: { type: "tool", name: TOOL_NAME },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // 응답 본문에 키가 섞여 들어가지 않도록 키 모양 문자열을 가린 뒤 앞부분만 남긴다.
          const detail = redactSecrets(await response.text(), [config.apiKey]).slice(0, 200);
          throw new Error(`Anthropic ${response.status}: ${detail}`);
        }

        const payload = await response.json() as {
          content?: { type?: string; name?: string; input?: unknown }[];
          usage?: { input_tokens?: unknown; output_tokens?: unknown };
        };
        const toolUse = payload.content?.find(block => block.type === "tool_use" && block.name === TOOL_NAME);
        if (!toolUse?.input) throw new Error("Anthropic 응답에 도구 호출 결과가 없습니다.");

        // 캐시 읽기·쓰기 토큰은 단가가 달라 넣지 않는다. 이 어댑터는 프롬프트 캐시를 쓰지 않는다.
        const usage = tokenUsageFrom(payload.usage?.input_tokens, payload.usage?.output_tokens);
        // 뒤에서 JSON 검증을 그대로 태우기 위해 문자열로 되돌린다.
        return { raw: JSON.stringify(toolUse.input), latencyMs: Date.now() - startedAt, ...(usage ? { usage } : {}) };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Anthropic 응답이 ${request.timeoutMs}ms 안에 오지 않았습니다.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
