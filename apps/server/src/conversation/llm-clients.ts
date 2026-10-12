import { conversationModes, type ConversationMode } from "@bori/character";

/**
 * 모드별 LLM 클라이언트를 만든다.
 * 회로 차단기와 호출 통계가 클라이언트 안에 있으므로, 하나를 같이 쓰면 1:1의 연속 실패가
 * 방송 회로를 열어 방송이 폴백 문장으로 떨어진다. 모드마다 따로 만들어 서로 영향을 주지 않게 한다.
 */
export function createModeLlmClients<C extends { reset(): void }>(create: () => C) {
  const clients = new Map<ConversationMode, C>(conversationModes.map(mode => [mode, create()]));

  return {
    llmFor(mode: ConversationMode): C {
      const client = clients.get(mode);
      // 모드를 모르면 다른 모드의 클라이언트로 대신하지 않는다. 회로와 통계가 섞인다.
      if (!client) throw new Error(`알 수 없는 대화 모드입니다: ${String(mode)}`);
      return client;
    },
    /** 설정을 바꾸면 모든 모드의 회로와 통계를 함께 초기화한다. */
    resetAll() {
      for (const client of clients.values()) client.reset();
    },
  };
}

export type ModeLlmClients<C extends { reset(): void }> = ReturnType<typeof createModeLlmClients<C>>;
