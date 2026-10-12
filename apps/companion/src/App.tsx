import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, describeError, MAX_MESSAGE_LENGTH, type Conversation, type Message } from "./api";
import { useBoriLive2D } from "./live2d/useBoriLive2D";
import { loadTtsEnabled, saveTtsEnabled } from "./preferences";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConversationList } from "./components/ConversationList";
import { MemoryDialog } from "./components/MemoryDialog";
import { MessageList } from "./components/MessageList";

/** 새 대화 제목은 첫 메시지 앞부분으로 정한다. 서버가 따로 정하지 않아도 목록에서 구분된다. */
const TITLE_LENGTH = 30;

type Notice = { tone: "error" | "info"; text: string };

export function App() {
  const live2d = useBoriLive2D();
  const [characterName, setCharacterName] = useState("보리");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingContent, setPendingContent] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(loadTtsEnabled);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 답을 기다리는 사이 다른 대화로 옮겨도 늦게 온 답이 엉뚱한 대화에 붙지 않게 현재 대화를 따로 둔다.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /** 오류를 화면 안내로 바꾼다. 서버에 닿지 못한 경우는 상단 연결 안내로 따로 보여 준다. */
  const showError = useCallback((error: unknown) => {
    const lost = !(error instanceof ApiError) || error.kind === "disconnected";
    setDisconnected(lost);
    setNotice(lost ? null : { tone: "error", text: describeError(error) });
    if (import.meta.env.DEV) console.warn("[companion] 요청 실패", error);
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const list = await api.listConversations();
      setConversations(list);
      setDisconnected(false);
      return list;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      setListLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    void refreshConversations();
    // 프로필은 이름 표시용이다. 받지 못해도 기본 이름으로 동작한다.
    api.getProfile().then(profile => { if (profile.name) setCharacterName(profile.name); }).catch(() => undefined);
  }, [refreshConversations]);

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
    setMessages([]);
    setNotice(null);
    setMessagesLoading(true);
    try {
      const result = await api.getMessages(id);
      if (activeIdRef.current === id) setMessages(result.messages);
      setDisconnected(false);
    } catch (error) {
      showError(error);
      // 이미 지워진 대화면 선택을 풀고 목록을 서버와 맞춘다.
      if (error instanceof ApiError && error.kind === "notFound") { setActiveId(null); void refreshConversations(); }
    } finally {
      setMessagesLoading(false);
    }
  }, [refreshConversations, showError]);

  const startNewConversation = useCallback(() => {
    // 대화는 첫 메시지를 보낼 때 만든다. 빈 대화가 목록에 쌓이지 않게 한다.
    setActiveId(null);
    setMessages([]);
    setNotice(null);
    setSidebarOpen(false);
    inputRef.current?.focus();
  }, []);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH || pendingContent !== null) return;

    setPendingContent(content);
    setDraft("");
    setNotice(null);
    live2d.lookAtChat();

    let conversationId = activeId;
    try {
      if (!conversationId) {
        const created = await api.createConversation(content.slice(0, TITLE_LENGTH));
        conversationId = created.id;
        setActiveId(created.id);
        activeIdRef.current = created.id;
      }

      const result = await api.sendMessage(conversationId, content, ttsEnabled);
      setDisconnected(false);
      // 기다리는 사이 다른 대화로 옮겼으면 화면에는 붙이지 않는다. 목록 갱신으로 반영된다.
      if (activeIdRef.current === conversationId) {
        setMessages(current => [...current, result.userMessage, result.reply]);
        live2d.react(result.reply.emotion, result.reply.actions);
        if (result.audioId && ttsEnabled) {
          void live2d.speakAudio(result.audioId, result.reply.content).then(outcome => {
            if (outcome === "audioBlocked") setNotice({ tone: "info", text: "브라우저가 소리 재생을 막았어요. 화면을 한 번 누른 뒤 다음 답부터 들을 수 있어요." });
          });
        } else {
          live2d.speakText(result.reply.content);
        }
      }
    } catch (error) {
      showError(error);
      // 보내지 못한 내용은 입력창에 되돌려 다시 보낼 수 있게 한다.
      setDraft(current => current || content);
      if (error instanceof ApiError && error.kind === "notFound") { setActiveId(null); setMessages([]); }
    } finally {
      setPendingContent(null);
      void refreshConversations();
    }
  }, [activeId, draft, live2d, pendingContent, refreshConversations, showError, ttsEnabled]);

  // 전송이 끝나면 입력창에 다시 포커스를 둔다. 보내는 동안 잠겨 있어 포커스가 빠진다.
  useEffect(() => { if (pendingContent === null) inputRef.current?.focus(); }, [pendingContent]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteConversation(deleteTarget.id);
      if (deleteTarget.id === activeId) { setActiveId(null); setMessages([]); }
      setNotice({ tone: "info", text: "대화를 삭제했어요." });
    } catch (error) {
      showError(error);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
      void refreshConversations();
    }
  };

  // 1:1 기록을 모두 지웠으면 열린 대화도 없어졌다. 화면을 비우고 목록을 서버와 맞춘다.
  const handleDataCleared = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setNotice(null);
    void refreshConversations();
  }, [refreshConversations]);

  const toggleTts = () => {
    setTtsEnabled(current => { saveTtsEnabled(!current); return !current; });
  };

  const activeTitle = conversations.find(conversation => conversation.id === activeId)?.title;

  return (
    <div className="companion-shell">
      {disconnected && (
        <div className="connection-banner" role="alert">
          <span>서버에 연결할 수 없어요. 서버가 켜져 있는지 확인해 주세요.</span>
          <button type="button" className="ghost-button" onClick={() => void refreshConversations()}>다시 연결</button>
        </div>
      )}
      <header className="app-header">
        <button type="button" className="ghost-button sidebar-toggle" aria-expanded={sidebarOpen} aria-controls="conversation-sidebar" onClick={() => setSidebarOpen(open => !open)}>대화 목록</button>
        <h1>{characterName}와 대화</h1>
        <div className="header-actions">
          <button type="button" className="ghost-button" aria-pressed={ttsEnabled} onClick={toggleTts}>{ttsEnabled ? "음성 켜짐" : "음성 꺼짐"}</button>
          <button type="button" className="ghost-button" onClick={() => setMemoryOpen(true)}>내 기억</button>
        </div>
      </header>
      <div className="companion-body">
        <aside id="conversation-sidebar" className={`conversation-sidebar${sidebarOpen ? " open" : ""}`}>
          <ConversationList
            conversations={conversations}
            activeId={activeId}
            loading={listLoading}
            locked={pendingContent !== null}
            onCreate={startNewConversation}
            onSelect={id => void openConversation(id)}
            onRequestDelete={setDeleteTarget}
          />
        </aside>
        <section className="character-pane" aria-label={`${characterName} 캐릭터`}>
          <div className="live2d-layer" ref={live2d.layerRef} />
          {live2d.status.state !== "ready" && <p className="character-badge" role="status">{live2d.status.message}</p>}
        </section>
        <section className="chat-pane" aria-label="채팅">
          <div className="chat-title">{activeTitle ?? "새 대화"}</div>
          {notice && <p className={`notice notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
          <MessageList characterName={characterName} messages={messages} pendingContent={pendingContent} loading={messagesLoading} />
          <Composer ref={inputRef} value={draft} sending={pendingContent !== null} onChange={setDraft} onSubmit={() => void send()} />
        </section>
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="대화를 삭제할까요?"
        description={`"${deleteTarget?.title || "제목 없는 대화"}" 대화와 메시지가 모두 지워져요. 되돌릴 수 없어요.`}
        confirmLabel="삭제"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
      <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} onDataCleared={handleDataCleared} />
    </div>
  );
}
