/**
 * 비밀값 저장 단위 검사.
 * 암호문이 왕복되는지, 고치거나 잘라 낸 암호문을 키 없음("")으로 다루는지 본다.
 * 키 값은 테스트용 가짜 문자열만 쓴다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, isEncrypted } from "../src/secret-store.js";

const PREFIX = "enc.v1:";
const FAKE_KEY = "test-not-a-real-key";

/** 암호문을 iv·태그·본문으로 나눈다. */
function partsOf(stored: string) {
  const [iv, tag, data] = stored.slice(PREFIX.length).split(":");
  return { iv, tag, data };
}

describe("암호화 왕복", () => {
  test("암호화한 값은 접두사가 붙고 다시 풀린다", () => {
    const stored = encryptSecret(FAKE_KEY);
    assert.ok(isEncrypted(stored));
    assert.ok(!stored.includes(FAKE_KEY));
    assert.equal(decryptSecret(stored), FAKE_KEY);
  });

  test("같은 값도 매번 다른 암호문이 된다", () => {
    assert.notEqual(encryptSecret(FAKE_KEY), encryptSecret(FAKE_KEY));
  });

  test("빈 값은 빈 문자열로 저장하고 빈 문자열로 푼다", () => {
    assert.equal(encryptSecret(""), "");
    assert.equal(decryptSecret(""), "");
  });

  test("접두사 없는 값은 이전 버전의 평문으로 보고 그대로 돌려준다", () => {
    assert.equal(decryptSecret(FAKE_KEY), FAKE_KEY);
    assert.equal(isEncrypted(FAKE_KEY), false);
  });

  test("인증 태그는 16바이트다", () => {
    assert.equal(Buffer.from(partsOf(encryptSecret(FAKE_KEY)).tag, "base64").length, 16);
  });
});

describe("손상·위조된 암호문", () => {
  test("본문을 바꾸면 풀지 않는다", () => {
    const { iv, tag, data } = partsOf(encryptSecret(FAKE_KEY));
    const bytes = Buffer.from(data, "base64");
    bytes[0] ^= 0xff;
    assert.equal(decryptSecret(`${PREFIX}${iv}:${tag}:${bytes.toString("base64")}`), "");
  });

  test("잘라 낸 인증 태그는 받지 않는다", () => {
    const { iv, tag, data } = partsOf(encryptSecret(FAKE_KEY));
    // 예전에는 앞 4바이트만 남긴 태그도 통과했다.
    const short = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    assert.equal(decryptSecret(`${PREFIX}${iv}:${short}:${data}`), "");
  });

  test("형식이 깨진 값은 예외 없이 빈 문자열이다", () => {
    for (const stored of [PREFIX, `${PREFIX}abc`, `${PREFIX}::`, `${PREFIX}a:b:c`]) {
      assert.equal(decryptSecret(stored), "", stored);
    }
  });
});
