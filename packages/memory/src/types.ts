/**
 * 기억의 공개 범위.
 * character: 캐릭터 자신에 대한 기억. 방송과 1:1 어디서나 쓴다.
 * broadcast: 방송에서 생긴 기억. 소유자가 없으면 방송 요약, 있으면 그 시청자에게 답할 때만 쓴다.
 * private: 1:1 대화의 개인 기억. 소유자 본인과의 1:1에서만 쓴다.
 */
export type MemoryScope = "character" | "broadcast" | "private";

/** 장기 기억 한 건. 계획서 12장의 항목을 그대로 담는다. */
export type MemoryRecord = {
  id: string;
  /** 기억 문장. 방송 화면에 그대로 나가지 않고 LLM 문맥으로만 쓴다. */
  text: string;
  /** broadcast: 방송 전체 요약, viewer: 시청자 관련 기억 */
  kind: "broadcast" | "viewer";
  /** 누구에게 답할 때 이 기억을 꺼낼 수 있는지 정한다. */
  scope: MemoryScope;
  /** 시청자·사용자 소유 기억일 때의 내부 ID. 닉네임은 저장하지 않는다. */
  ownerId?: string;
  /** 0~1. 낮은 기억은 검색에서 밀린다. */
  importance: number;
  /** 0~1. 확신이 낮은 기억은 혼잣말에 쓰지 않는다. */
  confidence: number;
  /** 여러 방송에서 반복해서 나온 횟수. */
  repeatCount: number;
  createdAt: string;
  /** 같은 뜻의 기억이 마지막으로 다시 들어온 시각. 한 번만 나왔으면 비어 있다. */
  lastSeenAt?: string;
  expiresAt: string;
  /** 임베딩. 아직 계산하지 못했으면 비어 있고, 그때는 검색에서 최신순으로만 다룬다. */
  embedding?: number[];
};

/** 저장 전 후보. 방송 중에 모았다가 종료 시 정리한다. */
export type MemoryCandidate = {
  text: string;
  kind: MemoryRecord["kind"];
  scope: MemoryScope;
  ownerId?: string;
  importance: number;
  confidence: number;
};

/**
 * 검색하는 쪽이 누구인지. 검색할 때마다 반드시 넘긴다.
 * broadcast: 방송에서 speakerId 시청자에게 답할 때. 익명 채팅이면 speakerId를 비운다.
 * private: 1:1에서 userId 사용자에게 답할 때.
 */
export type MemoryAccess =
  | { mode: "broadcast"; speakerId?: string }
  | { mode: "private"; userId: string };

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
  /**
   * 1:1 대화에서 사용자 메시지가 이만큼 쌓일 때마다 LLM으로 개인 기억을 정리한다. 0이면 정리하지 않는다.
   * 규칙 추출은 이 값과 상관없이 메시지마다 돈다.
   */
  privateDigestEveryMessages: number;
};
