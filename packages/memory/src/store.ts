import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { cosineSimilarity } from "./embedding.js";
import type { EmbeddingProvider, MemoryCandidate, MemoryRecord, MemorySearchHit, MemorySettings } from "./types.js";

/**
 * 장기 기억 저장소.
 * 기억이 수천 건 수준까지는 파일 하나에 담고 메모리에서 유사도를 계산해도 충분히 빠르다.
 * 더 커지면 이 파일만 다른 저장소 구현으로 바꾸면 된다.
 */
export function createMemoryStore(filePath: string) {
  let records: MemoryRecord[] = [];

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { records?: MemoryRecord[] };
      records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      records = [];
    }
    return purgeExpired();
  }

  function save() {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ records }, null, 2), "utf8");
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
   * 같은 문장이 이미 있으면 새로 만들지 않고 반복 횟수와 수명을 올린다.
   * 계획서의 "여러 방송에서 반복된 내용"을 중요하게 다루기 위한 처리다.
   */
  async function add(candidates: readonly MemoryCandidate[], settings: MemorySettings, embedding: EmbeddingProvider | null): Promise<number> {
    if (candidates.length === 0) return 0;

    const now = Date.now();
    const expiresAt = new Date(now + settings.retentionDays * 86_400_000).toISOString();
    const fresh: MemoryRecord[] = [];

    for (const candidate of candidates) {
      const normalized = candidate.text.trim();
      if (normalized.length === 0) continue;

      const existing = records.find(record => record.text === normalized && record.kind === candidate.kind && record.viewerId === candidate.viewerId);
      if (existing) {
        existing.repeatCount += 1;
        existing.importance = Math.min(1, existing.importance + 0.1);
        existing.expiresAt = expiresAt;
        continue;
      }

      fresh.push({
        id: randomUUID(),
        text: normalized,
        kind: candidate.kind,
        ...(candidate.viewerId ? { viewerId: candidate.viewerId } : {}),
        importance: candidate.importance,
        confidence: candidate.confidence,
        repeatCount: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt,
      });
    }

    // 임베딩은 있으면 좋고 없어도 저장은 된다. 검색 품질만 떨어진다.
    if (fresh.length > 0 && embedding?.isConfigured()) {
      try {
        const vectors = await embedding.embed(fresh.map(record => record.text));
        fresh.forEach((record, index) => { record.embedding = vectors[index]; });
      } catch {
        // 임베딩 실패는 저장을 막지 않는다.
      }
    }

    records.push(...fresh);
    save();
    return fresh.length;
  }

  /**
   * 하이브리드 검색.
   * 임베딩이 있으면 유사도로 좁히고, 없으면 최근 것과 중요한 것을 우선한다.
   * 최종적으로 어떤 기억을 실제로 쓸지는 답변을 만드는 LLM이 프롬프트 안에서 판단한다.
   */
  async function search(query: string, settings: MemorySettings, embedding: EmbeddingProvider | null): Promise<MemorySearchHit[]> {
    if (records.length === 0) return [];

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
      return [...records]
        .sort((a, b) => (b.importance - a.importance) || (Date.parse(b.createdAt) - Date.parse(a.createdAt)))
        .slice(0, settings.maxMemories)
        .map(record => ({ record, score: 0 }));
    }

    return records
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
    clear() {
      records = [];
      save();
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
