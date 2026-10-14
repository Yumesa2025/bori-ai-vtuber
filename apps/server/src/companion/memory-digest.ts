import { createAdapter, currentDateLine, digestPrivateMemories, type DigestedMemory, type DigestExisting, type SummaryTurn } from "@bori/llm";
import type { LlmSettings } from "@bori/shared";

/** 정리 한 번에 넘기는 것. existing의 id는 실제 기억 ID다. 요청에는 짧은 번호로 바꿔 넣는다. */
export type DigestRequest = {
  turns: readonly SummaryTurn[];
  /** 그 사람의 이미 저장된 개인 기억. 모델이 정정·중복을 replaces로 지정할 수 있게 넘긴다. */
  existing: readonly DigestExisting[];
  /** 현재 시각(ms). 상대적인 날짜를 날짜로 바꾸라고 오늘 날짜를 함께 넘긴다. */
  now: number;
};

/**
 * 최근 1:1 대화에서 개인 기억 문장을 뽑는다.
 * digest는 LLM을 쓸 수 없어 건너뛰었으면 null, 호출이나 응답 형식이 틀리면 예외다. replaces에는 실제 기억 ID가 담긴다.
 * isAvailable이 false면 1:1은 규칙 추출로 기억을 남긴다(ADR-023).
 */
export type DigestMemories = {
  isAvailable(): boolean;
  digest(request: DigestRequest): Promise<DigestedMemory[] | null>;
};

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

/** 요청에 넣는 기존 기억 수. 많으면 최근 것부터 이만큼만 넘긴다. */
const DIGEST_EXISTING_LIMIT = 30;

/**
 * LLM 기반 개인 기억 정리기를 만든다.
 * 누적 요약과 같이 어댑터를 직접 써서, 정리가 실패해도 답변용 회로와 통계에는 영향을 주지 않는다.
 * LLM이 꺼져 있거나 키가 없거나 1:1 회로가 열려 있으면 부르지 않는다.
 */
export function createPrivateMemoryDigest(deps: PrivateMemoryDigestDeps): DigestMemories {
  const makeAdapter = deps.createAdapter ?? createAdapter;
  const isAvailable = () => deps.llmSettings().enabled && deps.apiKey().trim().length > 0 && !deps.isCircuitOpen();

  return {
    isAvailable,
    async digest({ turns, existing, now }) {
      if (!isAvailable()) return null;
      const settings = deps.llmSettings();
      const adapter = makeAdapter(settings.provider, { apiKey: deps.apiKey(), model: settings.model });
      if (!adapter) return null;

      // 모델에는 짧은 번호(m1, m2…)만 보여 준다. 실제 ID를 넘기면 응답에서 남의 ID를 지어낼 여지가 생긴다.
      const listed = existing.slice(-DIGEST_EXISTING_LIMIT).map((memory, index) => ({ label: `m${index + 1}`, ...memory }));
      const byLabel = new Map(listed.map(memory => [memory.label, memory.id]));
      const digested = await digestPrivateMemories(adapter, turns, {
        timeoutMs: Math.max(settings.timeoutMs, 15_000),
        today: currentDateLine(now),
        existing: listed.map(memory => ({ id: memory.label, text: memory.text })),
      });
      return digested?.map(memory => ({ text: memory.text, replaces: memory.replaces.flatMap(label => byLabel.get(label) ?? []) })) ?? null;
    },
  };
}
