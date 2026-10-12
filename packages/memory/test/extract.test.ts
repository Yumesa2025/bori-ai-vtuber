/**
 * 기억 후보 추출 단위 검사.
 * 익명 발언은 누구의 기억인지 알 수 없으므로 후보가 되지 않아야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMemoryCandidates, extractPrivateMemoryCandidates } from "../src/extract.js";

const preference = "저는 잔잔한 인디 음악을 좋아해요";

test("닉네임이 있는 시청자의 취향은 그 시청자 소유의 방송 기억 후보가 된다", () => {
  const candidates = extractMemoryCandidates([{ role: "viewer", text: preference, viewerId: "local:a" }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].scope, "broadcast");
  assert.equal(candidates[0].ownerId, "local:a");
  assert.equal(candidates[0].kind, "viewer");
});

test("viewerId가 없는 발언은 후보가 되지 않는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "viewer", text: preference }]), []);
});

test("virtual-viewer 발언은 후보가 되지 않는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "viewer", text: preference, viewerId: "virtual-viewer" }]), []);
});

test("보리의 발언은 후보가 되지 않는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "bori", text: preference }]), []);
});

test("시청자가 섞여 있으면 각자 자기 소유로만 나뉜다", () => {
  const candidates = extractMemoryCandidates([
    { role: "viewer", text: preference, viewerId: "local:a" },
    { role: "viewer", text: "오늘 퇴근하고 바로 왔어요", viewerId: "virtual-viewer" },
    { role: "viewer", text: "요즘 기타 배우고 있어요", viewerId: "local:b" },
  ]);
  assert.deepEqual(candidates.map(candidate => [candidate.ownerId, candidate.text]), [
    ["local:a", preference],
    ["local:b", "요즘 기타 배우고 있어요"],
  ]);
});

test("1:1 사용자 메시지의 취향은 그 사용자 소유의 private 기억 후보가 된다", () => {
  const candidates = extractPrivateMemoryCandidates([preference, "안녕하세요"], "companion:local");
  assert.deepEqual(candidates.map(candidate => [candidate.scope, candidate.ownerId, candidate.text]), [
    ["private", "companion:local", preference],
  ]);
});

test("소유자를 모르는 1:1 메시지는 후보가 되지 않는다", () => {
  assert.deepEqual(extractPrivateMemoryCandidates([preference], ""), []);
  assert.deepEqual(extractPrivateMemoryCandidates([preference], "virtual-viewer"), []);
});

test("1:1에서도 저장하면 안 되는 내용은 후보가 되지 않는다", () => {
  assert.deepEqual(extractPrivateMemoryCandidates(["요즘 주식 투자하는 걸 좋아해요"], "companion:local"), []);
});
