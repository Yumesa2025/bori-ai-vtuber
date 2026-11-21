/**
 * 대시보드 API 클라이언트. 형식은 packages/shared의 DashboardState(설계 4절)다.
 * 서버 경로: GET /api/dashboard, POST /api/er/refresh, POST /api/narration/replay, GET /api/tts/:id
 */
import type { DashboardState, Narration } from "@bori/shared";

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
  disconnected: "서버에 연결할 수 없어요. 서버가 켜져 있는지 확인해 주세요.",
  badRequest: "요청을 처리할 수 없어요.",
  notFound: "아직 읽을 대사가 없어요.",
  conflict: "이미 처리 중이에요. 잠시 뒤 다시 눌러 주세요.",
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

async function request<T>(path: string, method = "GET"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, cache: "no-store" });
  } catch {
    throw new ApiError("disconnected", null, null);
  }
  return readResponse<T>(response);
}

export const api = {
  /** 대시보드 상태. 서버가 데이터가 오래됐다고 보면 이 요청에서 자동 갱신을 시작한다. */
  getDashboard: () => request<DashboardState>("/api/dashboard"),
  refresh: () => request<{ started: boolean }>("/api/er/refresh", "POST"),
  /** 최신 대사를 다시 받는다. 사라진 음성은 서버가 다시 만든다. */
  replayNarration: () => request<{ narration: Narration }>("/api/narration/replay", "POST").then(body => body.narration),
};
