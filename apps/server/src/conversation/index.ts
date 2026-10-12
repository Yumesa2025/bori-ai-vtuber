/**
 * 공통 대화 엔진. 방송과 1:1 대화가 같은 응답 경로를 쓰고, 대화 상태는 세션마다 따로 둔다.
 * 큐·발화권·타이머·방송 상태처럼 방송에만 있는 것은 여기서 알지 못한다.
 */
export {
  createConversationEngine,
  MEMORY_SEARCH_TIMEOUT_MS,
  memoryAccessFor,
  type ConversationEngine,
  type ConversationEngineDeps,
  type LlmClient,
  type RespondFailure,
  type RespondInput,
  type RespondResult,
  type Speaker,
} from "./engine.js";
export { RECENT_TURN_LIMIT, type ConversationSession, type SessionTurn, type Turn } from "./session.js";
export { MACRO_ACTIVE_LIMIT } from "./macros.js";
export { bodyAction, isQuestion, isUnsafeContent, pickNextChatIndex, QUEUE_WAIT_LIMIT_MS } from "./rules.js";
export { createModeLlmClients, type ModeLlmClients } from "./llm-clients.js";
