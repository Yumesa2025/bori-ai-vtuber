import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir, userInfo, hostname } from "node:os";
import { join } from "node:path";
import { createCipheriv, scryptSync } from "node:crypto";
import { initializeSecretStore, windowsProtector, encryptSecret, decryptSecret, createApiKeySlot } from "../src/secret-store.js";

const fake = { name: "test", async protect(value: Buffer) { return Buffer.from(value); }, async unprotect(value: Buffer) { return Buffer.from(value); } };
const secret = "fake-api-secret-never-log";
function legacy() {
  const key = scryptSync(`${userInfo().username}@${hostname()}:bori-ai-vtuber`, "bori-secret-salt", 32);
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `enc.v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "bori-secret-v2-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("v1 이전은 원본 백업 후 v2로 저장하며 재시작해도 풀린다", () => fixture(async dir => {
  const path = join(dir, "llm-config.json");
  const original = JSON.stringify({ settings: { enabled: true }, apiKey: legacy(), extra: 42 });
  writeFileSync(path, original);
  await initializeSecretStore(dir, fake);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(saved.apiKey.startsWith("enc.v2:"));
  assert.equal(saved.extra, 42);
  assert.equal(decryptSecret(saved.apiKey), secret);
  const backup = readdirSync(dir).find(name => name.includes("v1-backup-"))!;
  assert.equal(readFileSync(join(dir, backup), "utf8"), original);
  let calls = 0;
  await initializeSecretStore(dir, { ...fake, async unprotect(value) { calls++; return value; } });
  assert.equal(decryptSecret(saved.apiKey), secret);
  decryptSecret(saved.apiKey);
  assert.equal(calls, 1);
}));
for (const damage of ["missing", "corrupt", "unprotect"] as const) {
  test(`마스터 키 ${damage}: v2 보존·오류·재생성 금지`, () => fixture(async dir => {
    await initializeSecretStore(dir, fake);
    const stored = encryptSecret(secret);
    const path = join(dir, "tts-config.json");
    const raw = JSON.stringify({ elevenLabsApiKey: stored });
    writeFileSync(path, raw);
    const master = join(dir, "secret-master.v2");
    if (damage === "missing") rmSync(master);
    if (damage === "corrupt") writeFileSync(master, "broken");
    const before = existsSync(master) ? readFileSync(master, "utf8") : null;
    await assert.rejects(initializeSecretStore(dir, damage === "unprotect" ? { ...fake, async unprotect() { throw new Error(secret); } } : fake), error => {
      assert.ok(!String(error).includes(secret)); return true;
    });
    assert.equal(readFileSync(path, "utf8"), raw);
    assert.equal(existsSync(master) ? readFileSync(master, "utf8") : null, before);
    const slot = createApiKeySlot(undefined);
    assert.equal(slot.load(stored), "unreadable");
    assert.equal(slot.stored(), stored);
    assert.throws(() => encryptSecret(secret), /마스터/);
  }));
}
test("풀지 못한 v1은 그대로 남는다", () => fixture(async dir => {
  const path = join(dir, "llm-config.json");
  const raw = JSON.stringify({ apiKey: "enc.v1:broken" });
  writeFileSync(path, raw);
  await initializeSecretStore(dir, fake);
  assert.equal(readFileSync(path, "utf8"), raw);
  const slot = createApiKeySlot(undefined);
  assert.equal(slot.load("enc.v1:broken"), "unreadable");
  assert.equal(slot.stored(), "enc.v1:broken");
}));
test("보호 실패는 원문과 키를 출력하지 않고 파일을 남기지 않는다", () => fixture(async dir => {
  await assert.rejects(initializeSecretStore(dir, { ...fake, async protect() { throw new Error(secret); } }), error => {
    assert.ok(!String(error).includes(secret)); return true;
  });
  assert.equal(existsSync(join(dir, "secret-master.v2")), false);
}));
test("비Windows 마스터 파일은 0600이다", { skip: process.platform === "win32" }, () => fixture(async dir => {
  await initializeSecretStore(dir);
  assert.equal(statSync(join(dir, "secret-master.v2")).mode & 0o777, 0o600);
}));
test("Windows 실제 DPAPI CurrentUser 왕복", { skip: process.platform !== "win32" }, async () => {
  const input = Buffer.alloc(32, 17);
  const protectedValue = await windowsProtector.protect(input);
  assert.notDeepEqual(protectedValue, input);
  assert.deepEqual(await windowsProtector.unprotect(protectedValue), input);
});

test("JSON 이스케이프된 v2도 마스터 키 재생성을 막는다", () => fixture(async dir => {
  writeFileSync(join(dir, "llm-config.json"), '{"apiKey":"\\u0065nc.v2:broken"}');
  await assert.rejects(initializeSecretStore(dir, fake));
  assert.equal(existsSync(join(dir, "secret-master.v2")), false);
}));
test("설정 파일 읽기 실패는 마스터 키 생성을 막는다", () => fixture(async dir => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "llm-config.json"));
  await assert.rejects(initializeSecretStore(dir, fake));
  assert.equal(existsSync(join(dir, "secret-master.v2")), false);
}));
