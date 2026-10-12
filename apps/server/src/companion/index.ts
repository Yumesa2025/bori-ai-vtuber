/**
 * 1:1 대화(companion). 방송과 같은 대화 엔진을 쓰되 대화 기록·세션·개인 기억은 방송과 나눈다.
 * 방송 상태·큐·방송 세션은 이 모듈에 넘기지 않는다.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCompanionRoutes } from "./routes.js";
import { createCompanionService, type CompanionServiceDeps } from "./service.js";
import { createConversationStore } from "./store.js";

/**
 * 로컬 단일 사용자의 고정 소유자 ID. 클라이언트가 바꿀 수 없다.
 * 방송 시청자 ID(local:닉네임 등)와 겹치지 않도록 companion: 접두사를 쓴다.
 * 인증이 붙으면 요청에서 사용자를 정하도록 ownerOf만 바꾼다.
 */
export const COMPANION_LOCAL_OWNER = "companion:local";

export type CompanionOptions = Omit<CompanionServiceDeps, "store"> & {
  /** 대화 파일 경로. */
  filePath: string;
};

/** 저장소를 읽고 라우트 처리기를 돌려준다. 처리한 경로면 true다. */
export function createCompanionHandler(options: CompanionOptions): (request: IncomingMessage, response: ServerResponse) => boolean {
  const { filePath, ...deps } = options;
  const store = createConversationStore(filePath);
  store.load();
  console.log(`[bori-server] 1:1 대화 ${store.list(COMPANION_LOCAL_OWNER).length}건 불러옴`);

  const service = createCompanionService({ ...deps, store });
  return createCompanionRoutes({ service, store, ownerOf: () => COMPANION_LOCAL_OWNER });
}

export { createConversationStore, CONVERSATION_FILE_VERSION, type ConversationStore } from "./store.js";
export { createCompanionService, type CompanionService, type CompanionServiceDeps } from "./service.js";
export { createCompanionRoutes, MESSAGE_MAX_LENGTH } from "./routes.js";
