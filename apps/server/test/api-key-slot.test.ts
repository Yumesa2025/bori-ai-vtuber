/**
 * API 키 출처 단위 검사.
 * 환경변수 키는 파일에 쓸 값으로 나오지 않는지, 화면에서 넣은 키와 저장된 키가 환경변수보다 우선하는지 본다.
 * 키 값은 테스트용 가짜 문자열만 쓴다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApiKeySlot, decryptSecret, encryptSecret } from "../src/secret-store.js";

const ENV_KEY = "env-not-a-real-key";
const SCREEN_KEY = "screen-not-a-real-key";

describe("API 키 출처", () => {
  test("환경변수 키는 쓰지만 파일에 쓸 값은 없다", () => {
    const slot = createApiKeySlot(`  ${ENV_KEY}  `);
    assert.equal(slot.current(), ENV_KEY);
    assert.equal(slot.stored(), undefined);
    // JSON으로 쓰면 필드 자체가 빠진다.
    assert.equal(JSON.stringify({ apiKey: slot.stored() }), "{}");
  });

  test("환경변수가 없으면 빈 키다", () => {
    const slot = createApiKeySlot(undefined);
    assert.equal(slot.current(), "");
    assert.equal(slot.stored(), undefined);
  });

  test("화면에서 넣은 키는 환경변수보다 우선하고 암호화해 저장한다", () => {
    const slot = createApiKeySlot(ENV_KEY);
    slot.set(` ${SCREEN_KEY} `);
    assert.equal(slot.current(), SCREEN_KEY);
    const stored = slot.stored();
    assert.ok(stored?.startsWith("enc.v1:"));
    assert.equal(decryptSecret(stored ?? ""), SCREEN_KEY);
  });

  test("화면에서 키를 지우면 환경변수 키로 돌아가고 파일에서 빠진다", () => {
    const slot = createApiKeySlot(ENV_KEY);
    slot.set(SCREEN_KEY);
    slot.set("");
    assert.equal(slot.current(), ENV_KEY);
    assert.equal(slot.stored(), undefined);
  });

  test("저장된 암호문 키는 환경변수보다 우선한다", () => {
    const slot = createApiKeySlot(ENV_KEY);
    assert.equal(slot.load(encryptSecret(SCREEN_KEY)), "loaded");
    assert.equal(slot.current(), SCREEN_KEY);
    assert.equal(decryptSecret(slot.stored() ?? ""), SCREEN_KEY);
  });

  test("이전 버전의 평문 키는 plaintext로 알리고, 저장할 때는 암호문이 된다", () => {
    const slot = createApiKeySlot(undefined);
    assert.equal(slot.load(SCREEN_KEY), "plaintext");
    assert.equal(slot.current(), SCREEN_KEY);
    const stored = slot.stored() ?? "";
    assert.ok(stored.startsWith("enc.v1:") && !stored.includes(SCREEN_KEY));
  });

  test("풀 수 없는 값과 빈 값은 저장된 키가 없는 것으로 보고 환경변수 키를 쓴다", () => {
    const broken = createApiKeySlot(ENV_KEY);
    assert.equal(broken.load("enc.v1:AAAA:BBBB:CCCC"), "unreadable");
    assert.equal(broken.current(), ENV_KEY);

    const empty = createApiKeySlot(ENV_KEY);
    assert.equal(empty.load(""), "none");
    assert.equal(empty.load(undefined), "none");
    assert.equal(empty.load(42), "none");
    assert.equal(empty.current(), ENV_KEY);
  });
});
