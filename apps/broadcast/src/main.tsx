import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BroadcastState } from "@bori/shared";
import { boriMotionPriority, motionPairedExpression, resolveExpression, resolveMotion } from "@bori/live2d";
import "./styles.css";

const emptyState: BroadcastState = { status: "idle", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };

/** SDK 샘플 LAppModel 중 방송 화면이 쓰는 부분만 추린 타입. */
type BoriModel = {
  setExpression(expressionId: string): void;
  clearExpression(): void;
  startMotion(group: string, no: number, priority: number, onFinished?: () => void): unknown;
  setManualLipSync(value: number | null): void;
};
type BoriDelegate = {
  getLoadedModel(index?: number): BoriModel | null;
  lookAt(x: number, y: number): void;
};

/**
 * 시선 설정. 화면 중앙이 (0, 0), 오른쪽이 +x, 위가 +y다.
 * 모델 쪽에서 관성을 두고 목표를 따라가므로 여기서는 목표점만 자연스럽게 정한다.
 * 항상 정확히 정면으로 되돌리면 기계적으로 보이기 때문에 매번 조금씩 다른 지점을 본다.
 */
const GAZE = {
  /** 새 채팅이 올라왔을 때 실제로 쳐다볼 확률. 나머지는 못 본 척 넘어간다. */
  lookChance: 0.6,
  /** 쳐다볼 때의 가로 범위. 값이 클수록 확 돌아본다. */
  chatXMin: 0.45,
  chatXMax: 0.9,
  chatYMin: -0.3,
  chatYMax: 0.0,
  /**
   * 채팅을 보고 있는 시간.
   * 고개가 천천히 돌아가므로 이 값이 짧으면 다 돌아보기도 전에 시선이 되돌아온다.
   */
  holdMinMs: 2600,
  holdMaxMs: 4200,
  /** 평소 둘러보는 범위와 간격. 가만히 있어도 시선이 살짝 움직인다. */
  idleXMin: -0.28,
  idleXMax: 0.28,
  idleYMin: -0.15,
  idleYMax: 0.2,
  // 모델이 목표에 닿으면 멈추므로, 간격이 길면 한곳을 오래 응시하는 것처럼 보인다.
  idleIntervalMinMs: 1100,
  idleIntervalMaxMs: 3200,
  /** 말할 때는 시청자 쪽을 보되 완전히 고정하지는 않는다. */
  speakXMin: -0.12,
  speakXMax: 0.12,
  speakYMin: -0.05,
  speakYMax: 0.12,
};

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * 립싱크 설정.
 * 아직 음성이 없으므로 답변 길이에 맞춰 말하는 것처럼 입을 움직인다.
 * TTS를 붙이면 이 값 대신 음성 파형을 넣으면 된다.
 */
const LIP_SYNC = {
  /** 한 글자를 말하는 데 걸리는 시간. 한국어 발화 속도에 맞춘 값이다. */
  msPerChar: 78,
  minMs: 900,
  maxMs: 9000,
  /** 입이 열리고 닫히는 주기. 값이 작을수록 빠르게 움직인다. */
  cycleMs: 190,
  openMin: 0.12,
  openMax: 0.95,
  /**
   * 음성 파형을 입 벌림으로 바꿀 때의 배율.
   * 합성 음성의 실효값은 0.1 안팎이라 배율이 낮으면 입이 조금밖에 안 벌어져 티가 나지 않는다.
   */
  audioGain: 16,
  /** 파형이 순간적으로 튀는 것을 눌러 준다. 값이 작을수록 부드럽다. */
  audioSmoothing: 0.45,
};

/**
 * 시선이 목표를 따라가는 속도(1/초). 작을수록 천천히 고개를 돌린다.
 * 프레임 수가 아니라 경과 시간으로 계산해 화면 주사율이 달라도 같은 속도로 움직인다.
 * 2.5면 목표까지 대략 0.9초에 걸쳐 이동한다.
 */
const GAZE_SPEED = 2.5;

const NICKNAME_KEY = "bori-chat-nickname";
// OBS 송출용 화면에서는 입력창을 숨긴다. 소스 URL에 ?input=0 을 붙인다.
const showChatInput = new URLSearchParams(location.search).get("input") !== "0";

function BroadcastApp() {
  const [state, setState] = useState(emptyState);
  const [modelStatus, setModelStatus] = useState("모델 확인 중");
  const [message, setMessage] = useState("");
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICKNAME_KEY) ?? "");
  const [chatNotice, setChatNotice] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const live2dLayer = useRef<HTMLDivElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const delegateRef = useRef<BoriDelegate | null>(null);
  const appliedResponseRef = useRef<string | null>(null);
  const playingMotionRef = useRef<string | null>(null);
  const appliedTestSeqRef = useRef<number | null>(null);
  const expressionTimerRef = useRef<number | undefined>(undefined);
  const gazeTimerRef = useRef<number | undefined>(undefined);
  const lastChatIdRef = useRef<string | null>(null);
  // 시선은 목표만 바꾸고 실제 이동은 프레임마다 조금씩 한다. 바로 지정하면 고개가 휙 돌아간다.
  const gazeTargetRef = useRef({ x: 0, y: 0 });
  const gazeCurrentRef = useRef({ x: 0, y: 0 });
  // Cubism Core를 먼저 올린 뒤 렌더러를 초기화한다. 둘을 따로 실행하면 순서가 보장되지 않는다.
  // 렌더러는 전역 싱글톤이라 StrictMode가 effect를 두 번 실행하면 캔버스가 두 개 생기므로,
  // 취소된 실행은 초기화하지 않는다.
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;

    const loadCore = () => new Promise<void>((resolvePromise, rejectPromise) => {
      const script = document.createElement("script");
      script.src = "/private-core/live2dcubismcore.js";
      script.async = true;
      script.onload = () => resolvePromise();
      script.onerror = () => rejectPromise(new Error("Cubism Core를 불러오지 못했습니다."));
      document.head.appendChild(script);
    });

    loadCore()
      .then(() => import("@sdk-sample/lappdelegate"))
      .then(({ LAppDelegate }) => {
        if (cancelled) return;
        const delegate = LAppDelegate.getInstance();
        if (!delegate.initialize()) throw new Error("Cubism initialize failed");
        delegate.run();
        delegateRef.current = delegate;
        if (import.meta.env.DEV) (window as unknown as { __boriDelegate?: unknown }).__boriDelegate = delegate;
        const canvas = document.querySelector("body > canvas");
        if (canvas && live2dLayer.current) live2dLayer.current.appendChild(canvas);
        setModelStatus("Live2D 렌더러 초기화됨");
        release = () => { delegateRef.current = null; LAppDelegate.releaseInstance(); };
      })
      .catch(error => {
        if (cancelled) return;
        console.error(error);
        setModelStatus(error instanceof Error ? error.message : "Live2D 초기화 실패");
      });

    return () => { cancelled = true; release?.(); };
  }, []);

  // 응답의 감정과 actions를 모델 표정·모션으로 실행한다.
  // 같은 응답이 폴링으로 반복해서 들어오므로 한 번만 적용한다.
  useEffect(() => {
    const response = state.currentResponse;
    if (!response) { appliedResponseRef.current = null; return; }

    const model = delegateRef.current?.getLoadedModel();
    if (!model) return;

    const responseKey = `${response.emotion.primary}|${response.reply}`;
    if (appliedResponseRef.current === responseKey) return;
    appliedResponseRef.current = responseKey;

    const motion = resolveMotion(response.actions, response.emotion.primary);

    // 모션은 짝이 되는 표정이 켜져 있어야 화면에 보인다. 모션이 있으면 그 짝 표정을 쓴다.
    // 표정이 없는 감정은 표정을 해제해 기본 얼굴을 유지한다.
    const expression = motion ? motionPairedExpression(motion.group) : resolveExpression(response.emotion.primary);
    if (expression) model.setExpression(expression); else model.clearExpression();

    // 감정 지속 시간이 끝나면 표정을 해제해 기본 상태로 돌아온다.
    window.clearTimeout(expressionTimerRef.current);
    expressionTimerRef.current = window.setTimeout(() => {
      delegateRef.current?.getLoadedModel()?.clearExpression();
    }, response.emotion.durationSeconds * 1000);

    // 같은 모션이 재생 중이면 무시한다. 다른 모션은 SDK 우선순위 규칙에 맡긴다.
    const skipMotion = motion == null || playingMotionRef.current === motion.group;
    if (motion && !skipMotion) {
      playingMotionRef.current = motion.group;
      model.startMotion(motion.group, 0, motion.priority, () => { playingMotionRef.current = null; });
    }

    if (import.meta.env.DEV) console.info(`[bori] emotion=${response.emotion.primary} expression=${expression ?? "none"} motion=${skipMotion ? "none" : motion!.group}`);
  }, [state.currentResponse]);

  // 목표 시선을 프레임마다 조금씩 따라간다. 이 보간이 고개 돌아가는 속도를 정한다.
  useEffect(() => {
    let previous = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      // 프레임 간격이 들쭉날쭉해도 같은 속도로 움직이도록 경과 시간으로 계산한다.
      const deltaSeconds = Math.min(0.2, (now - previous) / 1000);
      previous = now;
      const ratio = 1 - Math.exp(-GAZE_SPEED * deltaSeconds);

      const current = gazeCurrentRef.current;
      const target = gazeTargetRef.current;
      current.x += (target.x - current.x) * ratio;
      current.y += (target.y - current.y) * ratio;
      delegateRef.current?.lookAt(current.x, current.y);
      if (import.meta.env.DEV) (window as unknown as { __boriGaze?: unknown }).__boriGaze = { target: { ...target }, current: { ...current } };
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // 평소에는 주변을 천천히 둘러본다. 한곳을 계속 응시하면 인형처럼 보인다.
  const scheduleIdleGaze = useRef<() => void>(() => {});
  scheduleIdleGaze.current = () => {
    window.clearTimeout(gazeTimerRef.current);
    gazeTimerRef.current = window.setTimeout(() => {
      gazeTargetRef.current = { x: randomBetween(GAZE.idleXMin, GAZE.idleXMax), y: randomBetween(GAZE.idleYMin, GAZE.idleYMax) };
      scheduleIdleGaze.current();
    }, randomBetween(GAZE.idleIntervalMinMs, GAZE.idleIntervalMaxMs));
  };

  useEffect(() => {
    scheduleIdleGaze.current();
    return () => window.clearTimeout(gazeTimerRef.current);
  }, []);

  // 새 채팅이 올라오면 가끔 그쪽을 쳐다본다. 매번 보면 오히려 어색하다.
  useEffect(() => {
    const latest = state.visibleChats.at(-1);
    if (!latest || latest.id === lastChatIdRef.current) return;
    lastChatIdRef.current = latest.id;
    if (!delegateRef.current) return;

    // 못 본 척 넘어가는 경우. 이때는 평소 시선 흐름을 그대로 둔다.
    if (Math.random() > GAZE.lookChance) return;

    gazeTargetRef.current = { x: randomBetween(GAZE.chatXMin, GAZE.chatXMax), y: randomBetween(GAZE.chatYMin, GAZE.chatYMax) };

    // 다 읽으면 정면이 아니라 평소 둘러보기로 돌아간다. 그래야 전환이 끊기지 않는다.
    window.clearTimeout(gazeTimerRef.current);
    gazeTimerRef.current = window.setTimeout(() => {
      gazeTargetRef.current = { x: randomBetween(GAZE.idleXMin, GAZE.idleXMax), y: randomBetween(GAZE.idleYMin, GAZE.idleYMax) };
      scheduleIdleGaze.current();
    }, randomBetween(GAZE.holdMinMs, GAZE.holdMaxMs));
  }, [state.visibleChats]);

  // 답변할 때는 시청자 쪽을 본다. 정확히 정면에 고정하지 않고 조금씩 흔들어 둔다.
  useEffect(() => {
    if (!state.currentResponse) return;
    gazeTargetRef.current = { x: randomBetween(GAZE.speakXMin, GAZE.speakXMax), y: randomBetween(GAZE.speakYMin, GAZE.speakYMax) };
    scheduleIdleGaze.current();
  }, [state.currentResponse]);

  // 음성이 있으면 재생하고 파형으로 입을 움직인다. 텍스트 립싱크보다 정확하다.
  useEffect(() => {
    const audioId = state.currentAudioId;
    if (!audioId) return;

    const audio = new Audio(`/api/tts/${audioId}`);
    audio.crossOrigin = "anonymous";
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaElementSource(audio).connect(analyser);
    analyser.connect(context.destination);

    const samples = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let stopped = false;
    let opening = 0;

    const step = () => {
      const model = delegateRef.current?.getLoadedModel();
      if (stopped || !model) return;

      analyser.getByteTimeDomainData(samples);
      // 파형의 실효값을 입 벌림으로 쓴다. 소리가 클수록 크게 벌린다.
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const value = (samples[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / samples.length);

      // 프레임마다 값이 튀면 입이 떨리는 것처럼 보이므로 이전 값과 섞는다.
      const target = Math.min(1, rms * LIP_SYNC.audioGain);
      opening += (target - opening) * LIP_SYNC.audioSmoothing;
      model.setManualLipSync(opening);

      frame = requestAnimationFrame(step);
    };

    const finish = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      delegateRef.current?.getLoadedModel()?.setManualLipSync(null);
    };

    audio.addEventListener("ended", finish);
    // 브라우저가 자동 재생을 막으면 소리 없이 진행한다. OBS 브라우저 소스에서는 막히지 않는다.
    void context.resume()
      .then(() => audio.play())
      .then(() => { setAudioBlocked(false); frame = requestAnimationFrame(step); })
      .catch(() => { setAudioBlocked(true); finish(); });

    return () => {
      finish();
      audio.pause();
      audio.removeEventListener("ended", finish);
      void context.close();
    };
  }, [state.currentAudioId]);

  // 음성이 없을 때만 답변 길이에 맞춰 말하는 시늉을 한다.
  useEffect(() => {
    const reply = state.currentResponse?.reply;
    if (!reply || state.currentAudioId) return;

    const durationMs = Math.min(LIP_SYNC.maxMs, Math.max(LIP_SYNC.minMs, reply.length * LIP_SYNC.msPerChar));
    const startedAt = performance.now();
    let frame = 0;

    const step = () => {
      const model = delegateRef.current?.getLoadedModel();
      const elapsed = performance.now() - startedAt;

      if (!model || elapsed >= durationMs) {
        model?.setManualLipSync(null);
        return;
      }

      // 사인파에 흔들림을 섞어 같은 폭으로 반복되지 않게 한다.
      const wave = (Math.sin((elapsed / LIP_SYNC.cycleMs) * Math.PI * 2) + 1) / 2;
      const jitter = 0.75 + Math.random() * 0.25;
      model.setManualLipSync(LIP_SYNC.openMin + wave * jitter * (LIP_SYNC.openMax - LIP_SYNC.openMin));

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      delegateRef.current?.getLoadedModel()?.setManualLipSync(null);
    };
  }, [state.currentResponse]);

  useEffect(() => { chatListRef.current?.scrollTo({ top: chatListRef.current.scrollHeight, behavior: "smooth" }); }, [state.visibleChats]);

  async function sendChat() {
    const content = message.trim();
    if (!content) return;
    if (state.status !== "live") { setChatNotice("방송을 먼저 시작해 주세요."); return; }

    const name = nickname.trim();
    if (name) localStorage.setItem(NICKNAME_KEY, name);
    setMessage("");
    setChatNotice("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, nickname: name }),
      });
      if (!response.ok) setChatNotice("같은 채팅이 이미 들어갔거나 지금은 보낼 수 없어요.");
    } catch {
      setChatNotice("서버에 연결할 수 없어요.");
    }
  }

  // 관리자 테스트 버튼으로 들어온 표정·모션을 실행한다. 방송 중이 아니어도 동작한다.
  useEffect(() => {
    const action = state.lastTestAction;
    if (!action || appliedTestSeqRef.current === action.seq) return;

    const model = delegateRef.current?.getLoadedModel();
    if (!model) return; // 모델이 아직 준비되지 않았으면 다음 폴링에서 다시 시도한다.
    appliedTestSeqRef.current = action.seq;

    window.clearTimeout(expressionTimerRef.current);
    if (action.kind === "expression") {
      model.setExpression(action.name);
    } else {
      // 모션 테스트도 짝 표정을 함께 켜야 실제로 보인다.
      model.setExpression(motionPairedExpression(action.name as never));
      playingMotionRef.current = action.name;
      model.startMotion(action.name, 0, boriMotionPriority.force, () => { playingMotionRef.current = null; });
    }

    if (import.meta.env.DEV) console.info(`[bori] test ${action.kind}=${action.name}`);
  }, [state.lastTestAction]);

  // 방송이 끝나면 감정을 초기화한다.
  useEffect(() => {
    if (state.status === "live") return;
    window.clearTimeout(expressionTimerRef.current);
    appliedResponseRef.current = null;
    playingMotionRef.current = null;
    delegateRef.current?.getLoadedModel()?.clearExpression();
  }, [state.status]);
  useEffect(() => { const refresh = () => fetch("/api/state").then(r => r.ok ? r.json() : null).then(next => next && setState(next)).catch(() => undefined); refresh(); const timer = window.setInterval(refresh, 1000); return () => window.clearInterval(timer); }, []);
  // 모델이 뜨지 않을 때만 진단 배지를 노출한다. 정상 렌더링 중에는 화면에 아무것도 덧그리지 않는다.
  const modelFailed = modelStatus.includes("실패") || modelStatus.includes("못했습니다") || modelStatus.includes("failed");
  return <main className="broadcast-shell"><div className="live2d-layer" ref={live2dLayer} /><header className="stream-header"><span>보리의 소통 방송</span><div className="header-right">{audioBlocked && <button className="audio-unlock" onClick={() => { void new AudioContext().resume(); setAudioBlocked(false); }}>소리 켜기</button>}<span className="live-dot">● LIVE</span></div></header><section className="stage"><div className="character-stage">{modelFailed && <div className="character-badge">{modelStatus}</div>}</div><aside className="chat-panel">
      <div className="chat-scroll" ref={chatListRef}>{state.visibleChats.map(chat => <p className="chat-line" key={chat.id}>{chat.content}</p>)}</div>
      {showChatInput && <div className="chat-compose">
        {chatNotice && <p className="chat-warn">{chatNotice}</p>}
        <input className="chat-nickname" value={nickname} onChange={event => setNickname(event.target.value)} placeholder="이름" maxLength={20} />
        <div className="chat-send-row">
          <input value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => event.key === "Enter" && void sendChat()} placeholder={state.status === "live" ? "채팅을 입력하세요" : "방송 대기 중"} maxLength={200} />
          <button onClick={() => void sendChat()} disabled={!message.trim() || state.status !== "live"}>전송</button>
        </div>
      </div>}
    </aside></section>{state.currentResponse && <div className="speech-bubble">{state.currentResponse.reply}</div>}<footer className="status-bar"><span>AI 버추얼 스트리머 보리</span><span>{state.status === "live" ? "소통 방송 중" : "방송 대기 중"}</span></footer></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><BroadcastApp /></StrictMode>);
