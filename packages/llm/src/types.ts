/**
 * 어댑터에 넘기는 요청. 프롬프트와 구조화 출력 스키마를 부르는 쪽이 다 만들어 넘긴다.
 * 2026-11-21 대화 프롬프트 조립(prompt.ts)을 지우면서 대화 전용 칸(모드·최근 대화·기억·감정 목록 등)을 모두 뺐다.
 * 칸 이름(override*)은 예전 "답변 대신 다른 작업" 경로의 이름을 그대로 쓴다.
 */
export type LlmRequest = {
  /** system 메시지(Anthropic은 system 칸). */
  overrideSystemPrompt: string;
  /** user 메시지. */
  overrideUserPrompt: string;
  /** 구조화 출력 JSON 스키마. OpenAI는 json_schema(strict), Anthropic은 도구 입력 스키마로 보낸다. */
  overrideSchema: object;
  /** 업체 응답을 기다리는 상한. 429 재시도도 이 안에서 끝난다. */
  timeoutMs: number;
  /** 출력 토큰 상한. 없으면 DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
};

/** 출력 토큰 상한 기본값. 대사 3~5줄 JSON이 넉넉히 들어간다. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

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
