/**
 * 관리자 폴링 단위 검사.
 * 앞 요청이 끝나기 전에는 다음 요청을 보내지 않는지, 지금 바로 새로 받기(runNow)가 겹치지 않는지 본다.
 * 타이머는 가짜로 바꿔 끼운다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../src/poll";

/** 예약된 콜백을 손으로 실행하는 가짜 타이머. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setTimeout: (callback: () => void) => { const id = next++; pending.set(id, callback); return id; },
      clearTimeout: (handle: unknown) => { pending.delete(handle as number); },
    },
    pendingCount: () => pending.size,
    fire: () => { const [id, callback] = [...pending.entries()][0] ?? []; if (id === undefined) return false; pending.delete(id); callback!(); return true; },
  };
}

/** 손으로 끝낼 수 있는 작업. 동시에 몇 개가 돌았는지 센다. */
function controlledTask() {
  let running = 0;
  let maxRunning = 0;
  let calls = 0;
  const finishers: (() => void)[] = [];
  return {
    task: () => new Promise<void>(resolve => { calls += 1; running += 1; maxRunning = Math.max(maxRunning, running); finishers.push(() => { running -= 1; resolve(); }); }),
    finish: async () => { finishers.shift()?.(); await new Promise(resolve => setImmediate(resolve)); },
    stats: () => ({ calls, running, maxRunning }),
  };
}

describe("관리자 폴링", () => {
  test("앞 요청이 끝나야 다음 요청을 예약한다", async () => {
    // 점검 A5-34: setInterval이라 느린 요청이 겹쳐 쌓였다.
    const clock = fakeTimers();
    const work = controlledTask();
    const poller = createPoller(work.task, 3000, clock.timers);
    assert.equal(work.stats().calls, 1);
    // 아직 끝나지 않았으므로 예약된 다음 요청이 없다.
    assert.equal(clock.pendingCount(), 0);
    await work.finish();
    assert.equal(clock.pendingCount(), 1);
    clock.fire();
    assert.equal(work.stats().calls, 2);
    await work.finish();
    assert.equal(work.stats().maxRunning, 1);
    poller.stop();
  });

  test("도는 중에 runNow를 부르면 끝난 직후 한 번만 더 돈다", async () => {
    const clock = fakeTimers();
    const work = controlledTask();
    const poller = createPoller(work.task, 3000, clock.timers);
    poller.runNow();
    poller.runNow();
    assert.equal(work.stats().calls, 1);
    await work.finish();
    assert.equal(work.stats().calls, 2);
    assert.equal(work.stats().maxRunning, 1);
    await work.finish();
    assert.equal(clock.pendingCount(), 1);
    poller.stop();
  });

  test("멈추면 더 예약하지 않고, 작업이 실패해도 폴링은 이어진다", async () => {
    const clock = fakeTimers();
    let calls = 0;
    const poller = createPoller(async () => { calls += 1; throw new Error("down"); }, 3000, clock.timers);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clock.pendingCount(), 1);
    clock.fire();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    poller.stop();
    assert.equal(clock.pendingCount(), 0);
  });
});
