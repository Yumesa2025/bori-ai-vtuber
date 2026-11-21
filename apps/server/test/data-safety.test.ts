/**
 * 서버 데이터 파일 안전 저장 단위 검사(점검 D-1, D-3, D-5, D-6, L-4, M-10, M-19, L8).
 * 풀지 못한 키를 지우지 않는지, 키에 섞인 개행을 지우는지, 읽지 못한 사용량 파일을 덮어쓰지 않는지,
 * 오래된 임시 파일을 정리하는지 본다. (1:1 대화·기억 삭제 검사는 2026-11-21 1:1 대화와 함께 지웠다.)
 * 키 값은 테스트용 가짜 문자열만 쓰고, 파일은 임시 디렉터리에만 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLlmSettingsPatch, validateTtsSettingsPatch } from "../src/http/settings.js";
import { isLeftoverTempFile, purgeExpiredBackups } from "../src/retention.js";
import { createApiKeySlot, encryptSecret, normalizeApiKey } from "../src/secret-store.js";
import { createUsageStore } from "../src/usage/index.js";
import { defaultTtsSettings } from "@bori/llm";

const silent = () => {};
const OTHER_PID_TEMP = "companion-conversations.json.99999999.0b0f6d3e-0000-4000-8000-000000000000.tmp";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-data-safety-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("풀지 못한 저장 키", () => {
  // 형식은 맞지만 이 컴퓨터의 키로 풀리지 않는 암호문.
  const foreign = "enc.v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";

  test("지우지 않고 원문 그대로 다시 저장하며, 풀 수 없음 상태를 알린다", () => {
    const slot = createApiKeySlot(undefined);
    assert.equal(slot.load(foreign), "unreadable");
    assert.equal(slot.current(), "");
    assert.equal(slot.stored(), foreign);
    assert.equal(slot.isUnreadable(), true);
  });

  test("새 키를 넣거나 지우면 그때 원문을 버린다", () => {
    const replaced = createApiKeySlot(undefined);
    replaced.load(foreign);
    replaced.set("new-fake-key");
    assert.notEqual(replaced.stored(), foreign);
    assert.equal(replaced.isUnreadable(), false);

    const cleared = createApiKeySlot(undefined);
    cleared.load(foreign);
    cleared.set("");
    assert.equal(cleared.stored(), undefined);
  });

  test("checkpoint로 저장 실패 전 상태로 되돌린다", () => {
    const slot = createApiKeySlot(undefined);
    slot.load(foreign);
    const restore = slot.checkpoint();
    slot.set("new-fake-key");
    restore();
    assert.equal(slot.stored(), foreign);
    assert.equal(slot.current(), "");

    const plain = createApiKeySlot(undefined);
    plain.load(encryptSecret("old-fake-key"));
    const back = plain.checkpoint();
    plain.set("");
    back();
    assert.equal(plain.current(), "old-fake-key");
  });
});

describe("키에 섞인 개행·공백(L-4)", () => {
  test("공백·개행·제로폭 문자를 지운다", () => {
    assert.equal(normalizeApiKey(" sk-fake-0123\nTAIL\r\n"), "sk-fake-0123TAIL");
    assert.equal(normalizeApiKey(`sk-fake${String.fromCharCode(0x200b)}-tail`), "sk-fake-tail");
    assert.equal(normalizeApiKey(""), "");
  });

  test("그 밖의 보이지 않는 문자나 ASCII 밖 문자는 거부한다", () => {
    assert.equal(normalizeApiKey("sk-fake\u0000tail"), null);
    assert.equal(normalizeApiKey("sk-가짜키"), null);
  });

  test("PATCH 검증은 다듬은 키를 넘기고, 거부할 때 오류 문장에 키를 넣지 않는다", () => {
    const llm = validateLlmSettingsPatch({ apiKey: "sk-fake-0123\nTAILSECRET" });
    assert.ok(llm.ok && llm.patch.apiKey === "sk-fake-0123TAILSECRET");
    const rejected = validateLlmSettingsPatch({ apiKey: "sk-fake\u0001TAILSECRET" });
    assert.ok(!rejected.ok && !rejected.error.includes("TAILSECRET"));

    const tts = validateTtsSettingsPatch({ elevenLabsApiKey: "eleven fake\nkey" }, defaultTtsSettings);
    assert.ok(tts.ok && tts.patch.elevenLabsApiKey === "elevenfakekey");
  });
});

describe("사용량 파일 읽기 실패", () => {
  test("깨진 사용량 파일은 원본을 남기고, 읽지 못한 사용량 파일은 덮어쓰지 않는다", () => {
    const broken = join(dir, "usage.json");
    writeFileSync(broken, "{ 깨진", "utf8");
    const store = createUsageStore(broken, { log: silent });
    store.load();
    const backups = readdirSync(dir).filter(name => name.startsWith("usage.unreadable-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), "{ 깨진");

    const locked = join(dir, "locked.json");
    mkdirSync(locked);
    const second = createUsageStore(locked, { log: silent });
    second.load();
    second.record({ feature: "reply", mode: "broadcast", model: "gpt-4o-mini", ok: true });
    assert.deepEqual(readdirSync(locked), []);
  });
});

describe("남은 임시 파일 정리(L8)", () => {
  const NOW = Date.parse("2026-10-12T00:00:00.000Z");
  function file(name: string, ageMs: number) {
    const path = join(dir, name);
    writeFileSync(path, "{}", "utf8");
    const at = new Date(NOW - ageMs);
    utimesSync(path, at, at);
    return path;
  }

  test("한 시간 지난 다른 프로세스의 임시 파일만 지운다", () => {
    const old = file(OTHER_PID_TEMP, 2 * 3_600_000);
    const fresh = file("memories.json.99999998.0b0f6d3e-0000-4000-8000-000000000001.tmp", 60_000);
    const own = file(`usage.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000002.tmp`, 2 * 3_600_000);
    const unrelated = file("notes.tmp", 2 * 3_600_000);

    assert.deepEqual(purgeExpiredBackups(dir, { now: NOW }), [OTHER_PID_TEMP]);
    assert.equal(existsSync(old), false);
    assert.ok(existsSync(fresh) && existsSync(own) && existsSync(unrelated));
  });

  test("임시 파일 이름 형식", () => {
    assert.equal(isLeftoverTempFile(OTHER_PID_TEMP), true);
    assert.equal(isLeftoverTempFile(`memories.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000000.tmp`), false);
    assert.equal(isLeftoverTempFile("usage.json.1234.abcd.tmp"), false);
    assert.equal(isLeftoverTempFile("memories.json"), false);
  });
});
