/**
 * 대시보드 숫자 모양 검사. 화면과 보리 대사가 같은 반올림을 쓰는지는 서버 검사(narration-format)가 이 함수와 비교해 고정한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatCollectedAt, formatCount, formatDecimal, formatMmr, formatPercent, formatPointChange, formatRank, formatRankChange } from "../src/format";

describe("숫자 모양", () => {
  test("비율은 % 소수 한 자리", () => {
    assert.equal(formatPercent(0.1234), "12.3%");
    assert.equal(formatPercent(0.00049), "0.0%");
    // 0.0125*1000은 부동소수로 12.499…가 된다. 사람이 읽는 값(1.25%)대로 올린다.
    assert.equal(formatPercent(0.0125), "1.3%");
    assert.equal(formatPercent(1), "100.0%");
  });

  test("순위는 소수 한 자리", () => {
    assert.equal(formatRank(3.94), "3.9");
    assert.equal(formatRank(4.05), "4.1");
    assert.equal(formatRank(1), "1.0");
  });

  test("변화량은 부호를 붙이고, 0은 부호 없이", () => {
    assert.equal(formatPointChange(0.012), "+1.2%p");
    assert.equal(formatPointChange(-0.0049), "-0.5%p");
    assert.equal(formatPointChange(0), "0.0%p");
    assert.equal(formatPointChange(-0.0001), "0.0%p");
    assert.equal(formatRankChange(-0.46), "-0.5");
    assert.equal(formatRankChange(0.3), "+0.3");
    assert.equal(formatRankChange(0.04), "0.0");
  });

  test("MMR은 부호와 소수 한 자리, 없으면 줄표", () => {
    assert.equal(formatMmr(12.34), "+12.3");
    assert.equal(formatMmr(-3), "-3.0");
    assert.equal(formatMmr(0), "0.0");
    assert.equal(formatMmr(null), "—");
  });

  test("개수는 로캘과 상관없이 세 자리마다 쉼표", () => {
    assert.equal(formatCount(7200), "7,200");
    assert.equal(formatCount(1234567), "1,234,567");
    assert.equal(formatCount(12), "12");
    assert.equal(formatCount(999.6), "1,000");
  });

  test("킬 같은 평균은 소수 한 자리", () => {
    assert.equal(formatDecimal(4.25), "4.3");
    assert.equal(formatDecimal(0), "0.0");
  });

  test("수집 시각은 월·일·시:분(현지 시각)", () => {
    const local = new Date(2026, 10, 21, 9, 5);
    assert.equal(formatCollectedAt(local.toISOString()), "11월 21일 09:05");
    assert.equal(formatCollectedAt("엉터리"), "—");
  });

  test("수가 아닌 값(NaN·무한)은 'NaN%' 대신 '—'로 보인다", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(formatPercent(bad), "—");
      assert.equal(formatRank(bad), "—");
      assert.equal(formatCount(bad), "—");
      assert.equal(formatDecimal(bad), "—");
      assert.equal(formatMmr(bad), "—");
      assert.equal(formatPointChange(bad), "—");
      assert.equal(formatRankChange(bad), "—");
    }
  });
});
