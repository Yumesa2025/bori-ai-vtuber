/**
 * 닉네임 가림 단위 검사. 방송 화면에 시청자 닉네임을 그대로 보이지 않게 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskNickname } from "../src/mask.js";

test("2자 이하는 첫 글자만 남긴다", () => {
  assert.equal(maskNickname("보리"), "보*");
  assert.equal(maskNickname("a"), "a*");
});

test("3~4자는 앞 2자만 남긴다", () => {
  assert.equal(maskNickname("보리팬"), "보리*");
  assert.equal(maskNickname("보리팬님"), "보리**");
});

test("5자 이상은 앞 3자 + ** 로 길이를 감춘다", () => {
  assert.equal(maskNickname("보리팬클럽"), "보리팬**");
  assert.equal(maskNickname("보리팬클럽회장님"), "보리팬**");
});

test("코드포인트 단위로 자른다(이모지가 깨지지 않는다)", () => {
  assert.equal(maskNickname("ab😀cd"), "ab😀**");
  assert.equal(maskNickname("😀😀"), "😀*");
});

test("빈 닉네임은 빈 문자열이다", () => {
  assert.equal(maskNickname(""), "");
});
