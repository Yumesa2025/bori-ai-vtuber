import { resolve } from "node:path";
import { collectMeta, loadDictionary, lookupPlayer, type ErClient, type ErDictionary } from "@bori/er";
import type { ErCharacterStat, ErMetaBasis, ErPlayerReport, ShowConnections } from "@bori/shared";
import { createConfigFile } from "../config-file.js";

/**
 * 이터널리턴 데이터(캐릭터 사전·메타 집계)를 data/ 아래 파일로 두고 읽는다.
 * - 서버 시작 때 `er-dictionary.json`·`er-meta.json`이 있으면 읽는다. 없으면 missing이다.
 * - `/api/er/refresh`가 백그라운드로 사전과 메타를 다시 받아 두 파일에 원자적으로 쓴다(설정 파일 공통 방식).
 * - 갱신 중에는 전적 조회를 받지 않는다. 개인 키는 초당 1회라 갱신 요청 뒤에 줄을 서면 몇 분을 기다린다.
 * - 오류 메시지에는 키가 없다(@bori/er 클라이언트가 키·쿼리를 빼고 만든다).
 */

export type ErStatus = { basis: ErMetaBasis | null; refreshing: boolean; progress: number | null; lastError: string | null };

/** 이보다 오래된 메타는 stale로 보인다. 패치 주기(2주)보다 짧게 잡는다. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_COUNT = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 파일에서 읽은 사전. 모양이 틀리면 null(없는 것으로 본다). */
function asDictionary(value: Record<string, unknown> | null): ErDictionary | null {
  if (!value || !Array.isArray(value.characters) || typeof value.seasonId !== "number" || typeof value.seasonName !== "string" || !isRecord(value.weaponNames)) return null;
  const characters = value.characters.filter((entry): entry is ErDictionary["characters"][number] =>
    isRecord(entry) && typeof entry.code === "number" && typeof entry.name === "string" && Array.isArray(entry.weapons));
  return { characters, weaponNames: value.weaponNames as ErDictionary["weaponNames"], seasonId: value.seasonId, seasonName: value.seasonName };
}

function asMeta(value: Record<string, unknown> | null): { stats: ErCharacterStat[]; basis: ErMetaBasis } | null {
  if (!value || !Array.isArray(value.stats) || !isRecord(value.basis)) return null;
  const basis = value.basis;
  if (typeof basis.seasonName !== "string" || typeof basis.sampleGames !== "number" || typeof basis.collectedAt !== "string" || typeof basis.description !== "string") return null;
  const stats = value.stats.filter((entry): entry is ErCharacterStat =>
    isRecord(entry) && typeof entry.code === "number" && typeof entry.name === "string" && typeof entry.picks === "number"
    && typeof entry.pickRate === "number" && typeof entry.avgRank === "number" && typeof entry.top1Rate === "number" && typeof entry.mainWeapon === "string");
  return { stats, basis: basis as ErMetaBasis };
}

export function createErData(options: {
  dataDir: string;
  /** 키가 없으면 null. 갱신·전적 조회를 하지 않는다. */
  client: ErClient | null;
  rankers: number;
  gamesPerRanker: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const dictionaryFile = createConfigFile(resolve(options.dataDir, "er-dictionary.json"), "이터널리턴 사전");
  const metaFile = createConfigFile(resolve(options.dataDir, "er-meta.json"), "이터널리턴 메타");
  let dictionary: ErDictionary | null = null;
  let meta: { stats: ErCharacterStat[]; basis: ErMetaBasis } | null = null;
  let refreshing = false;
  let progress: number | null = null;
  let lastError: string | null = null;

  async function runRefresh(client: ErClient) {
    try {
      const nextDictionary = await loadDictionary(client);
      dictionaryFile.write(nextDictionary);
      dictionary = nextDictionary;
      const collected = await collectMeta(client, nextDictionary, {
        rankers: options.rankers,
        gamesPerRanker: options.gamesPerRanker,
        onProgress: (done, total) => { progress = total > 0 ? Math.min(1, done / total) : 0; },
      });
      metaFile.write(collected);
      meta = collected;
      lastError = null;
      console.log(`[bori-server] 이터널리턴 메타 갱신 완료 (${collected.basis.description})`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "이터널리턴 데이터를 받지 못했습니다.";
      console.error("[bori-server] 이터널리턴 메타 갱신 실패:", lastError);
    } finally {
      refreshing = false;
      progress = null;
    }
  }

  return {
    /** 파일에서 사전과 메타를 읽는다. 없거나 깨졌으면 없는 것으로 둔다. */
    load() {
      dictionary = asDictionary(dictionaryFile.read());
      meta = asMeta(metaFile.read());
    },
    dictionary: () => dictionary,
    stats: (): ErCharacterStat[] => meta?.stats ?? [],
    basis: () => meta?.basis ?? null,
    top5: (): ErCharacterStat[] => (meta?.stats ?? []).slice(0, TOP_COUNT),

    connection(): ShowConnections["er"] {
      if (refreshing) return "refreshing";
      if (!dictionary || !meta) return "missing";
      const collectedAt = Date.parse(meta.basis.collectedAt);
      return Number.isFinite(collectedAt) && now() - collectedAt < STALE_AFTER_MS ? "ready" : "stale";
    },

    status: (): ErStatus => ({ basis: meta?.basis ?? null, refreshing, progress, lastError }),

    /** 갱신을 시작한다. 이미 도는 중이거나 키가 없으면 false. */
    refresh(): boolean {
      if (refreshing) return false;
      if (!options.client) {
        lastError = "ER_API_KEY가 없어 이터널리턴 데이터를 받을 수 없습니다.";
        return false;
      }
      refreshing = true;
      progress = 0;
      void runRefresh(options.client);
      return true;
    },

    /** 키와 사전이 있고 갱신 중이 아니면 전적을 볼 수 있다. */
    available: () => options.client !== null && dictionary !== null && !refreshing,

    /** 없으면 null. 실패하면 throw. */
    lookupPlayer(nickname: string): Promise<ErPlayerReport | null> {
      if (!options.client || !dictionary) return Promise.reject(new Error("이터널리턴 데이터를 쓸 수 없습니다."));
      return lookupPlayer(options.client, dictionary, nickname);
    },
  };
}

export type ErData = ReturnType<typeof createErData>;
