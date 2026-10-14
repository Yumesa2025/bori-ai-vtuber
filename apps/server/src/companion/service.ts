import { extractPrivateMemoryCandidates, isStorableMemory, type EmbeddingProvider, type MemoryCandidate, type MemorySettings, type MemoryStore } from "@bori/memory";
import type { CharacterResponse, CompanionMemory, ConversationMessage, SendConversationMessageResult } from "@bori/shared";
import { isUnsafeContent, type ConversationEngine, type ConversationSession, type RespondResult, type SessionTurn } from "../conversation/index.js";
import type { DigestMemories } from "./memory-digest.js";
import { relationshipStatusLines } from "./relationship.js";
import type { ConversationStore, NewConversationMessage } from "./store.js";

/** LLM이 정리한 기억 한 건의 최대 글자 수. 이보다 길면 한 문장짜리 사실이 아니라고 보고 버린다. */
const DIGEST_MEMORY_MAX_LENGTH = 120;

/**
 * 1:1 대화가 바깥에서 받는 것.
 * 방송 상태·큐·방송 세션은 받지 않는다. 받지 않은 것에는 닿을 방법이 없다.
 */
export type CompanionServiceDeps = {
  engine: Pick<ConversationEngine, "createSession" | "respond" | "record" | "tickMacros" | "restore">;
  store: ConversationStore;
  memoryStore: Pick<MemoryStore, "add" | "all" | "remove" | "removeByOwner"> & Partial<Pick<MemoryStore, "removeLeftovers">>;
  memorySettings: () => MemorySettings;
  embedding: () => EmbeddingProvider | null;
  /** 답변 음성을 만든다. 실패하면 undefined를 돌려주고 답변은 그대로 나간다. */
  prepareAudio: (text: string) => Promise<string | undefined>;
  /** LLM 기반 개인 기억 정리. 없으면 규칙 추출만 한다. */
  digestMemories?: DigestMemories;
  /** 현재 시각(ms). 관계 맥락 계산에 쓴다. 검사에서 고정한다. */
  now?: () => number;
};

/** 1:1 기록 전체 삭제에서 지운 개수. */
export type ClearAllResult = { conversations: number; messages: number; memories: number };

/**
 * 1:1 기록 전체 삭제가 일부만 끝났다. 무엇을 지웠고 무엇이 남았는지 담는다.
 * 지워졌다고 답하면 사용자는 다시 시도하지 않으므로 실패로 알린다.
 */
export class PartialDeletionError extends Error {
  constructor(readonly deleted: ClearAllResult, readonly failed: readonly ("conversations" | "leftovers")[], options?: { cause?: unknown }) {
    super("1:1 기록을 일부만 지웠습니다.", options);
    this.name = "PartialDeletionError";
  }
}

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
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, ConversationSession>();
  /** 답변을 만드는 중인 대화. 같은 대화에 겹쳐 보내면 순서가 꼬이므로 409로 돌려보낸다. */
  const inFlight = new Set<string>();
  /** 답변 뒤에 도는 작업(LLM 기억 정리). 답변을 기다리게 하지 않는다. */
  const background = new Set<Promise<void>>();
  /**
   * 소유자별 기억 삭제 세대. 기억을 모두 지울 때마다 올린다.
   * 기억 저장과 LLM 기억 정리는 비동기라 삭제 뒤에 끝날 수 있다. 시작할 때의 세대와 다르면 결과를 버린다.
   */
  const generations = new Map<string, number>();
  const generationOf = (ownerId: string) => generations.get(ownerId) ?? 0;
  /** 지금 세대를 잡아 두고, 그 뒤에 기억을 지웠는지 알려 주는 함수를 돌려준다. */
  const staleCheck = (ownerId: string) => {
    const started = generationOf(ownerId);
    return () => generationOf(ownerId) !== started;
  };

  // 소유자와 대화 ID를 함께 키로 쓴다. 대화 ID가 같아도 소유자가 다르면 다른 대화다.
  const keyOf = (ownerId: string, conversationId: string) => `${ownerId}\u0000${conversationId}`;

  function sessionFor(ownerId: string, conversationId: string): ConversationSession {
    const key = keyOf(ownerId, conversationId);
    const existing = sessions.get(key);
    if (existing) return existing;

    // 누적 요약이 갱신되면 대화 레코드에 남긴다. 대화가 이미 지워졌으면 저장소가 무시한다.
    const session = deps.engine.createSession("companion", { onSummary: summary => { deps.store.setSummary(ownerId, conversationId, summary); } });
    deps.engine.restore(session, turnsFromMessages(deps.store.messages(ownerId, conversationId) ?? [], ownerId), deps.store.summaryOf(ownerId, conversationId));
    sessions.set(key, session);
    return session;
  }

  /**
   * 사용자 메시지에서 개인 기억을 만든다. 실패해도 답변은 막지 않는다.
   * 만든 기억은 그 사용자 소유의 private 기억이라 방송에서는 꺼내지 않는다.
   */
  async function savePrivateMemories(ownerId: string, content: string) {
    const isStale = staleCheck(ownerId);
    const settings = deps.memorySettings();
    if (!settings.enabled) return;

    const candidates = extractPrivateMemoryCandidates([content], ownerId).filter(candidate => isStorableMemory(candidate.text));
    if (candidates.length === 0) return;

    try {
      const saved = await deps.memoryStore.add(candidates, settings, deps.embedding(), { isStale });
      if (saved > 0) console.log(`[bori-companion] 개인 기억 ${saved}건 저장`);
    } catch (error) {
      console.error("[bori-companion] 개인 기억 저장 실패:", error);
    }
  }

  /**
   * 최근 대화를 LLM에 넘겨 개인 기억을 정리한다. 실패해도 답변에는 영향이 없다.
   * 뽑힌 문장은 저장 직전에 민감 정보 검사를 다시 거친다. 같은 문장은 저장소 규칙대로 합쳐진다.
   */
  async function digestAndSave(ownerId: string, turns: readonly SessionTurn[]) {
    const digest = deps.digestMemories;
    if (!digest) return;

    const isStale = staleCheck(ownerId);
    try {
      const texts = await digest(turns.map(turn => ({ role: turn.role, text: turn.text })));
      // 정리하는 사이 기억을 껐거나 지웠으면 저장하지 않는다.
      const settings = deps.memorySettings();
      if (!texts || !settings.enabled || isStale()) return;

      const candidates: MemoryCandidate[] = texts
        .filter(text => Array.from(text).length <= DIGEST_MEMORY_MAX_LENGTH && !isUnsafeContent(text) && isStorableMemory(text))
        // 상대가 직접 말한 것만 뽑게 했으므로 규칙 추출(0.5)보다 확신을 조금 높게 둔다.
        .map(text => ({ text, kind: "viewer", scope: "private", ownerId, importance: 0.55, confidence: 0.7 }));
      if (candidates.length === 0) return;

      const saved = await deps.memoryStore.add(candidates, settings, deps.embedding(), { isStale });
      if (saved > 0) console.log(`[bori-companion] LLM 정리 개인 기억 ${saved}건 저장`);
    } catch (error) {
      console.error("[bori-companion] LLM 개인 기억 정리 실패:", error);
    }
  }

  /**
   * 사용자 메시지가 privateDigestEveryMessages개 쌓일 때마다 기억 정리를 백그라운드로 시작한다.
   * 개수는 이 대화에 저장된, 차단되지 않은 사용자 메시지로 센다. 저장소 기준이라 재시작 뒤에도 주기가 이어진다.
   * 넘기는 대화는 마지막 N개 사용자 메시지와 그 사이 보리 답변이다.
   */
  function maybeDigest(ownerId: string, conversationId: string) {
    const settings = deps.memorySettings();
    const every = settings.privateDigestEveryMessages;
    if (!deps.digestMemories || !settings.enabled || !(every > 0)) return;

    const turns = turnsFromMessages(deps.store.messages(ownerId, conversationId) ?? [], ownerId);
    const userIndexes = turns.flatMap((turn, index) => (turn.role === "viewer" ? [index] : []));
    if (userIndexes.length === 0 || userIndexes.length % every !== 0) return;

    const task = digestAndSave(ownerId, turns.slice(userIndexes[userIndexes.length - every]));
    background.add(task);
    void task.finally(() => background.delete(task));
  }

  async function sendMessage(ownerId: string, conversationId: string, content: string, options: { tts: boolean }): Promise<SendMessageOutcome> {
    const key = keyOf(ownerId, conversationId);
    if (!deps.store.get(ownerId, conversationId)) return { kind: "not_found" };
    if (inFlight.has(key)) return { kind: "busy" };

    inFlight.add(key);
    try {
      // 새 메시지를 저장하기 전에 세션을 되살린다. 그래야 이번 메시지가 최근 대화에 두 번 들어가지 않는다.
      const session = sessionFor(ownerId, conversationId);
      // 관계 맥락도 이번 메시지를 저장하기 전 기록으로 계산한다. 같은 소유자의 대화만 본다.
      const statusLines = relationshipStatusLines({ conversations: deps.store.activity(ownerId), currentId: conversationId, now: now() });
      const userMessage = deps.store.append(ownerId, conversationId, { role: "user", content });
      if (!userMessage) return { kind: "not_found" };

      // 기억 저장은 답변 생성과 나란히 돌린다. 막은 입력은 기억으로도 남기지 않는다.
      const memorySaved = isUnsafeContent(content) ? Promise.resolve() : savePrivateMemories(ownerId, content);
      const outcome = await deps.engine.respond(session, { content, speaker: { ownerId }, statusLines });
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
        maybeDigest(ownerId, conversationId);
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

  /**
   * 본인의 개인 기억을 모두 지운다. 진행 중인 기억 저장·정리 결과도 버린다.
   * 1:1 소유자 ID(companion:)는 방송 시청자 ID(local: 등)와 겹치지 않으므로 소유자로 지워도 방송 기억은 남는다.
   */
  function clearMemories(ownerId: string): Promise<number> {
    // 세대는 바로 올린다. 파일 쓰기를 기다리는 사이 끝난 저장·정리도 버려야 한다.
    generations.set(ownerId, generationOf(ownerId) + 1);
    return deps.memoryStore.removeByOwner(ownerId);
  }

  return {
    sendMessage,
    deleteConversation,

    /** 백그라운드 작업(LLM 기억 정리)이 모두 끝날 때까지 기다린다. 검사에서 쓴다. */
    async settle(): Promise<void> {
      while (background.size > 0) await Promise.all([...background]);
    },

    /** 본인의 개인 기억만 보여 준다. 방송 기억과 남의 기억은 목록에도 나오지 않는다. */
    listMemories(ownerId: string): CompanionMemory[] {
      return ownedPrivate(ownerId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map(record => ({ id: record.id, text: record.text, createdAt: record.createdAt, expiresAt: record.expiresAt }));
    },

    /** 본인의 개인 기억이 아니면 지우지 않는다. 없는 것과 같이 false를 돌려준다. 파일에 쓰지 못하면 예외를 넘긴다. */
    async deleteMemory(ownerId: string, memoryId: string): Promise<boolean> {
      if (!ownedPrivate(ownerId).some(record => record.id === memoryId)) return false;
      return deps.memoryStore.remove(memoryId);
    },

    clearMemories,

    /**
     * 본인의 1:1 기록을 모두 지운다. 대화·메시지·대화별 누적 요약·메모리의 세션·개인 기억이다.
     * 방송 기억과 남의 기록은 건드리지 않는다. 답변을 만드는 중인 대화는 답변을 저장하지 못하고 끝난다.
     *
     * 기억을 먼저 지운다. 기억 삭제는 쓰기에 실패하면 되돌리므로, 거기서 실패하면 아무것도 지우지 않은 채 예외가 난다.
     * 그 뒤 대화나 남은 조각(읽지 못한 대화 파일 백업·임시 파일) 삭제가 실패하면 PartialDeletionError로 알린다.
     */
    async clearAll(ownerId: string): Promise<ClearAllResult> {
      // 세션 키는 소유자로 시작한다(keyOf).
      const prefix = keyOf(ownerId, "");
      for (const key of sessions.keys()) {
        if (key.startsWith(prefix)) sessions.delete(key);
      }
      const memories = await clearMemories(ownerId);

      let removed: { conversations: number; messages: number };
      try {
        removed = deps.store.removeOwner(ownerId);
      } catch (error) {
        throw new PartialDeletionError({ conversations: 0, messages: 0, memories }, ["conversations"], { cause: error });
      }

      // 읽지 못한 대화 파일 백업은 소유자별로 나눌 수 없어 통째로 지운다. 지금은 로컬 단일 사용자라 모두 본인 기록이다.
      const leftovers = [deps.store.removeLeftovers(), deps.memoryStore.removeLeftovers?.() ?? { removed: 0, failed: 0 }];
      const deleted = { ...removed, memories };
      if (leftovers.some(result => result.failed > 0)) throw new PartialDeletionError(deleted, ["leftovers"]);
      return deleted;
    },
  };
}

export type CompanionService = ReturnType<typeof createCompanionService>;
