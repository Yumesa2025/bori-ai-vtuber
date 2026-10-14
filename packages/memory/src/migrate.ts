import type { MemoryRecord } from "./types.js";

/** 지금 저장 형식의 버전. */
export const MEMORY_FILE_VERSION = 2;

/** 버전 1 이전 기록. 소유자를 viewerId 하나로만 나타냈다. */
type LegacyRecord = Omit<MemoryRecord, "scope" | "ownerId"> & { viewerId?: string };

export type MemoryMigrationResult = {
  records: MemoryRecord[];
  /** 파일을 다시 써야 하는지. 이미 지금 버전이면 false다. */
  migrated: boolean;
  /** 지금 형식으로 옮긴 건수. */
  converted: number;
  /** 소유자를 알 수 없어 지운 건수. */
  deleted: number;
  /** 형식이 틀려 버린 건수(null, 문자열이 아닌 text, 날짜가 없는 레코드 등). */
  invalid: number;
  /** 이 코드가 모르는 버전 표시인지. 다음 버전이 쓴 파일일 수 있다. */
  unknownVersion: boolean;
};

const KINDS: readonly unknown[] = ["broadcast", "viewer"];
const SCOPES: readonly unknown[] = ["character", "broadcast", "private"];
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isFiniteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

/**
 * 파일에서 읽은 기억 한 건을 검사한다. 하나라도 틀리면 null이다.
 * 필드가 빠진 기록을 만료로 착각해 지우거나, 숫자 text 하나로 저장이 매번 실패하는 일을 막는다.
 * 모르는 필드는 그대로 둔다. 다음 버전이 더한 필드를 이번 저장이 지우지 않는다.
 */
export function parseMemoryRecord(value: unknown): MemoryRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isText(row.id) || !isText(row.text) || !KINDS.includes(row.kind) || !SCOPES.includes(row.scope)) return null;
  if (row.ownerId !== undefined && !isText(row.ownerId)) return null;
  if (!isFiniteNumber(row.importance) || !isFiniteNumber(row.confidence) || !isFiniteNumber(row.repeatCount)) return null;
  if (!isTime(row.createdAt) || !isTime(row.expiresAt) || (row.lastSeenAt !== undefined && !isTime(row.lastSeenAt))) return null;
  if (row.embedding !== undefined && !(Array.isArray(row.embedding) && row.embedding.every(isFiniteNumber))) return null;
  return row as MemoryRecord;
}

/** 레코드를 하나씩 검사해 통과한 것만 남긴다. */
function keepValid(rows: readonly unknown[]): { records: MemoryRecord[]; invalid: number } {
  const records: MemoryRecord[] = [];
  for (const row of rows) {
    const record = parseMemoryRecord(row);
    if (record) records.push(record);
  }
  return { records, invalid: rows.length - records.length };
}

/**
 * 버전 1 기록 한 건을 지금 형식으로 옮긴다. 소유자를 확정할 수 없으면 null이다.
 * - 방송 요약(viewerId 없음)은 소유자 없는 broadcast 기억이 된다.
 * - 닉네임으로 식별한 시청자(local:)는 그 시청자 소유의 broadcast 기억이 된다.
 * - virtual-viewer처럼 여러 사람이 섞인 ID나 처음 보는 ID는 지운다.
 */
function migrateLegacyRecord(legacy: LegacyRecord): MemoryRecord | null {
  const { viewerId, ...rest } = legacy;

  if (!viewerId) {
    return legacy.kind === "broadcast" ? { ...rest, scope: "broadcast" } : null;
  }
  if (viewerId.startsWith("local:")) {
    return { ...rest, scope: "broadcast", ownerId: viewerId };
  }
  return null;
}

/**
 * 파일에서 읽은 내용을 지금 형식으로 맞춘다. 파일을 직접 건드리지 않는 순수 함수다.
 * 버전 표시가 없거나 1이면 옮기고, 2면 그대로 둔다. 같은 입력에는 항상 같은 결과를 낸다.
 */
export function migrateMemoryFile(parsed: unknown): MemoryMigrationResult {
  const file = (parsed ?? {}) as { version?: unknown; records?: unknown };
  const rows = Array.isArray(file.records) ? file.records as unknown[] : [];

  if (file.version === MEMORY_FILE_VERSION) {
    return { ...keepValid(rows), migrated: false, converted: 0, deleted: 0, unknownVersion: false };
  }

  if (file.version !== undefined && file.version !== 1) {
    // 모르는 버전은 옮기지 않는다. 지금 형식으로 읽히는 레코드만 쓰고, 원본 보존은 저장소가 맡는다.
    return { ...keepValid(rows), migrated: false, converted: 0, deleted: 0, unknownVersion: true };
  }

  const migrated: unknown[] = [];
  let deleted = 0;
  for (const row of rows) {
    const record = row && typeof row === "object" ? migrateLegacyRecord(row as LegacyRecord) : null;
    if (record) migrated.push(record);
    else deleted += 1;
  }

  const { records, invalid } = keepValid(migrated);
  return { records, migrated: true, converted: records.length, deleted, invalid, unknownVersion: false };
}
