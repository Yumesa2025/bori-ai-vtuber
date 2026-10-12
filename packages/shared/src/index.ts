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

/**
 * 방송 상태로 내보내는 채팅. 화면에 필요한 값만 남긴다.
 * viewerId는 닉네임에서 만든 값(`local:<닉네임>`)이라 내보내면 닉네임이 그대로 드러난다.
 */
export type VisibleChat = Pick<ChatMessage, "id" | "content" | "receivedAt" | "category">;

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
  /**
   * 방송 중 누적 요약.
   * 최근 대화는 몇 턴만 유지되므로 그 창 밖으로 밀려난 흐름은 그대로 사라진다.
   * 켜 두면 일정 턴마다 지금까지의 대화를 한 문단으로 접어 문맥에 계속 넣는다.
   */
  rollingSummaryEnabled: boolean;
  /** 누적 요약을 갱신하는 주기(턴 수). 매 턴 요약하지 않아 비용과 지연이 낮다. */
  rollingSummaryTurns: number;
  /** 키워드 매크로. 고유명사는 벡터 검색보다 키워드 매칭이 정확하고 왕복이 없다. */
  macroEnabled: boolean;
};

/**
 * 키워드로 켜지는 참고 정보 한 덩어리.
 * 벡터 검색과 달리 임베딩 왕복이 없고, 고유명사처럼 철자가 정해진 대상에 정확하다.
 * data/macros.json에서 읽는다.
 */
export type MacroPrompt = {
  id: string;
  /** 이 중 하나라도 채팅에 나오면 켜진다. 최대 5개까지만 쓴다. */
  keywords: string[];
  /** 켜졌을 때 문맥에 붙는 텍스트. 짧게 쓴다. */
  prompt: string;
  /** 동시 활성 한도를 넘으면 이 값이 큰 것부터 남는다. */
  priority: number;
  /** 몇 번의 답변 동안 켜져 있을지. 1~5. */
  durationTurns: number;
};

/** 관리자에게 보여줄 매크로 상태. */
export type MacroStatus = {
  /** 파일에서 읽어 들인 매크로 수. */
  loaded: number;
  /** 지금 켜져 있는 매크로와 남은 턴. */
  active: { id: string; remainingTurns: number }[];
  /** 매크로 파일 경로. 관리자가 직접 편집한다. */
  path: string;
  /** 파일을 읽지 못했을 때의 이유. */
  error: string | null;
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
  visibleChats: VisibleChat[];
  unprocessedCount: number;
  currentResponse?: CharacterResponse;
  topAlert?: { message: string; severity: "info" | "error" };
  lastTestAction?: TestAction;
  /** 이번 답변의 음성 식별자. `/api/tts/{id}`로 받아 재생한다. 음성이 없으면 비어 있다. */
  currentAudioId?: string;
};

// ── 1:1 대화(companion) API ─────────────────────────────────
// 소유자는 서버가 정한다. 응답에는 소유자 ID를 싣지 않는다.

/** 1:1 대화 하나. 목록은 updatedAt 내림차순이다. */
export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

/**
 * 보리 답변이 만들어진 경로.
 * llm: LLM 답변, rule: 규칙 문장, fallback: LLM을 쓸 수 없어 쓴 폴백 문장, blocked: 위험 주제 거절 문장.
 */
export type ConversationMessageSource = "llm" | "rule" | "fallback" | "blocked";

/** 1:1 대화 메시지. emotion·actions·source는 보리 메시지에만 있다. */
export type ConversationMessage = {
  id: string;
  role: "user" | "bori";
  content: string;
  createdAt: string;
  emotion?: { primary: string; intensity: number; durationSeconds: number };
  actions?: { name: string; layer: CharacterResponse["actions"][number]["layer"]; priority: number }[];
  source?: ConversationMessageSource;
};

/** `POST /api/conversations/:id/messages` 응답. 폴백 문장을 썼으면 failure에 이유의 종류가 있다. */
export type SendConversationMessageResult = {
  userMessage: ConversationMessage;
  reply: ConversationMessage;
  /** 음성 식별자. `/api/tts/{id}`로 받는다. 요청하지 않았거나 만들지 못했으면 없다. */
  audioId?: string;
  failure?: { kind: string };
};

/** 1:1 사용자 본인의 개인 기억. 원문과 수명만 보여 준다. */
export type CompanionMemory = {
  id: string;
  text: string;
  createdAt: string;
  expiresAt: string;
};

/** 1:1 화면에 보여 줄 캐릭터 정보. 시스템 프롬프트 전체나 내부 규칙은 담지 않는다. */
export type CharacterProfile = {
  name: string;
  personaLines: string[];
  companionPolicyTitle: string;
};

/** 1:1 화면이 쓸 수 있는 감정·표정·모션 이름. */
export type CharacterCatalog = {
  emotions: string[];
  expressions: string[];
  motions: { name: string; description: string }[];
};
