/**
 * Live2D·음성 진단 판단. 화면 밖에서 검사할 수 있게 DOM에 묶이지 않는 부분만 둔다.
 * 방송 화면(`apps/broadcast/src/live2d-status.ts`)과 같은 규칙이다.
 */

/**
 * 모델 준비를 기다리는 시간.
 * 렌더러 초기화는 모델 파일과 따로 성공하고, 모델 로드는 비동기로 조용히 실패한다.
 * 이 시간 안에 모델이 준비되지 않으면 실패로 본다. 로컬 파일이라 정상이면 1~2초 안에 끝난다.
 */
export const MODEL_READY_TIMEOUT_MS = 10_000;
const MODEL_READY_POLL_MS = 250;

/** isReady가 참이 되면 true, timeoutMs 안에 안 되면 false. 취소되면 false로 끝난다. */
export function waitForModelReady(isReady: () => boolean, options: { timeoutMs?: number; intervalMs?: number; signal?: { cancelled: boolean } } = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? MODEL_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? MODEL_READY_POLL_MS;
  const startedAt = Date.now();
  return new Promise(resolvePromise => {
    const check = () => {
      if (options.signal?.cancelled) { resolvePromise(false); return; }
      if (isReady()) { resolvePromise(true); return; }
      if (Date.now() - startedAt >= timeoutMs) { resolvePromise(false); return; }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * 음성 재생 실패 원인.
 * 자동 재생 차단(NotAllowedError)만 사용자가 화면을 눌러 풀 수 있다.
 * 파일 없음(만료·404)·디코딩 실패(NotSupportedError) 등은 다시 눌러도 들리지 않으므로 따로 안내한다.
 */
export function playbackFailure(error: unknown): "blocked" | "failed" {
  return (error as { name?: unknown } | null)?.name === "NotAllowedError" ? "blocked" : "failed";
}
