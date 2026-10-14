/**
 * 설정 파일 읽기·쓰기와 읽은 값 검증 단위 검사(점검 D-5).
 * 깨진 설정 파일은 원본을 남기고 기본값으로 시작하는지, 틀린 값만 기본값으로 바꾸는지,
 * 있는데 읽지 못한 파일은 덮어쓰지 않는지 본다. 파일은 모두 임시 디렉터리에 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigFile } from "../src/config-file.js";
import { pickValidSettings, validateLlmSettingsPatch, validateMemorySettingsPatch, validateTtsSettingsPatch, type PatchResult } from "../src/http/settings.js";
import { defaultTtsSettings, type TtsSettings } from "@bori/llm";
import type { MemorySettings } from "@bori/memory";

let dir: string;
let filePath: string;
const warnings: string[] = [];
const open = () => createConfigFile(filePath, "LLM 설정", message => { warnings.push(message); });
const backups = () => readdirSync(dir).filter(name => /^llm-config\.unreadable-.+\.json$/.test(name));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-config-file-"));
  filePath = join(dir, "llm-config.json");
  warnings.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("설정 파일", () => {
  test("파일이 없으면 null이고 아무것도 남기지 않는다", () => {
    assert.equal(open().read(), null);
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(warnings, []);
  });

  test("깨진 파일은 원본을 남기고 null이다. 경고에 내용과 키를 넣지 않는다", () => {
    const broken = `{"settings":{"enabled":true},"apiKey":"enc.v1:SECRETPART`;
    writeFileSync(filePath, broken, "utf8");
    const config = open();
    assert.equal(config.read(), null);
    assert.equal(backups().length, 1);
    assert.equal(readFileSync(join(dir, backups()[0]), "utf8"), broken);
    assert.ok(warnings.every(message => !message.includes("SECRETPART")));

    // 다음 저장은 원본 자리에 새로 쓴다. 백업은 그대로다.
    config.write({ settings: { enabled: false } });
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { settings: { enabled: false } });
    assert.equal(readFileSync(join(dir, backups()[0]), "utf8"), broken);
  });

  test("JSON 객체가 아니면 깨진 파일로 본다", () => {
    for (const content of ["[]", "5", "null"]) {
      writeFileSync(filePath, content, "utf8");
      assert.equal(open().read(), null);
    }
    assert.equal(backups().length, 3);
  });

  test("있는데 읽지 못한 파일은 덮어쓰지 않는다", () => {
    mkdirSync(filePath);
    const config = open();
    assert.equal(config.read(), null);
    assert.throws(() => config.write({ settings: {} }));
  });

  test("일부 값을 버리면 원본을 남기고 키 이름만 알린다", () => {
    writeFileSync(filePath, JSON.stringify({ settings: { timeoutMs: -1 } }), "utf8");
    const config = open();
    config.read();
    config.rejected(["timeoutMs"]);
    assert.equal(backups().length, 1);
    assert.ok(warnings.some(message => message.includes("timeoutMs")));
    config.rejected([]);
    assert.equal(backups().length, 1, "버린 값이 없으면 백업하지 않는다");
  });

  test("임시 파일을 남기지 않고 쓴다", () => {
    open().write({ settings: { enabled: true } });
    assert.deepEqual(readdirSync(dir), ["llm-config.json"]);
  });
});

describe("읽은 설정 검증", () => {
  test("기억 설정: 틀린 값만 버리고 나머지는 쓴다", () => {
    const picked = pickValidSettings<MemorySettings>({ retentionDays: "abc", maxMemories: -5, enabled: false, unknown: 1 }, patch => validateMemorySettingsPatch(patch));
    assert.deepEqual(picked.patch, { enabled: false });
    assert.deepEqual(picked.rejected.sort(), ["maxMemories", "retentionDays", "unknown"]);
  });

  test("LLM 설정: 업체·타입·범위가 틀린 키를 버린다", () => {
    const picked = pickValidSettings({ provider: "bogus", model: 5, maxReplyLength: "x", timeoutMs: -1, cooldownSeconds: 30 }, patch => validateLlmSettingsPatch(patch));
    assert.deepEqual(picked.patch, { cooldownSeconds: 30 });
    assert.equal(picked.rejected.length, 4);
  });

  test("음성 설정: 목소리는 앞에서 받은 업체 기준으로 본다", () => {
    const validate = (patch: Record<string, unknown>, accepted: Partial<TtsSettings>) =>
      validateTtsSettingsPatch(patch, { ...defaultTtsSettings, ...accepted }) as PatchResult<TtsSettings>;
    const eleven = pickValidSettings<TtsSettings>({ provider: "elevenlabs", voice: "abcDEF123" }, validate);
    assert.deepEqual(eleven.patch, { provider: "elevenlabs", voice: "abcDEF123" });
    const openai = pickValidSettings<TtsSettings>({ provider: "openai", voice: "abcDEF123", speed: "fast" }, validate);
    assert.deepEqual(openai.rejected.sort(), ["speed", "voice"]);
  });
});
