export type ChatCategory =
  | "normal"
  | "question"
  | "compliment"
  | "concern"
  | "spam"
  | "unsafe";

export type ChatSource = "manual" | "scenario" | "chzzk";

export type QueueSettings = {
  responseDelayMinSeconds: number;
  responseDelayMaxSeconds: number;
  maxQueueSize: number;
  visibleChatLimit: number;
  duplicateWindowMinutes: number;
  /** 같은 답변 문장을 다시 쓰지 않는 시간. */
  sameReplyCooldownMinutes: number;
  /** 채팅이 없을 때 보리가 혼잣말을 할지 여부. */
  monologueEnabled: boolean;
  monologueMinSeconds: number;
  monologueMaxSeconds: number;
};

export type ChatMessage = {
  id: string;
  viewerId: string;
  viewerNickname?: string;
  content: string;
  receivedAt: string;
  source: ChatSource;
  category?: ChatCategory;
};

export type CharacterResponse = {
  reply: string;
  emotion: {
    primary: string;
    secondary?: string;
    intensity: number;
    durationSeconds: number;
    decayStyle?: string;
  };
  actions: Array<{
    name: string;
    priority: number;
    layer: "face" | "body" | "system";
  }>;
  source: "rule" | "llm" | "monologue";
};

/** 지원하는 LLM 제공 업체. 어댑터를 추가하면 여기에 이름을 늘린다. */
export type LlmProvider = "openai" | "anthropic" | "gemini";

export type LlmSettings = {
  enabled: boolean;
  provider: LlmProvider;
  model: string;
  /** 응답 최대 길이. 방송 말풍선과 TTS 지연을 고려한 값이다. */
  maxReplyLength: number;
  timeoutMs: number;
  /** 연속 실패가 이 횟수에 닿으면 LLM 호출을 잠시 멈춘다. */
  failureThreshold: number;
  cooldownSeconds: number;
};

/** 관리자에게 보여줄 LLM 상태. API 키 자체는 절대 내보내지 않는다. */
export type LlmStatus = {
  enabled: boolean;
  provider: LlmProvider;
  model: string;
  /** 키가 설정되어 있는지 여부만 알린다. */
  hasApiKey: boolean;
  /** 회로 차단기가 열려 LLM 호출을 멈춘 상태인지. */
  circuitOpen: boolean;
  callCount: number;
  failureCount: number;
  validationFailureCount: number;
  consecutiveFailures: number;
  averageLatencyMs: number;
  lastError: string | null;
};

export type SessionStatus = "idle" | "live" | "ending" | "ended";

/**
 * 관리자가 실행한 표정·모션 테스트 명령.
 * 방송 화면이 상태를 폴링으로 받으므로, seq로 이미 처리한 명령을 구분한다.
 */
export type TestAction = {
  seq: number;
  kind: "expression" | "motion";
  name: string;
};

export type BroadcastState = {
  status: SessionStatus;
  layout: "chat" | "content";
  currentEmotion: string;
  queueSize: number;
  visibleChatCount: number;
  lastError: string | null;
  visibleChats: ChatMessage[];
  unprocessedCount: number;
  currentResponse?: CharacterResponse;
  topAlert?: { message: string; severity: "info" | "error" };
  lastTestAction?: TestAction;
  /** 이번 답변의 음성 식별자. `/api/tts/{id}`로 받아 재생한다. 음성이 없으면 비어 있다. */
  currentAudioId?: string;
};
