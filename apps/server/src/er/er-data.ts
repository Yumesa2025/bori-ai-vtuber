import { resolve } from "node:path";
import { collectMeta, loadDictionary, lookupPlayer, officialSeasonNumber, type ErClient, type ErDictionary, type ErMetaCollection, type ErPlayerLookup } from "@bori/er";
import type { ErConnection } from "@bori/shared";
import { createConfigFile } from "../config-file.js";
import { STALE_AFTER_MS } from "./auto-refresh.js";
import { COLLECTION_FORMAT, createErHistory, parseCollection } from "./history.js";

/**
 * 이터널리턴 데이터(캐릭터 사전·조합 집계)를 data/ 아래 파일로 두고 읽는다.
 * - 서버 시작 때 `er-dictionary.json`·`er-meta.json`이 있으면 읽는다. 없으면 missing이다.
 *   조합 집계가 없는 예전 형식 `er-meta.json`(stats만)은 없는 것으로 본다. 다음 갱신 때 새 형식으로 쓴다.
 * - 갱신(refresh)이 백그라운드로 사전과 집계를 다시 받아 원자적으로 쓰고(설정 파일 공통 방식),
 *   집계를 `er-history/`에도 하나 남긴다(최근 10개). 실패하면 지난 파일은 그대로다.
 * - 갱신 중에는 전적 조회를 받지 않는다. 개인 키는 초당 1회라 갱신 요청 뒤에 줄을 서면 몇 분을 기다린다.
 * - 오류 메시지에는 키가 없다(@bori/er 클라이언트가 키·쿼리를 빼고 만든다).
 */

/** 갱신 진행 상태. 대시보드 상태의 refresh 칸이 쓴다. */
export type ErStatus = { refreshing: boolean; progress: number | null; lastError: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 파일에 쓴 시즌 표기 방식. 이 표시가 없는 예전 사전은 API 번호 그대로("시즌 21")라 읽을 때 게임 번호("시즌 12")로 바꾼다.
 * 파일 내용은 고치지 않는다(다음 갱신 때 새 표기로 다시 쓴다).
 */
const SEASON_LABEL = "official";

/** 예전 파일의 "시즌 21"·"프리시즌 21"을 게임 번호로. 모르는 형식은 그대로 둔다. */
function legacySeasonName(name: string): string {
  const match = /^(프리시즌|시즌) (\d+)$/.exec(name);
  return match ? `${match[1]} ${officialSeasonNumber(Number(match[2]))}` : name;
}

/** 파일에서 읽은 사전. 모양이 틀리면 null(없는 것으로 본다). */
function asDictionary(value: Record<string, unknown> | null): ErDictionary | null {
  if (!value || !Array.isArray(value.characters) || typeof value.seasonId !== "number" || typeof value.seasonName !== "string" || !isRecord(value.weaponNames)) return null;
  const characters = value.characters.filter((entry): entry is ErDictionary["characters"][number] =>
    isRecord(entry) && typeof entry.code === "number" && typeof entry.name === "string" && Array.isArray(entry.weapons));
  const seasonName = value.seasonLabel === SEASON_LABEL ? value.seasonName : legacySeasonName(value.seasonName);
  // 장비·특성 이름과 시즌 끝 시각이 없는 예전 파일은 빈 값으로 둔다(다음 갱신 때 채운다)
  return {
    characters,
    weaponNames: value.weaponNames as ErDictionary["weaponNames"],
    itemNames: isRecord(value.itemNames) ? value.itemNames as ErDictionary["itemNames"] : {},
    traitNames: isRecord(value.traitNames) ? value.traitNames as ErDictionary["traitNames"] : {},
    seasonId: value.seasonId,
    seasonName,
    seasonEnd: typeof value.seasonEnd === "string" ? value.seasonEnd : null,
  };
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
  const history = createErHistory({ dir: resolve(options.dataDir, "er-history") });
  const refreshedListeners = new Set<() => void>();
  let dictionary: ErDictionary | null = null;
  let meta: ErMetaCollection | null = null;
  /** history에서 찾은 직전 집계 */
  let previous: ErMetaCollection | null = null;
  let refreshing = false;
  let progress: number | null = null;
  let lastError: string | null = null;

  const findPrevious = (current: ErMetaCollection | null) => (current ? history.previous(current.basis.collectedAt) : null);

  async function runRefresh(client: ErClient) {
    let succeeded = false;
    try {
      const nextDictionary = await loadDictionary(client);
      dictionaryFile.write({ ...nextDictionary, seasonLabel: SEASON_LABEL });
      dictionary = nextDictionary;
      const collected = await collectMeta(client, nextDictionary, {
        rankers: options.rankers,
        gamesPerRanker: options.gamesPerRanker,
        now,
        onProgress: (done, total) => { progress = total > 0 ? Math.min(1, done / total) : 0; },
      });
      metaFile.write({ format: COLLECTION_FORMAT, ...collected, seasonLabel: SEASON_LABEL });
      meta = collected;
      try {
        history.save(collected);
      } catch (error) {
        // 기록을 못 남겨도 이번 집계는 쓴다. 다음 비교에서 이번 것이 빠질 뿐이다.
        console.warn("[bori-server] 이터널리턴 집계 기록을 남기지 못했습니다:", error instanceof Error ? error.message : "알 수 없는 오류");
      }
      previous = findPrevious(collected);
      lastError = null;
      succeeded = true;
      console.log(`[bori-server] 이터널리턴 메타 갱신 완료 (경기 ${collected.basis.games}판, 참가자 ${collected.basis.participants}명, 조합 ${collected.combos.length}개)`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "이터널리턴 데이터를 받지 못했습니다.";
      console.error("[bori-server] 이터널리턴 메타 갱신 실패:", lastError);
    } finally {
      refreshing = false;
      progress = null;
    }
    if (succeeded) {
      for (const listener of refreshedListeners) {
        try {
          listener();
        } catch (error) {
          console.error("[bori-server] 이터널리턴 갱신 알림 처리 실패:", error instanceof Error ? error.message : "알 수 없는 오류");
        }
      }
    }
  }

  /** 대시보드 내 전적 재료. 없으면 null. 실패하면 throw. */
  function lookupPlayerSummary(nickname: string): Promise<ErPlayerLookup | null> {
    if (!options.client || !dictionary) return Promise.reject(new Error("이터널리턴 데이터를 쓸 수 없습니다."));
    return lookupPlayer(options.client, dictionary, nickname);
  }

  return {
    /** 파일에서 사전·집계·직전 집계를 읽는다. 없거나 깨졌으면 없는 것으로 둔다. */
    load() {
      dictionary = asDictionary(dictionaryFile.read());
      meta = parseCollection(metaFile.read());
      previous = findPrevious(meta);
    },
    dictionary: () => dictionary,
    /** 최신 조합 집계(원래 개수) */
    meta: () => meta,
    /** 직전 갱신의 조합 집계. 없으면 null */
    previousMeta: () => previous,
    hasClient: () => options.client !== null,

    connection(): ErConnection {
      if (refreshing) return "refreshing";
      if (!dictionary || !meta) return "missing";
      const collectedAt = Date.parse(meta.basis.collectedAt);
      return Number.isFinite(collectedAt) && now() - collectedAt <= STALE_AFTER_MS ? "ready" : "stale";
    },

    status: (): ErStatus => ({ refreshing, progress, lastError }),

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

    /** 갱신이 성공해 새 집계를 쓴 뒤 부른다. 돌려준 함수로 그만 듣는다. */
    onRefreshed(listener: () => void): () => void {
      refreshedListeners.add(listener);
      return () => { refreshedListeners.delete(listener); };
    },

    /** 키와 사전이 있고 갱신 중이 아니면 전적을 볼 수 있다. */
    available: () => options.client !== null && dictionary !== null && !refreshing,

    lookupPlayerSummary,
  };
}

export type ErData = ReturnType<typeof createErData>;
