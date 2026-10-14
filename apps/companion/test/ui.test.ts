/**
 * 1:1 대화 화면 규칙 단위 검사.
 * Enter 처리, LLM을 못 쓸 때·음성을 못 틀 때 안내, 조사, 길이 초과 안내, 새로고침 뒤 대화 복원 저장을 본다.
 * 브라우저를 띄우지 않는다.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { failureNotice, isSubmitEnter, overLengthNotice, speechNotice, withParticle } from "../src/ui";
import { playbackFailure, waitForModelReady } from "../src/live2d/model-status";
import { loadActiveConversation, saveActiveConversation } from "../src/preferences";

describe("Composer Enter", () => {
  test("조합 중 Enter와 Shift+Enter는 보내지 않는다", () => {
    assert.equal(isSubmitEnter({ key: "Enter", nativeEvent: { isComposing: true } }), false);
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } }), false);
    assert.equal(isSubmitEnter({ key: "Enter", shiftKey: true, nativeEvent: { isComposing: false } }), false);
    assert.equal(isSubmitEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } }), true);
  });
});

describe("폴백 답변 원인 안내", () => {
  test("LLM이 꺼져 있거나 회로가 열렸으면 원인을 알린다", () => {
    // 점검 A5-13: 새 데이터 기본값(LLM 꺼짐)이면 모든 답이 폴백인데 원인 안내가 없었다.
    assert.match(failureNotice("disabled") ?? "", /LLM이 꺼져 있거나/);
    assert.match(failureNotice("circuit") ?? "", /잠시 쉬는 중/);
  });

  test("한 번 실패한 호출과 정상 답은 따로 안내하지 않는다", () => {
    assert.equal(failureNotice("call"), null);
    assert.equal(failureNotice("validation"), null);
    assert.equal(failureNotice(undefined), null);
  });
});

describe("음성 재생 안내", () => {
  test("자동 재생 차단과 파일 오류를 나눈다", () => {
    // 점검 A5-09
    assert.equal(playbackFailure(new DOMException("blocked", "NotAllowedError")), "blocked");
    assert.equal(playbackFailure(new DOMException("decode", "NotSupportedError")), "failed");
    assert.match(speechNotice("audioBlocked") ?? "", /막았어요/);
    assert.match(speechNotice("audioFailed") ?? "", /재생하지 못했어요/);
    assert.equal(speechNotice("audio"), null);
  });
});

describe("모델 준비 확인", () => {
  test("모델 파일이 없어 준비되지 않으면 false", async () => {
    // 점검 A5-08: 1:1도 모델만 없으면 상태가 ready로 남아 배지가 없었다.
    assert.equal(await waitForModelReady(() => false, { timeoutMs: 30, intervalMs: 5 }), false);
    assert.equal(await waitForModelReady(() => true, { timeoutMs: 30, intervalMs: 5 }), true);
  });
});

describe("문구", () => {
  test("이름 받침에 맞춰 조사를 고른다", () => {
    assert.equal(withParticle("보리", "와", "과"), "보리와");
    assert.equal(withParticle("보람", "와", "과"), "보람과");
    assert.equal(withParticle("보람", "가", "이"), "보람이");
    assert.equal(withParticle("Bori", "와", "과"), "Bori와");
  });

  test("최대 길이를 넘으면 넘친 글자 수를 알린다(말없이 자르지 않는다)", () => {
    // 점검 A5-21: 600자를 붙여 넣으면 안내 없이 500자로 잘렸다.
    assert.equal(overLengthNotice(500, 500), null);
    assert.match(overLengthNotice(600, 500) ?? "", /100자를 줄여야/);
  });
});

describe("열린 대화 기억", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  test("새로고침해도 열려 있던 대화를 다시 찾는다", () => {
    // 점검 A5-20: 새로고침하면 열린 대화가 풀렸다.
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    } });
    saveActiveConversation("c1");
    assert.equal(loadActiveConversation(), "c1");
    saveActiveConversation(null);
    assert.equal(loadActiveConversation(), null);
  });

  test("저장소가 막혀도 예외 없이 새 대화로 시작한다", () => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    assert.doesNotThrow(() => saveActiveConversation("c1"));
    assert.equal(loadActiveConversation(), null);
  });
});
