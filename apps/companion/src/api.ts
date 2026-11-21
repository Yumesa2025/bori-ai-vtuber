/**
 * 대시보드 API 클라이언트. 형식은 packages/shared의 DashboardState(설계 4절)다.
 * 서버 경로: GET /api/dashboard, POST /api/er/refresh, POST /api/narration/replay, GET /api/tts/:id
 */
import type { DashboardState, Narration } from "@bori/shared";

/**
 * 화면에 보여 줄 오류 종류.
 * disconnected는 서버에 닿지 못한 경우다. 개발 서버 프록시가 서버를 못 찾으면 JSON이 아닌 5xx를 돌려주므로 이것도 포함한다.
 * timeout은 연결은 됐지만 응답(머리 또는 본문)이 시간 상한 안에 끝나지 않은 경우다(Codex C2 8절).
 */
export type ApiErrorKind = "disconnected" | "timeout" | "badRequest" | "notFound" | "conflict" | "server";

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
  timeout: "서버 응답이 늦어요. 잠시 뒤 다시 시도할게요.",
  badRequest: "요청을 처리할 수 없어요.",
  notFound: "아직 읽을 대사가 없어요.",
  conflict: "이미 처리 중이에요. 잠시 뒤 다시 눌러 주세요.",
  server: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
};

export function describeError(error: unknown): string {
  return error instanceof ApiError ? errorMessages[error.kind] : errorMessages.disconnected;
}

/**
 * 상태 받기가 실패했을 때 화면에 보일 것. 서버에 닿지 못했으면 연결 배너, 그 밖(시간 초과 포함)은 안내 문구다.
 * 어느 쪽이든 다음 폴링이 다시 시도한다.
 */
export function loadFailureView(error: unknown): { disconnected: boolean; notice: string | null } {
  const lost = !(error instanceof ApiError) || error.kind === "disconnected";
  return { disconnected: lost, notice: lost ? null : describeError(error) };
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

/** 요청 하나의 기본 시간 상한. 응답 머리뿐 아니라 본문을 다 읽을 때까지다. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** 다시 듣기 시간 상한. 사라진 음성을 서버가 줄마다 다시 만들 수 있어 길게 둔다. */
export const REPLAY_TIMEOUT_MS = 60_000;

export type RequestOptions = { method?: string; timeoutMs?: number };
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * fetch를 바꿔 끼울 수 있는 요청 함수를 만든다.
 * 시간 상한은 AbortController로 요청을 끊고, 바꿔 끼운 fetch·본문이 끊김을 무시해도 Promise.race로 반드시 끝낸다.
 */
export function createRequest(fetchFn: FetchFn) {
  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApiError("timeout", null, null));
      }, timeoutMs);
    });
    const attempt = (async () => {
      let response: Response;
      try {
        response = await fetchFn(path, { method: options.method ?? "GET", cache: "no-store", signal: controller.signal });
      } catch {
        throw new ApiError(controller.signal.aborted ? "timeout" : "disconnected", null, null);
      }
      return readResponse<T>(response);
    })();
    try {
      return await Promise.race([attempt, timedOut]);
    } finally {
      clearTimeout(timer);
      // 시간 상한에 진 쪽의 거절이 처리되지 않은 오류로 남지 않게 한다.
      attempt.catch(() => undefined);
    }
  };
}

const request = createRequest((input, init) => fetch(input, init));

export const api = {
  /** 대시보드 상태. 서버가 데이터가 오래됐다고 보면 이 요청에서 자동 갱신을 시작한다. */
  getDashboard: () => request<DashboardState>("/api/dashboard"),
  refresh: () => request<{ started: boolean }>("/api/er/refresh", { method: "POST" }),
  /** 최신 대사를 다시 받는다. 사라진 음성은 서버가 다시 만든다. */
  replayNarration: () => request<{ narration: Narration }>("/api/narration/replay", { method: "POST", timeoutMs: REPLAY_TIMEOUT_MS }).then(body => body.narration),
};
