import type { EmbeddingProvider } from "./types.js";

/** 프록시나 호환 엔드포인트로 돌릴 때 환경변수로 바꾼다. 설정에 baseUrl이 오면 그쪽이 이긴다. */
const DEFAULT_BASE_URL = process.env.BORI_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
/**
 * 임베딩 요청 한 번의 상한(ms). 응답이 오지 않으면 기억 저장이 끝없이 기다리므로 끊는다.
 * 끊기면 다른 실패와 같이 다룬다. 저장은 임베딩 없이 하고, 검색은 최신·중요도 순으로 떨어진다(store.ts).
 */
export const EMBEDDING_TIMEOUT_MS = 10_000;

/**
 * OpenAI 임베딩 제공자.
 * 기억 저장 시 한 번, 검색 시 질문마다 한 번 호출한다.
 */
export function createOpenAiEmbedding(config: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }): EmbeddingProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? EMBEDDING_TIMEOUT_MS;

  return {
    name: "openai",

    isConfigured: () => config.apiKey.trim().length > 0,

    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      // 신호는 본문을 읽는 동안에도 유지되므로 응답 헤더만 오고 본문이 멈춘 경우도 끊긴다.
      const signal = AbortSignal.timeout(timeoutMs);
      let payload: { data?: { embedding?: number[]; index?: number }[] };
      try {
        const response = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal,
        });

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 200);
          throw new Error(`임베딩 ${response.status}: ${detail}`);
        }

        payload = await response.json() as typeof payload;
      } catch (error) {
        if (signal.aborted) throw new Error(`임베딩 응답이 ${timeoutMs}ms 안에 오지 않았습니다.`);
        throw error;
      }
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
