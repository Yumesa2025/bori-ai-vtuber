import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextState } from './context-state.js';
test('컨텍스트 손실·복구·시간 초과 상태', () => {
  assert.equal(contextState('ready', 'lost'), 'recovering');
  assert.equal(contextState('recovering', 'timeout'), 'failed');
  assert.equal(contextState('recovering', 'restored'), 'loading');
  assert.equal(contextState('failed', 'restored'), 'failed');
  assert.equal(contextState('ready', 'timeout'), 'ready');
});

import { startGuardedFrames } from './context-state.js';
test('SDK 프레임 예약만 중단하고 취소 뒤 콜백도 그리지 않는다', () => {
  let callback: FrameRequestCallback = () => {};
  let draws = 0;
  let cancelled = 0;
  const host = { requestAnimationFrame: (next: FrameRequestCallback) => { callback = next; return 1; }, cancelAnimationFrame: () => { cancelled++; } };
  const original = host.requestAnimationFrame;
  const stop = startGuardedFrames(() => {
    const loop = () => { draws++; host.requestAnimationFrame(loop); };
    loop();
  }, host as unknown as Window & typeof globalThis);
  assert.equal(host.requestAnimationFrame, original);
  callback(0);
  assert.equal(draws, 2);
  stop(); callback(1);
  assert.equal(draws, 2);
  assert.equal(cancelled, 1);
});
