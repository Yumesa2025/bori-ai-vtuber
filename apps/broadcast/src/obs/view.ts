/**
 * OBS 페이지가 그리는 값의 계산. 화면 컴포넌트는 이 결과를 그리기만 한다.
 * DOM에 묶이지 않아 브라우저 없이 검사한다(test/obs-view.test.ts).
 */
import type { BroadcastState, DashboardView, ErCharacterStat, ShowStage, VisibleChat } from "@bori/shared";

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

/** 채팅이 아직 없을 때 띠에 띄우는 참여 안내. 빈 띠가 사라지면 시청자가 채팅 자리를 알 수 없다. */
export function chatEmptyHint(stage: ShowStage | undefined): string {
  if (stage === "diagnosis") return "채팅에 !전적 닉네임을 적어 주세요";
  if (stage === "qna") return "궁금한 캐릭터를 채팅으로 물어봐 주세요";
  return "채팅으로 함께해 주세요";
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

/**
 * 자막을 maxLines줄씩 끊어 차례로 보여 줄 묶음으로 나눈다. 전에는 두 줄을 넘으면 "…"로 잘려 뒷말이 보이지 않았다.
 * 문장 단위로 묶고, 한 문장이 maxLines줄을 넘으면 어절 단위로 나눈다. 띄어쓰기 없는 긴 낱말은 폭만큼 줄을 더 차지한다고 센다.
 * measure는 글자열의 폭(px)이다. 화면은 canvas measureText를, 검사는 글자 수를 쓴다.
 */
export function paginateCaption(text: string, measure: (value: string) => number, maxWidth: number, maxLines = 2): string[] {
  const words = (value: string) => value.split(/\s+/).filter(Boolean);
  /** 어절을 앞에서부터 줄에 채운다. */
  const wrap = (list: readonly string[]) => {
    const lines: string[] = [];
    for (const word of list) {
      const last = lines.at(-1);
      if (last !== undefined && measure(`${last} ${word}`) <= maxWidth) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    return lines;
  };
  const lineCount = (lines: readonly string[]) => lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(measure(line) / maxWidth)), 0);

  const sentences = text.trim().split(/(?<=[.!?…~])\s+/).filter(Boolean);
  const pages: string[] = [];
  let current: string[] = [];
  for (const sentence of sentences) {
    const joined = [...current, ...words(sentence)];
    if (lineCount(wrap(joined)) <= maxLines) { current = joined; continue; }
    if (current.length > 0) pages.push(current.join(" "));
    current = [];
    // 한 문장이 길면 maxLines줄씩 잘라 넣고, 남은 줄은 다음 문장과 이어 붙일 수 있게 둔다.
    for (const line of wrap(words(sentence))) {
      const next = [...current, ...words(line)];
      if (lineCount(wrap(next)) <= maxLines) { current = next; continue; }
      if (current.length > 0) pages.push(current.join(" "));
      current = words(line);
    }
  }
  if (current.length > 0) pages.push(current.join(" "));
  return pages.length > 0 ? pages : [text.trim()].filter(Boolean);
}

/** 묶음마다 보여 줄 시간(ms). 말하는 시간을 글자 수 비율로 나눈다. 너무 짧으면 읽을 수 없어 최소 시간을 둔다. */
export function captionPageDurations(pages: readonly string[], speechMs: number, minMs = 1200): number[] {
  const total = pages.reduce((sum, page) => sum + Array.from(page).length, 0) || 1;
  return pages.map(page => Math.max(minMs, Math.round(speechMs * Array.from(page).length / total)));
}
