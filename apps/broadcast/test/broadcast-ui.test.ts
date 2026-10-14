/**
 * 방송 화면·채팅창(chat.html) 화면 규칙 단위 검사.
 * 한글 조합 중 Enter를 전송으로 보지 않는지, 저장소가 막혀도 화면이 멈추지 않는지,
 * 전송 실패·음성 실패·모델 파일 없음을 원인별로 나누는지 본다. 브라우저를 띄우지 않는다.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chatSendError, isSubmitEnter, readServerError, readStored, writeStored } from "../src/chat-input";
import { playbackFailure, waitForModelReady } from "../src/live2d-status";

describe("채팅 입력 Enter", () => {
  test("한글 조합 중 Enter는 보내지 않는다(isComposing 또는 keyCode 229)", () => {
    // 점검 A5-01·02: 조합 중 Enter에서 보내고 입력을 비우면 IME가 마지막 글자를 다시 넣어 따로 한 번 더 나갔다.
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: true } }), false);
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } }), false);
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } }), false);
  });

  test("조합이 끝난 Enter만 보낸다", () => {
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } }), true);
    assert.equal(isSubmitEnter({ key: "a", keyCode: 65, nativeEvent: { isComposing: false } }), false);
  });
});

describe("저장소 접근", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("저장소가 막혀 예외를 던져도 기본값으로 동작한다", () => {
    // 점검 A5-25: 사생활 보호 모드에서 useState 초기화가 던지면 화면 전체가 하얗게 떴다.
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    assert.equal(readStored("bori-chat-nickname"), "");
    assert.doesNotThrow(() => writeStored("bori-chat-nickname", "하늘"));
  });

  test("저장소가 있으면 그대로 읽고 쓴다", () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
    writeStored("bori-chat-nickname", "하늘");
    assert.equal(readStored("bori-chat-nickname"), "하늘");
  });
});

describe("채팅 전송 실패 안내", () => {
  test("서버가 준 이유를 그대로 보여 준다", async () => {
    const response = new Response(JSON.stringify({ error: "채팅을 처리할 수 없습니다." }), { status: 400 });
    assert.equal(chatSendError(400, await readServerError(response)), "채팅을 처리할 수 없습니다.");
  });

  test("이유가 없으면 상태별로 나눈다", async () => {
    assert.equal(await readServerError(new Response("<html>", { status: 502 })), null);
    assert.match(chatSendError(null, null), /연결할 수 없어요/);
    assert.match(chatSendError(429, null), /너무 많아요/);
    assert.match(chatSendError(500, null), /서버에서 문제/);
    assert.match(chatSendError(400, null), /보낼 수 없어요/);
  });
});

describe("음성 재생 실패 원인", () => {
  test("자동 재생 차단만 blocked로 본다", () => {
    // 점검 A5-09: 디코딩 실패(NotSupportedError)·404도 "브라우저가 막았어요"로 안내했다.
    assert.equal(playbackFailure(new DOMException("blocked", "NotAllowedError")), "blocked");
    assert.equal(playbackFailure(new DOMException("bad file", "NotSupportedError")), "failed");
    assert.equal(playbackFailure(new Error("network")), "failed");
    assert.equal(playbackFailure(null), "failed");
  });
});

describe("모델 준비 확인", () => {
  test("모델이 준비되면 true", async () => {
    let checks = 0;
    assert.equal(await waitForModelReady(() => ++checks >= 3, { timeoutMs: 1000, intervalMs: 5 }), true);
  });

  test("모델 파일이 없어 끝내 준비되지 않으면 false(진단 배지를 띄운다)", async () => {
    // 점검 A5-08: 렌더러 초기화만 성공으로 보고 모델 로드 실패를 놓쳐 배지 없이 빈 화면이었다.
    assert.equal(await waitForModelReady(() => false, { timeoutMs: 30, intervalMs: 5 }), false);
  });

  test("취소되면 기다리지 않고 끝난다", async () => {
    const signal = { cancelled: true };
    assert.equal(await waitForModelReady(() => true, { signal }), false);
  });
});
