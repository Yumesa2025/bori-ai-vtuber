/**
 * 출력 글 다듬기 단위 검사(a3 F12·F14). 네트워크를 쓰지 않는다.
 * 2026-11-21 대화 답 검증(validateLlmOutput)과 대화 프롬프트 스키마 검사는 대화와 함께 지웠다.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_EMOTION, replyLengthOf, stripDecorations } from "../src/validate.js";

describe("기호 지우기", () => {
  test("줄머리 기호와 줄바꿈을 정리한다", () => {
    assert.equal(stripDecorations("# 제목\n- 하나\n> 인용\n1. 둘"), "제목 하나 인용 둘");
  });

  test("한국어 문장과 숫자·물음표는 그대로 둔다", () => {
    assert.equal(stripDecorations("오늘 3시에 볼까요? 좋아요!"), "오늘 3시에 볼까요? 좋아요!");
  });
});

describe("이모지·마크다운·길이", () => {
  test("이모지·마크다운·태그를 지운다", () => {
    assert.equal(stripDecorations("**재키** 강해요 😀 <b>진짜</b> `코드` [링크](http://x)"), "재키 강해요 진짜 코드 링크");
  });

  test("길이는 코드포인트로 센다", () => {
    assert.equal(replyLengthOf("𝄞".repeat(3)), 3);
    assert.equal(replyLengthOf("가나다"), 3);
  });

  test("기본 감정은 calm이다", () => {
    assert.equal(DEFAULT_EMOTION, "calm");
  });
});
