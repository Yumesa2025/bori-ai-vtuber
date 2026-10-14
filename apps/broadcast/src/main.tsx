import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BroadcastState } from "@bori/shared";
import { chatSendError, isSubmitEnter, readServerError, readStored, writeStored } from "./chat-input";
import type { ModelStatus } from "./live2d-status";
import { createLive2DStage, type Live2DStage } from "./live2d/stage";
import "./styles.css";

const emptyState: BroadcastState = { status: "idle", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };

const NICKNAME_KEY = "bori-chat-nickname";
const query = new URLSearchParams(location.search);
// OBS 송출용 화면에서는 입력창을 숨긴다. 소스 URL에 ?input=0 을 붙인다.
const showChatInput = query.get("input") !== "0";
// OBS에서 게임 화면 위에 보리만 얹을 때는 배경을 비운다. 소스 URL에 ?transparent=1 을 붙인다.
// 모델을 기다리는 동안에도 배경이 비어 있도록 무대를 만들기 전에 바로 적용한다.
const transparent = query.get("transparent") === "1";
if (transparent) document.documentElement.classList.add("transparent");

function BroadcastApp() {
  const [state, setState] = useState(emptyState);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: "loading", message: "모델 확인 중" });
  const [message, setMessage] = useState("");
  const [nickname, setNickname] = useState(() => readStored(NICKNAME_KEY));
  const [chatNotice, setChatNotice] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  /** Live2D 무대. 모델 확인이 끝나야 생긴다. 표정·시선·음성은 모두 무대가 맡는다(live2d/stage.ts). */
  const [stage, setStage] = useState<Live2DStage | null>(null);
  const live2dLayer = useRef<HTMLDivElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  /** 직전에 받은 상태 원문. 바뀐 게 없으면 다시 넣지 않기 위한 비교용이다. */
  const lastStateJsonRef = useRef<string | null>(null);
  // 렌더러는 전역 싱글톤이라 StrictMode가 effect를 두 번 실행하면 캔버스가 두 개 생기므로,
  // 취소된 실행은 초기화하지 않는다.
  useEffect(() => {
    const signal = { cancelled: false };
    let created: Live2DStage | null = null;

    createLive2DStage(live2dLayer.current!, { transparent, signal, onAudioBlockedChange: setAudioBlocked })
      .then(next => {
        if (signal.cancelled) { next.dispose(); return; }
        created = next;
        setStage(next);
        setModelStatus(next.status());
      })
      .catch(error => {
        if (signal.cancelled) return;
        console.error(error);
        setModelStatus({ state: "failed", message: error instanceof Error ? error.message : "Live2D를 초기화하지 못했습니다." });
      });

    return () => { signal.cancelled = true; created?.dispose(); };
  }, []);

  // 답의 표정·모션·음성. 같은 답이 폴링으로 반복해서 들어와도 무대가 한 번만 적용한다.
  useEffect(() => {
    if (!stage) return;
    const response = state.currentResponse;
    if (!response) { stage.clearResponse(); return; }
    void stage.applyResponse(response, state.currentAudioId ? `/api/tts/${state.currentAudioId}` : undefined);
  }, [stage, state.currentResponse, state.currentAudioId]);

  // 새 채팅이 올라오면 가끔 그쪽을 쳐다본다.
  useEffect(() => {
    const latest = state.visibleChats.at(-1);
    if (latest) stage?.noticeChat(latest.id);
  }, [stage, state.visibleChats]);

  useEffect(() => { chatListRef.current?.scrollTo({ top: chatListRef.current.scrollHeight, behavior: "smooth" }); }, [state.visibleChats]);

  async function sendChat() {
    const content = message.trim();
    if (!content) return;
    if (state.status !== "live") { setChatNotice("방송을 먼저 시작해 주세요."); return; }

    const name = nickname.trim();
    if (name) writeStored(NICKNAME_KEY, name);
    setMessage("");
    setChatNotice("");

    // 보내지 못했으면 입력을 되돌려 다시 보낼 수 있게 한다. 그사이 새로 입력한 것이 있으면 그대로 둔다.
    const restore = (notice: string) => { setMessage(current => current || content); setChatNotice(notice); };
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, nickname: name }),
      });
      if (!response.ok) restore(chatSendError(response.status, await readServerError(response)));
    } catch {
      restore(chatSendError(null, null));
    }
  }

  // 관리자 테스트 버튼으로 들어온 표정·모션을 실행한다. 방송 중이 아니어도 동작한다.
  useEffect(() => {
    if (state.lastTestAction) stage?.applyTestAction(state.lastTestAction);
  }, [stage, state.lastTestAction]);

  // 방송이 끝나면 감정을 초기화한다.
  useEffect(() => {
    if (state.status !== "live") stage?.resetEmotion();
  }, [stage, state.status]);
  // 말풍선과 음성이 서버에서 준비된 뒤 화면에 뜰 때까지가 그대로 체감 지연이 된다.
  // 로컬 HTTP라 비용이 거의 없으므로 짧게 돈다.
  //
  // 다만 같은 내용이라도 setState를 부르면 객체 참조가 바뀌어,
  // state.currentResponse에 의존하는 시선 이펙트가 폴링마다 다시 돌아 눈이 떨린다.
  // 원문을 그대로 비교해서 바뀐 것이 없으면 넘긴다.
  // 서버가 느리면 요청이 겹쳐 쌓이므로 앞 요청이 끝나기 전에는 다음 요청을 보내지 않는다.
  useEffect(() => {
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      fetch("/api/state")
        .then(response => response.ok ? response.text() : null)
        .then(text => {
          if (text === null || text === lastStateJsonRef.current) return;
          lastStateJsonRef.current = text;
          setState(JSON.parse(text) as typeof emptyState);
        })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };

    refresh();
    const timer = window.setInterval(refresh, 250);
    return () => window.clearInterval(timer);
  }, []);
  // 모델이 뜨지 않을 때만 진단 배지를 노출한다. 정상 렌더링 중에는 화면에 아무것도 덧그리지 않는다.
  const live = state.status === "live";
  // 막힌 음성이 남아 있으면 지금 답을 다시 틀고, 없으면 버튼만 내린다. 누른 순간부터 다음 답은 자동 재생된다.
  const unlockAudio = () => stage?.unlockAudio();
  return <main className="broadcast-shell"><div className="live2d-layer" ref={live2dLayer} /><header className="stream-header"><span>보리의 소통 방송</span><div className="header-right">{audioBlocked && <button className="audio-unlock" onClick={unlockAudio}>소리 켜기</button>}{live && <span className="live-dot">● LIVE</span>}</div></header><section className="stage"><div className="character-stage">{modelStatus.state === "failed" && <div className="character-badge" role="status">{modelStatus.message}</div>}</div><aside className="chat-panel">
      <div className="chat-scroll" ref={chatListRef}>{state.visibleChats.map(chat => <p className="chat-line" key={chat.id}>{chat.content}</p>)}</div>
      {showChatInput && <div className="chat-compose">
        {chatNotice && <p className="chat-warn" role="status">{chatNotice}</p>}
        <input className="chat-nickname" value={nickname} onChange={event => setNickname(event.target.value)} placeholder="이름" aria-label="이름" maxLength={20} />
        <div className="chat-send-row">
          <input value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (isSubmitEnter(event)) void sendChat(); }} placeholder={live ? "채팅을 입력하세요" : "방송 대기 중"} aria-label="채팅" maxLength={200} />
          <button onClick={() => void sendChat()} disabled={!message.trim() || !live}>전송</button>
        </div>
      </div>}
    </aside></section>{state.currentResponse && <div className="speech-bubble">{state.currentResponse.reply}</div>}<footer className="status-bar"><span>AI 버추얼 스트리머 보리</span><span>{live ? "소통 방송 중" : "방송 대기 중"}</span></footer></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><BroadcastApp /></StrictMode>);
