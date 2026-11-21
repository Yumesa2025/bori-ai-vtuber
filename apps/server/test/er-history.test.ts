/**
 * ER 집계 history 단위 검사. 갱신마다 하나씩 쓰고 최근 10개만 남기며, 직전 집계를 찾는다. 임시 폴더만 쓴다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErMetaCollection } from "@bori/er";
import { createErHistory, historyFileName, parseCollection } from "../src/er/history.js";

let dir: string;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), "bori-er-history-")), "er-history"); });
afterEach(() => { rmSync(join(dir, ".."), { recursive: true, force: true }); });

const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T03:04:05.678Z`;
const collection = (collectedAt: string, participants = 8): ErMetaCollection => ({
  combos: [{ characterCode: 1, weaponCode: 15, participants, rankSum: participants * 2, top1: 1, mmrGainSum: 10, mmrGainSamples: 1, kills: 1, assists: 1, deaths: 1, damage: 100, traits: { "7000201": 1 }, equipment: { "0": { "117406": 1 } } }],
  basis: { seasonId: 41, seasonName: "시즌 12", patch: "7.0", games: 1, participants, rankers: 1, gamesPerRanker: 1, collectedAt },
});
const quiet = () => {};

describe("ER history", () => {
  test("파일 이름은 수집 시각에서 :를 -로 바꾼 것이다(Windows가 :를 못 쓴다)", () => {
    assert.equal(historyFileName("2026-11-21T03:04:05.678Z"), "2026-11-21T03-04-05.678Z.json");
  });

  test("갱신마다 하나씩 쓰고 최근 10개만 남긴다", () => {
    const history = createErHistory({ dir, warn: quiet });
    for (let day = 1; day <= 12; day += 1) history.save(collection(at(day)));
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 10);
    assert.equal(files[0], historyFileName(at(3)));
    assert.equal(files.at(-1), historyFileName(at(12)));
  });

  test("남길 개수를 바꿀 수 있고, 모르는 파일은 지우지 않는다", () => {
    const history = createErHistory({ dir, keep: 2, warn: quiet });
    history.save(collection(at(1)));
    writeFileSync(join(dir, "메모.txt"), "사용자 파일");
    for (let day = 2; day <= 4; day += 1) history.save(collection(at(day)));
    assert.deepEqual(readdirSync(dir).sort(), [historyFileName(at(3)), historyFileName(at(4)), "메모.txt"].sort());
  });

  test("직전 집계는 주어진 시각보다 이른 것 중 가장 최근 것이다", () => {
    const history = createErHistory({ dir, warn: quiet });
    history.save(collection(at(1), 8));
    history.save(collection(at(2), 16));
    history.save(collection(at(3), 24));
    assert.equal(history.previous(at(3))?.basis.collectedAt, at(2));
    assert.equal(history.previous(at(3))?.basis.participants, 16);
    assert.equal(history.previous(at(1)), null);
  });

  test("깨진 파일은 몇 번 읽어도 사본을 만들지 않고, 경고는 파일마다 한 번이다", () => {
    const warnings: string[] = [];
    const history = createErHistory({ dir, warn: (message) => warnings.push(message) });
    history.save(collection(at(1)));
    writeFileSync(join(dir, historyFileName(at(2))), "{ 깨짐");
    for (let i = 0; i < 3; i += 1) assert.equal(history.previous(at(3))?.basis.collectedAt, at(1));
    assert.deepEqual(readdirSync(dir).sort(), [historyFileName(at(1)), historyFileName(at(2))]);
    assert.equal(warnings.length, 1);
    // 경고에는 파일 이름만 있다(내용 없음)
    assert.ok(warnings[0]!.includes(historyFileName(at(2))));
    assert.ok(!warnings[0]!.includes("깨짐"));
  });

  test("시계가 뒤로 가도 방금 쓴 파일은 지우지 않는다", () => {
    const history = createErHistory({ dir, keep: 2, warn: quiet });
    history.save(collection(at(5)));
    history.save(collection(at(6)));
    history.save(collection(at(4)));
    assert.deepEqual(history.names(), [historyFileName(at(4)), historyFileName(at(6))]);
  });

  test("폴더가 없거나 깨진 파일은 건너뛴다", () => {
    const history = createErHistory({ dir, warn: quiet });
    assert.equal(history.previous(at(5)), null);
    history.save(collection(at(1)));
    writeFileSync(join(dir, historyFileName(at(2))), "{ 깨짐");
    assert.equal(history.previous(at(3))?.basis.collectedAt, at(1));
  });

  test("모양이 틀린 집계는 null로 읽는다", () => {
    assert.equal(parseCollection(null), null);
    assert.equal(parseCollection({ combos: "아님", basis: {} }), null);
    assert.equal(parseCollection({ stats: [], basis: { seasonName: "시즌 12" } }), null);
    const valid = collection(at(1));
    assert.deepEqual(parseCollection({ format: 2, ...valid }), valid);
  });
});
