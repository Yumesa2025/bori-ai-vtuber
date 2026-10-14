/**
 * 보리 Live2D 무대. Cubism Core 로드, 렌더러·모델 초기화, 표정·모션, 시선, 음성 재생·립싱크를 맡는다.
 * 옛 방송 화면(main.tsx)과 OBS character 페이지가 같이 쓴다. React에 묶이지 않으므로 화면은 상태만 넘긴다.
 */
import type { CharacterResponse, TestAction } from "@bori/shared";
import { boriMotionPriority, motionPairedExpression, resolveExpression, resolveMotion } from "@bori/live2d";
import { playbackFailure, waitForModelReady, type ModelStatus } from "../live2d-status";

export type Live2DStage = {
  status(): ModelStatus;
  /** 답의 표정·모션을 적용하고 말한다. 같은 답이 폴링으로 다시 와도 한 번만 적용한다. 말이 끝나면 풀린다. */
  applyResponse(response: CharacterResponse, audioUrl?: string): Promise<void>;
  /** 말풍선이 내려가면 음성·립싱크를 멈춘다. 표정은 감정 지속 시간이 끝날 때 풀린다. */
  clearResponse(): void;
  applyTestAction(action: TestAction): void;
  /** 새 채팅이 올라왔을 때 가끔 그쪽을 본다. 같은 채팅은 한 번만 본다. */
  noticeChat(chatId: string): void;
  /** 방송이 끝나면 감정을 초기화한다. */
  resetEmotion(): void;
  unlockAudio(): void;
  dispose(): void;
};

export type Live2DStageOptions = {
  transparent: boolean;
  /** 취소되면 렌더러를 만들지 않거나 만든 것을 정리한다. StrictMode에서 effect가 두 번 돌 때 쓴다. */
  signal?: { cancelled: boolean };
  /** 브라우저가 자동 재생을 막았는지. 화면에 "소리 켜기"를 띄울 때 쓴다. */
  onAudioBlockedChange?: (blocked: boolean) => void;
};

/** 취소로 끝난 생성. 호출부는 signal을 보고 무시한다. */
export const STAGE_CANCELLED = "Live2D 무대 생성을 취소했습니다.";

/** SDK 샘플 LAppModel 중 방송 화면이 쓰는 부분만 추린 타입. */
type BoriModel = {
  setExpression(expressionId: string): void;
  clearExpression(): void;
  startMotion(group: string, no: number, priority: number, onFinished?: () => void): unknown;
  setManualLipSync(value: number | null): void;
  /** 모델 파일과 모션까지 다 읽었는지. 파일이 없으면 끝내 false로 남는다. */
  isInitialized(): boolean;
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
 * 음성이 없으면 답변 길이에 맞춰 말하는 것처럼 입을 움직이고, 음성이 있으면 파형을 쓴다.
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

/**
 * Cubism Core를 먼저 올린 뒤 렌더러를 초기화하고, 모델이 실제로 준비될 때까지 기다린다.
 * 렌더러는 전역 싱글톤이라 한 화면에 무대는 하나만 둔다. 취소된 생성은 초기화하지 않는다.
 * 렌더러가 떠도 모델 파일이 없으면 빈 화면이므로, 그때는 status()가 failed인 무대를 돌려준다.
 */
export async function createLive2DStage(container: HTMLElement, options: Live2DStageOptions): Promise<Live2DStage> {
  const signal = options.signal ?? { cancelled: false };
  // OBS에서 게임 화면 위에 보리만 얹을 때는 배경을 비운다.
  if (options.transparent) document.documentElement.classList.add("transparent");

  await loadCore();
  const { LAppDelegate } = await import("@sdk-sample/lappdelegate");
  if (signal.cancelled) throw new Error(STAGE_CANCELLED);
  const delegate = LAppDelegate.getInstance();
  if (!delegate.initialize()) throw new Error("Live2D 렌더러를 초기화하지 못했습니다.");
  delegate.run();
  if (import.meta.env.DEV) (window as unknown as { __boriDelegate?: unknown }).__boriDelegate = delegate;
  const canvas = document.querySelector("body > canvas");
  if (canvas) container.appendChild(canvas);

  let disposed = false;
  const loadedModel = (): BoriModel | null => disposed ? null : delegate.getLoadedModel();

  let appliedResponseKey: string | null = null;
  let playingMotion: string | null = null;
  let appliedTestSeq: number | null = null;
  let lastChatId: string | null = null;
  let expressionTimer: number | undefined;
  let gazeTimer: number | undefined;

  // ── 시선 ──
  // 시선은 목표만 바꾸고 실제 이동은 프레임마다 조금씩 한다. 바로 지정하면 고개가 휙 돌아간다.
  const gazeTarget = { x: 0, y: 0 };
  const gazeCurrent = { x: 0, y: 0 };
  const setGazeTarget = (x: number, y: number) => { gazeTarget.x = x; gazeTarget.y = y; };

  let previous = performance.now();
  let gazeFrame = requestAnimationFrame(function step(now) {
    if (disposed) return;
    // 프레임 간격이 들쭉날쭉해도 같은 속도로 움직이도록 경과 시간으로 계산한다.
    const deltaSeconds = Math.min(0.2, (now - previous) / 1000);
    previous = now;
    const ratio = 1 - Math.exp(-GAZE_SPEED * deltaSeconds);
    gazeCurrent.x += (gazeTarget.x - gazeCurrent.x) * ratio;
    gazeCurrent.y += (gazeTarget.y - gazeCurrent.y) * ratio;
    delegate.lookAt(gazeCurrent.x, gazeCurrent.y);
    if (import.meta.env.DEV) (window as unknown as { __boriGaze?: unknown }).__boriGaze = { target: { ...gazeTarget }, current: { ...gazeCurrent } };
    gazeFrame = requestAnimationFrame(step);
  });

  // 평소에는 주변을 천천히 둘러본다. 한곳을 계속 응시하면 인형처럼 보인다.
  const scheduleIdleGaze = () => {
    window.clearTimeout(gazeTimer);
    gazeTimer = window.setTimeout(() => {
      setGazeTarget(randomBetween(GAZE.idleXMin, GAZE.idleXMax), randomBetween(GAZE.idleYMin, GAZE.idleYMax));
      scheduleIdleGaze();
    }, randomBetween(GAZE.idleIntervalMinMs, GAZE.idleIntervalMaxMs));
  };
  scheduleIdleGaze();

  // ── 음성·립싱크 ──
  /** 지금 말하고 있는 답. 같은 답·음성이 다시 오면 처음부터 다시 말하지 않는다. */
  let speechKey: string | null = null;
  let speechDone: Promise<void> = Promise.resolve();
  let stopSpeech: (() => void) | null = null;
  /** 자동 재생이 막힌 음성을 "소리 켜기"로 다시 틀 때 부른다. */
  let retryAudio: (() => void) | null = null;
  let audioBlocked = false;
  const setAudioBlocked = (blocked: boolean) => {
    if (audioBlocked === blocked) return;
    audioBlocked = blocked;
    options.onAudioBlockedChange?.(blocked);
  };

  // 음성이 없거나 재생하지 못했을 때만 답변 길이에 맞춰 말하는 시늉을 한다.
  function speakWithText(reply: string, done: () => void): () => void {
    const durationMs = Math.min(LIP_SYNC.maxMs, Math.max(LIP_SYNC.minMs, reply.length * LIP_SYNC.msPerChar));
    const startedAt = performance.now();
    let frame = 0;

    const step = () => {
      const model = loadedModel();
      const elapsed = performance.now() - startedAt;

      if (!model || elapsed >= durationMs) {
        model?.setManualLipSync(null);
        done();
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
      loadedModel()?.setManualLipSync(null);
    };
  }

  // 음성이 있으면 재생하고 파형으로 입을 움직인다. 텍스트 립싱크보다 정확하다.
  function speakWithAudio(audioUrl: string, reply: string, done: () => void): () => void {
    const audio = new Audio(audioUrl);
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
    /** 음성을 재생하지 못해 대신 시작한 글자 길이 립싱크. */
    let stopText: (() => void) | null = null;

    const step = () => {
      const model = loadedModel();
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
      loadedModel()?.setManualLipSync(null);
    };
    const ended = () => { finish(); done(); };

    // 브라우저가 자동 재생을 막으면 소리 없이 진행하고 "소리 켜기"로 다시 틀 수 있게 남긴다.
    // OBS 브라우저 소스에서는 막히지 않는다.
    const start = () => context.resume()
      .then(() => audio.play())
      .then(() => {
        stopped = false;
        retryAudio = null;
        setAudioBlocked(false);
        frame = requestAnimationFrame(step);
      })
      .catch(error => {
        finish();
        if (playbackFailure(error) === "blocked") { retryAudio = () => void start(); setAudioBlocked(true); return; }
        // 파일이 없거나(만료·404) 깨진 음성은 화면을 눌러도 들리지 않는다. 글자 길이 립싱크로 대신한다.
        console.warn(`[bori] 음성을 재생하지 못했습니다: ${audioUrl}`, error);
        retryAudio = null;
        setAudioBlocked(false);
        stopText = speakWithText(reply, done);
      });

    audio.addEventListener("ended", ended);
    void start();

    return () => {
      finish();
      stopText?.();
      retryAudio = null;
      audio.pause();
      audio.removeEventListener("ended", ended);
      void context.close();
    };
  }

  const endSpeech = () => {
    stopSpeech?.();
    stopSpeech = null;
    speechKey = null;
  };

  // ── 표정·모션 ──
  // 응답의 감정과 actions를 모델 표정·모션으로 실행한다.
  // 같은 응답이 폴링으로 반복해서 들어오므로 한 번만 적용한다.
  function applyEmotion(response: CharacterResponse) {
    const model = loadedModel();
    if (!model) return;

    const responseKey = `${response.emotion.primary}|${response.reply}`;
    if (appliedResponseKey === responseKey) return;
    appliedResponseKey = responseKey;

    const motion = resolveMotion(response.actions, response.emotion.primary);

    // 모션은 짝이 되는 표정이 켜져 있어야 화면에 보인다. 모션이 있으면 그 짝 표정을 쓴다.
    // 표정이 없는 감정은 표정을 해제해 기본 얼굴을 유지한다.
    const expression = motion ? motionPairedExpression(motion.group) : resolveExpression(response.emotion.primary);
    if (expression) model.setExpression(expression); else model.clearExpression();

    // 감정 지속 시간이 끝나면 표정을 해제해 기본 상태로 돌아온다.
    window.clearTimeout(expressionTimer);
    expressionTimer = window.setTimeout(() => {
      loadedModel()?.clearExpression();
    }, response.emotion.durationSeconds * 1000);

    // 같은 모션이 재생 중이면 무시한다. 다른 모션은 SDK 우선순위 규칙에 맡긴다.
    const skipMotion = motion == null || playingMotion === motion.group;
    if (motion && !skipMotion) {
      playingMotion = motion.group;
      model.startMotion(motion.group, 0, motion.priority, () => { playingMotion = null; });
    }

    if (import.meta.env.DEV) console.info(`[bori] emotion=${response.emotion.primary} expression=${expression ?? "none"} motion=${skipMotion ? "none" : motion!.group}`);
  }

  const dispose = () => {
    if (disposed) return;
    endSpeech();
    disposed = true;
    cancelAnimationFrame(gazeFrame);
    window.clearTimeout(gazeTimer);
    window.clearTimeout(expressionTimer);
    LAppDelegate.releaseInstance();
  };

  const ready = await waitForModelReady(() => delegate.getLoadedModel()?.isInitialized() === true, { signal });
  if (signal.cancelled) { dispose(); throw new Error(STAGE_CANCELLED); }
  const modelStatus: ModelStatus = ready
    ? { state: "ready", message: "Live2D 모델 준비됨" }
    : { state: "failed", message: "모델 파일을 불러오지 못했습니다. maolili 폴더를 확인해 주세요." };

  return {
    status: () => modelStatus,
    applyResponse(response, audioUrl) {
      if (disposed) return speechDone;
      applyEmotion(response);
      // 답변할 때는 시청자 쪽을 본다. 정확히 정면에 고정하지 않고 조금씩 흔들어 둔다.
      setGazeTarget(randomBetween(GAZE.speakXMin, GAZE.speakXMax), randomBetween(GAZE.speakYMin, GAZE.speakYMax));
      scheduleIdleGaze();

      const key = `${response.emotion.primary}|${response.reply}|${audioUrl ?? ""}`;
      if (speechKey === key) return speechDone;
      endSpeech();
      speechKey = key;
      speechDone = new Promise<void>(resolvePromise => {
        const stop = audioUrl ? speakWithAudio(audioUrl, response.reply, resolvePromise) : speakWithText(response.reply, resolvePromise);
        stopSpeech = () => { stop(); resolvePromise(); };
      });
      return speechDone;
    },
    clearResponse() {
      appliedResponseKey = null;
      endSpeech();
    },
    // 관리자 테스트 버튼으로 들어온 표정·모션을 실행한다. 방송 중이 아니어도 동작한다.
    applyTestAction(action) {
      if (appliedTestSeq === action.seq) return;
      const model = loadedModel();
      if (!model) return; // 모델이 아직 준비되지 않았으면 다음 폴링에서 다시 시도한다.
      appliedTestSeq = action.seq;

      window.clearTimeout(expressionTimer);
      if (action.kind === "expression") {
        model.setExpression(action.name);
      } else {
        // 모션 테스트도 짝 표정을 함께 켜야 실제로 보인다.
        model.setExpression(motionPairedExpression(action.name as never));
        playingMotion = action.name;
        model.startMotion(action.name, 0, boriMotionPriority.force, () => { playingMotion = null; });
      }

      if (import.meta.env.DEV) console.info(`[bori] test ${action.kind}=${action.name}`);
    },
    // 새 채팅이 올라오면 가끔 그쪽을 쳐다본다. 매번 보면 오히려 어색하다.
    noticeChat(chatId) {
      if (disposed || chatId === lastChatId) return;
      lastChatId = chatId;

      // 못 본 척 넘어가는 경우. 이때는 평소 시선 흐름을 그대로 둔다.
      if (Math.random() > GAZE.lookChance) return;

      setGazeTarget(randomBetween(GAZE.chatXMin, GAZE.chatXMax), randomBetween(GAZE.chatYMin, GAZE.chatYMax));

      // 다 읽으면 정면이 아니라 평소 둘러보기로 돌아간다. 그래야 전환이 끊기지 않는다.
      window.clearTimeout(gazeTimer);
      gazeTimer = window.setTimeout(() => {
        setGazeTarget(randomBetween(GAZE.idleXMin, GAZE.idleXMax), randomBetween(GAZE.idleYMin, GAZE.idleYMax));
        scheduleIdleGaze();
      }, randomBetween(GAZE.holdMinMs, GAZE.holdMaxMs));
    },
    resetEmotion() {
      window.clearTimeout(expressionTimer);
      appliedResponseKey = null;
      playingMotion = null;
      loadedModel()?.clearExpression();
    },
    // 막힌 음성이 남아 있으면 지금 답을 다시 틀고, 없으면 버튼만 내린다. 누른 순간부터 다음 답은 자동 재생된다.
    unlockAudio() {
      const retry = retryAudio;
      if (retry) retry(); else setAudioBlocked(false);
    },
    dispose,
  };
}
