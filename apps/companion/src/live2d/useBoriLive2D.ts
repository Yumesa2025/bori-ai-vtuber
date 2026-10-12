import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageAction, MessageEmotion } from "../api";
import { planReaction } from "./reaction";

/**
 * 1:1 대화 화면의 Live2D 제어.
 * 초기화·표정·모션·시선·립싱크는 방송 화면(`apps/broadcast/src/main.tsx`)과 같은 SDK 진입점과 같은 규칙을 쓴다.
 * 방송 화면은 상태 폴링에 묶여 있어 그대로 가져올 수 없으므로, 답변 하나를 받아 실행하는 형태로 옮겼다.
 */

/** SDK 샘플 LAppModel 중 대화 화면이 쓰는 부분만 추린 타입. */
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

export type Live2DStatus = { state: "loading" | "ready" | "failed"; message: string };
export type SpeechResult = "audio" | "text" | "audioBlocked";

/** 시선 설정. 화면 중앙이 (0, 0), 오른쪽이 +x, 위가 +y다. 값은 방송 화면과 같다. */
const GAZE = {
  idleXMin: -0.28,
  idleXMax: 0.28,
  idleYMin: -0.15,
  idleYMax: 0.2,
  idleIntervalMinMs: 1100,
  idleIntervalMaxMs: 3200,
  /** 답할 때는 사용자 쪽을 보되 완전히 고정하지는 않는다. */
  speakXMin: -0.12,
  speakXMax: 0.12,
  speakYMin: -0.05,
  speakYMax: 0.12,
  /** 사용자가 메시지를 보내면 채팅 쪽(넓은 화면에서 오른쪽)을 잠깐 본다. */
  readXMin: 0.35,
  readXMax: 0.7,
  readYMin: -0.3,
  readYMax: -0.05,
  readHoldMs: 1800,
};

/** 시선이 목표를 따라가는 속도(1/초). 방송 화면과 같다. */
const GAZE_SPEED = 2.5;

/** 립싱크 설정. 방송 화면과 같은 값이다. */
const LIP_SYNC = {
  msPerChar: 78,
  minMs: 900,
  maxMs: 9000,
  cycleMs: 190,
  openMin: 0.12,
  openMax: 0.95,
  audioGain: 16,
  audioSmoothing: 0.45,
};

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

// Core 스크립트는 한 번만 올린다. StrictMode에서 effect가 두 번 돌아도 태그가 중복되지 않는다.
let corePromise: Promise<void> | null = null;
function loadCore(): Promise<void> {
  corePromise ??= new Promise<void>((resolvePromise, rejectPromise) => {
    const script = document.createElement("script");
    script.src = "/private-core/live2dcubismcore.js";
    script.async = true;
    script.onload = () => resolvePromise();
    script.onerror = () => { corePromise = null; rejectPromise(new Error("Cubism Core를 불러오지 못했습니다.")); };
    document.head.appendChild(script);
  });
  return corePromise;
}

export function useBoriLive2D() {
  const layerRef = useRef<HTMLDivElement>(null);
  const delegateRef = useRef<BoriDelegate | null>(null);
  const [status, setStatus] = useState<Live2DStatus>({ state: "loading", message: "캐릭터를 불러오는 중" });
  const expressionTimerRef = useRef<number | undefined>(undefined);
  const gazeTimerRef = useRef<number | undefined>(undefined);
  const playingMotionRef = useRef<string | null>(null);
  const stopSpeechRef = useRef<(() => void) | null>(null);
  const gazeTargetRef = useRef({ x: 0, y: 0 });
  const gazeCurrentRef = useRef({ x: 0, y: 0 });

  const model = () => delegateRef.current?.getLoadedModel() ?? null;

  // Cubism Core를 먼저 올린 뒤 렌더러를 초기화한다.
  // 렌더러는 전역 싱글톤이라 StrictMode가 effect를 두 번 실행하면 캔버스가 두 개 생기므로, 취소된 실행은 초기화하지 않는다.
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;

    loadCore()
      .then(() => import("@sdk-sample/lappdelegate"))
      .then(({ LAppDelegate }) => {
        if (cancelled) return;
        const delegate = LAppDelegate.getInstance();
        if (!delegate.initialize()) throw new Error("Live2D 렌더러를 초기화하지 못했습니다.");
        delegate.run();
        delegateRef.current = delegate;
        if (import.meta.env.DEV) (window as unknown as { __boriDelegate?: unknown }).__boriDelegate = delegate;
        // SDK 샘플은 캔버스를 body 끝에 붙인다. 캐릭터 영역 안으로 옮겨 레이아웃을 따르게 한다.
        const canvas = document.querySelector("body > canvas");
        if (canvas && layerRef.current) layerRef.current.appendChild(canvas);
        setStatus({ state: "ready", message: "Live2D 렌더러 초기화됨" });
        release = () => { delegateRef.current = null; LAppDelegate.releaseInstance(); };
      })
      .catch(error => {
        if (cancelled) return;
        console.error(error);
        setStatus({ state: "failed", message: "캐릭터를 불러오지 못했어요. 대화는 그대로 할 수 있어요." });
      });

    return () => { cancelled = true; release?.(); };
  }, []);

  // 목표 시선을 프레임마다 조금씩 따라간다. 바로 지정하면 고개가 휙 돌아간다.
  useEffect(() => {
    let previous = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const deltaSeconds = Math.min(0.2, (now - previous) / 1000);
      previous = now;
      const ratio = 1 - Math.exp(-GAZE_SPEED * deltaSeconds);
      const current = gazeCurrentRef.current;
      const target = gazeTargetRef.current;
      current.x += (target.x - current.x) * ratio;
      current.y += (target.y - current.y) * ratio;
      delegateRef.current?.lookAt(current.x, current.y);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // 평소에는 주변을 천천히 둘러본다. 한곳을 계속 응시하면 인형처럼 보인다.
  const scheduleIdleGaze = useCallback((delayMs?: number) => {
    window.clearTimeout(gazeTimerRef.current);
    gazeTimerRef.current = window.setTimeout(() => {
      gazeTargetRef.current = { x: randomBetween(GAZE.idleXMin, GAZE.idleXMax), y: randomBetween(GAZE.idleYMin, GAZE.idleYMax) };
      scheduleIdleGaze();
    }, delayMs ?? randomBetween(GAZE.idleIntervalMinMs, GAZE.idleIntervalMaxMs));
  }, []);

  useEffect(() => {
    scheduleIdleGaze();
    return () => {
      window.clearTimeout(gazeTimerRef.current);
      window.clearTimeout(expressionTimerRef.current);
      stopSpeechRef.current?.();
    };
  }, [scheduleIdleGaze]);

  /** 사용자가 메시지를 보냈을 때 채팅 쪽을 잠깐 본다. */
  const lookAtChat = useCallback(() => {
    gazeTargetRef.current = { x: randomBetween(GAZE.readXMin, GAZE.readXMax), y: randomBetween(GAZE.readYMin, GAZE.readYMax) };
    scheduleIdleGaze(GAZE.readHoldMs);
  }, [scheduleIdleGaze]);

  /** 답변의 감정·actions를 표정·모션으로 실행하고 사용자 쪽을 본다. */
  const react = useCallback((emotion: MessageEmotion | undefined, actions: readonly MessageAction[] | undefined) => {
    const reaction = planReaction(emotion, actions);
    const current = model();

    gazeTargetRef.current = { x: randomBetween(GAZE.speakXMin, GAZE.speakXMax), y: randomBetween(GAZE.speakYMin, GAZE.speakYMax) };
    scheduleIdleGaze();

    if (current) {
      if (reaction.expression) current.setExpression(reaction.expression); else current.clearExpression();
      // 감정 지속 시간이 끝나면 표정을 해제해 기본 상태로 돌아온다.
      window.clearTimeout(expressionTimerRef.current);
      expressionTimerRef.current = window.setTimeout(() => model()?.clearExpression(), reaction.holdMs);
    }

    // 같은 모션이 재생 중이면 무시한다. 다른 모션은 SDK 우선순위 규칙에 맡긴다.
    const motion = reaction.motion;
    let playedMotion: string | null = null;
    if (current && motion && playingMotionRef.current !== motion.group) {
      playingMotionRef.current = motion.group;
      playedMotion = motion.group;
      current.startMotion(motion.group, 0, motion.priority, () => { playingMotionRef.current = null; });
    }

    // 모델이 없을 때도 무엇을 실행하려 했는지 남긴다. 비공개 자산 없이 화면을 확인할 때 쓴다.
    if (import.meta.env.DEV) {
      const planned = motion ? `${motion.group}${playedMotion ? "" : "(skipped)"}` : "none";
      console.info(`[bori] emotion=${emotion?.primary ?? "none"} expression=${reaction.expression ?? "none"} motion=${planned} model=${current ? "ready" : "missing"}`);
    }
  }, [scheduleIdleGaze]);

  /** 답변 길이에 맞춰 말하는 시늉을 한다. 음성이 없을 때 쓴다. */
  const speakText = useCallback((text: string) => {
    stopSpeechRef.current?.();
    const durationMs = Math.min(LIP_SYNC.maxMs, Math.max(LIP_SYNC.minMs, text.length * LIP_SYNC.msPerChar));
    const startedAt = performance.now();
    let frame = 0;

    const stop = () => { cancelAnimationFrame(frame); model()?.setManualLipSync(null); };
    const step = () => {
      const current = model();
      const elapsed = performance.now() - startedAt;
      if (!current || elapsed >= durationMs) { current?.setManualLipSync(null); return; }
      // 사인파에 흔들림을 섞어 같은 폭으로 반복되지 않게 한다.
      const wave = (Math.sin((elapsed / LIP_SYNC.cycleMs) * Math.PI * 2) + 1) / 2;
      const jitter = 0.75 + Math.random() * 0.25;
      current.setManualLipSync(LIP_SYNC.openMin + wave * jitter * (LIP_SYNC.openMax - LIP_SYNC.openMin));
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    stopSpeechRef.current = stop;
  }, []);

  /**
   * 음성을 재생하고 파형으로 입을 움직인다.
   * 브라우저가 재생을 막으면 텍스트 립싱크로 대신하고 audioBlocked를 돌려준다.
   */
  const speakAudio = useCallback(async (audioId: string, text: string): Promise<SpeechResult> => {
    stopSpeechRef.current?.();
    const audio = new Audio(`/api/tts/${encodeURIComponent(audioId)}`);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaElementSource(audio).connect(analyser);
    analyser.connect(context.destination);

    const samples = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let stopped = false;
    let opening = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      audio.pause();
      model()?.setManualLipSync(null);
      void context.close();
    };

    const step = () => {
      const current = model();
      if (stopped) return;
      if (current) {
        analyser.getByteTimeDomainData(samples);
        // 파형의 실효값을 입 벌림으로 쓴다. 소리가 클수록 크게 벌린다.
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const value = (samples[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / samples.length);
        // 프레임마다 값이 튀면 입이 떨리는 것처럼 보이므로 이전 값과 섞는다.
        opening += (Math.min(1, rms * LIP_SYNC.audioGain) - opening) * LIP_SYNC.audioSmoothing;
        current.setManualLipSync(opening);
      }
      frame = requestAnimationFrame(step);
    };

    audio.addEventListener("ended", stop);
    stopSpeechRef.current = stop;
    try {
      await context.resume();
      await audio.play();
      if (stopped) return "audio";
      frame = requestAnimationFrame(step);
      if (import.meta.env.DEV) console.info(`[bori] audio=${audioId} lipsync=waveform`);
      return "audio";
    } catch {
      stop();
      speakText(text);
      return "audioBlocked";
    }
  }, [speakText]);

  return { layerRef, status, react, lookAtChat, speakText, speakAudio };
}
