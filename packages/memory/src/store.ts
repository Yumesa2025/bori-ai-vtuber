import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { canAccessMemory } from "./access.js";
import { cosineSimilarity } from "./embedding.js";
import { backupFile, isMissingFileError, removeLeftoverFiles, writeFileAtomically, writeFileAtomicallyAsync } from "./file.js";
import { MEMORY_FILE_VERSION, migrateMemoryFile } from "./migrate.js";
import { isSameMemoryEmbedding, isSameMemoryText } from "./similar.js";
import type { EmbeddingProvider, MemoryAccess, MemoryCandidate, MemoryRecord, MemorySearchHit, MemorySettings } from "./types.js";

export type MemoryAddOptions = {
  /**
   * 임베딩을 기다린 뒤 저장 직전에 부른다. true면 아무것도 저장하지 않고 0을 돌려준다.
   * 기다리는 사이 그 소유자의 기억을 모두 지웠다면, 지우기 전에 시작한 저장이 삭제를 되돌리지 않게 한다.
   */
  isStale?: () => boolean;
};

export type MemoryStoreOptions = {
  /** 마이그레이션 결과를 남길 곳. 기본은 콘솔이다. */
  log?: (message: string) => void;
  /** 손상·저장 실패 경고를 남길 곳. 기본은 콘솔 경고다. 기억 문장은 넘기지 않는다. */
  warn?: (message: string) => void;
  /** 임시 파일을 제자리로 옮기는 함수. 테스트에서 쓰기 실패를 주입할 때 바꾼다. */
  rename?: (from: string, to: string) => void;
};

/** 한 조각에 담는 기억 수. 임베딩까지 담으면 한 건이 수십 KB라, 이 정도면 조각 하나를 만드는 데 수십 ms다. */
const RECORDS_PER_CHUNK = 200;

/** 파일 내용을 조각으로 만든다. 들여쓰기 없이 쓴다. 임베딩 숫자를 한 줄씩 쓰면 파일이 1.5배가 된다. */
function* fileChunks(snapshot: readonly MemoryRecord[]): Generator<string> {
  yield `{"version":${MEMORY_FILE_VERSION},"records":[`;
  for (let start = 0; start < snapshot.length; start += RECORDS_PER_CHUNK) {
    const part = snapshot.slice(start, start + RECORDS_PER_CHUNK).map(record => JSON.stringify(record)).join(",");
    yield start === 0 ? part : `,${part}`;
  }
  yield "]}";
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? "오류";

/**
 * 장기 기억 저장소.
 * 기억이 수천 건 수준까지는 파일 하나에 담고 메모리에서 유사도를 계산해도 충분히 빠르다.
 * 더 커지면 이 파일만 다른 저장소 구현으로 바꾸면 된다.
 *
 * 쓰기는 임시 파일 + rename이고(ADR-021), 실행 중 저장은 비동기로 한 번에 하나씩 한다.
 * 저장을 기다리는 동안 들어온 요청은 다음 저장 한 번으로 묶는다.
 */
export function createMemoryStore(filePath: string, options: MemoryStoreOptions = {}) {
  const log = options.log ?? (message => console.log(`[bori-memory] ${message}`));
  const warn = options.warn ?? (message => console.warn(`[bori-memory] ${message}`));
  const writeOptions = options.rename ? { rename: options.rename } : {};
  let records: MemoryRecord[] = [];
  /**
   * 파일에 써도 되는지. 파일이 있는데 읽지 못했거나 원본을 남기지 못했으면 false다.
   * 그대로 쓰면 읽지 못한 기억을 빈 목록으로 덮어쓰게 된다.
   */
  let writable = true;
  /** 마지막으로 시작한 저장. 다음 저장은 이것이 끝난 뒤에 시작한다. */
  let writing: Promise<void> = Promise.resolve();
  /** 아직 시작하지 않은 다음 저장. 실패하면 onFailure를 차례로 부른 뒤 예외를 넘긴다. */
  let queued: { promise: Promise<void>; onFailure: (() => void)[] } | null = null;

  /**
   * 원본을 unreadable 백업으로 남긴다. 남기지 못하면 이번 실행 동안 파일에 쓰지 않는다.
   * 경고에는 이유와 백업 이름만 넣는다. 기억 문장은 넣지 않는다.
   */
  function preserveOriginal(reason: string) {
    try {
      warn(`${reason} 원본: ${basename(backupFile(filePath, "unreadable"))}`);
    } catch (error) {
      writable = false;
      warn(`${reason} 원본을 남기지 못해 이번 실행에서는 기억 파일에 쓰지 않습니다. (${errorCode(error)})`);
    }
  }

  /**
   * 파일을 읽는다. 예전 형식이면 원본을 백업한 뒤 지금 형식으로 바꿔 다시 쓴다.
   * 소유자를 알 수 없는 기억은 이때 지운다. 지운 내용은 백업 파일에만 남는다.
   * 읽지 못한 파일, 형식이 틀린 레코드, 모르는 버전은 원본을 unreadable 백업으로 남긴 뒤 읽을 수 있는 것만 쓴다.
   * 파일에 쓰다 실패해도 서버 시작을 막지 않는다. 경고만 남기고 다음 저장 때 다시 쓴다.
   */
  function load() {
    records = [];
    writable = true;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      // 파일이 없으면 빈 상태로 시작한다. 아무것도 쓰지 않는다.
      if (isMissingFileError(error)) return 0;
      // 있는데 못 읽었다(잠김·권한·크기). 파일은 멀쩡할 수 있으므로 덮어쓰지 않는다.
      writable = false;
      warn(`기억 파일을 읽지 못했습니다. 이번 실행에서는 기억 파일에 쓰지 않습니다. (${errorCode(error)})`);
      return 0;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const file = parsed as { version?: unknown; records?: unknown } | undefined;
    if (typeof file !== "object" || file === null || Array.isArray(file) || !Array.isArray(file.records)) {
      preserveOriginal("기억 파일을 읽지 못해 빈 상태로 시작합니다.");
      return 0;
    }

    const migration = migrateMemoryFile(file);
    records = migration.records;
    if (migration.unknownVersion) {
      preserveOriginal(`기억 파일의 버전(${JSON.stringify(file.version)})을 알 수 없습니다. 읽을 수 있는 기억 ${records.length}건만 씁니다.`);
    } else if (migration.invalid > 0) {
      preserveOriginal(`형식이 틀린 기억 ${migration.invalid}건을 버립니다.`);
    }
    if (migration.migrated && writable) {
      try {
        const backupPath = backupFile(filePath, "v1-backup");
        writeNow();
        log(`기억 파일을 버전 ${MEMORY_FILE_VERSION}으로 옮김: 변환 ${migration.converted}건, 소유자 불명 삭제 ${migration.deleted}건, 백업 ${basename(backupPath)}`);
      } catch (error) {
        // 원본을 남기지 못했으면 옮긴 결과로 덮어쓰지 않는다. 소유자 불명으로 지운 기억이 백업에도 없게 된다.
        writable = false;
        warn(`예전 형식 기억 파일의 원본을 남기지 못해 이번 실행에서는 기억 파일에 쓰지 않습니다. (${errorCode(error)})`);
      }
    }

    const removed = dropExpired();
    if (removed > 0) writeNow();
    return removed;
  }

  /** 서버 시작 때 쓰는 동기 저장. 실패해도 예외를 넘기지 않는다. 메모리 상태는 다음 저장 때 다시 쓴다. */
  function writeNow() {
    if (!writable) return;
    try {
      writeFileAtomically(filePath, [...fileChunks(records)].join(""), writeOptions);
    } catch (error) {
      warn(`기억 파일을 저장하지 못했습니다. 다음 저장 때 다시 씁니다. (${errorCode(error)})`);
    }
  }

  /**
   * 지금 메모리 상태를 파일에 쓴다. 쓰기가 실제로 시작할 때의 상태를 쓰므로, 그 전에 바뀐 것은 모두 담긴다.
   * onFailure는 이 쓰기가 실패하면 다음 쓰기가 시작하기 전에 불린다. 삭제를 되돌릴 때 쓴다.
   */
  function persist(onFailure?: () => void): Promise<void> {
    if (!writable) {
      onFailure?.();
      return Promise.reject(new Error("기억 파일을 읽지 못해 이번 실행에서는 저장하지 않습니다."));
    }
    if (!queued) {
      const batch: { promise: Promise<void>; onFailure: (() => void)[] } = { promise: Promise.resolve(), onFailure: [] };
      batch.promise = writing.catch(() => {}).then(async () => {
        if (queued === batch) queued = null;
        try {
          await writeFileAtomicallyAsync(filePath, fileChunks([...records]), writeOptions);
        } catch (error) {
          for (const undo of batch.onFailure) undo();
          throw error;
        }
      });
      queued = batch;
      writing = batch.promise;
    }
    if (onFailure) queued.onFailure.push(onFailure);
    return queued.promise;
  }

  /**
   * 지운 기억을 파일에 반영한다. 쓰기에 실패하면 지운 기억을 메모리에 되돌리고 예외를 넘긴다.
   * 되돌리지 않으면 화면에는 지워진 것으로 보이다가 재시작하면 되살아난다.
   */
  async function commitRemoval(removed: readonly MemoryRecord[]) {
    if (removed.length === 0) return;
    await persist(() => {
      const present = new Set(records.map(record => record.id));
      records.push(...removed.filter(record => !present.has(record.id)));
    });
  }

  /** 만료된 기억을 메모리에서 지운다. 지운 건수를 돌려준다. */
  function dropExpired(): number {
    const now = Date.now();
    const before = records.length;
    records = records.filter(record => Date.parse(record.expiresAt) > now);
    return before - records.length;
  }

  /** 만료된 기억을 지운다. 계획서의 자동 만료다. 저장 실패는 경고만 남긴다. */
  function purgeExpired(): number {
    const removed = dropExpired();
    if (removed > 0) void persist().catch(error => warn(`만료 기억 정리를 저장하지 못했습니다. (${errorCode(error)})`));
    return removed;
  }

  /**
   * 후보를 기억으로 저장한다.
   * 같은 뜻의 기억이 이미 있으면 새로 만들지 않고 반복 횟수·수명·마지막 시각만 올린다.
   * 계획서의 "여러 방송에서 반복된 내용"을 중요하게 다루기 위한 처리다.
   *
   * 같은 뜻은 두 단계로 본다. 먼저 문자열 규칙으로, 남은 것은 임베딩이 있으면 유사도로 본다(similar.ts).
   * 비교 대상은 공개 범위·소유자·종류가 모두 같은 기억뿐이다. 다른 사람의 기억과는 뜻이 같아도 합치지 않는다.
   */
  async function add(candidates: readonly MemoryCandidate[], settings: MemorySettings, embedding: EmbeddingProvider | null, options: MemoryAddOptions = {}): Promise<number> {
    if (candidates.length === 0 || options.isStale?.()) return 0;

    const now = Date.now();
    const seenAt = new Date(now).toISOString();
    const expiresAt = new Date(now + settings.retentionDays * 86_400_000).toISOString();
    const fresh: MemoryRecord[] = [];

    // 공개 범위나 소유자가 다르면 같은 문장이라도 다른 기억이다. 합치면 남의 기억이 섞인다.
    const sameOwner = (record: MemoryRecord, other: Pick<MemoryRecord, "kind" | "scope" | "ownerId">) =>
      record.kind === other.kind && record.scope === other.scope && record.ownerId === other.ownerId;
    const repeat = (record: MemoryRecord) => {
      record.repeatCount += 1;
      record.importance = Math.min(1, record.importance + 0.1);
      record.expiresAt = expiresAt;
      record.lastSeenAt = seenAt;
    };

    for (const candidate of candidates) {
      const normalized = candidate.text.trim();
      if (normalized.length === 0) continue;

      // 같은 묶음 안에서 앞서 나온 후보와도 비교한다. 한 방송에서 같은 말을 두 번 해도 한 건이다.
      const existing = [...records, ...fresh].find(record => sameOwner(record, candidate) && (record.text === normalized || isSameMemoryText(record.text, normalized)));
      if (existing) {
        repeat(existing);
        continue;
      }

      fresh.push({
        id: randomUUID(),
        text: normalized,
        kind: candidate.kind,
        scope: candidate.scope,
        ...(candidate.ownerId ? { ownerId: candidate.ownerId } : {}),
        importance: candidate.importance,
        confidence: candidate.confidence,
        repeatCount: 1,
        createdAt: seenAt,
        expiresAt,
      });
    }

    // 임베딩은 있으면 좋고 없어도 저장은 된다. 검색 품질과 뜻 비교만 문자열 규칙으로 떨어진다.
    if (fresh.length > 0 && embedding?.isConfigured()) {
      try {
        const vectors = await embedding.embed(fresh.map(record => record.text));
        fresh.forEach((record, index) => { record.embedding = vectors[index]; });
      } catch {
        // 임베딩 실패는 저장을 막지 않는다.
      }
    }

    // isStale은 그 소유자의 기억을 지운 뒤에 true가 된다. 위에서 반복 횟수를 올린 기존 기억도 이미 목록에 없다.
    if (options.isStale?.()) return 0;

    // 문자열로 못 잡은 바꿔 쓰기를 임베딩으로 한 번 더 합친다. 임베딩이 없는 기억끼리는 비교하지 않는다.
    const kept: MemoryRecord[] = [];
    for (const record of fresh) {
      const vector = record.embedding;
      const match = vector && [...records, ...kept].find(other =>
        sameOwner(other, record)
        && other.embedding !== undefined
        && isSameMemoryEmbedding({ text: other.text, embedding: other.embedding }, { text: record.text, embedding: vector }));
      if (match) {
        repeat(match);
        continue;
      }
      kept.push(record);
    }

    records.push(...kept);
    await persist();
    return kept.length;
  }

  /**
   * 하이브리드 검색.
   * 임베딩이 있으면 유사도로 좁히고, 없으면 최근 것과 중요한 것을 우선한다.
   * 최종적으로 어떤 기억을 실제로 쓸지는 답변을 만드는 LLM이 프롬프트 안에서 판단한다.
   *
   * 접근 범위는 순위를 매기기 전에 먼저 거른다. 남의 기억은 점수를 받을 기회조차 없어야 한다.
   */
  async function search(query: string, settings: MemorySettings, embedding: EmbeddingProvider | null, access: MemoryAccess): Promise<MemorySearchHit[]> {
    const visible = records.filter(record => canAccessMemory(record, access));
    if (visible.length === 0) return [];

    let queryVector: number[] | null = null;
    if (embedding?.isConfigured()) {
      try {
        const [vector] = await embedding.embed([query]);
        queryVector = vector ?? null;
      } catch {
        queryVector = null;
      }
    }

    if (!queryVector) {
      // 임베딩을 못 쓰면 중요도와 최신순으로 대신한다.
      return visible
        .sort((a, b) => (b.importance - a.importance) || (Date.parse(b.createdAt) - Date.parse(a.createdAt)))
        .slice(0, settings.maxMemories)
        .map(record => ({ record, score: 0 }));
    }

    return visible
      .map(record => ({
        record,
        // 중요도를 약하게 섞어 같은 유사도면 중요한 기억이 먼저 오게 한다.
        score: record.embedding ? cosineSimilarity(queryVector, record.embedding) + record.importance * 0.05 : 0,
      }))
      .filter(hit => hit.score >= settings.minSimilarity)
      .sort((a, b) => b.score - a.score)
      .slice(0, settings.maxMemories);
  }

  return {
    load,
    /** 지금 상태를 파일에 쓴다. 쓰기가 끝나면 풀린다. */
    save: () => persist(),
    /** 진행 중인 저장이 모두 끝날 때까지 기다린다. 실패는 넘기지 않는다. 검사와 종료 때 쓴다. */
    flush: (): Promise<void> => writing.catch(() => {}),
    purgeExpired,
    add,
    search,
    all: () => [...records],
    count: () => records.length,
    /** 이전 실행이 남긴 임시 파일을 지운다. 사용자 데이터 삭제 때 함께 부른다. */
    removeLeftovers: () => removeLeftoverFiles(filePath, { unreadable: false }),
    /** 지우고 파일에 쓴다. 쓰기에 실패하면 지운 것을 되돌리고 예외를 넘긴다. */
    async remove(id: string): Promise<boolean> {
      const removed = records.filter(record => record.id === id);
      if (removed.length === 0) return false;
      records = records.filter(record => record.id !== id);
      await commitRemoval(removed);
      return true;
    },
    /** 한 소유자의 기억을 모두 지운다. 지운 건수를 돌려준다. 쓰기에 실패하면 되돌리고 예외를 넘긴다. */
    async removeByOwner(ownerId: string): Promise<number> {
      if (ownerId.length === 0) return 0;
      const removed = records.filter(record => record.ownerId === ownerId);
      records = records.filter(record => record.ownerId !== ownerId);
      await commitRemoval(removed);
      return removed.length;
    },
    /** 모두 지운다. 쓰기에 실패하면 되돌리고 예외를 넘긴다. */
    async clear(): Promise<void> {
      const removed = records;
      records = [];
      // 지울 것이 없어도 파일을 쓴다. 전체 삭제를 눌렀으면 파일도 비어 있어야 한다.
      if (removed.length === 0) { await persist(); return; }
      await commitRemoval(removed);
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
