/**
 * 치지직 로그인·연결 묶음 단위 검사.
 * 로그인 주소의 일회용 state, 콜백 state 검사(틀림·재사용·만료), 코드 교환 뒤 채팅 수신, 끊기,
 * 저장된 토큰으로 시작 때 자동 연결, 앱 키가 없을 때를 본다. 가짜 치지직 서버(포트 4843)를 쓴다.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChzzkCallbackError, createChzzkLink, type ChzzkLink } from "../src/show/chzzk-link.js";
import type { ChzzkChat } from "../src/chzzk/types.js";
import { loadFakeChzzk, waitFor, type FakeChzzk } from "./chzzk-fake.js";

const PORT = 4843;
const baseUrl = `http://127.0.0.1:${PORT}`;
const { startFakeChzzk, FAKE_CLIENT_ID: clientId, FAKE_CLIENT_SECRET: clientSecret } = await loadFakeChzzk();
let fake: FakeChzzk;
let dir: string;
let links: ChzzkLink[] = [];

before(async () => { fake = await startFakeChzzk({ port: PORT }); });
after(async () => { await fake.close(); });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bori-chzzk-link-")); });
afterEach(() => {
  for (const link of links) link.disconnect();
  links = [];
  rmSync(dir, { recursive: true, force: true });
});

function open(overrides: { clientId?: string; now?: () => number } = {}) {
  const chats: ChzzkChat[] = [];
  const link = createChzzkLink({
    clientId: overrides.clientId ?? clientId,
    clientSecret,
    redirectUri: "http://localhost:4310/api/chzzk/callback",
    tokenFile: join(dir, "chzzk-token.json"),
    onChat: chat => chats.push(chat),
    baseUrl,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  links.push(link);
  return { link, chats };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";

describe("치지직 로그인과 연결", () => {
  test("로그인 주소는 치지직 인증 페이지이고 redirectUri와 state를 담는다", () => {
    const { link } = open();
    const url = new URL(link.loginUrl()!);
    assert.equal(url.origin + url.pathname, "https://chzzk.naver.com/account-interlock");
    assert.equal(url.searchParams.get("redirectUri"), "http://localhost:4310/api/chzzk/callback");
    assert.ok((url.searchParams.get("state") ?? "").length >= 32);
    assert.notEqual(stateOf(link.loginUrl()!), stateOf(link.loginUrl()!));
  });

  test("맞는 state로 콜백하면 토큰을 받아 채팅에 연결하고 채팅을 받는다", async () => {
    const { link, chats } = open();
    const state = stateOf(link.loginUrl()!);
    await link.callback(fake.issueCode(), state);
    await waitFor(() => link.status().state === "connected", "연결");
    fake.sendChat({ senderChannelId: "viewer-1", profile: { nickname: "보리팬" }, userRoleCode: "common_user", content: "재키 어때?" });
    await waitFor(() => chats.length === 1, "채팅 수신");
    assert.equal(chats[0].content, "재키 어때?");
    // 가짜 서버는 내 채널 조회를 모른다. 채널 이름을 못 받아도 연결은 그대로다.
    assert.equal(link.status().channelName, null);
  });

  test("모르는 state·다시 쓴 state는 토큰을 교환하지 않는다", async () => {
    const { link } = open();
    const tokenCalls = () => fake.calls.filter(call => call.path === "/auth/v1/token").length;
    const before = tokenCalls();
    await assert.rejects(link.callback(fake.issueCode(), "모르는-state"), (error: Error) => error instanceof ChzzkCallbackError && error.kind === "state");
    const state = stateOf(link.loginUrl()!);
    await link.callback(fake.issueCode(), state);
    await assert.rejects(link.callback(fake.issueCode(), state), (error: Error) => error instanceof ChzzkCallbackError && error.kind === "state");
    assert.equal(tokenCalls() - before, 1);
  });

  test("10분 지난 state는 받지 않는다", async () => {
    let clock = 0;
    const { link } = open({ now: () => clock });
    const state = stateOf(link.loginUrl()!);
    clock += 10 * 60 * 1000 + 1;
    await assert.rejects(link.callback(fake.issueCode(), state), (error: Error) => error instanceof ChzzkCallbackError && error.kind === "state");
  });

  test("코드 교환이 실패하면 exchange 오류이고 메시지에 코드가 없다", async () => {
    const { link } = open();
    const state = stateOf(link.loginUrl()!);
    const code = "가짜-코드-없는-값";
    await assert.rejects(link.callback(code, state), (error: Error) => error instanceof ChzzkCallbackError && error.kind === "exchange" && !error.message.includes(code));
  });

  test("끊으면 off이고, 저장된 토큰으로 다음 시작 때 다시 연결한다", async () => {
    const first = open();
    await first.link.callback(fake.issueCode(), stateOf(first.link.loginUrl()!));
    await waitFor(() => first.link.status().state === "connected", "연결");
    first.link.disconnect();
    assert.equal(first.link.status().state, "off");

    const second = open();
    second.link.start();
    await waitFor(() => second.link.status().state === "connected", "저장된 토큰으로 연결");
  });

  test("앱 키가 없으면 로그인 주소를 만들지 않고 off다", () => {
    const { link } = open({ clientId: "" });
    assert.equal(link.configured(), false);
    assert.equal(link.loginUrl(), null);
    link.start();
    assert.deepEqual(link.status(), { state: "off", channelName: null, lastError: null });
  });
});
