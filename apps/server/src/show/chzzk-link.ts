import { randomUUID } from "node:crypto";
import { buildAuthorizeUrl, exchangeCode } from "../chzzk/oauth.js";
import { connectChzzkChat } from "../chzzk/session.js";
import { createChzzkTokenStore } from "../chzzk/token-store.js";
import { DEFAULT_CHZZK_BASE_URL, requestChzzk, type ChzzkChat, type ChzzkChatConnection } from "../chzzk/types.js";
import type { ShowConnections } from "@bori/shared";

/**
 * 치지직 로그인과 채팅 연결을 묶는다.
 * - 로그인 주소마다 일회용 state(10분)를 만든다. 콜백은 그 state와 맞을 때만 코드를 토큰으로 바꾼다.
 * - 토큰은 data/chzzk-token.json(암호화)에 둔다. 서버 시작 때 토큰이 있으면 바로 채팅에 연결한다.
 * - 연결되면 내 채널 이름을 한 번 묻는다(Users 문서 `GET /open/v1/users/me`). 못 받아도 연결은 그대로다.
 * - 코드·state·토큰·secret은 오류 메시지·로그에 넣지 않는다.
 */

export type ChzzkStatus = { state: ShowConnections["chzzk"]; channelName: string | null; lastError: string | null };

/** 로그인 state 유효 시간. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** 동시에 살아 있는 state 수. 로그인 버튼을 여러 번 눌러도 이만큼만 둔다. */
const STATE_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 10_000;

/** 콜백을 받지 않은 이유. 화면에는 이유 종류만 보인다. */
export class ChzzkCallbackError extends Error {
  constructor(readonly kind: "state" | "exchange" | "config", message: string) {
    super(message);
    this.name = "ChzzkCallbackError";
  }
}

export function createChzzkLink(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenFile: string;
  onChat: (chat: ChzzkChat) => void;
  /** 검사용. 기본 https://openapi.chzzk.naver.com */
  baseUrl?: string;
  now?: () => number;
}) {
  const baseUrl = options.baseUrl ?? DEFAULT_CHZZK_BASE_URL;
  const now = options.now ?? Date.now;
  const configured = options.clientId.length > 0 && options.clientSecret.length > 0;
  const tokens = createChzzkTokenStore({ filePath: options.tokenFile, clientId: options.clientId, clientSecret: options.clientSecret, baseUrl });
  /** state → 만료 시각. */
  const pendingStates = new Map<string, number>();
  let connection: ChzzkChatConnection | null = null;
  let channelName: string | null = null;
  let lastError: string | null = null;

  async function fetchChannelName() {
    try {
      const token = await tokens.getAccessToken();
      const content = await requestChzzk("내 채널 조회", () => fetch(`${baseUrl}/open/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }));
      const name = typeof content === "object" && content !== null ? (content as Record<string, unknown>).channelName : undefined;
      channelName = typeof name === "string" && name.length > 0 ? name : null;
    } catch (error) {
      // 채널 이름은 표시용이다. 못 받아도 채팅 연결은 그대로 둔다.
      console.warn("[bori-server] 치지직 채널 이름을 받지 못했습니다:", error instanceof Error ? error.message : "알 수 없는 오류");
    }
  }

  function connect() {
    connection?.stop();
    lastError = null;
    connection = connectChzzkChat({
      getAccessToken: request => tokens.getAccessToken(request),
      onChat: options.onChat,
      baseUrl,
      onStatus: status => {
        if (status === "connected" && channelName === null) void fetchChannelName();
      },
    });
  }

  function pruneStates() {
    const at = now();
    for (const [state, expiresAt] of pendingStates) if (expiresAt <= at) pendingStates.delete(state);
  }

  return {
    configured: () => configured,

    /** 저장된 토큰이 있으면 채팅에 연결한다. */
    start() {
      if (!configured) return;
      if (tokens.load() === "ready") connect();
      else if (tokens.state() === "needs-login") lastError = "저장된 치지직 토큰을 쓸 수 없습니다. 다시 로그인해 주세요.";
    },

    /** 치지직 인증 페이지 주소. 앱 키가 없으면 null. */
    loginUrl(): string | null {
      if (!configured) return null;
      pruneStates();
      // 오래된 것부터 버려 STATE_LIMIT개만 둔다.
      while (pendingStates.size >= STATE_LIMIT) pendingStates.delete(pendingStates.keys().next().value!);
      const state = randomUUID();
      pendingStates.set(state, now() + STATE_TTL_MS);
      return buildAuthorizeUrl({ clientId: options.clientId, redirectUri: options.redirectUri, state });
    },

    /** 콜백. state가 맞으면 한 번만 쓰고 지운 뒤 토큰을 받아 저장하고 연결한다. */
    async callback(code: string, state: string): Promise<void> {
      if (!configured) throw new ChzzkCallbackError("config", "치지직 앱 키가 설정되지 않았습니다.");
      pruneStates();
      if (!pendingStates.delete(state) || code.length === 0) throw new ChzzkCallbackError("state", "로그인 요청이 만료되었거나 맞지 않습니다.");
      let received;
      try {
        received = await exchangeCode({ clientId: options.clientId, clientSecret: options.clientSecret, code, state, baseUrl });
      } catch (error) {
        lastError = error instanceof Error ? error.message : "치지직 토큰을 받지 못했습니다.";
        throw new ChzzkCallbackError("exchange", lastError);
      }
      channelName = null;
      try {
        tokens.save(received);
      } catch {
        // 메모리 토큰은 바뀌었으므로 이번 실행에서는 연결한다. 다음 실행에서는 다시 로그인해야 한다.
        console.warn("[bori-server] 치지직 토큰을 파일에 저장하지 못했습니다. 서버를 다시 켜면 다시 로그인해야 합니다.");
      }
      connect();
    },

    /** 채팅 연결을 끊는다. 토큰은 그대로 두어 서버를 다시 켜면 다시 연결된다. */
    disconnect() {
      connection?.stop();
      connection = null;
      channelName = null;
      lastError = null;
    },

    status(): ChzzkStatus {
      if (connection) return { state: connection.status(), channelName, lastError: connection.lastError() ?? lastError };
      return { state: lastError ? "error" : "off", channelName: null, lastError };
    },
  };
}

export type ChzzkLink = ReturnType<typeof createChzzkLink>;
