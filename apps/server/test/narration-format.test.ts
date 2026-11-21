/**
 * 보리 대사 숫자 모양이 화면(apps/companion/src/format.ts)과 같은지 고정한다.
 * 화면은 "3.4위"인데 보리가 "3.42위"라고 읽으면 숫자 검사도 어긋나므로, 같은 입력을 두 쪽에 넣어 결과가 모두 같은지 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as screen from "../../companion/src/format.js";
import * as narration from "../src/narration/format.js";

describe("화면과 대사의 숫자 모양", () => {
  test("비율·비율 변화", () => {
    for (let i = -2000; i <= 2000; i += 1) {
      const rate = i / 2000;
      if (rate >= 0) assert.equal(narration.formatPercent(rate), screen.formatPercent(rate), `percent ${rate}`);
      assert.equal(narration.formatPointChange(rate / 10), screen.formatPointChange(rate / 10), `point ${rate / 10}`);
    }
    // 부동소수 경계값
    for (const rate of [0.0125, 0.0135, 0.0245, 0.1005, 0.00049, 0.00051]) assert.equal(narration.formatPercent(rate), screen.formatPercent(rate));
  });

  test("순위·순위 변화", () => {
    for (let i = 0; i <= 1600; i += 1) {
      const rank = 1 + i * 0.005;
      assert.equal(narration.formatRank(rank), screen.formatRank(rank), `rank ${rank}`);
      assert.equal(narration.formatRankChange(rank - 5), screen.formatRankChange(rank - 5), `change ${rank - 5}`);
    }
  });

  test("MMR·개수·소수", () => {
    for (let i = -1000; i <= 1000; i += 1) {
      assert.equal(narration.formatMmr(i / 20), screen.formatMmr(i / 20));
      assert.equal(narration.formatDecimal(Math.abs(i) / 37), screen.formatDecimal(Math.abs(i) / 37));
    }
    assert.equal(narration.formatMmr(null), screen.formatMmr(null));
    for (const count of [0, 7, 12, 999, 1000, 7200, 12345, 1234567]) assert.equal(narration.formatCount(count), screen.formatCount(count));
  });

  test("수가 아닌 값도 두 쪽이 같은 모양('—')이다", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const name of ["formatPercent", "formatRank", "formatCount", "formatDecimal", "formatMmr", "formatPointChange", "formatRankChange"] as const) {
        assert.equal(narration[name](bad), screen[name](bad), `${name}(${bad})`);
        assert.equal(narration[name](bad), "—", `${name}(${bad})`);
      }
    }
  });
});
