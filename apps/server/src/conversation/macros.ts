import type { MacroPrompt } from "@bori/shared";
import type { ConversationSession } from "./session.js";

/** 동시에 켜 둘 매크로 수. 넘치면 priority가 큰 것부터 남긴다. */
export const MACRO_ACTIVE_LIMIT = 5;

/**
 * 채팅에 키워드가 있는 매크로를 켠다.
 * 이미 켜져 있으면 남은 턴을 다시 채운다. 화제가 이어지는 동안 계속 붙어 있게 하기 위한 것이다.
 */
export function activateMacros(session: ConversationSession, content: string, definitions: readonly MacroPrompt[]) {
  if (definitions.length === 0) return;

  for (const macro of definitions) {
    if (!macro.keywords.some(keyword => content.includes(keyword))) continue;

    const already = session.activeMacros.find(entry => entry.macro.id === macro.id);
    if (already) already.remainingTurns = macro.durationTurns;
    else session.activeMacros.push({ macro, remainingTurns: macro.durationTurns });
  }

  if (session.activeMacros.length > MACRO_ACTIVE_LIMIT) {
    session.activeMacros = [...session.activeMacros]
      .sort((a, b) => b.macro.priority - a.macro.priority)
      .slice(0, MACRO_ACTIVE_LIMIT);
  }
}

/** 답변을 한 번 내보낸 뒤 남은 턴을 줄인다. 다 쓴 매크로는 떨어져 나간다. */
export function tickMacros(session: ConversationSession) {
  if (session.activeMacros.length === 0) return;
  session.activeMacros = session.activeMacros
    .map(entry => ({ ...entry, remainingTurns: entry.remainingTurns - 1 }))
    .filter(entry => entry.remainingTurns > 0);
}

/** 켜져 있는 매크로를 모두 내린다. 매크로 파일을 다시 읽었거나 방송이 끝났을 때 쓴다. */
export function clearMacros(session: ConversationSession) {
  session.activeMacros = [];
}
