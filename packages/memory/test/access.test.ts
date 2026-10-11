/**
 * 기억 접근 규칙 단위 검사.
 * 사용자가 확정한 규칙표의 모든 칸과 표 밖의 조합(fail closed)을 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessMemory, isAnonymousViewer } from "../src/access.js";
import type { MemoryAccess, MemoryRecord } from "../src/types.js";

const A = "local:a";
const B = "local:b";

function record(scope: string, ownerId?: string): MemoryRecord {
  return {
    id: `${scope}-${ownerId ?? "none"}`,
    text: "기억",
    kind: "viewer",
    scope: scope as MemoryRecord["scope"],
    ...(ownerId !== undefined ? { ownerId } : {}),
    importance: 0.5,
    confidence: 0.5,
    repeatCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

const columns: { label: string; access: MemoryAccess }[] = [
  { label: "방송(A 발언)", access: { mode: "broadcast", speakerId: A } },
  { label: "방송(B 발언)", access: { mode: "broadcast", speakerId: B } },
  { label: "1:1(A)", access: { mode: "private", userId: A } },
  { label: "1:1(B)", access: { mode: "private", userId: B } },
];

// 규칙표를 그대로 옮긴다. 순서는 위 columns와 같다.
const table: { label: string; record: MemoryRecord; expected: boolean[] }[] = [
  { label: "character / 소유자 없음", record: record("character"), expected: [true, true, true, true] },
  { label: "broadcast / 소유자 없음(요약)", record: record("broadcast"), expected: [true, true, false, false] },
  { label: "broadcast / A", record: record("broadcast", A), expected: [true, false, false, false] },
  { label: "private / A", record: record("private", A), expected: [false, false, true, false] },
];

for (const row of table) {
  columns.forEach((column, index) => {
    const expected = row.expected[index];
    test(`규칙표: ${row.label} × ${column.label} → ${expected ? "O" : "X"}`, () => {
      assert.equal(canAccessMemory(row.record, column.access), expected);
    });
  });
}

test("익명 방송 채팅은 소유자 없는 기억만 본다", () => {
  const anonymous: MemoryAccess = { mode: "broadcast" };
  assert.equal(canAccessMemory(record("character"), anonymous), true);
  assert.equal(canAccessMemory(record("broadcast"), anonymous), true);
  assert.equal(canAccessMemory(record("broadcast", A), anonymous), false);
  assert.equal(canAccessMemory(record("private", A), anonymous), false);
});

test("virtual-viewer를 speakerId로 넘겨도 소유 기억을 열지 못한다", () => {
  const access: MemoryAccess = { mode: "broadcast", speakerId: "virtual-viewer" };
  assert.equal(canAccessMemory(record("broadcast", "virtual-viewer"), access), false);
  assert.equal(canAccessMemory(record("broadcast"), access), true);
});

test("알 수 없는 scope는 어떤 경우에도 제외한다", () => {
  for (const column of columns) {
    assert.equal(canAccessMemory(record("public"), column.access), false, column.label);
    assert.equal(canAccessMemory(record("", A), column.access), false, column.label);
    assert.equal(canAccessMemory({ ...record("broadcast"), scope: undefined as unknown as MemoryRecord["scope"] }, column.access), false, column.label);
  }
});

test("소유자가 불명확한 기억은 제외한다", () => {
  // 소유자 없는 private, 빈 문자열 소유자, 소유자가 붙은 character
  for (const column of columns) {
    assert.equal(canAccessMemory(record("private"), column.access), false, column.label);
    assert.equal(canAccessMemory(record("broadcast", ""), column.access), false, column.label);
    assert.equal(canAccessMemory(record("character", A), column.access), false, column.label);
  }
});

test("1:1에서 userId가 비어 있으면 private 기억을 열지 못한다", () => {
  assert.equal(canAccessMemory(record("private", A), { mode: "private", userId: "" }), false);
});

test("접근 정보가 없으면 아무것도 열지 않는다", () => {
  assert.equal(canAccessMemory(record("character"), undefined as unknown as MemoryAccess), false);
});

test("익명 판정", () => {
  assert.equal(isAnonymousViewer(undefined), true);
  assert.equal(isAnonymousViewer(""), true);
  assert.equal(isAnonymousViewer("virtual-viewer"), true);
  assert.equal(isAnonymousViewer(A), false);
});
