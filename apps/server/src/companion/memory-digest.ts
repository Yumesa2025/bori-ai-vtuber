import { createAdapter, digestPrivateMemories, type SummaryTurn } from "@bori/llm";
import type { LlmSettings } from "@bori/shared";

/** 최근 1:1 대화에서 개인 기억 문장을 뽑는다. 정리를 건너뛰었거나 응답이 틀리면 null이다. */
export type DigestMemories = (turns: readonly SummaryTurn[]) => Promise<string[] | null>;

export type PrivateMemoryDigestDeps = {
  llmSettings: () => LlmSettings;
  apiKey: () => string;
  /**
   * 1:1 LLM 클라이언트의 회로가 열려 있는지. 열려 있으면 정리를 건너뛴다.
   * 방송 회로를 넘기면 1:1과 방송의 장애 범위가 섞이므로 반드시 1:1 것을 준다.
   */
  isCircuitOpen: () => boolean;
  /** 어댑터 생성기. 검사에서 가짜 어댑터로 바꾼다. */
  createAdapter?: typeof createAdapter;
};

/**
 * LLM 기반 개인 기억 정리기를 만든다.
 * 누적 요약과 같이 어댑터를 직접 써서, 정리가 실패해도 답변용 회로와 통계에는 영향을 주지 않는다.
 * LLM이 꺼져 있거나 키가 없거나 1:1 회로가 열려 있으면 부르지 않는다.
 */
export function createPrivateMemoryDigest(deps: PrivateMemoryDigestDeps): DigestMemories {
  const makeAdapter = deps.createAdapter ?? createAdapter;

  return async turns => {
    const settings = deps.llmSettings();
    const apiKey = deps.apiKey();
    if (!settings.enabled || apiKey.trim().length === 0) return null;
    if (deps.isCircuitOpen()) return null;

    const adapter = makeAdapter(settings.provider, { apiKey, model: settings.model });
    if (!adapter) return null;
    return digestPrivateMemories(adapter, turns, { timeoutMs: Math.max(settings.timeoutMs, 15_000) });
  };
}
