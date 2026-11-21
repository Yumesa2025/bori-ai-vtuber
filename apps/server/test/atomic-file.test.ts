/**
 * 데이터 파일 공통 쓰기(ADR-021) 단위 검사.
 * 2026-11-21 장기 기억 패키지(packages/memory)를 지우면서 이 도우미를 서버로 옮겼다. 이름·시그니처는 그대로다.
 * 파일은 임시 디렉터리에만 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile, isMissingFileError, removeLeftoverFiles, temporaryPathFor, writeFileAtomically, writeFileAtomicallyAsync } from "../src/atomic-file.js";

let dir: string;
const eperm = () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bori-atomic-file-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeFileAtomically", () => {
  test("없는 폴더까지 만들고 내용을 쓴다. 임시 파일은 남지 않는다", () => {
    const target = join(dir, "sub", "a.json");
    writeFileAtomically(target, "{\"a\":1}");
    assert.equal(readFileSync(target, "utf8"), "{\"a\":1}");
    assert.deepEqual(readdirSync(join(dir, "sub")), ["a.json"]);
  });

  test("rename이 실패하면 임시 파일을 지우고 예외를 넘기며, 이전 파일은 그대로다", () => {
    const target = join(dir, "a.json");
    writeFileSync(target, "이전", "utf8");
    assert.throws(() => writeFileAtomically(target, "새것", { rename: eperm }), /EPERM/);
    assert.equal(readFileSync(target, "utf8"), "이전");
    assert.deepEqual(readdirSync(dir), ["a.json"]);
  });
});

describe("writeFileAtomicallyAsync", () => {
  test("조각을 차례로 이어 쓴다", async () => {
    const target = join(dir, "b.json");
    await writeFileAtomicallyAsync(target, ["[", "1,2", "]"]);
    assert.equal(readFileSync(target, "utf8"), "[1,2]");
  });

  test("rename이 실패하면 임시 파일을 지우고 예외를 넘긴다", async () => {
    const target = join(dir, "b.json");
    await assert.rejects(writeFileAtomicallyAsync(target, ["x"], { rename: eperm }), /EPERM/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe("backupFile", () => {
  test("<이름>.<label>-<시각>.json으로 복사하고, 같은 시각이면 덮지 않고 번호를 붙인다", () => {
    const target = join(dir, "llm-config.json");
    writeFileSync(target, "원본", "utf8");
    const now = Date.parse("2026-11-21T01:02:03.004Z");
    const first = backupFile(target, "unreadable", now);
    const second = backupFile(target, "unreadable", now);
    assert.equal(first, join(dir, "llm-config.unreadable-2026-11-21T01-02-03-004Z.json"));
    assert.equal(second, join(dir, "llm-config.unreadable-2026-11-21T01-02-03-004Z-1.json"));
    assert.equal(readFileSync(second, "utf8"), "원본");
  });
});

describe("isMissingFileError·temporaryPathFor", () => {
  test("ENOENT만 파일 없음으로 본다", () => {
    assert.equal(isMissingFileError(Object.assign(new Error("x"), { code: "ENOENT" })), true);
    assert.equal(isMissingFileError(Object.assign(new Error("x"), { code: "EPERM" })), false);
    assert.equal(isMissingFileError(null), false);
  });

  test("임시 파일 이름에 지금 프로세스 ID가 들어간다", () => {
    assert.match(temporaryPathFor("/d/a.json"), new RegExp(`^/d/a\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`));
  });
});

describe("removeLeftoverFiles", () => {
  test("다른 프로세스의 임시 파일과(요청하면) 읽지 못한 원본 백업만 지운다", () => {
    const target = join(dir, "usage.json");
    writeFileSync(target, "{}", "utf8");
    const files = [
      "usage.json.99999999.0b0f6d3e-0000-4000-8000-000000000000.tmp",
      `usage.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000001.tmp`,
      "usage.unreadable-2026-11-01T00-00-00-000Z.json",
      "other.json.99999999.x.tmp",
    ];
    for (const name of files) writeFileSync(join(dir, name), "", "utf8");
    assert.deepEqual(removeLeftoverFiles(target, { unreadable: false }), { removed: 1, failed: 0 });
    assert.deepEqual(removeLeftoverFiles(target, { unreadable: true }), { removed: 1, failed: 0 });
    assert.deepEqual(readdirSync(dir).sort(), ["other.json.99999999.x.tmp", "usage.json", `usage.json.${process.pid}.0b0f6d3e-0000-4000-8000-000000000001.tmp`].sort());
  });

  test("폴더가 없으면 아무것도 지우지 않는다", () => {
    assert.deepEqual(removeLeftoverFiles(join(dir, "none", "a.json"), { unreadable: true }), { removed: 0, failed: 0 });
  });
});

