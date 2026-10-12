import { useEffect, useRef } from "react";
import type { Message } from "../api";

type Props = {
  characterName: string;
  messages: Message[];
  /** 서버 답을 기다리는 동안 먼저 보여 주는 내 메시지. */
  pendingContent: string | null;
  loading: boolean;
};

const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const formatTime = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date); };

/** 답변 출처별 보조 안내. LLM 답변과 규칙 답변은 따로 표시하지 않는다. */
const sourceNotes: Partial<Record<NonNullable<Message["source"]>, string>> = {
  fallback: "답변을 만들지 못해 기본 문장으로 대신했어요.",
};

export function MessageList({ characterName, messages, pendingContent, loading }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pendingContent]);

  const empty = !loading && messages.length === 0 && pendingContent === null;

  return (
    <div className="message-scroll" ref={scrollRef}>
      {/* 새 메시지를 화면 낭독기가 읽도록 log로 둔다. 대기 표시는 따로 status로 알린다. */}
      <ol className="message-list" role="log" aria-live="polite" aria-label="대화 내용">
        {messages.map(message => (
          <li key={message.id} className={`message message-${message.role}`}>
            <span className="message-author">{message.role === "bori" ? characterName : "나"}</span>
            <p className="message-content">{message.content}</p>
            {message.role === "bori" && message.source && sourceNotes[message.source] && <p className="message-note">{sourceNotes[message.source]}</p>}
            <time className="message-time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          </li>
        ))}
        {pendingContent !== null && (
          <li className="message message-user message-pending">
            <span className="message-author">나</span>
            <p className="message-content">{pendingContent}</p>
          </li>
        )}
      </ol>
      {pendingContent !== null && (
        <div className="typing-indicator" role="status">
          <span className="dots" aria-hidden="true"><i /><i /><i /></span>
          {characterName}가 답을 생각하고 있어요
        </div>
      )}
      {loading && <p className="muted centered">대화를 불러오는 중</p>}
      {empty && <p className="muted centered">{characterName}에게 하고 싶은 말을 보내 보세요.</p>}
    </div>
  );
}
