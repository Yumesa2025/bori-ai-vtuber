import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRemainingSeconds } from './refresh-eta.js';
test('진행 초반과 완료는 추정하지 않고 경과 시간으로 남은 초 계산', () => {
  for (const p of [null, 0, .049, 1, NaN]) assert.equal(estimateRemainingSeconds(p, 10000), null);
  assert.equal(estimateRemainingSeconds(.05, 10000), 190);
  assert.equal(estimateRemainingSeconds(.5, 60000), 60);
  assert.equal(estimateRemainingSeconds(.5, -1), null);
});
