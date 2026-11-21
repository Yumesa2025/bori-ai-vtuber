/**
 * 자동 재생 대비(점검 V2 5번).
 * 사용자가 화면을 한 번도 누르지 않았으면 브라우저는 AudioContext.resume()을 거절하지 않고 보류한다.
 * 그 약속을 그대로 기다리면 대사 재생이 1줄째에서 멈추고 "소리가 막혔다" 안내도 나오지 않았다.
 * 짧은 시간 상한 안에 running이 되지 않으면 막힌 것으로 본다.
 */

/** AudioContext 중 쓰는 부분. 검사에서 가짜로 바꿔 끼운다. */
export type ResumableContext = { state: string; resume(): Promise<void> };

/** resume을 기다리는 상한. 허용된 상태면 바로 끝나므로 짧게 둔다. */
export const RESUME_TIMEOUT_MS = 500;

export async function resumeAudio(context: ResumableContext, timeoutMs = RESUME_TIMEOUT_MS): Promise<"running" | "blocked"> {
  if (context.state === "running") return "running";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return context.state === "running" ? "running" : "blocked";
}
