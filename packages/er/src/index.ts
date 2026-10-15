/**
 * 이터널리턴 Open API 패키지. 클라이언트·캐릭터 사전·메타 집계·전적 진단·닉네임 가림.
 */
export { createErClient, ErApiError, type ErClient, type ErClientOptions } from "./client.js";
export { EARLY_ACCESS_SEASONS, findCharacter, loadDictionary, officialSeasonNumber, type ErDictionary } from "./dictionary.js";
export { collectMeta, type MetaProgress } from "./meta.js";
export { lookupPlayer } from "./player.js";
export { maskNickname } from "./mask.js";
