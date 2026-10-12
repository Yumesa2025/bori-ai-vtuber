import { extractPrivateMemoryCandidates, isStorableMemory, type EmbeddingProvider, type MemorySettings, type MemoryStore } from "@bori/memory";
import type { CharacterResponse, CompanionMemory, ConversationMessage, SendConversationMessageResult } from "@bori/shared";
import { isUnsafeContent, type ConversationEngine, type ConversationSession, type RespondResult, type SessionTurn } from "../conversation/index.js";
import type { ConversationStore, NewConversationMessage } from "./store.js";

/**
 * 1:1 대화가 바깥에서 받는 것.
 * 방송 상태·큐·방송 세션은 받지 않는다. 받지 않은 것에는 닿을 방법이 없다.
 */
export type CompanionServiceDeps = {
  engine: Pick<ConversationEngine, "createSession" | "respond" | "record" | "tickMacros" | "restore">;
  store: ConversationStore;
  memoryStore: Pick<MemoryStore, "add" | "all" | "remove" | "removeByOwner">;
  memorySettings: () => MemorySettings;
  embedding: () => EmbeddingProvider | null;
  /** 답변 음성을 만든다. 실패하면 undefined를 돌려주고 답변은 그대로 나간다. */
  prepareAudio: (text: string) => Promise<string | undefined>;
};

export type SendMessageOutcome =
  | { kind: "ok"; result: SendConversationMessageResult }
  | { kind: "not_found" }
  /** 같은 대화에 답변을 만드는 중이다. */
  | { kind: "busy" };

/** 보리 답변을 메시지 형식으로 옮긴다. 방송 전용 필드(secondary, decayStyle)는 싣지 않는다. */
function replyDraft(response: CharacterResponse, source: NonNullable<ConversationMessage["source"]>): NewConversationMessage {
  return {
    role: "bori",
    content: response.reply,
    emotion: { primary: response.emotion.primary, intensity: response.emotion.intensity, durationSeconds: response.emotion.durationSeconds },
    actions: response.actions.map(action => ({ name: action.name, layer: action.layer, priority: action.priority })),
    source,
  };
}

function draftFor(outcome: RespondResult): NewConversationMessage {
  if (outcome.kind === "blocked") {
    // 1:1 정책에는 거절 문장이 있다. 없으면 정책 데이터가 잘못된 것이라 조용히 넘기지 않는다.
    if (!outcome.refusal) throw new Error("1:1 정책에 거절 문장이 없습니다.");
    return replyDraft(outcome.refusal, "blocked");
  }
  if (outcome.failure) return replyDraft(outcome.response, "fallback");
  return replyDraft(outcome.response, outcome.response.source === "llm" ? "llm" : "rule");
}

/**
 * 저장된 메시지를 세션 발언으로 바꾼다.
 * 차단한 입력과 그 거절 문장은 뺀다. 막은 입력이 다음 LLM 요청의 최근 대화로 새어 나가면 안 된다.
 */
function turnsFromMessages(messages: readonly ConversationMessage[], ownerId: string): SessionTurn[] {
  return messages.flatMap((message): SessionTurn[] => {
    if (message.role === "bori") return message.source === "blocked" ? [] : [{ role: "bori", text: message.content }];
    return isUnsafeContent(message.content) ? [] : [{ role: "viewer", text: message.content, viewerId: ownerId }];
  });
}

/**
 * 1:1 대화 처리. 대화마다 엔진 세션을 하나씩 메모리에 두고, 처음 쓸 때 만든다.
 * 서버를 다시 띄운 뒤 처음 접근하면 저장된 최근 메시지로 세션의 최근 대화를 되살린다.
 */
export function createCompanionService(deps: CompanionServiceDeps) {
  const sessions = new Map<string, ConversationSession>();
  /** 답변을 만드는 중인 대화. 같은 대화에 겹쳐 보내면 순서가 꼬이므로 409로 돌려보낸다. */
  const inFlight = new Set<string>();

  // 소유자와 대화 ID를 함께 키로 쓴다. 대화 ID가 같아도 소유자가 다르면 다른 대화다.
  const keyOf = (ownerId: string, conversationId: string) => `${ownerId}\u0000${conversationId}`;

  function sessionFor(ownerId: string, conversationId: string): ConversationSession {
    const key = keyOf(ownerId, conversationId);
    const existing = sessions.get(key);
    if (existing) return existing;

    const session = deps.engine.createSession("companion");
    deps.engine.restore(session, turnsFromMessages(deps.store.messages(ownerId, conversationId) ?? [], ownerId));
    sessions.set(key, session);
    return session;
  }

  /**
   * 사용자 메시지에서 개인 기억을 만든다. 실패해도 답변은 막지 않는다.
   * 만든 기억은 그 사용자 소유의 private 기억이라 방송에서는 꺼내지 않는다.
   */
  async function savePrivateMemories(ownerId: string, content: string) {
    const settings = deps.memorySettings();
    if (!settings.enabled) return;

    const candidates = extractPrivateMemoryCandidates([content], ownerId).filter(candidate => isStorableMemory(candidate.text));
    if (candidates.length === 0) return;

    try {
      const saved = await deps.memoryStore.add(candidates, settings, deps.embedding());
      if (saved > 0) console.log(`[bori-companion] 개인 기억 ${saved}건 저장`);
    } catch (error) {
      console.error("[bori-companion] 개인 기억 저장 실패:", error);
    }
  }

  async function sendMessage(ownerId: string, conversationId: string, content: string, options: { tts: boolean }): Promise<SendMessageOutcome> {
    const key = keyOf(ownerId, conversationId);
    if (!deps.store.get(ownerId, conversationId)) return { kind: "not_found" };
    if (inFlight.has(key)) return { kind: "busy" };

    inFlight.add(key);
    try {
      // 새 메시지를 저장하기 전에 세션을 되살린다. 그래야 이번 메시지가 최근 대화에 두 번 들어가지 않는다.
      const session = sessionFor(ownerId, conversationId);
      const userMessage = deps.store.append(ownerId, conversationId, { role: "user", content });
      if (!userMessage) return { kind: "not_found" };

      // 기억 저장은 답변 생성과 나란히 돌린다. 막은 입력은 기억으로도 남기지 않는다.
      const memorySaved = isUnsafeContent(content) ? Promise.resolve() : savePrivateMemories(ownerId, content);
      const outcome = await deps.engine.respond(session, { content, speaker: { ownerId } });
      const reply = deps.store.append(ownerId, conversationId, draftFor(outcome));
      // 다음 메시지가 이번에 만든 기억을 볼 수 있도록 응답 전에 저장을 마친다.
      await memorySaved;
      // 답변을 만드는 사이 대화가 지워졌다. 세션도 이미 버려졌으므로 기록하지 않는다.
      if (!reply) return { kind: "not_found" };

      // 답변이 실제로 저장된 뒤에만 문맥에 남기고 매크로 수명을 줄인다. 거절한 대화는 문맥에 넣지 않는다.
      if (outcome.kind === "reply") {
        deps.engine.record(session, { role: "viewer", text: content, viewerId: ownerId });
        deps.engine.record(session, { role: "bori", text: outcome.response.reply });
        deps.engine.tickMacros(session);
      }

      const audioId = options.tts ? await deps.prepareAudio(reply.content) : undefined;
      return {
        kind: "ok",
        result: {
          userMessage,
          reply,
          ...(audioId ? { audioId } : {}),
          ...(outcome.kind === "reply" && outcome.failure ? { failure: { kind: outcome.failure.kind } } : {}),
        },
      };
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * 대화를 지우고 세션도 버린다.
   * 그 대화에서 생긴 개인 기억은 남는다. 개인 기억은 /api/me/memories로 따로 지운다.
   */
  function deleteConversation(ownerId: string, conversationId: string): boolean {
    sessions.delete(keyOf(ownerId, conversationId));
    return deps.store.remove(ownerId, conversationId);
  }

  const ownedPrivate = (ownerId: string) =>
    deps.memoryStore.all().filter(record => record.scope === "private" && record.ownerId === ownerId);

  return {
    sendMessage,
    deleteConversation,

    /** 본인의 개인 기억만 보여 준다. 방송 기억과 남의 기억은 목록에도 나오지 않는다. */
    listMemories(ownerId: string): CompanionMemory[] {
      return ownedPrivate(ownerId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map(record => ({ id: record.id, text: record.text, createdAt: record.createdAt, expiresAt: record.expiresAt }));
    },

    /** 본인의 개인 기억이 아니면 지우지 않는다. 없는 것과 같이 false를 돌려준다. */
    deleteMemory(ownerId: string, memoryId: string): boolean {
      if (!ownedPrivate(ownerId).some(record => record.id === memoryId)) return false;
      return deps.memoryStore.remove(memoryId);
    },

    /**
     * 본인의 개인 기억을 모두 지운다.
     * 1:1 소유자 ID(companion:)는 방송 시청자 ID(local: 등)와 겹치지 않으므로 소유자로 지워도 방송 기억은 남는다.
     */
    clearMemories(ownerId: string): number {
      return deps.memoryStore.removeByOwner(ownerId);
    },
  };
}

export type CompanionService = ReturnType<typeof createCompanionService>;
