import type { IncomingMessage, ServerResponse } from "node:http";
import { boriName, boriPersonaLines, conversationPolicies } from "@bori/character";
import { boriEmotionNames, boriExpressionNames, boriMotionDescriptions, boriMotionGroupNames } from "@bori/live2d";
import type { CharacterCatalog, CharacterProfile } from "@bori/shared";
import { readBodyText } from "./body.js";
import type { CompanionService } from "./service.js";
import type { ConversationStore } from "./store.js";

/** 메시지 최대 길이(글자). */
export const MESSAGE_MAX_LENGTH = 500;
/** 대화 제목 최대 길이(글자). 넘으면 잘라서 저장한다. */
const TITLE_MAX_LENGTH = 60;
const DEFAULT_TITLE = "새 대화";

type Handler = (request: IncomingMessage, response: ServerResponse) => boolean;

export type CompanionRouteDeps = {
  service: CompanionService;
  store: ConversationStore;
  /** 요청한 사용자. 지금은 로컬 단일 사용자라 서버가 고정값을 준다. 클라이언트가 정할 수 없다. */
  ownerOf: (request: IncomingMessage) => string;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/**
 * 본문을 JSON 객체로 읽는다. 비어 있으면 빈 객체로 본다.
 * 본문이 너무 커서 이미 413으로 답했으면 null이다. 호출하는 쪽은 바로 끝낸다.
 */
async function readJsonObject(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBodyText(request, response);
  if (raw === null) return null;
  if (raw.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "Invalid JSON");
  return parsed as Record<string, unknown>;
}

/** 글자 수. 한글 한 글자도, 이모지 하나도 한 글자로 센다. */
const lengthOf = (text: string) => Array.from(text).length;

function decodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // 풀 수 없는 ID는 어떤 대화와도 맞지 않는다.
    return "";
  }
}

/** 공개해도 되는 캐릭터 정보. 시스템 프롬프트 전체·역할 범위·대화 규칙은 내보내지 않는다. */
function characterProfile(): CharacterProfile {
  return {
    name: boriName,
    // 프롬프트용 목록 기호("- ")는 화면에 필요 없으므로 뗀다.
    personaLines: boriPersonaLines.map(line => line.replace(/^-\s*/, "")),
    companionPolicyTitle: conversationPolicies.companion.title,
  };
}

function characterCatalog(): CharacterCatalog {
  return {
    emotions: [...boriEmotionNames],
    expressions: [...boriExpressionNames],
    motions: boriMotionGroupNames.map(name => ({ name, description: boriMotionDescriptions[name] })),
  };
}

/**
 * 1:1 대화 API.
 * 처리한 경로면 true를 돌려준다. 응답은 비동기로 보내지만 어느 경로인지는 바로 판단한다.
 * 방송 상태·큐·방송 세션에는 닿지 않는다.
 */
export function createCompanionRoutes(deps: CompanionRouteDeps): Handler {
  const { service, store } = deps;

  async function route(request: IncomingMessage, response: ServerResponse, segments: string[]) {
    const method = request.method ?? "GET";
    const ownerId = deps.ownerOf(request);
    const [, resource, id, sub] = segments;

    if (resource === "conversations") {
      // /api/conversations
      if (segments.length === 2) {
        if (method === "GET") { sendJson(response, 200, { conversations: store.list(ownerId) }); return; }
        if (method === "POST") {
          const body = await readJsonObject(request, response);
          if (!body) return;
          if (body.title !== undefined && typeof body.title !== "string") throw new HttpError(400, "title은 문자열이어야 합니다.");
          const title = Array.from((body.title ?? "").trim()).slice(0, TITLE_MAX_LENGTH).join("");
          sendJson(response, 201, { conversation: store.create(ownerId, title.length > 0 ? title : DEFAULT_TITLE) });
          return;
        }
        throw new HttpError(405, "지원하지 않는 메서드입니다.");
      }

      const conversationId = decodeId(id);
      // /api/conversations/:id
      if (segments.length === 3) {
        if (method !== "DELETE") throw new HttpError(405, "지원하지 않는 메서드입니다.");
        if (!service.deleteConversation(ownerId, conversationId)) throw new HttpError(404, "대화를 찾을 수 없습니다.");
        sendJson(response, 200, { deleted: true });
        return;
      }

      // /api/conversations/:id/messages
      if (method === "GET") {
        const conversation = store.get(ownerId, conversationId);
        const messages = store.messages(ownerId, conversationId);
        if (!conversation || !messages) throw new HttpError(404, "대화를 찾을 수 없습니다.");
        sendJson(response, 200, { conversation, messages });
        return;
      }
      if (method !== "POST") throw new HttpError(405, "지원하지 않는 메서드입니다.");

      const body = await readJsonObject(request, response);
      if (!body) return;
      if (typeof body.content !== "string") throw new HttpError(400, "content는 문자열이어야 합니다.");
      if (body.tts !== undefined && typeof body.tts !== "boolean") throw new HttpError(400, "tts는 true 또는 false여야 합니다.");
      const content = body.content.trim();
      if (content.length === 0) throw new HttpError(400, "내용이 비어 있습니다.");
      if (lengthOf(content) > MESSAGE_MAX_LENGTH) throw new HttpError(400, `내용은 ${MESSAGE_MAX_LENGTH}자 이하여야 합니다.`);

      const outcome = await service.sendMessage(ownerId, conversationId, content, { tts: body.tts === true });
      if (outcome.kind === "not_found") throw new HttpError(404, "대화를 찾을 수 없습니다.");
      if (outcome.kind === "busy") throw new HttpError(409, "이 대화에 답변을 만드는 중입니다.");
      sendJson(response, 200, outcome.result);
      return;
    }

    if (resource === "me") {
      // /api/me/data: 1:1 대화·요약·세션·개인 기억을 한 번에 지운다. 방송 기억은 남는다.
      if (id === "data") {
        if (method !== "DELETE") throw new HttpError(405, "지원하지 않는 메서드입니다.");
        sendJson(response, 200, { deleted: service.clearAll(ownerId) });
        return;
      }
      // /api/me/memories
      if (segments.length === 3) {
        if (method === "GET") { sendJson(response, 200, { memories: service.listMemories(ownerId) }); return; }
        if (method === "DELETE") { sendJson(response, 200, { deleted: service.clearMemories(ownerId) }); return; }
        throw new HttpError(405, "지원하지 않는 메서드입니다.");
      }
      // /api/me/memories/:id
      if (method !== "DELETE") throw new HttpError(405, "지원하지 않는 메서드입니다.");
      if (!service.deleteMemory(ownerId, decodeId(sub))) throw new HttpError(404, "기억을 찾을 수 없습니다.");
      sendJson(response, 200, { deleted: true });
      return;
    }

    // /api/character/profile, /api/character/catalog
    if (method !== "GET") throw new HttpError(405, "지원하지 않는 메서드입니다.");
    sendJson(response, 200, id === "profile" ? characterProfile() : characterCatalog());
  }

  return (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const segments = pathname.split("/").filter(segment => segment.length > 0);
    if (!matches(segments)) return false;

    void route(request, response, segments).catch(error => {
      if (!(error instanceof HttpError)) console.error("[bori-companion] 요청 처리 실패:", error);
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error instanceof HttpError ? error.message : "요청을 처리하지 못했습니다." });
    });
    return true;
  };
}

/** 이 모듈이 맡는 경로인지. 메서드는 보지 않는다. 맞지 않는 메서드는 405로 답한다. */
function matches(segments: readonly string[]): boolean {
  if (segments[0] !== "api") return false;
  const [, resource, second, third] = segments;
  switch (resource) {
    case "conversations":
      return segments.length === 2 || segments.length === 3 || (segments.length === 4 && third === "messages");
    case "me":
      return (second === "memories" && (segments.length === 3 || segments.length === 4)) || (second === "data" && segments.length === 3);
    case "character":
      return segments.length === 3 && (second === "profile" || second === "catalog");
    default:
      return false;
  }
}
