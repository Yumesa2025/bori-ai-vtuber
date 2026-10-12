import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canAccessMemory } from "./access.js";
import { cosineSimilarity } from "./embedding.js";
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
};

/**
 * 장기 기억 저장소.
 * 기억이 수천 건 수준까지는 파일 하나에 담고 메모리에서 유사도를 계산해도 충분히 빠르다.
 * 더 커지면 이 파일만 다른 저장소 구현으로 바꾸면 된다.
 */
export function createMemoryStore(filePath: string, options: MemoryStoreOptions = {}) {
  const log = options.log ?? (message => console.log(`[bori-memory] ${message}`));
  let records: MemoryRecord[] = [];

  /**
   * 파일을 읽는다. 예전 형식이면 원본을 백업한 뒤 지금 형식으로 바꿔 다시 쓴다.
   * 소유자를 알 수 없는 기억은 이때 지운다. 지운 내용은 백업 파일에만 남는다.
   */
  function load() {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      // 파일이 없으면 빈 상태로 시작한다. 아무것도 쓰지 않는다.
      records = [];
      return 0;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      records = [];
      return 0;
    }

    const migration = migrateMemoryFile(parsed);
    records = migration.records;
    if (migration.migrated) {
      const backupPath = writeBackup(raw);
      save();
      log(`기억 파일을 버전 ${MEMORY_FILE_VERSION}으로 옮김: 변환 ${migration.converted}건, 소유자 불명 삭제 ${migration.deleted}건, 백업 ${basename(backupPath)}`);
    }
    return purgeExpired();
  }

  /** 옮기기 전 원본을 같은 디렉터리에 그대로 남긴다. 파일 이름에 콜론을 쓰지 않는다. */
  function writeBackup(raw: string): string {
    const stem = basename(filePath, extname(filePath));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupPath = join(dirname(filePath), `${stem}.v1-backup-${stamp}.json`);
    // 같은 밀리초에 두 번 옮기는 일은 드물지만, 있어도 이전 백업을 덮지 않는다.
    for (let suffix = 1; existsSync(backupPath); suffix += 1) {
      backupPath = join(dirname(filePath), `${stem}.v1-backup-${stamp}-${suffix}.json`);
    }
    writeFileSync(backupPath, raw, "utf8");
    return backupPath;
  }

  function save() {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: MEMORY_FILE_VERSION, records }, null, 2), "utf8");
  }

  /** 만료된 기억을 지운다. 계획서의 자동 만료다. */
  function purgeExpired(): number {
    const now = Date.now();
    const before = records.length;
    records = records.filter(record => new Date(record.expiresAt).getTime() > now);
    const removed = before - records.length;
    if (removed > 0) save();
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
    save();
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
    save,
    purgeExpired,
    add,
    search,
    all: () => [...records],
    count: () => records.length,
    remove(id: string): boolean {
      const before = records.length;
      records = records.filter(record => record.id !== id);
      if (records.length === before) return false;
      save();
      return true;
    },
    /** 한 소유자의 기억을 모두 지운다. 지운 건수를 돌려준다. */
    removeByOwner(ownerId: string): number {
      if (ownerId.length === 0) return 0;
      const before = records.length;
      records = records.filter(record => record.ownerId !== ownerId);
      const removed = before - records.length;
      if (removed > 0) save();
      return removed;
    },
    clear() {
      records = [];
      save();
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
