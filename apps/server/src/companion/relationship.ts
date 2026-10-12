/**
 * 1:1 관계 맥락 문장.
 *
 * 관계를 점수로 저장하지 않는다(ADR-017). 저장된 대화 기록에서 사실만 계산해 문장으로 만들고,
 * 그 해석은 LLM과 1:1 정책 지침에 맡긴다. 문장은 프롬프트의 [대화 상황]에 들어가며 방송 요청에는 넣지 않는다.
 *
 * 문구는 평가 워커와 함께 쓰는 계약이라 바꾸지 않는다.
 * - 첫 대화: "이 사람과는 오늘 처음 대화한다."
 * - 재방문: "이 사람과는 {N}번째 대화다. 처음 대화한 지 {D}일 지났다." (D가 0이면 둘째 문장은 "처음 대화한 날이 오늘이다.")
 * - 마지막 대화 간격: "마지막 대화는 {G}일 전이었다." (G가 0이면 "마지막 대화는 오늘 앞서 있었다.")
 * - 지난 대화 요약(있을 때만): "지난 대화 요약: {요약}"
 */

/** 지난 대화 요약을 넣을 때의 최대 글자 수. 넘으면 잘라서 말줄임표를 붙인다. */
export const PREVIOUS_SUMMARY_MAX_LENGTH = 200;

/**
 * 이 시간보다 짧게 이어진 메시지는 같은 방문으로 본다.
 * 대화 도중 매 턴 "마지막 대화는 오늘 앞서 있었다"가 들어가면 모델이 "아까도 얘기했죠"처럼
 * 어색하게 반응할 수 있다. 그래서 간격 줄은 방문이 새로 시작될 때만 넣는다.
 */
export const NEW_VISIT_GAP_MS = 30 * 60_000;

/** 관계 계산에 쓰는 대화 하나의 기록. 메시지가 없는 대화는 firstMessageAt·lastMessageAt이 null이다. */
export type ConversationActivity = {
  id: string;
  /** 첫 메시지 시각(ms). */
  firstMessageAt: number | null;
  /** 마지막 메시지 시각(ms). */
  lastMessageAt: number | null;
  /** 저장된 누적 요약. 없으면 빈 문자열이다. */
  summary: string;
};

export type RelationshipInput = {
  /** 같은 소유자의 대화 전부. 다른 소유자의 대화를 넣으면 안 된다. 호출하는 쪽이 소유자로 거른다. */
  conversations: readonly ConversationActivity[];
  /** 지금 답하는 대화. 이번 메시지는 아직 기록에 들어 있지 않아야 한다. */
  currentId: string;
  /** 현재 시각(ms). 검사에서 고정한다. */
  now: number;
  summaryMaxLength?: number;
};

const DAY_MS = 86_400_000;

/** 로컬 날짜 기준 일 수. 자정을 넘기면 하루로 센다. 서머타임이 있어도 날짜만 비교하도록 UTC 자정으로 옮겨 뺀다. */
function localDaysBetween(from: number, to: number): number {
  const dayIndex = (time: number) => {
    const date = new Date(time);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
  };
  return Math.max(0, dayIndex(to) - dayIndex(from));
}

function truncate(text: string, maxLength: number): string {
  const chars = Array.from(text);
  return chars.length <= maxLength ? text : `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

/**
 * 관계 맥락 문장을 계산한다. 같은 입력에는 항상 같은 결과를 내는 순수 함수다.
 *
 * - N은 메시지가 한 건 이상 있는 대화 수에 현재 대화를 더한 값이다. 만들기만 한 빈 대화는 세지 않는다.
 * - D는 가장 이른 메시지부터 오늘까지의 일 수다.
 * - G는 이번 메시지 직전 메시지(현재 대화의 이전 메시지 포함)부터의 일 수다. 현재 대화의 첫 메시지이거나
 *   직전 메시지와 NEW_VISIT_GAP_MS 이상 떨어졌을 때만 넣는다.
 * - 지난 대화 요약은 현재 대화를 제외하고 마지막 메시지가 가장 최근인 대화의 요약이다. 그 대화에 요약이 없으면 넣지 않는다.
 */
export function relationshipStatusLines(input: RelationshipInput): string[] {
  const { now, currentId } = input;
  const maxLength = input.summaryMaxLength ?? PREVIOUS_SUMMARY_MAX_LENGTH;

  const spoken = input.conversations.filter((entry): entry is ConversationActivity & { firstMessageAt: number; lastMessageAt: number } =>
    entry.firstMessageAt !== null && entry.lastMessageAt !== null);
  const others = spoken.filter(entry => entry.id !== currentId);
  const current = spoken.find(entry => entry.id === currentId);

  const count = others.length + 1;
  const firstAt = spoken.length > 0 ? Math.min(...spoken.map(entry => entry.firstMessageAt)) : now;
  const sinceFirst = localDaysBetween(firstAt, now);

  if (count === 1 && sinceFirst === 0) return ["이 사람과는 오늘 처음 대화한다."];

  const lines = [`이 사람과는 ${count}번째 대화다. ${sinceFirst === 0 ? "처음 대화한 날이 오늘이다." : `처음 대화한 지 ${sinceFirst}일 지났다.`}`];

  const lastAt = Math.max(...spoken.map(entry => entry.lastMessageAt));
  const newVisit = !current || now - lastAt >= NEW_VISIT_GAP_MS;
  if (newVisit) {
    const gap = localDaysBetween(lastAt, now);
    lines.push(gap === 0 ? "마지막 대화는 오늘 앞서 있었다." : `마지막 대화는 ${gap}일 전이었다.`);
  }

  const previous = [...others].sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
  const summary = previous?.summary.trim() ?? "";
  if (summary.length > 0) lines.push(`지난 대화 요약: ${truncate(summary, maxLength)}`);

  return lines;
}
