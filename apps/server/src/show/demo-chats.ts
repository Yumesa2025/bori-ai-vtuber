import type { ShowStage } from "@bori/shared";

/**
 * 시연 채팅 대본(2026-10-15 사용자 요청). 포트폴리오 시연용으로 시청자 채팅을 코너별 시간에 맞춰 미리 적어 두고,
 * 켜 두면 서버가 그 시간에 채팅을 올린다. 보리는 평소처럼 LLM으로 답한다(보리가 잘하는지·고장 나는지 확인하는 용도).
 * - 대본 파일: docs/broadcast/demo-chats.json. 코너마다 "코너 시작 몇 초 뒤(after), 닉네임, 채팅".
 * - 코너 시작은 진행기 단계가 바뀐 때다. 같은 코너 안에서 한 줄은 한 번만 올린다. 코너에 다시 들어오면 다시 올린다.
 * - 방송 세션 중(live)에만 올린다. 대기·엔딩에는 줄을 두지 않는다(보리가 답하지 않는다).
 */

export type DemoChat = { after: number; nickname: string; content: string };
export type DemoScript = Partial<Record<ShowStage, DemoChat[]>>;

const STAGES: readonly ShowStage[] = ["idle", "opening", "briefing", "qna", "diagnosis", "ending"];

/** 파일에서 읽은 값을 대본으로. 모양이 틀린 줄은 빼고, 대본이 아니면 null. */
export function parseDemoScript(value: unknown): DemoScript | null {
  if (typeof value !== "object" || value === null) return null;
  const corners = (value as { corners?: unknown }).corners;
  if (typeof corners !== "object" || corners === null) return null;
  const script: DemoScript = {};
  for (const stage of STAGES) {
    const lines = (corners as Record<string, unknown>)[stage];
    if (!Array.isArray(lines)) continue;
    script[stage] = lines
      .filter((line): line is DemoChat => typeof line === "object" && line !== null
        && typeof (line as DemoChat).after === "number" && (line as DemoChat).after >= 0
        && typeof (line as DemoChat).nickname === "string" && typeof (line as DemoChat).content === "string" && (line as DemoChat).content.trim().length > 0)
      .sort((a, b) => a.after - b.after);
  }
  return script;
}

export function createDemoChats(deps: {
  stage: () => ShowStage;
  epoch: () => number;
  live: () => boolean;
  /** 대본을 읽는다. 없거나 틀리면 null. 켤 때마다 다시 읽어 파일을 고친 뒤 바로 쓸 수 있다. */
  load: () => DemoScript | null;
  /** 채팅을 올린다. 받지 않았으면 그 이유. */
  post: (chat: { nickname: string; content: string }) => string | null;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let enabled = false;
  let script: DemoScript | null = null;
  let seenEpoch = deps.epoch();
  let stageStartedAt = now();
  /** 이번 코너에서 이미 올린 줄 번호. */
  let sent = new Set<number>();

  function observe() {
    const epoch = deps.epoch();
    if (epoch === seenEpoch) return;
    seenEpoch = epoch;
    stageStartedAt = now();
    sent = new Set();
  }

  return {
    /** 주기적으로 부른다. 지금 코너에서 시간이 된 줄을 올린다. */
    tick() {
      observe();
      if (!enabled || !script || !deps.live()) return;
      const lines = script[deps.stage()] ?? [];
      const elapsed = (now() - stageStartedAt) / 1000;
      lines.forEach((line, index) => {
        if (sent.has(index) || line.after > elapsed) return;
        sent.add(index);
        const rejected = deps.post({ nickname: line.nickname, content: line.content });
        if (rejected) console.warn(`[bori-server] 시연 채팅을 올리지 못했습니다(${deps.stage()} ${line.after}초): ${rejected}`);
      });
    },
    /** 켜면 대본을 다시 읽는다. 대본이 없으면 켜지지 않고 false. */
    setEnabled(next: boolean): boolean {
      if (next) {
        script = deps.load();
        if (!script) { enabled = false; return false; }
      }
      enabled = next;
      return true;
    },
    status: () => ({ enabled, lines: script ? Object.values(script).reduce((sum, lines) => sum + (lines?.length ?? 0), 0) : 0 }),
  };
}
