import { buildSystemPrompt, buildUserPrompt, responseJsonSchema } from "./prompt.js";
import type { LlmAdapter, LlmAdapterConfig, LlmRawResult, LlmRequest } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI Chat Completions 어댑터.
 * Structured Outputs로 JSON 스키마를 강제하지만, 출력은 여전히 validateLlmOutput으로 검증한다.
 */
export function createOpenAiAdapter(config: LlmAdapterConfig): LlmAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    name: "openai",

    isConfigured: () => config.apiKey.trim().length > 0,

    async complete(request: LlmRequest): Promise<LlmRawResult> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: request.overrideSystemPrompt ?? buildSystemPrompt(request) },
              { role: "user", content: request.overrideUserPrompt ?? buildUserPrompt(request) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "bori_response", strict: true, schema: request.overrideSchema ?? responseJsonSchema },
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // 응답 본문에 키가 섞여 들어가지 않도록 앞부분만 남긴다.
          const detail = (await response.text()).slice(0, 200);
          throw new Error(`OpenAI ${response.status}: ${detail}`);
        }

        const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("OpenAI 응답에 content가 없습니다.");

        return { raw: content, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`OpenAI 응답이 ${request.timeoutMs}ms 안에 오지 않았습니다.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
