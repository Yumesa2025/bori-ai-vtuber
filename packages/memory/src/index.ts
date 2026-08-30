export type {
  EmbeddingProvider,
  MemoryCandidate,
  MemoryRecord,
  MemorySearchHit,
  MemorySettings,
} from "./types.js";
export { cosineSimilarity, createOpenAiEmbedding } from "./embedding.js";
export { createMemoryStore, type MemoryStore } from "./store.js";
export { extractMemoryCandidates, isStorableMemory, type ConversationTurn } from "./extract.js";

import type { MemorySettings } from "./types.js";

export const defaultMemorySettings: MemorySettings = {
  enabled: true,
  maxMemories: 5,
  // 임계값을 낮게 둔다. 관련 기억을 놓치는 것보다 조금 넉넉히 넣는 편이 낫다.
  minSimilarity: 0.3,
  retentionDays: 30,
  embeddingModel: "text-embedding-3-small",
};
