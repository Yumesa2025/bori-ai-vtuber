/** 지원하는 LLM 제공 업체. 어댑터를 추가하면 여기에 이름을 늘린다. */
export type LlmProvider = "openai" | "anthropic" | "gemini";

export type LlmSettings = {
  enabled: boolean;
  provider: LlmProvider;
  model: string;
  /** 응답 한 줄의 최대 길이(글자). 자막과 음성 길이를 고려한 값이다. */
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

// ── API 사용량 ──────────────────────────────────────────────
// 숫자만 다룬다. 대사 내용·닉네임은 사용량 기록에 들어가지 않는다.

/**
 * 사용량을 나누는 기능. reply(LLM 대사)·tts(음성 합성)만 새로 기록한다.
 * summary·digest·embedding은 1:1 대화를 쓰던 때(2026-11-21 이전)의 기록을 읽기 위해 남긴다.
 */
export type UsageFeature = "reply" | "summary" | "digest" | "embedding" | "tts";
/**
 * 호출한 모드. 새 기록은 narration(보리 읽어 주기)과 모를 때의 none뿐이다.
 * broadcast·companion은 방송·1:1 대화를 쓰던 때의 기록을 읽어 보여 주기만 한다(위험 R5).
 */
export type UsageMode = "narration" | "broadcast" | "companion" | "none";

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

/** 이터널리턴 데이터 상태. 화면 배지와 자동 갱신 판단에 쓴다. */
export type ErConnection = "ready" | "stale" | "missing" | "refreshing";

// ── 이터널리턴 메타 대시보드 (2026-11-21 설계, docs/superpowers/specs/2026-11-21-er-meta-dashboard-design.md) ──

/** 캐릭터+무기 조합 하나의 집계. 비율은 0~1, 순위는 1이 1등. */
export type ErComboStat = {
  characterCode: number;
  characterName: string;
  /** 무기를 모르면 0과 "" */
  weaponCode: number;
  weaponName: string;
  participants: number;
  /** 전체 참가자 대비 */
  pickRate: number;
  avgRank: number;
  top1Rate: number;
  /** 랭크 MMR 증감 표본이 없으면 null */
  avgMmrGain: number | null;
  avgKills: number;
  avgAssists: number;
  avgDeaths: number;
  avgDamage: number;
  /** 많이 고른 코어 특성, 최대 2 */
  topTraits: Array<{ code: number; name: string; rate: number }>;
  /** 부위(0~4)별 많이 쓴 최종 장비, 부위마다 최대 2 */
  topEquipment: Array<{ slot: number; items: Array<{ code: number; name: string; rate: number }> }>;
  /** 참가자 30명 미만 */
  lowSample: boolean;
  /** 직전 갱신 대비 변화량(이번 값 − 직전 값). 직전 갱신이 없거나 그때 없던 조합이면 null */
  change: { avgRank: number; top1Rate: number; pickRate: number; avgMmrGain: number | null } | null;
};

/** 대시보드 집계의 기준. 화면과 보리 대사에 그대로 밝힌다. */
export type ErMetaBasisV2 = {
  seasonId: number;
  /** 게임 표기, 예: "시즌 13" */
  seasonName: string;
  /** 표본에서 가장 많은 패치, 예: "1.47". 모르면 null */
  patch: string | null;
  /** 집계한 경기 수 */
  games: number;
  /** 집계한 참가자 수(경기 수 × 참가자) */
  participants: number;
  rankers: number;
  gamesPerRanker: number;
  collectedAt: string;
  previousCollectedAt: string | null;
  /** 직전 갱신과 시즌이나 패치가 다르다 */
  patchChanged: boolean;
};

/** 대시보드 "내 전적" 칸. 닉네임은 본인 화면에만 보이고 로그·LLM에는 넣지 않는다. */
export type ErPlayerSummary = {
  nickname: string;
  seasonName: string;
  mmr: number | null;
  /** 0~1, 작을수록 상위 */
  rankPercent: number | null;
  games: number;
  avgRank: number;
  top1Rate: number;
  avgKills: number | null;
  avgAssists: number | null;
  /** 최근 경기, 최신 먼저, 최대 10 */
  recent: Array<{ characterName: string; weaponName: string; rank: number; kills: number; mmrGain: number | null }>;
  /** 많이 한 캐릭터, 최대 3. metaRank는 현재 메타 조합 순위(픽률 순)에서 그 캐릭터 최고 조합의 순위 */
  mainCharacters: Array<{ name: string; games: number; avgRank: number; metaRank: number | null }>;
};

/** 보리가 읽는 대사 한 줄. emotion은 packages/character의 감정 이름. */
export type NarrationLine = { text: string; emotion: string; audioId?: string };

export type Narration = {
  id: string;
  createdAt: string;
  /** LLM이 썼는지, 정해진 문장인지 */
  source: "llm" | "template";
  lines: NarrationLine[];
};

export type DashboardPlayerStatus = "unset" | "loading" | "ready" | "not-found" | "error";

/** GET /api/dashboard 응답 */
export type DashboardState = {
  connection: ErConnection;
  /** available: 갱신할 수 있는지(ER_API_KEY가 있는지). false면 화면은 "키 없음"을 보이고 갱신 버튼을 끈다 */
  refresh: { available: boolean; running: boolean; progress: number | null; lastError: string | null; autoStarted: boolean };
  basis: ErMetaBasisV2 | null;
  /** 픽률 순 */
  combos: ErComboStat[];
  player: { status: DashboardPlayerStatus; summary: ErPlayerSummary | null };
  narration: Narration | null;
};

/** GET/PUT /api/dashboard/settings */
export type DashboardSettings = { nickname: string | null };
