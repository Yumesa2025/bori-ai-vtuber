/**
 * 관리자 화면 폴링.
 * setInterval은 앞 요청이 느려도 다음 요청을 보내 겹쳐 쌓이므로, 한 번 끝난 뒤에 다음 번을 예약한다.
 * React에 묶이지 않아 화면 밖 단위 검사(test/poll.test.ts)에서 그대로 부른다.
 */

/**
 * 상태 폴링 간격. 방송 상태·대기 채팅 수·LLM 회로처럼 사람이 눈으로 보는 숫자라 3초면 충분하다.
 * (예전 1.5초 간격으로 7개 API를 부르면 6초에 29회였다.)
 */
export const STATUS_POLL_MS = 3000;
/**
 * 설정·기억 목록·사용량·음성 설정 폴링 간격.
 * 이 화면에서 저장하면 바로 다시 받으므로, 이 간격은 다른 창에서 바꾼 값이 늦게 보이는 정도의 차이만 낸다.
 * 음성 설정(GET /api/tts)은 서버가 업체에 목소리 목록을 물어보므로(ElevenLabs면 외부 호출) 자주 부르지 않는다.
 */
export const SETTINGS_POLL_MS = 30_000;
/** 요청 하나의 제한 시간. 서버가 멈춰도 폴링이 영원히 기다리지 않는다. */
export const REQUEST_TIMEOUT_MS = 5000;

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * task를 바로 한 번 실행하고, 끝날 때마다 intervalMs 뒤에 다시 실행한다. 한 번에 하나만 돈다.
 * runNow는 저장 직후처럼 지금 바로 새로 받아야 할 때 쓴다. 이미 도는 중이면 끝난 직후 한 번 더 돈다.
 */
export function createPoller(task: () => Promise<void>, intervalMs: number, timers: Timers = defaultTimers) {
  let stopped = false;
  let running = false;
  let rerun = false;
  let timer: unknown = null;

  const run = async () => {
    if (stopped) return;
    if (running) { rerun = true; return; }
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    running = true;
    try {
      await task();
    } catch {
      // 실패는 task 안에서 화면에 알린다. 폴링은 계속한다.
    } finally {
      running = false;
    }
    if (stopped) return;
    if (rerun) { rerun = false; void run(); return; }
    timer = timers.setTimeout(() => { timer = null; void run(); }, intervalMs);
  };

  void run();
  return {
    runNow: () => { void run(); },
    stop: () => { stopped = true; if (timer !== null) timers.clearTimeout(timer); timer = null; },
  };
}
