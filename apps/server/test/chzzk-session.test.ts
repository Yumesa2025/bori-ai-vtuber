/**
 * 치지직 채팅 세션 단위 검사.
 * 세션 URL 받기 → 소켓 연결 → sessionKey로 구독 → 채팅 수신 흐름과, 끊긴 뒤 재연결, 토큰 만료 시 갱신 후 재시도,
 * stop 뒤 재연결하지 않는지, 세션 URL 호스트 제한과 큰 페이로드 버리기를 본다.
 * 마지막 검사는 로그인(코드 교환) → 토큰 저장 → 소켓 → 채팅 수신 → 재연결 전체를 한 번에 확인한다.
 * 실제 치지직 대신 가짜 서버(포트 4831)와 실제 socket.io-client 2.0.3을 쓴다.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realIo from "socket.io-client";
import { exchangeCode } from "../src/chzzk/oauth.js";
import { connectChzzkChat, isAllowedSessionUrl } from "../src/chzzk/session.js";
import { createChzzkTokenStore } from "../src/chzzk/token-store.js";
import { ChzzkLoginRequiredError, DEFAULT_CHZZK_BASE_URL, type ChzzkChat, type ChzzkChatConnection } from "../src/chzzk/types.js";
import { loadFakeChzzk, sleep, waitFor, type FakeChzzk } from "./chzzk-fake.js";

const PORT = 4831;
const baseUrl = `http://127.0.0.1:${PORT}`;
const { startFakeChzzk, FAKE_CLIENT_ID: clientId, FAKE_CLIENT_SECRET: clientSecret } = await loadFakeChzzk();
let fake: FakeChzzk;

before(async () => {
  fake = await startFakeChzzk({ port: PORT });
});

after(async () => {
  await fake.close();
});

/** 가짜 서버가 보내는 채팅 이벤트. 필드는 공식 문서의 "채팅 이벤트 메시지"를 따른다. */
const chatEvent = (content: string) => ({
  channelId: "fake-channel",
  senderChannelId: "viewer-1",
  chatChannelId: "chat-channel",
  profile: { nickname: "보리팬", badges: [], verifiedMark: false },
  userRoleCode: "common_user",
  content,
  emojis: {},
  messageTime: Date.now(),
});

type Harness = {
  connection: ChzzkChatConnection;
  chats: ChzzkChat[];
  statuses: string[];
  tokenRequests: { forceRefresh: boolean }[];
};

let current: Harness | null = null;

/** 가짜 서버에서 받은 토큰으로 연결한다. forceRefresh면 새 토큰을 발급해 준다. */
function connect(overrides: Partial<Parameters<typeof connectChzzkChat>[0]> = {}): Harness {
  let token = fake.issueTokens().accessToken;
  const harness: Harness = { chats: [], statuses: [], tokenRequests: [], connection: undefined as unknown as ChzzkChatConnection };
  harness.connection = connectChzzkChat({
    baseUrl,
    reconnectDelaysMs: [30, 60],
    getAccessToken: async options => {
      harness.tokenRequests.push({ forceRefresh: options?.forceRefresh === true });
      if (options?.forceRefresh) token = fake.issueTokens().accessToken;
      return token;
    },
    onChat: chat => { harness.chats.push(chat); },
    onStatus: status => { harness.statuses.push(status); },
    ...overrides,
  });
  current = harness;
  return harness;
}

const sessionAuthCalls = () => fake.calls.filter(entry => entry.path === "/open/v1/sessions/auth").length;

beforeEach(() => {
  fake.options.stringPayload = false;
  fake.options.sessionUrlHost = `127.0.0.1:${PORT}`;
});

afterEach(async () => {
  current?.connection.stop();
  current = null;
  await waitFor(() => fake.connectedSockets() === 0, "소켓 정리");
});

describe("채팅 수신", () => {
  test("세션 URL → 연결 → 구독 → CHAT을 ChzzkChat으로 바꿔 넘긴다", async () => {
    const { connection, chats, statuses } = connect();
    assert.equal(connection.status(), "connecting");
    await waitFor(() => connection.status() === "connected", "구독 완료");
    assert.deepEqual(statuses.slice(0, 2), ["connecting", "connected"]);
    assert.equal(fake.calls.filter(entry => entry.path === "/open/v1/sessions/events/subscribe/chat").at(-1)?.sessionKeyIn, "query");

    fake.sendChat(chatEvent("재키 어때?"));
    await waitFor(() => chats.length === 1, "채팅 수신");
    assert.equal(chats[0].content, "재키 어때?");
    assert.equal(chats[0].senderChannelId, "viewer-1");
    assert.equal(chats[0].nickname, "보리팬");
    assert.equal(chats[0].role, "common_user");
    assert.ok(!Number.isNaN(Date.parse(chats[0].receivedAt)));
    assert.equal(connection.lastError(), null);
  });

  test("이벤트가 문자열 JSON으로 와도 같은 결과다", async () => {
    fake.options.stringPayload = true;
    const { connection, chats } = connect();
    await waitFor(() => connection.status() === "connected", "구독 완료");
    fake.sendChat(chatEvent("문자열로 왔어요"));
    await waitFor(() => chats.length === 1, "채팅 수신");
    assert.equal(chats[0].content, "문자열로 왔어요");
  });

  test("깨진 JSON, 필드가 빠진 이벤트, 16KB를 넘는 이벤트는 버리고 연결은 유지한다", async () => {
    const { connection, chats } = connect();
    await waitFor(() => connection.status() === "connected", "구독 완료");
    fake.sendChat(null, { raw: "{not json" });
    fake.sendChat({ content: "보낸 사람 없음" });
    fake.sendChat(chatEvent("가".repeat(17 * 1024)));
    fake.sendChat(null, { raw: JSON.stringify(chatEvent("나".repeat(17 * 1024))) });
    fake.sendChat(chatEvent("정상"));
    await waitFor(() => chats.length === 1, "정상 채팅");
    await sleep(50);
    assert.deepEqual(chats.map(chat => chat.content), ["정상"]);
    assert.equal(connection.status(), "connected");
  });

  test("socket.io 옵션: 자동 재연결 끄고 websocket만, 업그레이드 끔", async () => {
    const seen: Record<string, unknown>[] = [];
    const io = { ...realIo, connect: (url: string, options?: Record<string, unknown>) => { seen.push(options ?? {}); return realIo.connect(url, options); } } as typeof realIo;
    const { connection } = connect({ io });
    await waitFor(() => connection.status() === "connected", "구독 완료");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reconnection, false);
    assert.deepEqual(seen[0].transports, ["websocket"]);
    assert.equal(seen[0].upgrade, false);
    assert.equal(seen[0]["force new connection"], true);
  });
});

describe("재연결", () => {
  test("서버가 끊으면 세션 URL부터 다시 받아 재연결하고 채팅을 계속 받는다", async () => {
    const { connection, chats, statuses } = connect();
    await waitFor(() => connection.status() === "connected", "첫 연결");
    const before = sessionAuthCalls();

    fake.dropSockets();
    await waitFor(() => statuses.at(-1) !== "connected", "끊김 감지");
    await waitFor(() => connection.status() === "connected" && fake.connectedSockets() === 1, "재연결");
    assert.equal(sessionAuthCalls() - before, 1);

    fake.sendChat(chatEvent("다시 왔어요"));
    await waitFor(() => chats.length === 1, "재연결 후 채팅");
  });

  test("세션 URL 요청이 401이면 토큰을 강제로 갱신해 한 번 더 시도한다", async () => {
    const harness = connect();
    await waitFor(() => harness.connection.status() === "connected", "첫 연결");
    fake.expireAccessTokens();
    fake.dropSockets();
    await waitFor(() => harness.tokenRequests.some(request => request.forceRefresh), "강제 갱신");
    await waitFor(() => harness.connection.status() === "connected", "갱신 후 재연결");
  });

  test("갱신해도 401이면 error로 두고 재연결하지 않는다", async () => {
    const harness = connect({ getAccessToken: async () => "fake-access-unknown" });
    await waitFor(() => harness.connection.status() === "error", "인증 실패");
    const calls = sessionAuthCalls();
    await sleep(200);
    assert.equal(sessionAuthCalls(), calls);
    assert.match(harness.connection.lastError() ?? "", /401/);
    assert.ok(!(harness.connection.lastError() ?? "").includes("fake-access-unknown"));
  });

  test("다시 로그인해야 하면 error로 두고 재연결하지 않는다", async () => {
    const harness = connect({ getAccessToken: async () => { throw new ChzzkLoginRequiredError(); } });
    await waitFor(() => harness.connection.status() === "error", "로그인 필요");
    const calls = sessionAuthCalls();
    await sleep(200);
    assert.equal(sessionAuthCalls(), calls);
  });

  test("권한 회수(revoked)를 받으면 error로 두고 재연결하지 않는다", async () => {
    const { connection } = connect();
    await waitFor(() => connection.status() === "connected", "첫 연결");
    const calls = sessionAuthCalls();
    fake.sendSystem({ type: "revoked", data: { eventType: "CHAT", channelId: "fake-channel" } });
    await waitFor(() => connection.status() === "error", "권한 회수");
    await waitFor(() => fake.connectedSockets() === 0, "소켓 닫힘");
    await sleep(200);
    assert.equal(sessionAuthCalls(), calls);
  });

  test("서버 오류가 이어지면 reconnectDelaysMs 마지막 값으로 계속 시도한다", async () => {
    let failures = 3;
    const harness = connect({
      getAccessToken: async () => {
        if (failures > 0) { failures -= 1; throw new Error("일시 오류"); }
        return fake.issueTokens().accessToken;
      },
    });
    await waitFor(() => harness.connection.status() === "connected", "오류 뒤 연결", 5000);
    assert.ok(harness.statuses.includes("error"));
    assert.equal(harness.connection.lastError(), null);
  });
});

describe("stop", () => {
  test("stop 뒤에는 off이고 서버가 끊어도 다시 연결하지 않으며 채팅도 넘기지 않는다", async () => {
    const { connection, chats } = connect();
    await waitFor(() => connection.status() === "connected", "첫 연결");
    const calls = sessionAuthCalls();
    connection.stop();
    assert.equal(connection.status(), "off");
    await waitFor(() => fake.connectedSockets() === 0, "소켓 닫힘");
    fake.sendChat(chatEvent("들리면 안 됨"));
    await sleep(200);
    assert.equal(sessionAuthCalls(), calls);
    assert.equal(chats.length, 0);
  });

  test("연결 중에 stop하면 소켓을 열지 않는다", async () => {
    const { connection } = connect({ getAccessToken: async () => { await sleep(100); return fake.issueTokens().accessToken; } });
    connection.stop();
    await sleep(300);
    assert.equal(connection.status(), "off");
    assert.equal(fake.connectedSockets(), 0);
  });
});

describe("세션 URL 제한", () => {
  test("기본 주소에서는 https·wss와 *.nchat.naver.com만 받는다", () => {
    assert.equal(isAllowedSessionUrl("https://ssio08.nchat.naver.com:443?auth=x", DEFAULT_CHZZK_BASE_URL), true);
    assert.equal(isAllowedSessionUrl("wss://ssio08.nchat.naver.com?auth=x", DEFAULT_CHZZK_BASE_URL), true);
    assert.equal(isAllowedSessionUrl("http://ssio08.nchat.naver.com?auth=x", DEFAULT_CHZZK_BASE_URL), false);
    assert.equal(isAllowedSessionUrl("https://nchat.naver.com.evil.example?auth=x", DEFAULT_CHZZK_BASE_URL), false);
    assert.equal(isAllowedSessionUrl("https://evil.example/ssio08.nchat.naver.com", DEFAULT_CHZZK_BASE_URL), false);
    assert.equal(isAllowedSessionUrl("https://127.0.0.1?auth=x", DEFAULT_CHZZK_BASE_URL), false);
    assert.equal(isAllowedSessionUrl("not a url", DEFAULT_CHZZK_BASE_URL), false);
  });

  test("다른 주소(검사용)에서는 그 주소와 같은 호스트만 받는다", () => {
    assert.equal(isAllowedSessionUrl(`http://127.0.0.1:${PORT}?auth=x`, baseUrl), true);
    assert.equal(isAllowedSessionUrl(`http://127.0.0.1:9999?auth=x`, baseUrl), true);
    assert.equal(isAllowedSessionUrl(`http://localhost:${PORT}?auth=x`, baseUrl), false);
    assert.equal(isAllowedSessionUrl(`https://ssio08.nchat.naver.com?auth=x`, baseUrl), false);
  });

  test("허용 밖 세션 URL이면 연결하지 않고 오류를 기록한다", async () => {
    fake.options.sessionUrlHost = `localhost:${PORT}`;
    const { connection } = connect();
    await waitFor(() => connection.status() === "error", "호스트 거절");
    assert.match(connection.lastError() ?? "", /세션 주소/);
    await sleep(100);
    assert.equal(fake.connectedSockets(), 0);
  });
});

describe("전체 흐름", () => {
  test("로그인 → 토큰 저장 → 소켓 → 채팅 수신 → 끊김 → 토큰 갱신 후 재연결 → 채팅 수신", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bori-chzzk-flow-"));
    try {
      const store = createChzzkTokenStore({ filePath: join(dir, "chzzk-token.json"), clientId, clientSecret, baseUrl, warn: () => {} });
      store.load();
      store.save(await exchangeCode({ clientId, clientSecret, code: fake.issueCode(), state: "flow", baseUrl }));

      const { connection, chats } = connect({ getAccessToken: request => store.getAccessToken(request) });
      await waitFor(() => connection.status() === "connected", "첫 연결");
      fake.sendChat(chatEvent("첫 채팅"));
      await waitFor(() => chats.length === 1, "첫 채팅");

      // Access Token이 만료된 상태에서 끊기면 401 → 갱신 → 새 세션 URL로 다시 붙는다.
      fake.expireAccessTokens();
      fake.dropSockets();
      await waitFor(() => connection.status() !== "connected", "끊김 감지");
      await waitFor(() => connection.status() === "connected", "재연결");
      fake.sendChat(chatEvent("두 번째 채팅"));
      await waitFor(() => chats.length === 2, "재연결 후 채팅");
      assert.deepEqual(chats.map(chat => chat.content), ["첫 채팅", "두 번째 채팅"]);
      assert.equal(store.state(), "ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
