import { koreanDateLabel } from "@bori/llm";
import { extractPrivateMemoryCandidates, hasRelativeTime, isMemoryProbe, isStorableMemory, type EmbeddingProvider, type MemoryCandidate, type MemorySettings, type MemoryStore } from "@bori/memory";
import type { CharacterResponse, CompanionMemory, ConversationMessage, SendConversationMessageResult } from "@bori/shared";
import { crisisTurnMask, isCrisisContent, isInCrisisContext, isUnsafeContent, type ConversationEngine, type ConversationSession, type RespondResult, type SessionTurn } from "../conversation/index.js";
import type { DigestMemories } from "./memory-digest.js";
import { relationshipStatusLines } from "./relationship.js";
import type { ConversationStore, NewConversationMessage } from "./store.js";

/** LLM이 정리한 기억 한 건의 최대 글자 수. 이보다 길면 한 문장짜리 사실이 아니라고 보고 버린다. */
const DIGEST_MEMORY_MAX_LENGTH = 120;
/**
 * 대화에 이 시간 동안 새 메시지가 없으면 대화가 끝난 것으로 보고 남은 메시지를 정리한다(점검 M-6).
 * 예전에는 사용자 메시지 6·12·18번째에만 정리해서, 마지막 정리 뒤의 메시지와 6개 미만인 대화가 기억되지 않았다.
 */
export const IDLE_DIGEST_MS = 10 * 60_000;
/** 같은 구간의 정리가 이만큼 실패하면 그 구간은 건너뛴다. 다음 기회에 다시 시도하되 끝없이 되풀이하지 않는다. */
export const DIGEST_MAX_ATTEMPTS = 3;
/**
 * 새 대화의 첫 메시지는 앞 대화의 정리가 진행 중이면 이만큼까지 기다린다.
 * 실모델 재현에서 새 대화를 열자마자 보낸 첫 메시지가 정정 전 기억(콩)으로 답했다. 보통은 입력하는 사이에 끝난다.
 */
export const PENDING_DIGEST_WAIT_MS = 3000;
/** 한 번에 따라잡는 밀린 정리 몫의 수. LLM이 오래 꺼져 있다 켜져도 호출이 한꺼번에 몰리지 않게 한다. */
const DIGEST_BACKLOG_WINDOWS = 3;

/**
 * 1:1 대화가 바깥에서 받는 것.
 * 방송 상태·큐·방송 세션은 받지 않는다. 받지 않은 것에는 닿을 방법이 없다.
 */
export type CompanionServiceDeps = {
  engine: Pick<ConversationEngine, "createSession" | "respond" | "record" | "tickMacros" | "restore">;
  store: ConversationStore;
  memoryStore: Pick<MemoryStore, "add" | "all" | "remove" | "removeByOwner"> & Partial<Pick<MemoryStore, "removeLeftovers" | "watchRemovals" | "onRemoved">>;
  memorySettings: () => MemorySettings;
  embedding: () => EmbeddingProvider | null;
  /** 답변 음성을 만든다. 실패하면 undefined를 돌려주고 답변은 그대로 나간다. */
  prepareAudio: (text: string) => Promise<string | undefined>;
  /** LLM 기반 개인 기억 정리. 없거나 지금 쓸 수 없으면 규칙 추출로 기억을 남긴다. */
  digestMemories?: DigestMemories;
  /** 현재 시각(ms). 관계 맥락 계산과 기억의 날짜에 쓴다. 검사에서 고정한다. */
  now?: () => number;
  /** 대화가 끝난 것으로 보는 무응답 시간(ms). 0이면 무응답으로는 정리하지 않는다. 기본 IDLE_DIGEST_MS. */
  idleDigestMs?: number;
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
 *
 * 개인 기억은 LLM 정리가 주 경로다(ADR-023). 정리는 대화마다 "어디까지 정리했는지"(digestedCount)를 남기고
 * 사용자 메시지가 privateDigestEveryMessages개 쌓이거나 대화가 끝났을 때(새 대화 시작, 다른 대화로 옮김, 무응답) 남은 몫을 정리한다.
 * LLM을 쓸 수 없을 때만 규칙 추출로 사용자 원문을 남긴다.
 */
export function createCompanionService(deps: CompanionServiceDeps) {
  const now = deps.now ?? Date.now;
  const idleDigestMs = deps.idleDigestMs ?? IDLE_DIGEST_MS;
  const sessions = new Map<string, ConversationSession>();
  /** 답변을 만드는 중인 대화. 같은 대화에 겹쳐 보내면 순서가 꼬이므로 409로 돌려보낸다. */
  const inFlight = new Set<string>();
  /** 답변 뒤에 도는 작업(기억 저장·LLM 기억 정리). 답변을 기다리게 하지 않는다. */
  const background = new Set<Promise<void>>();
  /** 대화별 무응답 정리 예약. */
  const idleTimers = new Map<string, NodeJS.Timeout>();
  /** 소유자별 정리 줄. 같은 사람의 정리가 겹치면 서로의 결과를 모른 채 같은 기억을 두 번 만든다. */
  const digestChains = new Map<string, Promise<void>>();
  /** 구간별 정리 실패 횟수. 키는 대화 키와 구간 시작 위치다. */
  const digestFailures = new Map<string, number>();

  // 소유자와 대화 ID를 함께 키로 쓴다. 대화 ID가 같아도 소유자가 다르면 다른 대화다.
  const keyOf = (ownerId: string, conversationId: string) => `${ownerId}\u0000${conversationId}`;

  /**
   * 지금부터 이 소유자의 기억이 지워지는지 지켜본다. 관리자 삭제도 저장소를 거치므로 함께 잡힌다(점검 M-9).
   * 기억 저장과 LLM 정리는 비동기라 삭제 뒤에 끝날 수 있다. 그 결과는 버린다.
   */
  const removalWatch = (ownerId: string) => deps.memoryStore.watchRemovals?.(ownerId) ?? (() => false);

  // 기억을 지우면 그때까지의 메시지는 정리한 것으로 표시한다. 지우기 전에 한 말이 다음 정리로 되살아나지 않게 한다(점검 M-9).
  deps.memoryStore.onRemoved?.(scope => {
    if (scope === "all") { deps.store.markAllDigested(); return; }
    for (const ownerId of scope) if (ownerId.length > 0) deps.store.markAllDigested(ownerId);
  });

  function track(task: Promise<void>) {
    background.add(task);
    void task.finally(() => background.delete(task));
  }

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

  const ownedPrivate = (ownerId: string) =>
    deps.memoryStore.all().filter(record => record.scope === "private" && record.ownerId === ownerId);

  /**
   * LLM을 쓸 수 없을 때 사용자 메시지에서 규칙으로 개인 기억을 만든다. 실패해도 답변은 막지 않는다.
   * LLM 정리를 쓸 수 있으면 하지 않는다. 같은 사실이 1인칭 원문과 정리 문장으로 따로 쌓여 [기억] 칸을 두 번 차지했다(점검 M-2).
   * 만든 기억은 그 사용자 소유의 private 기억이라 방송에서는 꺼내지 않는다.
   */
  async function savePrivateMemories(ownerId: string, content: string, isRemoved: () => boolean) {
    const settings = deps.memorySettings();
    if (!settings.enabled || deps.digestMemories?.isAvailable()) return;

    const candidates = extractPrivateMemoryCandidates([content], ownerId, { heardOn: koreanDateLabel(now()) }).filter(candidate => isStorableMemory(candidate.text));
    if (candidates.length === 0) return;

    try {
      const saved = await deps.memoryStore.add(candidates, settings, deps.embedding(), { isStale: isRemoved });
      if (saved > 0) console.log(`[bori-companion] 개인 기억 ${saved}건 저장`);
    } catch (error) {
      console.error("[bori-companion] 개인 기억 저장 실패:", error);
    }
  }

  /**
   * 대화에서 아직 정리하지 않은 메시지가 어디서 시작하는지.
   * 남긴 값이 없으면(이 기능 전에 만든 대화) 예전 규칙대로 사용자 메시지 N개마다 이미 정리한 것으로 계산한다.
   */
  function digestStart(ownerId: string, conversationId: string, messages: readonly ConversationMessage[]): number {
    const stored = deps.store.digestCursor(ownerId, conversationId);
    if (stored !== null) return Math.min(stored, messages.length);
    const every = deps.memorySettings().privateDigestEveryMessages;
    if (!(every > 0)) return 0;
    let users = 0;
    let start = 0;
    messages.forEach((message, index) => {
      if (message.role !== "user" || isUnsafeContent(message.content)) return;
      users += 1;
      // 예전 정리는 답변을 저장한 뒤에 돌았으므로 그 답변까지 들어갔다.
      if (users % every === 0) start = messages[index + 1]?.role === "bori" ? index + 2 : index + 1;
    });
    return start;
  }

  /** 정리하지 않은 메시지와 그 안의 사용자 메시지 위치. 차단한 입력은 세지 않는다. 대화가 없으면 null이다. */
  function pendingOf(ownerId: string, conversationId: string) {
    const messages = deps.store.messages(ownerId, conversationId);
    if (!messages) return null;
    const start = digestStart(ownerId, conversationId, messages);
    const users: number[] = [];
    for (let index = start; index < messages.length; index += 1) {
      if (messages[index].role === "user" && !isUnsafeContent(messages[index].content)) users.push(index);
    }
    return { messages, start, users };
  }

  /** 정리한 위치를 앞으로만 옮긴다. 기억 삭제가 이미 더 앞으로 옮겼으면 그대로 둔다. */
  function advanceDigest(ownerId: string, conversationId: string, end: number) {
    try {
      if (end > (deps.store.digestCursor(ownerId, conversationId) ?? 0)) deps.store.setDigestCursor(ownerId, conversationId, end);
    } catch (error) {
      // 대화 파일에 쓰지 못했다. 다음에 같은 구간을 한 번 더 정리할 뿐이라 답변은 막지 않는다.
      console.error("[bori-companion] 기억 정리 위치를 저장하지 못했습니다:", error);
    }
  }

  /**
   * messages[start, end) 구간을 LLM으로 정리해 저장한다. 다음 구간으로 넘어가도 되면 true다.
   * 실패하면 위치를 그대로 두어 다음 기회에 다시 정리하고, DIGEST_MAX_ATTEMPTS번 실패하면 그 구간은 건너뛴다(점검 M-6).
   * LLM을 쓸 수 없어 건너뛰었으면 위치를 그대로 두고 false다. 그동안의 메시지는 규칙 추출이 맡았다.
   */
  async function digestRange(ownerId: string, conversationId: string, messages: readonly ConversationMessage[], start: number, end: number): Promise<boolean> {
    const digest = deps.digestMemories;
    if (!digest) return false;
    const isRemoved = removalWatch(ownerId);
    const failureKey = `${keyOf(ownerId, conversationId)}\u0000${start}`;
    const finish = () => { digestFailures.delete(failureKey); advanceDigest(ownerId, conversationId, end); return true; };

    // 위기 대화는 정리에 넘기지 않는다(S-3). 앞뒤 맥락을 보도록 대화 전체로 표시한 뒤 이번 구간만 자른다.
    const indexed = messages.flatMap((message, index) => turnsFromMessages([message], ownerId).map(turn => ({ index, turn })));
    const excluded = crisisTurnMask(indexed.map(entry => entry.turn));
    // 기억을 떠보는 질문과 그 바로 뒤 보리의 답도 넘기지 않는다(점검 M-3). 지시문만으로는 모델이 질문에서 사실을 만들었다.
    indexed.forEach((entry, position) => {
      if (entry.turn.role !== "viewer" || !isMemoryProbe(entry.turn.text)) return;
      excluded[position] = true;
      if (indexed[position + 1]?.turn.role === "bori") excluded[position + 1] = true;
    });
    const material = indexed.filter((entry, position) => entry.index >= start && entry.index < end && !excluded[position]).map(entry => entry.turn);
    // 위기 대화·떠보기를 빼고 나면 상대의 발언이 없을 수 있다. 그때는 부르지 않고 지나간다.
    if (!material.some(turn => turn.role === "viewer")) return finish();

    const existing = ownedPrivate(ownerId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(record => ({ id: record.id, text: record.text }));
    let digested;
    try {
      digested = await digest.digest({ turns: material.map(turn => ({ role: turn.role, text: turn.text })), existing, now: now() });
    } catch (error) {
      const attempts = (digestFailures.get(failureKey) ?? 0) + 1;
      if (attempts >= DIGEST_MAX_ATTEMPTS) {
        console.error(`[bori-companion] LLM 개인 기억 정리가 ${attempts}번 실패해 이 구간(메시지 ${start + 1}~${end})은 건너뜁니다:`, error);
        finish();
      } else {
        digestFailures.set(failureKey, attempts);
        console.error(`[bori-companion] LLM 개인 기억 정리 실패(${attempts}/${DIGEST_MAX_ATTEMPTS}). 다음 기회에 다시 정리합니다:`, error);
      }
      return false;
    }
    if (digested === null) return false;

    // 정리하는 사이 기억을 껐으면 이 구간은 기억하지 않는다. 기억을 지웠거나 대화를 지웠으면 결과를 버린다(점검 M-9).
    const settings = deps.memorySettings();
    if (!settings.enabled) return finish();
    const isStale = () => isRemoved() || deps.store.get(ownerId, conversationId) === null;
    if (isStale()) return false;

    const heardOn = koreanDateLabel(now());
    const own = new Set(ownedPrivate(ownerId).map(record => record.id));
    const candidates: MemoryCandidate[] = digested
      .filter(memory => Array.from(memory.text).length <= DIGEST_MEMORY_MAX_LENGTH && !isUnsafeContent(memory.text) && isStorableMemory(memory.text))
      .map(memory => ({
        // 모델이 상대적인 날짜를 날짜로 바꾸지 않았으면 들은 날을 붙인다(점검 M-7).
        text: hasRelativeTime(memory.text) ? `${memory.text} (${heardOn}에 들음)` : memory.text,
        kind: "viewer",
        scope: "private",
        ownerId,
        // 상대가 직접 말한 것만 뽑게 했으므로 규칙 추출(0.5)보다 확신을 조금 높게 둔다.
        importance: 0.55,
        confidence: 0.7,
        replaces: memory.replaces.filter(id => own.has(id)),
      }));
    if (candidates.length === 0) return finish();

    try {
      const saved = await deps.memoryStore.add(candidates, settings, deps.embedding(), { isStale });
      const replaced = candidates.reduce((sum, candidate) => sum + (candidate.replaces?.length ?? 0), 0);
      if (saved > 0 || replaced > 0) console.log(`[bori-companion] LLM 정리 개인 기억 ${saved}건 저장${replaced > 0 ? `, ${replaced}건 대체` : ""}`);
    } catch (error) {
      // 저장소는 메모리에 반영한 뒤 파일 쓰기에서 실패한다. 다음 저장 때 다시 쓰므로 같은 구간을 다시 정리하지 않는다.
      console.error("[bori-companion] LLM 정리 개인 기억 저장 실패:", error);
    }
    return isStale() ? false : finish();
  }

  /**
   * 대화의 남은 메시지를 정리한다. reason이 count면 사용자 메시지가 주기만큼 쌓인 몫만, end면 대화가 끝났으므로 남은 몫 전부를 정리한다.
   * 한 번에 사용자 메시지 privateDigestEveryMessages개씩 오래된 것부터 넘긴다.
   */
  async function digestConversation(ownerId: string, conversationId: string, reason: "count" | "end") {
    const settings = deps.memorySettings();
    const every = settings.privateDigestEveryMessages;
    if (!deps.digestMemories || !settings.enabled || !(every > 0)) return;

    for (;;) {
      const pending = pendingOf(ownerId, conversationId);
      if (!pending || pending.users.length === 0) return;
      if (reason === "count" && pending.users.length < every) return;

      let { start, users } = pending;
      const backlog = every * DIGEST_BACKLOG_WINDOWS;
      if (users.length > backlog) {
        // 너무 밀렸으면 오래된 몫은 건너뛴다. 그 메시지들은 LLM을 못 쓰는 동안 규칙 추출이 맡았다.
        start = users[users.length - backlog];
        users = users.slice(-backlog);
        console.log(`[bori-companion] 밀린 기억 정리가 많아 최근 사용자 메시지 ${backlog}개만 정리합니다.`);
      }
      const end = users.length > every ? users[every] : pending.messages.length;
      if (!(await digestRange(ownerId, conversationId, pending.messages, start, end))) return;
    }
  }

  /** 정리를 그 소유자의 정리 줄 끝에 붙인다. 답변을 기다리게 하지 않는다. */
  function requestDigest(ownerId: string, conversationId: string, reason: "count" | "end") {
    const previous = digestChains.get(ownerId) ?? Promise.resolve();
    const task: Promise<void> = previous.then(() => digestConversation(ownerId, conversationId, reason)).catch(error => {
      console.error("[bori-companion] LLM 개인 기억 정리 실패:", error);
    });
    digestChains.set(ownerId, task);
    track(task);
    void task.finally(() => { if (digestChains.get(ownerId) === task) digestChains.delete(ownerId); });
  }

  function cancelIdle(key: string) {
    const timer = idleTimers.get(key);
    if (timer) clearTimeout(timer);
    idleTimers.delete(key);
  }

  /** 무응답 정리를 다시 예약한다. 메시지가 올 때마다 미룬다. */
  function scheduleIdleDigest(ownerId: string, conversationId: string) {
    if (!(idleDigestMs > 0)) return;
    const key = keyOf(ownerId, conversationId);
    cancelIdle(key);
    const timer = setTimeout(() => { idleTimers.delete(key); requestDigest(ownerId, conversationId, "end"); }, idleDigestMs);
    // 예약이 남아 있어도 서버 종료를 막지 않는다.
    timer.unref?.();
    idleTimers.set(key, timer);
  }

  /**
   * 다른 대화로 옮겨 갔으면 그 대화들은 끝난 것으로 보고 남은 메시지를 정리한다.
   * 새 대화를 만들 때와, 서버를 띄운 뒤 어떤 대화에 처음 메시지를 보낼 때 부른다.
   */
  function digestOtherConversations(ownerId: string, exceptId: string) {
    for (const conversation of deps.store.list(ownerId)) {
      if (conversation.id === exceptId) continue;
      if ((pendingOf(ownerId, conversation.id)?.users.length ?? 0) === 0) continue;
      cancelIdle(keyOf(ownerId, conversation.id));
      requestDigest(ownerId, conversation.id, "end");
    }
  }

  /** 그 소유자의 진행 중인 정리를 PENDING_DIGEST_WAIT_MS까지 기다린다. 넘으면 기다리지 않고 답한다. */
  async function waitForDigests(ownerId: string) {
    const chain = digestChains.get(ownerId);
    if (!chain) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>(done => { timer = setTimeout(done, PENDING_DIGEST_WAIT_MS); });
    await Promise.race([chain, limit]).finally(() => clearTimeout(timer));
  }

  /** 답변을 저장한 뒤 부른다. 주기만큼 쌓였으면 바로 정리하고, 아니면 무응답 정리를 예약한다. */
  function afterReply(ownerId: string, conversationId: string) {
    const every = deps.memorySettings().privateDigestEveryMessages;
    if (!deps.digestMemories || !(every > 0)) return;
    scheduleIdleDigest(ownerId, conversationId);
    if ((pendingOf(ownerId, conversationId)?.users.length ?? 0) >= every) requestDigest(ownerId, conversationId, "count");
  }

  async function sendMessage(ownerId: string, conversationId: string, content: string, options: { tts: boolean }): Promise<SendMessageOutcome> {
    const key = keyOf(ownerId, conversationId);
    if (!deps.store.get(ownerId, conversationId)) return { kind: "not_found" };
    if (inFlight.has(key)) return { kind: "busy" };

    inFlight.add(key);
    try {
      // 이 대화를 처음 여는 것이면 다른 대화는 끝난 것으로 보고 남은 메시지를 정리한다. 서버를 다시 띄운 뒤에도 이어진다.
      if (!sessions.has(key)) {
        digestOtherConversations(ownerId, conversationId);
        await waitForDigests(ownerId);
      }
      // 새 메시지를 저장하기 전에 세션을 되살린다. 그래야 이번 메시지가 최근 대화에 두 번 들어가지 않는다.
      const session = sessionFor(ownerId, conversationId);
      // 관계 맥락도 이번 메시지를 저장하기 전 기록으로 계산한다. 같은 소유자의 대화만 본다.
      const statusLines = relationshipStatusLines({ conversations: deps.store.activity(ownerId), currentId: conversationId, now: now() });
      const userMessage = deps.store.append(ownerId, conversationId, { role: "user", content });
      if (!userMessage) return { kind: "not_found" };

      // 위기 신호와 그 뒤에 이어진 말은 개인 기억으로 남기지 않는다(S-3). 엔진이 위기 답을 고르는 기준과 같다.
      const crisis = isCrisisContent(content) || isInCrisisContext(session.recentTurns);
      // 기억 저장은 답 뒤에 하지만, 답을 만드는 사이 기억을 지웠으면 이 메시지도 지우기 전 메시지라 저장하지 않는다.
      const removedSinceSent = removalWatch(ownerId);
      const outcome = await deps.engine.respond(session, { content, speaker: { ownerId }, statusLines });
      const reply = deps.store.append(ownerId, conversationId, draftFor(outcome));
      // 답변을 만드는 사이 대화가 지워졌다. 세션도 이미 버려졌으므로 기록하지 않고, 기억도 만들지 않는다.
      if (!reply) return { kind: "not_found" };

      // 답이 먼저고 기억 저장은 뒤다. 예전에는 임베딩이 늦으면 저장을 기다리느라 답이 10초 넘게 늦었다(점검 M-8).
      // 막은 입력은 기억으로도 남기지 않는다.
      if (!isUnsafeContent(content) && !crisis) track(savePrivateMemories(ownerId, content, removedSinceSent));

      // 답변이 실제로 저장된 뒤에만 문맥에 남기고 매크로 수명을 줄인다. 거절한 대화는 문맥에 넣지 않는다.
      if (outcome.kind === "reply") {
        deps.engine.record(session, { role: "viewer", text: content, viewerId: ownerId });
        deps.engine.record(session, { role: "bori", text: outcome.response.reply });
        deps.engine.tickMacros(session);
        afterReply(ownerId, conversationId);
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

  /** 대화 키가 이 소유자(와 대화)의 것인지. 정리 예약·실패 기록을 지울 때 쓴다. */
  function forgetDigestState(prefix: string) {
    for (const key of [...idleTimers.keys()]) if (key.startsWith(prefix)) cancelIdle(key);
    for (const key of [...digestFailures.keys()]) if (key.startsWith(prefix)) digestFailures.delete(key);
  }

  /**
   * 대화를 지우고 세션도 버린다.
   * 그 대화에서 이미 생긴 개인 기억은 남는다. 개인 기억은 /api/me/memories로 따로 지운다.
   * 진행 중인 그 대화의 정리 결과는 저장하지 않는다(점검 M-18). 대화를 지운 뒤에 그 대화의 기억이 새로 생기면 안 된다.
   */
  function deleteConversation(ownerId: string, conversationId: string): boolean {
    const key = keyOf(ownerId, conversationId);
    sessions.delete(key);
    forgetDigestState(`${key}\u0000`);
    cancelIdle(key);
    return deps.store.remove(ownerId, conversationId);
  }

  /**
   * 본인의 개인 기억을 모두 지운다. 진행 중인 기억 저장·정리 결과도 버린다.
   * 1:1 소유자 ID(companion:)는 방송 시청자 ID(local: 등)와 겹치지 않으므로 소유자로 지워도 방송 기억은 남는다.
   * 지우기 전의 메시지는 정리한 것으로 표시된다(onRemoved). 다음 정리가 지운 기억을 되살리지 않는다.
   */
  function clearMemories(ownerId: string): Promise<number> {
    return deps.memoryStore.removeByOwner(ownerId);
  }

  return {
    sendMessage,
    deleteConversation,

    /** 새 대화를 만들었다. 다른 대화는 끝난 것으로 보고 남은 메시지를 정리한다(점검 M-6). */
    conversationStarted(ownerId: string, conversationId: string): void {
      digestOtherConversations(ownerId, conversationId);
    },

    /** 백그라운드 작업(기억 저장·LLM 기억 정리)이 모두 끝날 때까지 기다린다. 검사에서 쓴다. */
    async settle(): Promise<void> {
      while (background.size > 0) await Promise.all([...background]);
    },

    /** 본인의 개인 기억만 보여 준다. 방송 기억과 남의 기억은 목록에도 나오지 않는다. 만료된 기억은 빠진다. */
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
      forgetDigestState(prefix);
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
