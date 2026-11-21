/**
 * 보리 대사를 줄마다 차례로 읽는다: 자막 표시 → 감정을 Live2D 표정으로 → 말하기(음성 또는 글자 길이만큼 입 모양).
 * DOM·오디오는 주입받아 화면 밖 검사에서 순서와 분기를 확인한다.
 *
 * createPlayback은 재생 하나를 맡는 제어기다(Codex C2 4·5·7).
 * - 재생마다 세대(signal)를 두고, 지금 세대가 아닌 재생의 콜백(자막·표정·말하기)은 무시한다. 새 대사가 재생을 바꿔도 이전 재생이 새 자막을 지우지 않는다.
 * - 음성 설정은 줄마다 함수로 읽는다. 재생 중 바꾸면 audioModeChanged가 지금 줄을 멈추고 새 설정으로 다시 말한다.
 * - dispose는 전체 재생을 취소하고 그 뒤의 재생을 막는다(컴포넌트 언마운트).
 */
import type { NarrationLine } from "@bori/shared";

/** useBoriLive2D의 SpeechResult와 같은 값. audioBlocked는 자동 재생 차단, audioFailed는 파일 없음 같은 실패다. */
export type SpeechOutcome = "audio" | "text" | "audioBlocked" | "audioFailed";

export type PlayerDeps = {
  /** 감정 이름(@bori/live2d 감정 표)을 표정·모션으로 */
  react(emotion: string): void;
  /** 한 줄을 끝까지 말하고 결과를 돌려준다. useAudio가 false면 글자 길이만큼 입만 움직인다 */
  speak(line: NarrationLine, useAudio: boolean): Promise<SpeechOutcome>;
  /** 지금 읽는 줄. 다 읽었거나 멈추면 null */
  onLine(index: number | null): void;
};

/**
 * audioBlocked: 자동 재생이 막혔다(화면을 눌러야 풀림). audioFailed: 음성을 켰는데 못 낸 줄이 있다
 * (파일 오류이거나 서버가 음성을 만들지 못해 id가 없는 줄). 둘 다면 막힘을 먼저 알린다(점검 V2 11번).
 */
export type PlayResult = "done" | "cancelled" | "audioBlocked" | "audioFailed";

/** 재생 하나의 상태. cancelled면 다음 줄로 가지 않는다. restart면 지금 줄을 새 음성 설정으로 다시 말한다. */
export type PlaySignal = { cancelled: boolean; restart: boolean };

export async function playNarration(
  lines: readonly NarrationLine[],
  deps: PlayerDeps,
  options: { audio: () => boolean; signal: PlaySignal },
): Promise<PlayResult> {
  const { signal } = options;
  let blocked = false;
  let failed = false;
  try {
    for (const [index, line] of lines.entries()) {
      if (signal.cancelled) return "cancelled";
      deps.onLine(index);
      deps.react(line.emotion);
      for (;;) {
        // 음성 설정은 말할 때마다 다시 읽는다. 재생 중에 바꿔도 지금·남은 줄에 바로 맞춘다.
        const wantAudio = options.audio();
        if (wantAudio && line.audioId === undefined) failed = true;
        // 소리가 한 번 막히면 같은 재생에서는 다시 시도하지 않는다. 화면을 눌러야 풀린다.
        const outcome = await deps.speak(line, wantAudio && !blocked && line.audioId !== undefined);
        if (outcome === "audioBlocked") blocked = true;
        if (outcome === "audioFailed") failed = true;
        if (signal.cancelled) return "cancelled";
        if (!signal.restart) break;
        signal.restart = false;
      }
    }
    return blocked ? "audioBlocked" : failed ? "audioFailed" : "done";
  } finally {
    deps.onLine(null);
  }
}

export type Playback = {
  /** 이전 재생을 멈추고 새로 읽는다. 다른 재생에 바뀌었거나 멈췄거나 해제됐으면 cancelled */
  play(lines: readonly NarrationLine[], audio: () => boolean): Promise<PlayResult>;
  /** 지금 재생을 멈춘다. 그 재생의 남은 콜백은 부르지 않으므로 자막은 부르는 쪽이 내린다 */
  stop(): void;
  /** 음성 설정이 바뀌었다. 지금 줄을 멈추고 새 설정으로 다시 말한다 */
  audioModeChanged(): void;
  /** 전체 재생을 취소하고 그 뒤의 재생을 막는다 */
  dispose(): void;
  readonly playing: boolean;
};

export function createPlayback(deps: PlayerDeps & { stopSpeech(): void }): Playback {
  let current: PlaySignal | null = null;
  let disposed = false;

  /** 이 재생이 지금 세대일 때만 화면에 반영한다 */
  const guarded = (signal: PlaySignal): PlayerDeps => ({
    react: emotion => { if (current === signal) deps.react(emotion); },
    speak: (line, useAudio) => (current === signal ? deps.speak(line, useAudio) : Promise.resolve<SpeechOutcome>("text")),
    onLine: index => { if (current === signal) deps.onLine(index); },
  });

  const stop = () => {
    if (current) current.cancelled = true;
    current = null;
    deps.stopSpeech();
  };

  return {
    async play(lines, audio) {
      if (disposed) return "cancelled";
      stop();
      const signal: PlaySignal = { cancelled: false, restart: false };
      current = signal;
      const result = await playNarration(lines, guarded(signal), { audio, signal });
      if (current === signal) current = null;
      return result;
    },
    stop() {
      if (!disposed) stop();
    },
    audioModeChanged() {
      if (disposed || !current) return;
      current.restart = true;
      deps.stopSpeech();
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
    },
    get playing() {
      return current !== null;
    },
  };
}
