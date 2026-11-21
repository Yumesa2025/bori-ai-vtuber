/**
 * 최신 대사 저장(data/narration.json) 검사. 실제 data/ 대신 임시 폴더를 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Narration } from "@bori/shared";
import { createNarrationStore } from "../src/narration/store.js";

let dir: string;
let filePath: string;
const warnings: string[] = [];
const open = () => createNarrationStore(filePath, message => { warnings.push(message); });

const sample: Narration = {
  id: "n-1",
  createdAt: "2026-11-21T03:00:00.000Z",
  source: "llm",
  lines: [{ text: "재키 쌍검이 3.4위예요.", emotion: "gaming", audioId: "a-1" }, { text: "정리해 봤어요.", emotion: "calm" }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-narration-store-"));
  filePath = join(dir, "narration.json");
  warnings.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("대사 저장", () => {
  test("저장한 대사를 새로 연 저장소가 그대로 읽는다", () => {
    open().save(sample);
    assert.deepEqual(open().load(), sample);
    // 임시 파일이 남지 않는다(원자적 쓰기).
    assert.deepEqual(readdirSync(dir), ["narration.json"]);
  });

  test("파일이 없으면 null", () => {
    assert.equal(open().load(), null);
  });

  test("깨진 파일은 null이고 원본을 남긴다", () => {
    writeFileSync(filePath, "{broken", "utf8");
    assert.equal(open().load(), null);
    assert.ok(readdirSync(dir).some(name => /^narration\.unreadable-.+\.json$/.test(name)));
    assert.equal(warnings.length, 1);
  });

  test("모양이 틀린 파일은 null", () => {
    for (const value of [{ id: 1 }, { ...sample, source: "rule" }, { ...sample, lines: [{ text: "a" }] }, { ...sample, lines: [{ text: "a", emotion: "calm", audioId: 3 }] }]) {
      writeFileSync(filePath, JSON.stringify(value), "utf8");
      assert.equal(open().load(), null, JSON.stringify(value));
    }
  });
});
