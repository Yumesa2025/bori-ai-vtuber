/**
 * 예전 방송 경로 변환 단위 검사. 방송 코드를 지울 때 legacy.ts와 같이 지운다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toLegacyBasis } from "../src/er/legacy.js";

test("예전 기준 문구는 경기 수와 참가자 수를 나눠 천 단위 쉼표로 밝힌다", () => {
  const basis = toLegacyBasis({
    combos: [],
    basis: { seasonId: 41, seasonName: "시즌 12", patch: "7.0", games: 1234, participants: 29616, rankers: 100, gamesPerRanker: 3, collectedAt: "2026-11-21T00:00:00.000Z" },
  });
  assert.deepEqual(basis, { seasonName: "시즌 12", sampleGames: 29616, collectedAt: "2026-11-21T00:00:00.000Z", description: "상위 랭커 경기 1,234판(참가자 29,616명) 기준" });
});
