/** 장기 기억 한 건. 계획서 12장의 항목을 그대로 담는다. */
export type MemoryRecord = {
  id: string;
  /** 기억 문장. 방송 화면에 그대로 나가지 않고 LLM 문맥으로만 쓴다. */
  text: string;
  /** broadcast: 방송 전체 요약, viewer: 시청자 관련 기억 */
  kind: "broadcast" | "viewer";
  /** 시청자별 기억일 때의 내부 사용자 ID. 닉네임은 저장하지 않는다. */
  viewerId?: string;
  /** 0~1. 낮은 기억은 검색에서 밀린다. */
  importance: number;
  /** 0~1. 확신이 낮은 기억은 혼잣말에 쓰지 않는다. */
  confidence: number;
  /** 여러 방송에서 반복해서 나온 횟수. */
  repeatCount: number;
  createdAt: string;
  expiresAt: string;
  /** 임베딩. 아직 계산하지 못했으면 비어 있고, 그때는 검색에서 최신순으로만 다룬다. */
  embedding?: number[];
};

/** 저장 전 후보. 방송 중에 모았다가 종료 시 정리한다. */
export type MemoryCandidate = {
  text: string;
  kind: MemoryRecord["kind"];
  viewerId?: string;
  importance: number;
  confidence: number;
};

/** 임베딩 제공자. 업체를 바꿔도 검색 코드는 그대로 둔다. */
export type EmbeddingProvider = {
  readonly name: string;
  isConfigured(): boolean;
  embed(texts: readonly string[]): Promise<number[][]>;
};

export type MemorySearchHit = {
  record: MemoryRecord;
  /** 코사인 유사도. 임베딩이 없으면 0이다. */
  score: number;
};

export type MemorySettings = {
  enabled: boolean;
  /** LLM 프롬프트에 넣을 최대 기억 수. */
  maxMemories: number;
  /** 이 유사도 아래는 관련 없다고 본다. */
  minSimilarity: number;
  /** 저장한 기억의 기본 수명. */
  retentionDays: number;
  embeddingModel: string;
};
