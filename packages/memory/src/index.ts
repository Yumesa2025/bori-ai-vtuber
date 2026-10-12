export type {
  EmbeddingProvider,
  MemoryAccess,
  MemoryCandidate,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemorySettings,
} from "./types.js";
export { cosineSimilarity, createOpenAiEmbedding } from "./embedding.js";
export { ANONYMOUS_VIEWER_ID, canAccessMemory, isAnonymousViewer } from "./access.js";
export { MEMORY_FILE_VERSION, migrateMemoryFile, type MemoryMigrationResult } from "./migrate.js";
export { createMemoryStore, type MemoryStore, type MemoryStoreOptions } from "./store.js";
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
