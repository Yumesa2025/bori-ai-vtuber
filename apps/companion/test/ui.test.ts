/**
 * 대시보드 화면 규칙 단위 검사: 음성을 못 틀 때 안내, 모델 준비 확인, 마지막으로 읽은 대사 기억.
 * 브라우저를 띄우지 않는다.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { speechNotice } from "../src/ui";
import { playbackFailure, waitForModelReady } from "../src/live2d/model-status";
import { loadLastNarrationId, loadTtsEnabled, saveLastNarrationId, saveTtsEnabled } from "../src/preferences";

describe("음성 재생 안내", () => {
  test("자동 재생 차단과 파일 오류를 나눈다", () => {
    // 점검 A5-09
    assert.equal(playbackFailure(new DOMException("blocked", "NotAllowedError")), "blocked");
    assert.equal(playbackFailure(new DOMException("decode", "NotSupportedError")), "failed");
    assert.match(speechNotice("audioBlocked") ?? "", /막았어요/);
    assert.match(speechNotice("audioBlocked") ?? "", /다시 듣기/);
    assert.match(speechNotice("audioFailed") ?? "", /자막으로/);
    assert.equal(speechNotice("audio"), null);
    assert.equal(speechNotice("done"), null);
  });
});

describe("모델 준비 확인", () => {
  test("모델 파일이 없어 준비되지 않으면 false", async () => {
    // 점검 A5-08: 모델만 없으면 상태가 ready로 남아 배지가 없었다.
    assert.equal(await waitForModelReady(() => false, { timeoutMs: 30, intervalMs: 5 }), false);
    assert.equal(await waitForModelReady(() => true, { timeoutMs: 30, intervalMs: 5 }), true);
  });
});

describe("브라우저에 남기는 설정", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const fakeStorage = () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    } });
  };

  test("마지막으로 읽은 대사 id를 기억해 같은 대사를 다시 자동으로 읽지 않는다", () => {
    fakeStorage();
    assert.equal(loadLastNarrationId(), null);
    saveLastNarrationId("n-1");
    assert.equal(loadLastNarrationId(), "n-1");
  });

  test("음성 켜기는 기본 끔이고 저장한 값을 읽는다", () => {
    fakeStorage();
    assert.equal(loadTtsEnabled(), false);
    saveTtsEnabled(true);
    assert.equal(loadTtsEnabled(), true);
  });

  test("저장소가 막혀도 예외 없이 기본값으로 동작한다", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    assert.doesNotThrow(() => saveLastNarrationId("n-1"));
    assert.equal(loadLastNarrationId(), null);
    assert.equal(loadTtsEnabled(), false);
  });
});
