import type { EmbeddingProvider } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI 임베딩 제공자.
 * 기억 저장 시 한 번, 검색 시 질문마다 한 번 호출한다.
 */
export function createOpenAiEmbedding(config: { apiKey: string; model: string; baseUrl?: string }): EmbeddingProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    name: "openai",

    isConfigured: () => config.apiKey.trim().length > 0,

    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new Error(`임베딩 ${response.status}: ${detail}`);
      }

      const payload = await response.json() as { data?: { embedding?: number[]; index?: number }[] };
      const rows = payload.data ?? [];
      if (rows.length !== texts.length) throw new Error("임베딩 개수가 입력과 다릅니다.");

      // index 순서가 보장되지 않을 수 있어 정렬한다.
      const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return sorted.map(row => {
        if (!Array.isArray(row.embedding)) throw new Error("임베딩 형식이 올바르지 않습니다.");
        return row.embedding;
      });
    },
  };
}

/** 코사인 유사도. 임베딩 길이가 다르면 0으로 본다. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
