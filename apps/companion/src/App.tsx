import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, describeError, MAX_MESSAGE_LENGTH, type Conversation, type Message } from "./api";
import { useBoriLive2D } from "./live2d/useBoriLive2D";
import { loadActiveConversation, loadTtsEnabled, saveActiveConversation, saveTtsEnabled } from "./preferences";
import { failureNotice, speechNotice, withParticle } from "./ui";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConversationList } from "./components/ConversationList";
import { MemoryDialog } from "./components/MemoryDialog";
import { MessageList } from "./components/MessageList";

/** 새 대화 제목은 첫 메시지 앞부분으로 정한다. 서버가 따로 정하지 않아도 목록에서 구분된다. */
const TITLE_LENGTH = 30;
/** 서버에 닿지 못하는 동안 다시 연결을 시도하는 간격. 서버가 돌아오면 연결 안내가 저절로 사라진다. */
const RECONNECT_INTERVAL_MS = 5000;

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
  // 저장된 값은 아래 effect가 activeId로 덮으므로 첫 렌더 때 한 번만 읽어 둔다.
  const [restoreId] = useState(loadActiveConversation);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  /** 대화를 지운 뒤 입력창으로 포커스를 옮기라는 신호. 지운 항목의 버튼이 사라져 포커스가 body로 빠지는 것을 막는다. */
  const [focusInputSeq, setFocusInputSeq] = useState(0);
  /** 답을 기다리는 사이 1:1 기록을 모두 지웠는지. 그러면 보낸 문장을 입력창에 되돌리지 않는다. */
  const dataClearedRef = useRef(false);
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

  // 끊긴 동안에만 주기적으로 다시 연결해 본다. 붙으면 refreshConversations가 안내를 내린다.
  useEffect(() => {
    if (!disconnected) return;
    const timer = window.setInterval(() => void refreshConversations(), RECONNECT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [disconnected, refreshConversations]);

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

  useEffect(() => {
    // 새로고침 전에 열려 있던 대화가 아직 있으면 다시 연다. 이미 지워졌으면 새 대화로 시작한다.
    void refreshConversations().then(list => {
      if (restoreId && list?.some(conversation => conversation.id === restoreId) && activeIdRef.current === null) void openConversation(restoreId);
    });
    // 프로필은 이름 표시용이다. 받지 못해도 기본 이름으로 동작한다.
    api.getProfile().then(profile => { if (profile.name) setCharacterName(profile.name); }).catch(() => undefined);
  }, [openConversation, refreshConversations, restoreId]);

  useEffect(() => { saveActiveConversation(activeId); }, [activeId]);

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
    dataClearedRef.current = false;
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
        // LLM을 쓸 수 없어 기본 문장으로 답했으면 이유를 알려 준다. 고장인지 설정 문제인지 구분할 수 있다.
        const unavailable = failureNotice(result.failure?.kind);
        if (unavailable) setNotice({ tone: "info", text: unavailable });
        if (result.audioId && ttsEnabled) {
          void live2d.speakAudio(result.audioId, result.reply.content).then(outcome => {
            const text = speechNotice(outcome);
            // LLM 안내가 더 중요하므로 덮지 않는다.
            if (text && !unavailable) setNotice({ tone: "info", text });
          });
        } else {
          live2d.speakText(result.reply.content);
        }
      }
    } catch (error) {
      // 기다리는 사이 1:1 기록을 모두 지웠으면 실패는 당연하다. 지운 문장을 되살리거나 오류를 띄우지 않는다.
      if (dataClearedRef.current) return;
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
  // 대화를 지운 뒤에도 입력창으로 돌아온다. 확인 대화상자가 닫힌 뒤(자식 effect 다음)에 돈다.
  useEffect(() => { if (focusInputSeq > 0) inputRef.current?.focus(); }, [focusInputSeq]);

  // 좁은 화면 서랍: 열면 첫 버튼으로 포커스를 옮기고, Esc로 닫으면 여닫는 버튼으로 돌려준다.
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    sidebarToggleRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeSidebar(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen, closeSidebar]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteConversation(deleteTarget.id);
      if (deleteTarget.id === activeId) { setActiveId(null); setMessages([]); }
      setNotice({ tone: "info", text: "대화를 지웠어요." });
    } catch (error) {
      showError(error);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
      setFocusInputSeq(seq => seq + 1);
      void refreshConversations();
    }
  };

  // 1:1 기록을 모두 지웠으면 열린 대화도 없어졌다. 화면을 비우고 목록을 서버와 맞춘다.
  const handleDataCleared = useCallback(() => {
    dataClearedRef.current = true;
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
        <button type="button" ref={sidebarToggleRef} className="ghost-button sidebar-toggle" aria-expanded={sidebarOpen} aria-controls="conversation-sidebar" onClick={() => setSidebarOpen(open => !open)}>대화 목록</button>
        <h1>{withParticle(characterName, "와", "과")} 대화</h1>
        <div className="header-actions">
          <button type="button" className="ghost-button" aria-pressed={ttsEnabled} onClick={toggleTts}>{ttsEnabled ? "음성 켜짐" : "음성 꺼짐"}</button>
          <button type="button" className="ghost-button" onClick={() => setMemoryOpen(true)}>내 기억</button>
        </div>
      </header>
      <div className="companion-body">
        {sidebarOpen && <button type="button" className="sidebar-backdrop" aria-label="대화 목록 닫기" tabIndex={-1} onClick={closeSidebar} />}
        <aside id="conversation-sidebar" ref={sidebarRef} className={`conversation-sidebar${sidebarOpen ? " open" : ""}`}>
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
        title="대화를 지울까요?"
        description={`"${deleteTarget?.title || "제목 없는 대화"}" 대화와 메시지가 모두 지워져요. 되돌릴 수 없어요.`}
        confirmLabel="지우기"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
      <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} onDataCleared={handleDataCleared} />
    </div>
  );
}
