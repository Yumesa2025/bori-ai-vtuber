/**
 * 백업·로그 보관 정리 단위 검사.
 * 정해진 형식의 오래된 백업만 지우고, 사용자 데이터 원본·최근 백업·하위 디렉터리는 남기는지 본다.
 * 파일은 모두 임시 디렉터리에 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_RETENTION_DAYS, isDisposableFile, purgeExpiredBackups } from "../src/retention.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-12T00:00:00.000Z");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-retention-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** ageDays일 전에 마지막으로 고친 파일을 만든다. */
function file(name: string, ageDays: number) {
  const path = join(dir, name);
  writeFileSync(path, "{}", "utf8");
  const at = new Date(NOW - ageDays * DAY_MS);
  utimesSync(path, at, at);
}

describe("지워도 되는 파일 이름", () => {
  test("백업과 이전 로그 형식만 고른다", () => {
    assert.ok(isDisposableFile("memories.v1-backup-2026-10-12T03-04-05-678Z.json"));
    assert.ok(isDisposableFile("memories.v1-backup-2026-10-12T03-04-05-678Z-2.json"));
    assert.ok(isDisposableFile("companion-conversations.unreadable-2026-10-12T03-04-05-678Z.json"));
    assert.ok(isDisposableFile("admin-renderer.previous.log"));
  });

  test("사용자 데이터 원본과 지금 쓰는 로그, 비슷한 이름은 고르지 않는다", () => {
    for (const name of [
      "memories.json",
      "companion-conversations.json",
      "llm-config.json",
      "tts-config.json",
      "memory-config.json",
      "usage.json",
      "macros.json",
      "admin-renderer.log",
      "memories.v1-backup-notes.json",
      "memories.v1-backup-2026-10-12T03-04-05-678Z.json.tmp",
      "../memories.v1-backup-2026-10-12T03-04-05-678Z.json",
    ]) {
      assert.equal(isDisposableFile(name), false, name);
    }
  });
});

describe("보관 기간 정리", () => {
  test(`${BACKUP_RETENTION_DAYS}일 지난 백업만 지우고 지운 이름을 돌려준다`, () => {
    file("memories.v1-backup-2026-08-01T00-00-00-000Z.json", 40);
    file("companion-conversations.unreadable-2026-08-01T00-00-00-000Z.json", 31);
    file("admin-renderer.previous.log", 60);
    file("memories.v1-backup-2026-10-01T00-00-00-000Z.json", 10);
    file("memories.json", 400);
    file("admin-renderer.log", 400);

    const removed = purgeExpiredBackups(dir, { now: NOW });
    assert.deepEqual(removed.sort(), [
      "admin-renderer.previous.log",
      "companion-conversations.unreadable-2026-08-01T00-00-00-000Z.json",
      "memories.v1-backup-2026-08-01T00-00-00-000Z.json",
    ]);
    assert.deepEqual(readdirSync(dir).sort(), ["admin-renderer.log", "memories.json", "memories.v1-backup-2026-10-01T00-00-00-000Z.json"]);
  });

  test("하위 디렉터리는 이름이 맞아도 보지 않는다", () => {
    mkdirSync(join(dir, "memories.v1-backup-2026-08-01T00-00-00-000Z.json"));
    const nested = join(dir, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "memories.v1-backup-2026-08-01T00-00-00-000Z.json"), "{}", "utf8");
    utimesSync(join(nested, "memories.v1-backup-2026-08-01T00-00-00-000Z.json"), new Date(NOW - 40 * DAY_MS), new Date(NOW - 40 * DAY_MS));

    assert.deepEqual(purgeExpiredBackups(dir, { now: NOW }), []);
    assert.deepEqual(readdirSync(nested), ["memories.v1-backup-2026-08-01T00-00-00-000Z.json"]);
  });

  test("디렉터리가 없으면 아무것도 하지 않는다", () => {
    assert.deepEqual(purgeExpiredBackups(join(dir, "missing"), { now: NOW }), []);
  });

  test("보관 기간을 바꿀 수 있다", () => {
    file("memories.v1-backup-2026-10-01T00-00-00-000Z.json", 10);
    assert.deepEqual(purgeExpiredBackups(dir, { now: NOW, retentionDays: 7 }), ["memories.v1-backup-2026-10-01T00-00-00-000Z.json"]);
  });
});
