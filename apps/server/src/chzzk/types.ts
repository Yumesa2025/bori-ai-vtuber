/**
 * 치지직 연동 공통 타입과 응답 읽기.
 * 형식은 공식 문서(chzzk.gitbook.io/chzzk)의 Authorization·Session·참고사항 페이지를 따른다(2026-10-15 열람).
 */

/** Open API 도메인(참고사항). */
export const DEFAULT_CHZZK_BASE_URL = "https://openapi.chzzk.naver.com";

/** 받은 채팅 하나. 닉네임은 화면·기억에 쓸지 받는 쪽(W4)이 정한다. */
export type ChzzkChat = {
  senderChannelId: string;
  nickname: string;
  content: string;
  /** 서버가 받은 시각(ISO). 치지직 messageTime이 아니다. */
  receivedAt: string;
  role: "streamer" | "common_user" | "streaming_channel_manager" | "streaming_chat_manager" | string;
};

export type ChzzkTokens = { accessToken: string; refreshToken: string; expiresAt: number };

export type ChzzkChatConnection = {
  status(): "off" | "connecting" | "connected" | "error";
  lastError(): string | null;
  stop(): void;
};

/**
 * 치지직 API가 실패로 답했다. 메시지에는 HTTP 상태와 치지직 오류 이름(INVALID_TOKEN 같은 대문자 이름)만 넣는다.
 * 응답 본문·요청 값(코드·토큰·secret)은 넣지 않는다.
 */
export class ChzzkApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(action: string, status: number, code: string | null) {
    super(`치지직 ${action} 요청이 실패했습니다. (HTTP ${status}${code ? ` ${code}` : ""})`);
    this.name = "ChzzkApiError";
    this.status = status;
    this.code = code;
  }
}

/** 저장된 토큰이 없거나 더 쓸 수 없다. 사용자가 치지직 로그인을 다시 해야 한다. */
export class ChzzkLoginRequiredError extends Error {
  constructor() {
    super("치지직에 다시 연결해야 합니다.");
    this.name = "ChzzkLoginRequiredError";
  }
}

/** 오류 이름으로 보이는 값만 남긴다. 치지직이 메시지에 다른 내용을 담아도 그대로 옮기지 않는다. */
const errorCodeOf = (message: unknown) => (typeof message === "string" && /^[A-Z_]{1,40}$/.test(message) ? message : null);

/**
 * 공통 응답 구조 `{ code, message, content }`에서 content를 꺼낸다(참고사항).
 * 실패 응답이면 ChzzkApiError를 던진다. 네트워크 오류도 원문 메시지를 버리고 같은 형식으로 바꾼다.
 */
export async function requestChzzk(action: string, send: () => Promise<Response>): Promise<unknown> {
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    // fetch 오류 메시지에 요청 주소·값이 섞일 수 있어 이름만 남긴다.
    const reason = error instanceof Error && error.name === "TimeoutError" ? "시간 초과" : "네트워크 오류";
    throw new Error(`치지직 ${action} 요청을 보내지 못했습니다. (${reason})`);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // 아래에서 상태 코드로 판단한다.
  }
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
  if (!response.ok) throw new ChzzkApiError(action, response.status, errorCodeOf(record?.message));
  if (!record || !("content" in record)) throw new Error(`치지직 ${action} 응답 형식이 예상과 다릅니다.`);
  return record.content;
}
