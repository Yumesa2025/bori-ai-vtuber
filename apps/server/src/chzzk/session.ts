import * as socketIo from "socket.io-client";
import { ChzzkApiError, ChzzkLoginRequiredError, DEFAULT_CHZZK_BASE_URL, requestChzzk, type ChzzkChat, type ChzzkChatConnection } from "./types.js";

/**
 * 치지직 채팅 세션(Session 문서).
 * 1. `GET /open/v1/sessions/auth`(유저 세션)로 소켓 URL을 받는다. URL은 일정 시간만 유효하므로 연결할 때마다 새로 받는다.
 * 2. socket.io-client 2.0.3으로 연결한다(치지직은 2.0.3까지만 지원). 라이브러리 자동 재연결은 끄고 여기서 직접 한다.
 * 3. `SYSTEM` connected의 sessionKey로 `POST /open/v1/sessions/events/subscribe/chat`를 부른다.
 *    문서는 sessionKey를 "Request Param"이라고만 적었다. 같은 문서에서 본문은 "Request Body"로 따로 적으므로 쿼리로 보낸다.
 * 4. `CHAT` 이벤트를 ChzzkChat으로 바꿔 넘긴다.
 *
 * 보안 공지가 있는 구버전 클라이언트를 쓰므로(docs/security-review.md 9절) 연결 대상과 받는 값을 좁힌다.
 * - 세션 URL은 치지직 세션 서버 호스트(https·wss의 *.nchat.naver.com)일 때만 연결한다.
 * - websocket 전송만 쓰고 polling·업그레이드는 끈다. polling 경로(xmlhttprequest-ssl)를 타지 않는다.
 * - 이벤트 페이로드가 16KB를 넘으면 버린다.
 */

type Status = ReturnType<ChzzkChatConnection["status"]>;

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
/** 공식 예시의 'connect timeout' 값. */
const CONNECT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
/** 공식 문서 예시 주소(ssio08.nchat.naver.com) 기준. 실제 호스트는 실연결(W4)에서 확인한다. */
const SESSION_HOST_SUFFIX = ".nchat.naver.com";

/**
 * 세션 URL로 연결해도 되는지.
 * 기본 Open API 주소면 https·wss의 *.nchat.naver.com만, 검사용으로 baseUrl을 바꿨으면 그 주소와 같은 호스트만 받는다.
 */
export function isAllowedSessionUrl(url: string, baseUrl: string): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (base.origin === new URL(DEFAULT_CHZZK_BASE_URL).origin) {
    return (parsed.protocol === "https:" || parsed.protocol === "wss:") && parsed.hostname.endsWith(SESSION_HOST_SUFFIX);
  }
  return parsed.hostname === base.hostname;
}

/** 소켓 이벤트 값을 객체로 읽는다. 문자열 JSON과 객체 둘 다 온다고 보고, 상한을 넘거나 객체가 아니면 null이다. */
function parsePayload(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  try {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
    if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) return null;
    if (typeof raw === "string") value = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** CHAT 이벤트(채팅 이벤트 메시지)를 ChzzkChat으로 바꾼다. 보낸 사람이나 내용이 없으면 버린다. */
function toChat(payload: Record<string, unknown> | null): ChzzkChat | null {
  if (!payload) return null;
  const { senderChannelId, content, profile, userRoleCode } = payload;
  if (typeof senderChannelId !== "string" || senderChannelId.length === 0 || typeof content !== "string") return null;
  const nickname = typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>).nickname : undefined;
  return {
    senderChannelId,
    nickname: typeof nickname === "string" ? nickname : "",
    content,
    receivedAt: new Date().toISOString(),
    role: typeof userRoleCode === "string" ? userRoleCode : "common_user",
  };
}

export function connectChzzkChat(options: {
  /** 만료 1시간 전이면 갱신해서 준다. forceRefresh면 만료와 무관하게 갱신한다(API가 401을 준 경우). */
  getAccessToken: (request?: { forceRefresh?: boolean }) => Promise<string>;
  onChat: (chat: ChzzkChat) => void;
  onStatus?: (status: string) => void;
  /** 기본 https://openapi.chzzk.naver.com */
  baseUrl?: string;
  /** 검사용 주입 */
  io?: typeof import("socket.io-client");
  /** 기본 [1000, 2000, 5000, 10000, 30000]. 다 쓰면 마지막 값으로 계속 시도한다. */
  reconnectDelaysMs?: number[];
}): ChzzkChatConnection {
  const baseUrl = options.baseUrl ?? DEFAULT_CHZZK_BASE_URL;
  const io = options.io ?? socketIo;
  const delays = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  let status: Status = "off";
  let lastError: string | null = null;
  let stopped = false;
  let socket: socketIo.Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 연속 실패 수. 구독까지 마치면 0으로 돌아간다. */
  let failures = 0;
  /** 시도 번호. 끝난 시도의 늦은 응답·이벤트가 지금 상태를 바꾸지 못하게 한다. */
  let attempt = 0;

  function setStatus(next: Status) {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  }

  /** 소켓을 닫는다. 처리기를 먼저 떼어 우리가 닫은 끊김을 재연결로 받지 않는다. 유저 세션은 3개까지라 새로 열기 전에 꼭 닫는다. */
  function closeSocket() {
    if (!socket) return;
    const closing = socket;
    socket = null;
    closing.off();
    closing.close();
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** 다시 시도해도 소용없는 실패. 다시 로그인하거나 설정을 고쳐야 한다. */
  function giveUp(message: string) {
    attempt += 1;
    clearTimer();
    closeSocket();
    lastError = message;
    setStatus("error");
  }

  /** 잠시 뒤 세션 URL부터 다시 받는다. */
  function retryLater(message: string) {
    if (stopped) return;
    attempt += 1;
    closeSocket();
    lastError = message;
    setStatus("error");
    const delay = delays[Math.min(failures, delays.length - 1)];
    failures += 1;
    timer = setTimeout(() => {
      timer = null;
      void start();
    }, delay);
  }

  /** 오류를 다시 시도할지 멈출지 나눈다. 메시지는 이 모듈과 토큰 저장이 만든 것뿐이라 비밀값이 없다. */
  function fail(error: unknown) {
    const message = error instanceof Error ? error.message : "치지직 연결 중 오류가 났습니다.";
    // 로그인이 필요하거나, 갱신한 토큰으로도 401이거나, 권한(Scope)이 없으면 다시 시도하지 않는다.
    if (error instanceof ChzzkLoginRequiredError || (error instanceof ChzzkApiError && (error.status === 401 || error.status === 403))) giveUp(message);
    else retryLater(message);
  }

  /** Access Token으로 부른다. 401이면 토큰을 강제로 갱신해 한 번만 다시 부른다. */
  async function withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(await options.getAccessToken());
    } catch (error) {
      if (!(error instanceof ChzzkApiError && error.status === 401)) throw error;
      return call(await options.getAccessToken({ forceRefresh: true }));
    }
  }

  const authorized = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  async function subscribe(current: number, sessionKey: string) {
    try {
      await withToken(token => requestChzzk("채팅 구독", () => fetch(`${baseUrl}/open/v1/sessions/events/subscribe/chat?${new URLSearchParams({ sessionKey })}`, {
        method: "POST",
        headers: authorized(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })));
    } catch (error) {
      if (current === attempt) fail(error);
    }
  }

  function handleSystem(current: number, message: Record<string, unknown> | null) {
    const data = typeof message?.data === "object" && message.data !== null ? message.data as Record<string, unknown> : {};
    switch (message?.type) {
      case "connected":
        if (typeof data.sessionKey === "string" && data.sessionKey.length > 0) void subscribe(current, data.sessionKey);
        else retryLater("치지직 세션 연결 메시지에 sessionKey가 없습니다.");
        return;
      case "subscribed":
        failures = 0;
        lastError = null;
        setStatus("connected");
        return;
      case "revoked":
        // 사용자가 동의를 철회했거나 Scope가 바뀌었다. 자동으로 다시 붙지 않는다.
        giveUp("치지직 권한이 회수되었습니다. 다시 연결해야 합니다.");
        return;
      case "unsubscribed":
        retryLater("치지직 채팅 구독이 취소되어 다시 연결합니다.");
        return;
    }
  }

  async function start() {
    const current = ++attempt;
    const isCurrent = () => !stopped && current === attempt;
    setStatus("connecting");

    let url: unknown;
    try {
      const content = await withToken(token => requestChzzk("세션 생성", () => fetch(`${baseUrl}/open/v1/sessions/auth`, {
        headers: authorized(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })));
      url = typeof content === "object" && content !== null ? (content as Record<string, unknown>).url : undefined;
    } catch (error) {
      if (isCurrent()) fail(error);
      return;
    }
    if (!isCurrent()) return;
    if (typeof url !== "string") return retryLater("치지직 세션 생성 응답에 주소가 없습니다.");
    if (!isAllowedSessionUrl(url, baseUrl)) return giveUp("치지직이 준 세션 주소가 허용 범위 밖이라 연결하지 않았습니다.");

    const opened = io.connect(url, {
      reconnection: false,
      "force new connection": true,
      forceNew: true,
      transports: ["websocket"],
      upgrade: false,
      "connect timeout": CONNECT_TIMEOUT_MS,
      timeout: CONNECT_TIMEOUT_MS,
    });
    socket = opened;
    opened.on("SYSTEM", raw => {
      if (isCurrent()) handleSystem(current, parsePayload(raw));
    });
    opened.on("CHAT", raw => {
      if (!isCurrent()) return;
      const chat = toChat(parsePayload(raw));
      if (chat) options.onChat(chat);
    });
    for (const event of ["disconnect", "connect_error", "connect_timeout", "error"]) {
      opened.on(event, () => {
        if (isCurrent()) retryLater(event === "disconnect" ? "치지직 채팅 연결이 끊겨 다시 연결합니다." : "치지직 채팅 소켓에 연결하지 못했습니다.");
      });
    }
  }

  void start();

  return {
    status: () => status,
    lastError: () => lastError,
    stop() {
      stopped = true;
      attempt += 1;
      clearTimer();
      closeSocket();
      setStatus("off");
    },
  };
}
