import type { ConversationMode, ConversationPolicy } from "@bori/character";
import type { MacroPrompt } from "@bori/shared";

/** LLM 문맥에 들어가는 발언 하나. */
export type Turn = { role: "viewer" | "bori"; text: string };
/** 세션 전체 기록의 발언 하나. 기억 후보를 뽑을 때 누구의 발언인지 알아야 하므로 viewerId를 함께 둔다. */
export type SessionTurn = Turn & { viewerId?: string };
export type ActiveMacro = { macro: MacroPrompt; remainingTurns: number };

/**
 * 대화 하나의 상태. 방송은 방송 시작마다, 1:1은 사용자별로 새로 만든다.
 * 서로 다른 세션은 아무것도 공유하지 않는다. 한 대화의 문맥·요약·매크로가 다른 대화로 새지 않게 하기 위한 것이다.
 */
export type ConversationSession = {
  readonly mode: ConversationMode;
  /** 세션을 만들 때 고정한 모드 정책. 대화 도중에 다른 모드 정책으로 바뀌지 않는다. */
  readonly policy: ConversationPolicy;
  /** 최근 대화. LLM 문맥으로만 쓰고 방송 화면에는 보내지 않는다. */
  recentTurns: Turn[];
  /** 이번 세션의 전체 대화. 방송은 종료 시 여기서 기억 후보를 뽑는다. */
  sessionTurns: SessionTurn[];
  /** 누적 요약. recentTurns 창 밖으로 밀려난 흐름이 여기에 남는다. */
  summary: string;
  /** 누적 요약이 이미 반영한 sessionTurns 개수. 아직 안 접힌 대화만 다음 요약에 넘긴다. */
  summarizedTurnCount: number;
  /** 요약 호출이 진행 중인지. 겹쳐 부르면 같은 대화를 두 번 접게 된다. */
  summaryInFlight: boolean;
  /** 누적 요약이 갱신될 때 부른다. 1:1은 대화 레코드에 저장하고, 방송은 쓰지 않는다. */
  onSummary?: (summary: string) => void;
  /** 지금 켜져 있는 매크로. 답변을 한 번 내보낼 때마다 남은 턴이 줄어든다. */
  activeMacros: ActiveMacro[];
  /** 답변 문장별 마지막 사용 시각. 같은 문장을 연달아 쓰지 않기 위한 기록이다. */
  replyLastUsedAt: Map<string, number>;
};

// 발언 10개 = 채팅 5건. 그 앞의 내용은 누적 요약이 대신 붙든다.
export const RECENT_TURN_LIMIT = 10;

export function createSessionState(policy: ConversationPolicy): ConversationSession {
  return {
    mode: policy.mode,
    policy,
    recentTurns: [],
    sessionTurns: [],
    summary: "",
    summarizedTurnCount: 0,
    summaryInFlight: false,
    activeMacros: [],
    replyLastUsedAt: new Map(),
  };
}

/** 최근 대화를 짧게 유지한다. LLM 문맥 길이를 제한하기 위한 것이다. */
export function pushTurn(session: ConversationSession, turn: SessionTurn) {
  session.recentTurns.push({ role: turn.role, text: turn.text });
  while (session.recentTurns.length > RECENT_TURN_LIMIT) session.recentTurns.shift();
  // 기억 후보 추출은 세션 전체 대화를 대상으로 하므로 따로 쌓아 둔다.
  session.sessionTurns.push({ role: turn.role, text: turn.text, ...(turn.viewerId ? { viewerId: turn.viewerId } : {}) });
}

/**
 * 저장해 둔 대화로 세션의 최근 대화와 누적 요약을 되살린다. 서버를 다시 띄운 뒤 1:1 대화를 이어갈 때 쓴다.
 * 누적 요약은 부르지 않는다. 되살린 대화는 아직 요약되지 않은 것으로 남아 다음 요약 때 함께 접힌다.
 * 저장된 요약에 이미 들어간 대화가 한 번 더 접힐 수 있지만, 요약은 이전 요약과 합치도록 지시하므로 빠지는 것보다 낫다.
 */
export function restoreTurns(session: ConversationSession, turns: readonly SessionTurn[], summary = "") {
  for (const turn of turns.slice(-RECENT_TURN_LIMIT)) pushTurn(session, turn);
  session.summary = summary;
}

/**
 * 쿨다운이 지나지 않은 문장은 피해서 고른다.
 * 후보가 모두 쿨다운이면 가장 오래전에 쓴 문장을 쓴다. 답변을 아예 못 하는 것보다 낫다.
 */
export function pickReply(session: ConversationSession, values: readonly string[], cooldownMinutes: number): string {
  const now = Date.now();
  const cooldownMs = cooldownMinutes * 60_000;
  const lastUsedAt = session.replyLastUsedAt;
  const fresh = values.filter(value => now - (lastUsedAt.get(value) ?? 0) >= cooldownMs);
  const pool = fresh.length > 0 ? fresh : [...values].sort((a, b) => (lastUsedAt.get(a) ?? 0) - (lastUsedAt.get(b) ?? 0)).slice(0, 1);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  lastUsedAt.set(chosen, now);
  return chosen;
}
