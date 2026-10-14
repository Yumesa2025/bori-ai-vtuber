/**
 * 치지직 Open API와 세션 소켓(Socket.IO 2.x)을 흉내 내는 가짜 서버.
 *
 * 실제 치지직 계정·Client ID 없이 로그인 → 토큰 → 소켓 → 채팅 수신 → 재연결 흐름을 검사한다.
 * 형식은 공식 문서(chzzk.gitbook.io/chzzk, 2026-10-15 열람)의 Authorization·Session 페이지를 따른다.
 * 문서로 확정하지 못한 것은 두 형식을 모두 받는다.
 * - 구독 API의 `sessionKey`: 문서는 "Request Param"이라고만 적었다. 쿼리와 JSON 본문을 모두 받는다.
 * - 소켓 이벤트 페이로드: 문자열 JSON인지 객체인지 문서에 없다. 보내는 쪽에서 고른다.
 *
 * 검사 코드에서는 startFakeChzzk()로 띄우고, 단독으로는 다음처럼 띄운다.
 *
 *   FAKE_CHZZK_PORT=4830 node tools/test/fixtures/fake-chzzk.mjs
 *
 * 토큰·코드는 모두 이 서버가 만든 가짜 값이다.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import createSocketServer from "socket.io";

export const FAKE_CLIENT_ID = "fake-client-id";
export const FAKE_CLIENT_SECRET = "fake-client-secret-DO-NOT-LEAK";

const sendJson = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
/** 공통 응답 구조(참고사항 문서). 성공은 content에 담고, 실패는 code·message만 준다. */
const ok = (response, content) => sendJson(response, 200, { code: 200, message: null, content });
const fail = (response, status, message) => sendJson(response, status, { code: status, message });

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 가짜 서버를 띄운다.
 * @param {{ port: number; host?: string; accessTokenTtlSec?: number }} options
 */
export async function startFakeChzzk({ port, host = "127.0.0.1", accessTokenTtlSec = 86400 }) {
  /** 받은 요청 기록. 토큰 원문은 남기지 않고 경로·grantType·sessionKey 전달 방식만 남긴다. */
  const calls = [];
  /** 발급한 인증 코드(일회용). */
  const codes = new Set();
  const accessTokens = new Set();
  /** Refresh Token은 일회용이다(공식). 쓰면 지운다. */
  const refreshTokens = new Set();
  /** 세션 URL의 auth 값 → 세션을 만든 Access Token. 연결에 한 번만 쓴다. */
  const sessionAuths = new Map();
  /** sessionKey → 소켓. */
  const sessions = new Map();
  const options = {
    /** 세션 URL에 넣을 호스트. 다른 호스트를 주는 경우를 검사할 때 바꾼다. */
    sessionUrlHost: `${host}:${port}`,
    /** 소켓 이벤트를 문자열 JSON으로 보낼지. */
    stringPayload: false,
    /** 다음 토큰 응답의 실패 메시지. 오류 메시지에 비밀값이 새지 않는지 볼 때 쓴다. */
    tokenErrorMessage: null,
  };

  function issueTokens() {
    const accessToken = `fake-access-${randomUUID()}`;
    const refreshToken = `fake-refresh-${randomUUID()}`;
    accessTokens.add(accessToken);
    refreshTokens.add(refreshToken);
    return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: String(accessTokenTtlSec) };
  }

  const bearerOf = request => {
    const header = request.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  };

  const emitTo = (socket, event, payload) => socket.emit(event, options.stringPayload ? JSON.stringify(payload) : payload);

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "POST" && url.pathname === "/auth/v1/token") {
      const body = await readJson(request);
      calls.push({ path: url.pathname, grantType: body?.grantType ?? null, contentType: request.headers["content-type"] ?? "" });
      if (!body || body.clientId !== FAKE_CLIENT_ID || body.clientSecret !== FAKE_CLIENT_SECRET) return fail(response, 401, "INVALID_CLIENT");
      if (options.tokenErrorMessage) return fail(response, 401, options.tokenErrorMessage);
      if (body.grantType === "authorization_code") {
        if (!codes.delete(body.code) || typeof body.state !== "string") return fail(response, 401, "INVALID_TOKEN");
        return ok(response, issueTokens());
      }
      if (body.grantType === "refresh_token") {
        if (!refreshTokens.delete(body.refreshToken)) return fail(response, 401, "INVALID_TOKEN");
        return ok(response, { ...issueTokens(), scope: "채팅 메시지 조회" });
      }
      return fail(response, 400, "잘못된 값을 입력했습니다.");
    }

    if (request.method === "GET" && url.pathname === "/open/v1/sessions/auth") {
      const token = bearerOf(request);
      calls.push({ path: url.pathname, authorized: accessTokens.has(token) });
      if (!accessTokens.has(token)) return fail(response, 401, "INVALID_TOKEN");
      const auth = randomUUID();
      sessionAuths.set(auth, token);
      return ok(response, { url: `http://${options.sessionUrlHost}?auth=${auth}` });
    }

    if (request.method === "POST" && url.pathname === "/open/v1/sessions/events/subscribe/chat") {
      const token = bearerOf(request);
      const body = await readJson(request);
      const fromQuery = url.searchParams.get("sessionKey");
      const sessionKey = fromQuery ?? (typeof body?.sessionKey === "string" ? body.sessionKey : null);
      calls.push({ path: url.pathname, authorized: accessTokens.has(token), sessionKeyIn: fromQuery ? "query" : sessionKey ? "body" : "none" });
      if (!accessTokens.has(token)) return fail(response, 401, "INVALID_TOKEN");
      const socket = sessionKey ? sessions.get(sessionKey) : undefined;
      if (!socket) return fail(response, 400, "잘못된 값을 입력했습니다.");
      ok(response, null);
      emitTo(socket, "SYSTEM", { type: "subscribed", data: { eventType: "CHAT", channelId: "fake-channel" } });
      return;
    }

    fail(response, 404, "NOT_FOUND");
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => fail(response, 500, "INTERNAL_SERVER_ERROR"));
  });
  const io = createSocketServer(server, { serveClient: false });

  // 세션 URL의 auth 값을 확인한다. 한 번 쓴 값과 모르는 값은 거절한다.
  io.use((socket, next) => {
    const auth = socket.handshake.query?.auth;
    if (typeof auth !== "string" || !sessionAuths.delete(auth)) return next(new Error("unauthorized"));
    next();
  });
  io.on("connection", socket => {
    const sessionKey = randomUUID();
    sessions.set(sessionKey, socket);
    socket.on("disconnect", () => sessions.delete(sessionKey));
    emitTo(socket, "SYSTEM", { type: "connected", data: { sessionKey } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    calls,
    options,
    /** 인증 코드 하나를 발급한다. 실제로는 사용자가 동의한 뒤 redirectUri로 온다. */
    issueCode() {
      const code = `fake-code-${randomUUID()}`;
      codes.add(code);
      return code;
    },
    /** 로그인을 건너뛰고 토큰을 바로 만든다. */
    issueTokens,
    /** 지금까지 발급한 Access Token을 모두 만료시킨다. Refresh Token은 그대로다. */
    expireAccessTokens: () => accessTokens.clear(),
    /** Refresh Token도 모두 무효로 만든다. */
    expireRefreshTokens: () => refreshTokens.clear(),
    connectedSockets: () => sessions.size,
    /** 연결된 모든 세션에 채팅 이벤트를 보낸다. raw를 주면 그 값을 그대로 보낸다. */
    sendChat(chat, { raw } = {}) {
      for (const socket of sessions.values()) {
        if (raw !== undefined) socket.emit("CHAT", raw);
        else emitTo(socket, "CHAT", chat);
      }
    },
    sendSystem(message) {
      for (const socket of sessions.values()) emitTo(socket, "SYSTEM", message);
    },
    /** 서버 쪽에서 모든 소켓을 끊는다. */
    dropSockets() {
      for (const socket of sessions.values()) socket.disconnect(true);
    },
    async close() {
      for (const socket of sessions.values()) socket.disconnect(true);
      io.close();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// 단독 실행
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_CHZZK_PORT ?? 4830);
  await startFakeChzzk({ port });
  console.log(`[fake-chzzk] http://127.0.0.1:${port}`);
}
