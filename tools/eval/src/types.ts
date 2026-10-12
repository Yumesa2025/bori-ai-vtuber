import type { ConversationMode } from "@bori/character";

/**
 * 검사 하나의 결과.
 *   pass / fail  자동 판정
 *   manual       사람이 봐야 판정할 수 있다
 *   skip         이번 실행에서 판정하지 않았다(키 없음, 범위 밖 등)
 */
export type CheckStatus = "pass" | "fail" | "manual" | "skip";

export type CheckResult = {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
};

/**
 * 시나리오 하나의 결과.
 *   out_of_scope  이 평가 방식으로는 볼 수 없는 경로(서버 차단, 혼잣말 등)
 *   skipped       실행하지 않았다(키 없음)
 *   error         호출 자체가 실패했다
 */
export type ScenarioStatus = "pass" | "fail" | "out_of_scope" | "skipped" | "error";

export type ScenarioResult = {
  id: string;
  title: string;
  mode: ConversationMode;
  status: ScenarioStatus;
  /** out_of_scope·skipped·error일 때 이유. */
  reason?: string;
  checks: CheckResult[];
  /** 실모델 평가에서 받은 답. */
  response?: {
    reply: string;
    emotion: string;
    actions: string[];
    /** actions와 감정 매핑으로 실제 화면에 나갈 모션. 없으면 null. */
    displayedMotion: string | null;
    latencyMs: number;
  };
  /** 실모델 평가의 원본 출력. 검증에 실패했을 때만 남긴다. */
  raw?: string;
};

export type StatusCounts = Record<ScenarioStatus, number>;

export type SectionResult = {
  /** 이 평가를 아예 돌리지 않았으면 그 이유. */
  skippedReason?: string;
  counts: StatusCounts;
  scenarios: ScenarioResult[];
};

export type EvalResultFile = {
  version: 1;
  label: string;
  createdAt: string;
  /** 실행 시점 커밋. 저장소 밖에서 돌리면 null. */
  commit: string | null;
  /** 모드별 시스템 프롬프트 지문. 비교할 때 프롬프트가 바뀌었는지 본다. */
  promptFingerprints: Record<ConversationMode, string>;
  scenarioCount: number;
  static?: SectionResult;
  model?: SectionResult & {
    provider: "openai";
    model: string;
    /** 기본 OpenAI 주소가 아니면 그 주소. 가짜 API로 배관만 확인한 결과를 가린다. */
    baseUrl: string | null;
  };
};

export function countStatuses(results: readonly ScenarioResult[]): StatusCounts {
  const counts: StatusCounts = { pass: 0, fail: 0, out_of_scope: 0, skipped: 0, error: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

/** 자동 판정에서 하나라도 실패하면 실패. 수동·건너뜀은 통과를 막지 않는다. */
export function statusFromChecks(checks: readonly CheckResult[]): "pass" | "fail" {
  return checks.some(check => check.status === "fail") ? "fail" : "pass";
}
