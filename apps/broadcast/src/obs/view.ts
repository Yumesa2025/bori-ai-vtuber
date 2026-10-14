/**
 * OBS 페이지가 그리는 값의 계산. 화면 컴포넌트는 이 결과를 그리기만 한다.
 * DOM에 묶이지 않아 브라우저 없이 검사한다(test/obs-view.test.ts).
 */
import type { BroadcastState, DashboardView, ErCharacterStat, VisibleChat } from "@bori/shared";

/** 0~1 비율을 소수 한 자리 퍼센트로. 예: 0.0812 → "8.1%" */
export const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

/** 평균 순위. 예: 3.42 → "3.4위" */
export const formatRank = (rank: number) => `${rank.toFixed(1)}위`;

/** TOP 5 중 지금까지 공개한 줄. 진행기가 revealed를 1씩 올린다. */
export function visibleTop5(items: ErCharacterStat[], revealed: number): ErCharacterStat[] {
  return items.slice(0, Math.max(0, Math.min(5, revealed)));
}

/** 채팅 띠에 보이는 줄 수. 방송 화면 아래 띠 높이에 맞춘 값이다. */
export const CHAT_STRIP_LINES = 4;

/** 채팅 띠 한 줄. 닉네임은 싣지 않는다(방송 화면 규칙). 명령(!전적 등)은 강조한다. */
export type ChatStripLine = { id: string; text: string; command: boolean };

export function chatStripLines(chats: VisibleChat[]): ChatStripLine[] {
  return chats.slice(-CHAT_STRIP_LINES).map(chat => ({ id: chat.id, text: chat.content, command: chat.content.trimStart().startsWith("!") }));
}

/** 자막. 진행기의 자막이 있으면 그것, 없으면 보리의 현재 답이다. */
export function captionText(state: BroadcastState): string {
  return state.show?.caption || state.currentResponse?.reply || "";
}

type PlayerStatus = Extract<DashboardView, { kind: "player" }>["status"];

/** 전적 카드의 안내 문구. 결과가 있으면(ready) 문구 대신 결과를 그리므로 null이다. */
export function playerStatusText(status: PlayerStatus): string | null {
  switch (status) {
    case "waiting": return "채팅에 !전적 닉네임을 적어 주세요";
    case "loading": return "찾아보는 중…";
    case "not-found": return "닉네임을 찾지 못했어요";
    case "error": return "전적을 불러오지 못했어요. 잠시 뒤 다시 해 볼게요";
    case "ready": return null;
  }
}
