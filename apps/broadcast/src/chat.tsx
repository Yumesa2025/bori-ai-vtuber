import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BroadcastState } from "@bori/shared";
import "./chat.css";

const NICKNAME_KEY = "bori-chat-nickname";

type Entry = { id: string; who: "me" | "bori"; text: string; at: number };

function ChatApp() {
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICKNAME_KEY) ?? "");
  const [draftNickname, setDraftNickname] = useState(nickname);
  const [message, setMessage] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<BroadcastState["status"]>("idle");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(true);
  const lastReplyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 방송 상태와 보리의 답변을 폴링으로 가져온다. 같은 답변은 한 번만 쌓는다.
  useEffect(() => {
    const tick = async () => {
      try {
        const response = await fetch("/api/state");
        if (!response.ok || response.status >= 500) { setOnline(false); return; }
        setOnline(true);
        const next = await response.json() as BroadcastState;
        setStatus(next.status);
        const reply = next.currentResponse?.reply;
        if (reply && reply !== lastReplyRef.current) {
          lastReplyRef.current = reply;
          setEntries(prev => [...prev, { id: `bori-${Date.now()}`, who: "bori", text: reply, at: Date.now() }]);
        }
        if (!reply) lastReplyRef.current = null;
      } catch {
        setOnline(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [entries]);

  function saveNickname() {
    const trimmed = draftNickname.trim().slice(0, 20);
    if (!trimmed) return;
    localStorage.setItem(NICKNAME_KEY, trimmed);
    setNickname(trimmed);
  }

  async function send() {
    const content = message.trim();
    if (!content) return;
    if (status !== "live") { setNotice("아직 방송이 시작되지 않았어요."); return; }

    setEntries(prev => [...prev, { id: `me-${Date.now()}`, who: "me", text: content, at: Date.now() }]);
    setMessage("");
    setNotice("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, nickname }),
      });
      if (!response.ok) setNotice("같은 채팅이 이미 들어갔거나 지금은 보낼 수 없어요.");
    } catch {
      setOnline(false);
      setNotice("서버에 연결할 수 없어요.");
    }
  }

  if (!nickname) {
    return <main className="chat-shell">
      <div className="nickname-gate">
        <h1>보리 방송 채팅</h1>
        <p>사용할 이름을 정해 주세요. 방송 화면에는 이름이 나오지 않습니다.</p>
        <div className="chat-input-row">
          <input value={draftNickname} onChange={event => setDraftNickname(event.target.value)} onKeyDown={event => event.key === "Enter" && saveNickname()} placeholder="이름" maxLength={20} autoFocus />
          <button className="primary" onClick={saveNickname} disabled={!draftNickname.trim()}>시작</button>
        </div>
      </div>
    </main>;
  }

  return <main className="chat-shell">
    <header className="chat-header">
      <div><strong>보리 방송 채팅</strong><span className="who">{nickname}</span></div>
      <span className={`badge ${!online ? "badge-off" : status === "live" ? "badge-live" : "badge-idle"}`}>{!online ? "서버 끊김" : status === "live" ? "방송 중" : "대기 중"}</span>
    </header>

    <div className="chat-list" ref={listRef}>
      {entries.length === 0 && <p className="empty">채팅을 보내면 보리가 답해요.</p>}
      {entries.map(entry => <div key={entry.id} className={`bubble ${entry.who}`}>{entry.who === "bori" && <span className="from">보리</span>}<span>{entry.text}</span></div>)}
    </div>

    {notice && <div className="chat-notice">{notice}</div>}

    <div className="chat-input-row">
      <input value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => event.key === "Enter" && void send()} placeholder={status === "live" ? "채팅을 입력하세요" : "방송 시작을 기다리는 중"} maxLength={200} />
      <button className="primary" onClick={() => void send()} disabled={!message.trim() || status !== "live"}>보내기</button>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><ChatApp /></StrictMode>);
