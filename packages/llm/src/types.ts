import type { ConversationMode } from "@bori/character";
import type { CharacterResponse } from "@bori/shared";

/** 어댑터에 넘기는 대화 문맥. 선별된 채팅만 들어간다. */
export type LlmRequest = {
  /**
   * 대화 모드. 같은 페르소나 위에 모드별 대화 정책을 얹는다.
   * 방송 서버는 항상 "broadcast"를 넘긴다.
   */
  mode: ConversationMode;
  /** 답변 대상 채팅 내용. 닉네임은 넣지 않는다. */
  content: string;
  /** 최근 대화. 오래된 것부터 순서대로. */
  recentTurns: readonly { role: "viewer" | "bori"; text: string }[];
  /** 장기 기억에서 고른 문장. 기억 시스템 연결 전에는 비어 있다. */
  memories: readonly string[];
  /**
   * 이번 방송의 누적 요약. recentTurns 창 밖으로 밀려난 흐름이 여기에만 남는다.
   * 요약을 쓰지 않을 때는 빈 문자열이다.
   */
  sessionSummary: string;
  /**
   * 채팅 키워드로 켜진 참고 정보. 기억과 달리 임베딩 왕복 없이 즉시 붙는다.
   * 고유명사처럼 철자가 정해진 대상에 쓴다.
   */
  macroPrompts: readonly string[];
  /**
   * 방송 경과 시간과 답변 수처럼 모델이 스스로 셀 수 없는 값.
   * 모델에게 세라고 시키지 않고 서버가 계산해서 문장으로 넘긴다.
   */
  broadcastStatus: readonly string[];
  /**
   * 오늘 날짜 문장(currentDateLine). 상황 섹션 맨 앞에 들어간다. 없으면 넣지 않는다.
   * 서버가 매 요청 시각으로 만든다. 요약·정리처럼 프롬프트를 갈아 끼우는 작업에서는 쓰이지 않는다.
   */
  currentDate?: string;
  /**
   * 위기 신호에 답할 때 모드 정책 뒤에 붙이는 지침([위기 대응]). 평소에는 비우거나 넘기지 않는다.
   * 서버가 위기를 감지했을 때만 넣으므로 매 턴 시스템 프롬프트가 커지지 않는다.
   */
  crisisGuidance?: readonly string[];
  /**
   * 방송 진행기가 단계에 들어갈 때 주는 지시([방송 단계]). 서버가 넣는 지침이라 system 메시지에 둔다.
   * 지시만 있고 content가 비어 있으면 채팅 없이 지시대로 말하는 턴이다.
   */
  stageDirective?: string;
  /**
   * 서버가 집계한 게임 수치 줄([게임 데이터]). 보리는 이 수치만 말한다. 없으면 섹션을 넣지 않는다.
   * 서버가 만든 줄이지만 외부 API 이름이 섞이므로 사람이 쓴 글처럼 다듬어 넣는다.
   */
  gameData?: readonly string[];
  /** 허용된 감정 이름. 이 밖의 값은 검증에서 걸러진다. */
  allowedEmotions: readonly string[];
  /**
   * 허용된 모션. 이름이 무슨 동작인지 알 수 없는 값이라 설명을 함께 넘긴다.
   * 설명이 없으면 모델이 모션을 거의 고르지 못한다.
   */
  allowedMotions: readonly { name: string; description: string }[];
  maxReplyLength: number;
  timeoutMs: number;
  /**
   * 답변 생성이 아닌 다른 작업(예: 방송 요약)에 같은 어댑터를 쓸 때 프롬프트와 스키마를 갈아 끼운다.
   * 지정하지 않으면 보리 답변용 기본값을 쓴다.
   */
  overrideSystemPrompt?: string;
  overrideUserPrompt?: string;
  overrideSchema?: object;
};

/** 업체 응답의 토큰 사용량. 사용량 집계와 비용 추정에 쓴다. */
export type LlmTokenUsage = { inputTokens: number; outputTokens: number };

/** 어댑터가 돌려주는 원본 결과. 아직 검증 전이다. */
export type LlmRawResult = {
  /** 모델이 만든 JSON 문자열. 검증은 호출자가 한다. */
  raw: string;
  latencyMs: number;
  /** 업체 응답에 usage가 있을 때만 붙는다. 없으면 추측하지 않고 비워 둔다. */
  usage?: LlmTokenUsage;
};

export type LlmAdapter = {
  readonly name: string;
  /** 키가 없으면 false. 호출 전에 확인한다. */
  isConfigured(): boolean;
  complete(request: LlmRequest): Promise<LlmRawResult>;
};

export type LlmAdapterConfig = {
  apiKey: string;
  model: string;
  /** 사내 프록시나 호환 엔드포인트를 쓸 때 바꾼다. */
  baseUrl?: string;
};

/**
 * 검증 결과. 실패 이유를 남겨 관리자 화면에 보여준다.
 * corrections는 답은 살리고 기본값으로 바꾼 곁가지 값(감정·모션·기호)의 설명이다. 실패로 세지 않는다.
 */
export type LlmValidation =
  | { ok: true; response: CharacterResponse; corrections: string[] }
  | { ok: false; reason: string };
