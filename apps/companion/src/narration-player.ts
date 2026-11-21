/**
 * 보리 대사를 줄마다 차례로 읽는다: 자막 표시 → 감정을 Live2D 표정으로 → 말하기(음성 또는 글자 길이만큼 입 모양).
 * DOM·오디오는 주입받아 화면 밖 검사에서 순서와 분기를 확인한다.
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

export async function playNarration(
  lines: readonly NarrationLine[],
  deps: PlayerDeps,
  options: { audio: boolean; signal: { cancelled: boolean } },
): Promise<PlayResult> {
  let blocked = false;
  let failed = false;
  try {
    for (const [index, line] of lines.entries()) {
      if (options.signal.cancelled) return "cancelled";
      deps.onLine(index);
      deps.react(line.emotion);
      // 소리가 한 번 막히면 같은 재생에서는 다시 시도하지 않는다. 화면을 눌러야 풀린다.
      if (options.audio && line.audioId === undefined) failed = true;
      const outcome = await deps.speak(line, options.audio && !blocked && line.audioId !== undefined);
      if (outcome === "audioBlocked") blocked = true;
      if (outcome === "audioFailed") failed = true;
      if (options.signal.cancelled) return "cancelled";
    }
    return blocked ? "audioBlocked" : failed ? "audioFailed" : "done";
  } finally {
    deps.onLine(null);
  }
}
