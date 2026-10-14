import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { basename } from "node:path";
import { backupFile, isMissingFileError, removeLeftoverFiles, writeFileAtomically } from "@bori/memory";
import type { Conversation, ConversationMessage } from "@bori/shared";
import type { ConversationActivity } from "./relationship.js";

/**
 * 파일 형식 버전. 형식을 바꾸면 올리고 읽을 때 옮기는 경로를 만든다.
 * 2: 대화에 누적 요약(summary, summaryUpdatedAt)을 더했다. 1은 요약이 없는 2와 같으므로 그대로 읽는다.
 */
export const CONVERSATION_FILE_VERSION = 2;
/** 그대로 읽을 수 있는 이전 버전. 다음에 쓸 때 지금 버전으로 바뀐다. */
const READABLE_VERSIONS: readonly number[] = [1, CONVERSATION_FILE_VERSION];

/** 파일에 저장하는 대화. 밖으로 내보낼 때는 ownerId·요약을 빼고 messageCount를 붙인다. */
type StoredConversation = {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 엔진 세션의 누적 요약. 재시작 뒤 세션을 되살릴 때와 다음 대화의 지난 대화 요약에 쓴다. */
  summary?: string;
  summaryUpdatedAt?: string;
};

type StoredMessage = ConversationMessage & { conversationId: string; ownerId: string };

type ConversationFile = {
  version: number;
  conversations: StoredConversation[];
  messages: StoredMessage[];
};

/** 저장할 메시지. id와 시각은 저장소가 붙인다. */
export type NewConversationMessage = Omit<ConversationMessage, "id" | "createdAt">;

export type ConversationStoreOptions = {
  log?: (message: string) => void;
  /** 현재 시각(ms). 테스트에서 순서를 고정할 때 바꾼다. */
  now?: () => number;
  /** 임시 파일을 제자리로 옮기는 함수. 테스트에서 쓰기 실패를 주입할 때 바꾼다. */
  rename?: (from: string, to: string) => void;
};

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * 1:1 대화 저장소.
 * 기억 저장소와 같은 방식(ADR-001)으로 파일 하나를 통째로 읽고 쓴다. 대화와 메시지를 한 파일에 두어
 * 목록의 messageCount·updatedAt과 실제 메시지가 어긋나지 않게 한다.
 *
 * 모든 레코드에 소유자가 있고, 조회·추가·삭제는 항상 소유자로 거른다. 남의 대화는 없는 것과 같다.
 * 쓰기는 임시 파일에 쓴 뒤 rename으로 바꾼다. 중간에 멈춰도 이전 파일이 그대로 남는다.
 */
export function createConversationStore(filePath: string, options: ConversationStoreOptions = {}) {
  const log = options.log ?? (message => console.log(`[bori-companion] ${message}`));
  const now = options.now ?? Date.now;
  const rename = options.rename ?? renameSync;

  let conversations: StoredConversation[] = [];
  let messages: StoredMessage[] = [];
  /** 파일에 써도 되는지. 파일이 있는데 읽지 못했거나 원본을 남기지 못했으면 false다. 덮어쓰면 대화가 사라진다. */
  let writable = true;

  /**
   * 파일을 읽는다. 읽을 수 없는 파일은 지우지 않고 옆에 백업한 뒤 빈 상태로 시작한다.
   * 소유자가 없는 레코드는 누구에게도 보여 줄 수 없으므로 버린다.
   */
  function load() {
    conversations = [];
    messages = [];
    writable = true;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return;
      // 있는데 못 읽었다(잠김·권한). 파일은 멀쩡할 수 있으므로 덮어쓰지 않는다.
      writable = false;
      log(`대화 파일을 읽지 못했습니다. 이번 실행에서는 대화를 저장하지 않습니다. (${(error as NodeJS.ErrnoException).code ?? "오류"})`);
      return;
    }

    let parsed: Partial<ConversationFile> | null = null;
    try {
      parsed = JSON.parse(raw) as Partial<ConversationFile>;
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed.version !== "number" || !READABLE_VERSIONS.includes(parsed.version) || !Array.isArray(parsed.conversations) || !Array.isArray(parsed.messages)) {
      try {
        log(`대화 파일을 읽지 못해 빈 상태로 시작합니다. 원본: ${basename(backupFile(filePath, "unreadable", now()))}`);
      } catch (error) {
        writable = false;
        log(`대화 파일을 읽지 못했고 원본도 남기지 못해 이번 실행에서는 대화를 저장하지 않습니다. (${(error as NodeJS.ErrnoException).code ?? "오류"})`);
      }
      return;
    }

    conversations = parsed.conversations
      .filter(entry => isString(entry?.id) && isString(entry?.ownerId))
      // 문자열이 아닌 요약은 없는 것으로 본다. 프롬프트에 그대로 들어가는 값이다.
      .map(({ summary, summaryUpdatedAt, ...entry }) => ({
        ...entry,
        ...(typeof summary === "string" && summary.length > 0 ? { summary } : {}),
        ...(typeof summary === "string" && summary.length > 0 && typeof summaryUpdatedAt === "string" ? { summaryUpdatedAt } : {}),
      }));
    const known = new Set(conversations.map(entry => `${entry.ownerId}\u0000${entry.id}`));
    // 대화가 없는 메시지나 소유자가 대화와 다른 메시지는 버린다.
    messages = parsed.messages.filter(entry => isString(entry?.id) && isString(entry?.ownerId) && known.has(`${entry.ownerId}\u0000${entry.conversationId}`));

    const dropped = parsed.conversations.length - conversations.length + parsed.messages.length - messages.length;
    if (dropped > 0) log(`소유자를 알 수 없는 레코드 ${dropped}건을 제외했습니다.`);
    if (parsed.version !== CONVERSATION_FILE_VERSION) log(`대화 파일 버전 ${parsed.version}을 읽었습니다. 다음 저장 때 버전 ${CONVERSATION_FILE_VERSION}으로 씁니다.`);
  }

  /**
   * 바뀐 상태를 파일에 쓰고, 성공했을 때만 메모리에 반영한다.
   * 쓰기에 실패했는데 메모리만 바뀌면 재시작 뒤에 사라질 내용을 사용자에게 보여 주게 된다.
   */
  function commit(nextConversations: StoredConversation[], nextMessages: StoredMessage[]) {
    if (!writable) throw new Error("대화 파일을 읽지 못해 이번 실행에서는 저장하지 않습니다.");
    const file: ConversationFile = { version: CONVERSATION_FILE_VERSION, conversations: nextConversations, messages: nextMessages };
    // 들여쓰기 없이 쓴다. 메시지마다 파일 전체를 다시 쓰므로 작게 둔다(메시지 2만 건에서 약 10% 작다).
    writeFileAtomically(filePath, JSON.stringify(file), { rename });
    conversations = nextConversations;
    messages = nextMessages;
  }

  const find = (ownerId: string, id: string) => conversations.find(entry => entry.ownerId === ownerId && entry.id === id);
  const messagesOf = (conversation: StoredConversation) =>
    messages.filter(entry => entry.ownerId === conversation.ownerId && entry.conversationId === conversation.id);

  function toConversation(conversation: StoredConversation): Conversation {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: messagesOf(conversation).length,
    };
  }

  function toMessage({ conversationId: _conversationId, ownerId: _ownerId, ...message }: StoredMessage): ConversationMessage {
    return message;
  }

  return {
    load,

    /** 소유자의 대화 목록. 최근에 이야기한 대화가 먼저 온다. */
    list(ownerId: string): Conversation[] {
      return conversations
        .filter(entry => entry.ownerId === ownerId)
        .sort((a, b) => (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) || (Date.parse(b.createdAt) - Date.parse(a.createdAt)))
        .map(toConversation);
    },

    get(ownerId: string, id: string): Conversation | null {
      const conversation = find(ownerId, id);
      return conversation ? toConversation(conversation) : null;
    },

    create(ownerId: string, title: string): Conversation {
      const at = new Date(now()).toISOString();
      const conversation: StoredConversation = { id: randomUUID(), ownerId, title, createdAt: at, updatedAt: at };
      commit([...conversations, conversation], messages);
      return toConversation(conversation);
    },

    /** 대화의 메시지를 오래된 것부터 돌려준다. 소유자의 대화가 아니면 null이다. */
    messages(ownerId: string, id: string): ConversationMessage[] | null {
      const conversation = find(ownerId, id);
      return conversation ? messagesOf(conversation).map(toMessage) : null;
    },

    /** 메시지를 덧붙이고 대화의 updatedAt을 올린다. 소유자의 대화가 아니면 null이다. */
    append(ownerId: string, id: string, draft: NewConversationMessage): ConversationMessage | null {
      const conversation = find(ownerId, id);
      if (!conversation) return null;

      const at = new Date(now()).toISOString();
      const stored: StoredMessage = { ...draft, id: randomUUID(), createdAt: at, conversationId: id, ownerId };
      commit(
        conversations.map(entry => (entry === conversation ? { ...entry, updatedAt: at } : entry)),
        [...messages, stored],
      );
      return toMessage(stored);
    },

    /** 대화의 누적 요약. 소유자의 대화가 아니거나 요약이 없으면 빈 문자열이다. */
    summaryOf(ownerId: string, id: string): string {
      return find(ownerId, id)?.summary ?? "";
    },

    /**
     * 누적 요약을 저장한다. 소유자의 대화가 아니면 false다.
     * 요약은 대화 활동이 아니므로 updatedAt(목록 순서)을 올리지 않는다.
     */
    setSummary(ownerId: string, id: string, summary: string): boolean {
      const conversation = find(ownerId, id);
      if (!conversation) return false;
      const at = new Date(now()).toISOString();
      commit(
        conversations.map(entry => (entry === conversation ? { ...entry, summary, summaryUpdatedAt: at } : entry)),
        messages,
      );
      return true;
    },

    /** 관계 맥락 계산용 기록. 소유자의 대화만 돌려준다. */
    activity(ownerId: string): ConversationActivity[] {
      return conversations
        .filter(entry => entry.ownerId === ownerId)
        .map(entry => {
          const times = messagesOf(entry).map(message => Date.parse(message.createdAt)).filter(Number.isFinite);
          return {
            id: entry.id,
            firstMessageAt: times.length > 0 ? Math.min(...times) : null,
            lastMessageAt: times.length > 0 ? Math.max(...times) : null,
            summary: entry.summary ?? "",
          };
        });
    },

    /** 대화와 그 메시지를 지운다. 소유자의 대화가 아니면 아무것도 지우지 않는다. */
    remove(ownerId: string, id: string): boolean {
      const conversation = find(ownerId, id);
      if (!conversation) return false;
      commit(
        conversations.filter(entry => entry !== conversation),
        messages.filter(entry => !(entry.ownerId === ownerId && entry.conversationId === id)),
      );
      return true;
    },

    /** 소유자의 대화와 메시지를 모두 지운다. 요약은 대화 레코드에 있어 함께 지워진다. 남의 대화는 남는다. */
    removeOwner(ownerId: string): { conversations: number; messages: number } {
      const removed = {
        conversations: conversations.filter(entry => entry.ownerId === ownerId).length,
        messages: messages.filter(entry => entry.ownerId === ownerId).length,
      };
      if (removed.conversations === 0 && removed.messages === 0) return removed;
      commit(
        conversations.filter(entry => entry.ownerId !== ownerId),
        messages.filter(entry => entry.ownerId !== ownerId),
      );
      return removed;
    },

    /** 읽지 못해 남겨 둔 원본 백업과 이전 실행의 임시 파일을 지운다. 1:1 기록 전체 삭제 때 부른다. */
    removeLeftovers: () => removeLeftoverFiles(filePath, { unreadable: true }),
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
