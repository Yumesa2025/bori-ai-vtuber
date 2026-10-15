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
  /** 이번 답변을 말하는 시간(ms). 음성이 있으면 음성 길이, 없으면 말풍선 표시 시간이다. 자막을 두 줄씩 넘길 때 쓴다. */
  currentSpeechMs?: number;
  /** 방송 진행(쇼) 상태. 방송 진행기가 꺼져 있으면 비어 있다. */
  show?: ShowState;
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

// ── API 사용량 ──────────────────────────────────────────────
// 숫자만 다룬다. 대화 내용·닉네임·소유자 ID는 사용량 기록에 들어가지 않는다.

/** 사용량을 나누는 기능. 답변·누적 요약(방송 요약 포함)·개인 기억 정리·임베딩·음성 합성. */
export type UsageFeature = "reply" | "summary" | "digest" | "embedding" | "tts";
/** 호출한 대화 모드. 모드를 알 수 없는 호출(임베딩)은 none으로 묶는다. */
export type UsageMode = "broadcast" | "companion" | "none";

export type UsageTotals = {
  calls: number;
  /** 업체 호출 자체가 실패한 수. 응답 형식 검증 실패는 과금된 호출이라 넣지 않는다. */
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** 성공했지만 업체 응답에 토큰 수가 없던 호출. 이 호출의 비용은 추정에서 빠진다. */
  callsWithoutTokens: number;
  /** 음성 합성에 보낸 글자 수. */
  characters: number;
  /** 단가를 아는 부분만 더한 추정 비용(USD). 계산할 수 있는 부분이 하나도 없으면 null. */
  estimatedCostUsd: number | null;
  /** 단가 없음이나 토큰 정보 없음으로 추정에서 빠진 호출이 없으면 true. */
  costComplete: boolean;
};

/** 기능·모드·모델별 한 줄. costNote는 비용을 다 계산하지 못한 이유다. */
export type UsageRow = UsageTotals & {
  feature: UsageFeature;
  mode: UsageMode;
  model: string;
  costNote: "단가 없음" | "토큰 정보 없음" | "일부 호출 토큰 정보 없음" | null;
};

export type UsagePeriod = {
  /** 로컬 날짜 YYYY-MM-DD. 양 끝을 포함한다. */
  from: string;
  to: string;
  totals: UsageTotals;
  byFeature: Record<UsageFeature, UsageTotals>;
  byMode: Record<UsageMode, UsageTotals>;
  rows: UsageRow[];
  /** 이 기간에 쓰였지만 단가를 모르는 모델. */
  unpricedModels: string[];
};

/** 1M 단위 단가(USD). 해당하지 않는 항목은 비운다. */
export type UsagePrice = {
  model: string;
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  charactersPerMillionUsd?: number;
  /** default: 코드 기본값(추정치), file: data/usage-prices.json */
  source: "default" | "file";
};

export type UsageReport = {
  generatedAt: string;
  today: UsagePeriod;
  last7Days: UsagePeriod;
  last31Days: UsagePeriod;
  prices: {
    /** 기본 단가를 확인한 날짜. */
    defaultAsOf: string;
    note: string;
    /** 단가 파일을 읽었는지. 파일이 없으면 false다. */
    fileLoaded: boolean;
    /** 단가 파일을 읽지 못한 이유. 이때는 기본 단가만 쓴다. */
    fileError: string | null;
    models: UsagePrice[];
  };
};

/** 1:1 사용 통계. 숫자만 담는다. */
export type CompanionStats = {
  conversations: number;
  messages: number;
  privateMemories: number;
};

// ── 방송 진행(쇼) ─────────────────────────────────
export type ShowStage = "idle" | "opening" | "briefing" | "qna" | "diagnosis" | "ending";
export const showStages: readonly ShowStage[] = ["idle", "opening", "briefing", "qna", "diagnosis", "ending"];

/** OBS 장면 이름. OBS에서 이 이름 그대로 장면을 만든다. */
export type ObsSceneName = "보리-대기" | "보리-메인" | "보리-전적" | "보리-엔딩";

/** 이터널리턴 캐릭터 하나의 집계값. 픽률·평균 순위는 표본 기준이다. */
export type ErCharacterStat = {
  code: number;
  name: string;          // 한국어 이름
  picks: number;         // 표본 안에서 고른 횟수
  pickRate: number;      // 0~1
  avgRank: number;       // 평균 순위(1이 1등)
  top1Rate: number;      // 0~1
  mainWeapon: string;    // 가장 많이 쓴 무기 한국어 이름, 모르면 ""
};

/** 메타 집계의 기준. 화면과 보리 대사에 그대로 밝힌다. */
export type ErMetaBasis = {
  seasonName: string;    // 예: "시즌 21"
  sampleGames: number;   // 집계에 쓴 캐릭터-경기 수
  collectedAt: string;   // ISO 시각
  description: string;   // 예: "최근 7일 상위 랭커 7,200판 기준"
};

export type ErPlayerReport = {
  maskedNickname: string;   // 예: "보리팬**"
  seasonName: string;
  games: number;
  avgRank: number;
  top1Rate: number;
  recentRanks: number[];    // 최근 경기 순위, 최신이 앞, 최대 10개
  mainCharacters: Array<{ name: string; games: number; avgRank: number }>; // 최대 3개
};

export type DashboardView =
  | { kind: "season"; basis: ErMetaBasis | null }
  | { kind: "top5"; items: ErCharacterStat[]; revealed: number; basis: ErMetaBasis | null }
  | { kind: "character"; query: string; stat: ErCharacterStat | null; suggestions: string[]; basis: ErMetaBasis | null }
  | { kind: "player"; status: "waiting" | "loading" | "ready" | "not-found" | "error"; report: ErPlayerReport | null }
  | { kind: "summary"; characters: string[] };

export type ShowConnections = {
  chzzk: "off" | "connecting" | "connected" | "error";
  obs: "off" | "connecting" | "connected" | "error";
  er: "ready" | "stale" | "missing" | "refreshing";
};

export type ShowState = {
  stage: ShowStage;
  scene: ObsSceneName;
  dashboard: DashboardView;
  /** 자막. 보리의 현재 답 문장과 같지만 OBS 자막 페이지가 따로 읽는다. */
  caption: string;
  connections: ShowConnections;
  /** ER 데이터 갱신 진행률 0~1, 갱신 중이 아니면 null. */
  erRefreshProgress: number | null;
  /** 코너 자동 진행. 지금 코너에 주어진 시간(초, 제한 없으면 0)과 지난 시간(초). */
  auto?: { enabled: boolean; stageSeconds: number; elapsedSeconds: number };
};
