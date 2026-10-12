import type { LlmAdapter } from "@bori/llm";
import type { EmbeddingProvider } from "@bori/memory";
import type { UsageEvent } from "./store.js";

export type RecordUsage = (event: UsageEvent) => void;

/** 기록이 실패해도 호출 결과는 그대로 돌려준다. 사용량은 보조 기록이다. */
function safely(record: RecordUsage): RecordUsage {
  return event => {
    try {
      record(event);
    } catch (error) {
      console.error("[bori-usage] 사용량 기록 실패:", error);
    }
  };
}

/**
 * 요약·기억 정리처럼 클라이언트를 거치지 않고 어댑터를 직접 쓰는 호출을 센다.
 * 모드는 요청에 들어 있는 값을 쓴다. 요청 본문은 보지 않는다.
 */
export function trackAdapter(adapter: LlmAdapter, model: string, feature: "summary" | "digest", record: RecordUsage): LlmAdapter {
  const write = safely(record);
  return {
    name: adapter.name,
    isConfigured: () => adapter.isConfigured(),
    async complete(request) {
      try {
        const result = await adapter.complete(request);
        write({ feature, mode: request.mode, model, ok: true, ...(result.usage ? { usage: result.usage } : {}) });
        return result;
      } catch (error) {
        write({ feature, mode: request.mode, model, ok: false });
        throw error;
      }
    },
  };
}

/**
 * 임베딩 호출을 센다. 기억 패키지의 임베딩은 업체 응답의 토큰 수를 돌려주지 않아 횟수만 센다.
 * 어느 모드의 검색·저장인지 이 자리에서는 알 수 없어 모드 없이 기록한다.
 */
export function trackEmbedding(provider: EmbeddingProvider, model: string, record: RecordUsage): EmbeddingProvider {
  const write = safely(record);
  return {
    name: provider.name,
    isConfigured: () => provider.isConfigured(),
    async embed(texts) {
      try {
        const vectors = await provider.embed(texts);
        write({ feature: "embedding", mode: null, model, ok: true });
        return vectors;
      } catch (error) {
        write({ feature: "embedding", mode: null, model, ok: false });
        throw error;
      }
    },
  };
}
