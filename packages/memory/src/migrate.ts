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
};

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
    return { records: rows as MemoryRecord[], migrated: false, converted: 0, deleted: 0 };
  }

  if (file.version !== undefined && file.version !== 1) {
    // 모르는 버전은 옮기지 않는다. 처음 보는 scope는 검색이 알아서 막는다.
    return { records: rows as MemoryRecord[], migrated: false, converted: 0, deleted: 0 };
  }

  const records: MemoryRecord[] = [];
  let deleted = 0;
  for (const row of rows) {
    const migrated = row && typeof row === "object" ? migrateLegacyRecord(row as LegacyRecord) : null;
    if (migrated) records.push(migrated);
    else deleted += 1;
  }

  return { records, migrated: true, converted: records.length, deleted };
}
