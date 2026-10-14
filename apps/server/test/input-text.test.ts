/**
 * 입력 글 정리 단위 검사(B-5, a1 M3·L6).
 * 점검에서 그대로 저장·송출된 NUL·제어문자·RTL override·짝 없는 서로게이트를 지우는지 본다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInputText, lengthOf } from "../src/input-text.js";

test("NUL·제어문자·방향 바꿈 문자·BOM을 지운다", () => {
  assert.equal(cleanInputText("a\u0000b\u0001c\u007Fd"), "abcd");
  assert.equal(cleanInputText("‮evil‬"), "evil");
  assert.equal(cleanInputText("⁦x⁩﻿"), "x");
});

test("짝 없는 서로게이트는 지우고 짝이 맞는 이모지는 남긴다", () => {
  assert.equal(cleanInputText("\uDC00lone\uD83D"), "lone");
  assert.equal(cleanInputText("고양이 🐱"), "고양이 🐱");
});

test("줄바꿈과 탭은 글의 일부라 남기고 CRLF는 LF로 맞춘다", () => {
  assert.equal(cleanInputText("한 줄\r\n두 줄\t끝"), "한 줄\n두 줄\t끝");
});

test("글자 수는 코드포인트로 센다", () => {
  assert.equal(lengthOf("🐱🐱"), 2);
  assert.equal(lengthOf("가나다"), 3);
});
