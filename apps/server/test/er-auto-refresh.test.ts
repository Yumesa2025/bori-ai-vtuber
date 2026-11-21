/**
 * 대시보드 자동 갱신 판정 단위 검사. 데이터 없음·24시간·시즌, 하루 한 번(한국 날짜). 시계는 주입한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDailyGate, koreanDay, refreshReason, STALE_AFTER_MS } from "../src/er/auto-refresh.js";

const NOW = Date.parse("2026-11-21T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const fresh = { collectedAt: new Date(NOW - HOUR).toISOString(), metaSeasonId: 43, dictionarySeasonId: 43, seasonEnd: "2027-02-18T00:00:00.000Z", now: NOW };

describe("자동 갱신 판정", () => {
  test("데이터가 없으면 missing", () => {
    assert.equal(refreshReason({ ...fresh, collectedAt: null }), "missing");
  });

  test("수집 시각이 24시간을 넘으면 old, 딱 24시간은 아직 아니다", () => {
    assert.equal(STALE_AFTER_MS, 24 * HOUR);
    assert.equal(refreshReason({ ...fresh, collectedAt: new Date(NOW - 24 * HOUR).toISOString() }), null);
    assert.equal(refreshReason({ ...fresh, collectedAt: new Date(NOW - 24 * HOUR - 1).toISOString() }), "old");
  });

  test("읽지 못하는 수집 시각은 old", () => {
    assert.equal(refreshReason({ ...fresh, collectedAt: "아님" }), "old");
  });

  test("사전의 시즌이 끝났거나 집계 시즌이 사전 시즌과 다르면 season", () => {
    assert.equal(refreshReason({ ...fresh, seasonEnd: new Date(NOW - 1).toISOString() }), "season");
    assert.equal(refreshReason({ ...fresh, metaSeasonId: 42 }), "season");
  });

  test("새 데이터면 null. 시즌 끝을 모르면 시즌으로는 판정하지 않는다", () => {
    assert.equal(refreshReason(fresh), null);
    assert.equal(refreshReason({ ...fresh, seasonEnd: null }), null);
  });
});

describe("하루 한 번", () => {
  test("한국 날짜로 센다(UTC 14:59는 그날, 15:00은 다음 날)", () => {
    assert.equal(koreanDay(Date.parse("2026-11-21T14:59:59.999Z")), "2026-11-21");
    assert.equal(koreanDay(Date.parse("2026-11-21T15:00:00.000Z")), "2026-11-22");
  });

  test("같은 날 두 번째는 false, 다음 날은 다시 true", () => {
    let clock = Date.parse("2026-11-21T00:00:00.000Z");
    const gate = createDailyGate(() => clock);
    assert.equal(gate.tryToday(), true);
    clock += 10 * HOUR;
    assert.equal(gate.tryToday(), false);
    clock += 6 * HOUR;
    assert.equal(gate.tryToday(), true);
    assert.equal(gate.tryToday(), false);
  });
});
