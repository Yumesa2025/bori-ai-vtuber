import type { Conversation } from "../api";

type Props = {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  /** 답을 기다리는 동안은 대화를 바꾸지 못하게 한다. 늦게 온 답이 다른 대화에 섞이지 않는다. */
  locked: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRequestDelete: (conversation: Conversation) => void;
};

const dateFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const formatDate = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date); };

export function ConversationList({ conversations, activeId, loading, locked, onCreate, onSelect, onRequestDelete }: Props) {
  return (
    <nav className="conversation-list" aria-label="대화 목록">
      <button type="button" className="primary-button new-conversation" onClick={onCreate} disabled={locked}>새 대화</button>
      {loading && conversations.length === 0 && <p className="muted">대화 목록을 불러오는 중</p>}
      {!loading && conversations.length === 0 && <p className="muted">아직 대화가 없어요. 메시지를 보내면 새 대화가 시작돼요.</p>}
      <ul>
        {conversations.map(conversation => (
          <li key={conversation.id} className={conversation.id === activeId ? "active" : undefined}>
            <button type="button" className="conversation-select" aria-current={conversation.id === activeId ? "true" : undefined} disabled={locked} onClick={() => onSelect(conversation.id)}>
              <span className="conversation-title">{conversation.title || "제목 없는 대화"}</span>
              <span className="conversation-meta">{formatDate(conversation.updatedAt)} · 메시지 {conversation.messageCount}개</span>
            </button>
            <button type="button" className="icon-button" aria-label={`${conversation.title || "제목 없는 대화"} 지우기`} title="대화 지우기" disabled={locked} onClick={() => onRequestDelete(conversation)}>×</button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
