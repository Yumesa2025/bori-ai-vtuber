export type ContextState = 'loading' | 'ready' | 'recovering' | 'failed';
export function contextState(state: ContextState, event: 'lost' | 'restored' | 'timeout'): ContextState {
  if (event === 'lost' && state !== 'failed') return 'recovering';
  if (state !== 'recovering') return state;
  return event === 'restored' ? 'loading' : event === 'timeout' ? 'failed' : state;
}

/** SDK run이 동기적으로 예약하는 프레임만 소유한다. 다른 앱 루프는 건드리지 않는다. */
export function startGuardedFrames(run: () => void, host = window): () => void {
  let stopped = false;
  const pending = new Set<number>();
  const nativeRequest = host.requestAnimationFrame.bind(host);
  function scoped(callback: () => void) {
    if (stopped) return;
    const previous = host.requestAnimationFrame;
    host.requestAnimationFrame = next => {
      const id = nativeRequest(time => { pending.delete(id); scoped(() => next(time)); });
      pending.add(id);
      return id;
    };
    try { callback(); } finally { host.requestAnimationFrame = previous; }
  }
  const stop = () => { stopped = true; for (const id of pending) host.cancelAnimationFrame(id); pending.clear(); };
  try { scoped(run); } catch (error) { stop(); throw error; }
  return stop;
}
