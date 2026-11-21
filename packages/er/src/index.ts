/**
 * 이터널리턴 Open API 패키지. 클라이언트·캐릭터 사전·메타 집계·전적 조회.
 */
export { createErClient, ErApiError, type ErClient, type ErClientOptions } from "./client.js";
export { EARLY_ACCESS_SEASONS, loadDictionary, officialSeasonNumber, type ErDictionary } from "./dictionary.js";
export { collectMeta, type ErComboTally, type ErMetaCollection, type ErMetaCollectionBasis, type MetaProgress, type MetaSkip } from "./meta.js";
export { lookupPlayer, type ErPlayerLookup } from "./player.js";
