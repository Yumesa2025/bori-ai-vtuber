import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ErComboTally, ErMetaCollection, ErMetaCollectionBasis } from "@bori/er";
import { createConfigFile } from "../config-file.js";

/**
 * ER 집계 history. `data/er-history/<collectedAt>.json`에 갱신마다 하나씩 쓰고 최근 keep(기본 10)개만 남긴다.
 * - 직전 갱신과 비교할 때 쓴다(비교 키는 캐릭터 code + 무기 code, combos.ts).
 * - 쓰기는 설정 파일 공통 방식(createConfigFile, 원자적). 오래된 파일 지우기·목록은 node:fs.
 * - 이름 규칙에 맞는 파일만 세고 지운다. 사람이 둔 파일이나 예전에 남긴 원본 보존본은 건드리지 않는다.
 * - 깨진 기록 파일은 읽을 때 건너뛰고 경고만 한 번 남긴다. 설정 파일처럼 사본을 남기면 읽을 때마다 사본이 쌓인다
 *   (기록은 다시 쓰지 않는 파일이라 원본이 그대로 남고, 오래되면 keep 정리로 지워진다).
 */

/** 집계 파일 형식 번호. er-meta.json과 history 파일이 같은 모양이다. */
export const COLLECTION_FORMAT = 2;
const DEFAULT_KEEP = 10;
const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(\.\d+)?Z\.json$/;

/** "2026-11-21T03:04:05.678Z" → "2026-11-21T03-04-05.678Z.json". Windows 파일 이름에 :를 못 쓴다. 이름순 = 시각순. */
export const historyFileName = (collectedAt: string) => `${collectedAt.replace(/:/g, "-")}.json`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function asCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => isNumber(entry[1])));
}

function asTally(value: unknown): ErComboTally | null {
  if (!isRecord(value)) return null;
  const numbers = ["characterCode", "weaponCode", "participants", "rankSum", "top1", "mmrGainSum", "mmrGainSamples", "kills", "assists", "deaths", "damage"] as const;
  if (!numbers.every((key) => isNumber(value[key]))) return null;
  const equipment = isRecord(value.equipment)
    ? Object.fromEntries(Object.entries(value.equipment).map(([slot, counts]) => [slot, asCounts(counts)]))
    : {};
  return { ...(Object.fromEntries(numbers.map((key) => [key, value[key]])) as Omit<ErComboTally, "traits" | "equipment">), traits: asCounts(value.traits), equipment };
}

function asBasis(value: unknown): ErMetaCollectionBasis | null {
  if (!isRecord(value)) return null;
  const { seasonId, seasonName, patch, games, participants, rankers, gamesPerRanker, collectedAt } = value;
  if (!isNumber(seasonId) || typeof seasonName !== "string" || !(patch === null || typeof patch === "string")) return null;
  if (!isNumber(games) || !isNumber(participants) || !isNumber(rankers) || !isNumber(gamesPerRanker)) return null;
  if (typeof collectedAt !== "string" || !Number.isFinite(Date.parse(collectedAt))) return null;
  return { seasonId, seasonName, patch, games, participants, rankers, gamesPerRanker, collectedAt };
}

/** 파일에서 읽은 집계. 모양이 틀리면 null(예전 stats 형식도 null). 틀린 조합 행 하나는 버린다. */
export function parseCollection(value: unknown): ErMetaCollection | null {
  if (!isRecord(value) || !Array.isArray(value.combos)) return null;
  const basis = asBasis(value.basis);
  if (!basis) return null;
  return { combos: value.combos.map(asTally).filter((tally): tally is ErComboTally => tally !== null), basis };
}

export function createErHistory(options: { dir: string; keep?: number; warn?: (message: string) => void }) {
  const keep = options.keep ?? DEFAULT_KEEP;
  const file = (name: string) => createConfigFile(join(options.dir, name), "이터널리턴 집계 기록", options.warn);
  const warn = options.warn ?? ((message: string) => console.warn(`[bori-server] ${message}`));
  /** 이미 경고한 깨진 파일 이름. 같은 파일로 경고를 되풀이하지 않는다. */
  const warned = new Set<string>();

  /** 기록 파일 하나를 읽는다. 없거나 깨졌으면 null(사본은 만들지 않는다). */
  function readEntry(name: string): ErMetaCollection | null {
    let parsed: ErMetaCollection | null = null;
    let reason: string | null = null;
    try {
      parsed = parseCollection(JSON.parse(readFileSync(join(options.dir, name), "utf8")) as unknown);
      if (!parsed) reason = "모양이 틀린";
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      reason = "읽지 못한";
    }
    if (reason && !warned.has(name)) {
      warned.add(name);
      warn(`${reason} 이터널리턴 집계 기록을 건너뜁니다: ${name}`);
    }
    return parsed;
  }

  /** 이름 규칙에 맞는 파일, 오래된 것부터. 폴더가 없으면 빈 목록. */
  function names(): string[] {
    try {
      return readdirSync(options.dir).filter((name) => FILE_PATTERN.test(name)).sort();
    } catch {
      return [];
    }
  }

  return {
    names,

    /** 집계 하나를 쓰고 오래된 것을 지워 keep개만 남긴다. 쓰기가 실패하면 예외를 넘긴다(지난 파일은 그대로). */
    save(collection: ErMetaCollection) {
      mkdirSync(options.dir, { recursive: true });
      const written = historyFileName(collection.basis.collectedAt);
      file(written).write({ format: COLLECTION_FORMAT, ...collection });
      // 방금 쓴 파일은 남긴다(시계가 뒤로 가 이름순으로 가장 오래돼도 지우지 않는다)
      const all = names();
      const victims = all.filter((name) => name !== written).slice(0, Math.max(0, all.length - keep));
      for (const name of victims) rmSync(join(options.dir, name), { force: true });
    },

    /** collectedAt보다 이른 것 중 가장 최근 집계. 없으면 null. 깨진 파일은 건너뛴다. */
    previous(collectedAt: string): ErMetaCollection | null {
      const limit = historyFileName(collectedAt);
      for (const name of names().filter((entry) => entry < limit).reverse()) {
        const parsed = readEntry(name);
        if (parsed) return parsed;
      }
      return null;
    },
  };
}

export type ErHistory = ReturnType<typeof createErHistory>;
