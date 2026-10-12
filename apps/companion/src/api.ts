/**
 * 1:1 대화 API 클라이언트.
 * 타입은 세 워커가 함께 정한 API 계약을 그대로 옮긴 것이다. 서버 타입이 공용 패키지로 나오면 그쪽으로 바꾼다.
 * 소유자는 서버가 정하므로 클라이언트는 사용자 ID를 보내지 않는다.
 */

export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number };

/** 1:1 기록 모두 지우기(DELETE /api/me/data)로 지운 개수. */
export type ClearedData = { conversations: number; messages: number; memories: number };

export type MessageEmotion = { primary: string; intensity: number; durationSeconds: number };
export type MessageAction = { name: string; layer: string; priority: number };
export type MessageSource = "llm" | "rule" | "fallback" | "blocked";

export type Message = {
  id: string;
  role: "user" | "bori";
  content: string;
  createdAt: string;
  // 아래 세 값은 role이 bori일 때만 온다.
  emotion?: MessageEmotion;
  actions?: MessageAction[];
  source?: MessageSource;
};

export type SendResult = { userMessage: Message; reply: Message; audioId?: string; failure?: { kind: string } };
export type Memory = { id: string; text: string; createdAt: string; expiresAt: string | null };
export type CharacterProfile = { name: string; personaLines: string[]; companionPolicyTitle: string };

/** 서버가 받는 메시지 최대 길이. 넘기면 400이므로 입력창에서 먼저 막는다. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * 화면에 보여 줄 오류 종류.
 * disconnected는 서버에 닿지 못한 경우다. 개발 서버 프록시가 서버를 못 찾으면 JSON이 아닌 5xx를 돌려주므로 이것도 포함한다.
 */
export type ApiErrorKind = "disconnected" | "badRequest" | "notFound" | "conflict" | "server";

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, readonly status: number | null, readonly serverMessage: string | null) {
    super(serverMessage ?? kind);
  }
}

export function errorKindForStatus(status: number): ApiErrorKind {
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "badRequest";
  return "server";
}

/** 오류 종류별 안내 문구. 서버 원문은 개발자용이라 그대로 보여 주지 않는다. */
export const errorMessages: Record<ApiErrorKind, string> = {
  disconnected: "서버에 연결할 수 없어요. 서버가 켜져 있는지 확인한 뒤 다시 시도해 주세요.",
  badRequest: "보낼 수 없는 내용이에요. 비어 있거나 500자를 넘지 않았는지 확인해 주세요.",
  notFound: "대화를 찾을 수 없어요. 이미 삭제되었을 수 있어요.",
  conflict: "보리가 아직 앞 메시지에 답하는 중이에요. 답변이 끝난 뒤 다시 보내 주세요.",
  server: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
};

export function describeError(error: unknown): string {
  return error instanceof ApiError ? errorMessages[error.kind] : errorMessages.disconnected;
}

/** 응답을 계약 형태로 풀거나 ApiError로 바꾼다. fetch를 바꿔 끼워 검사할 수 있게 응답만 받는다. */
export async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (response.ok) {
    if (body === null) throw new ApiError("server", response.status, "응답이 JSON이 아닙니다.");
    return body as T;
  }

  const serverMessage = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : null;
  // 서버는 오류도 항상 { error } JSON으로 준다. JSON이 아닌 5xx는 프록시가 서버를 못 찾은 경우다.
  if (response.status >= 500 && serverMessage === null) throw new ApiError("disconnected", response.status, null);
  throw new ApiError(errorKindForStatus(response.status), response.status, serverMessage);
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("disconnected", null, null);
  }
  return readResponse<T>(response);
}

const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export const api = {
  listConversations: () => request<{ conversations: Conversation[] }>("/api/conversations").then(body => body.conversations),
  createConversation: (title?: string) =>
    request<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: title ? { title } : {} }).then(body => body.conversation),
  getMessages: (id: string) => request<{ conversation: Conversation; messages: Message[] }>(`${conversationPath(id)}/messages`),
  sendMessage: (id: string, content: string, tts: boolean) =>
    request<SendResult>(`${conversationPath(id)}/messages`, { method: "POST", body: { content, tts } }),
  deleteConversation: (id: string) => request<{ deleted: true }>(conversationPath(id), { method: "DELETE" }),
  listMemories: () => request<{ memories: Memory[] }>("/api/me/memories").then(body => body.memories),
  deleteMemory: (id: string) => request<{ deleted: true }>(`/api/me/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteAllMemories: () => request<{ deleted: number }>("/api/me/memories", { method: "DELETE" }).then(body => body.deleted),
  /** 1:1 대화·메시지·대화 요약·기억을 모두 지운다. 방송 기록은 남는다. */
  deleteAllData: () => request<{ deleted: ClearedData }>("/api/me/data", { method: "DELETE" }).then(body => body.deleted),
  getProfile: () => request<CharacterProfile>("/api/character/profile"),
};
