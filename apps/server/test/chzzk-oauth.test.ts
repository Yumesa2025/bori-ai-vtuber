/**
 * 치지직 OAuth와 토큰 저장 단위 검사.
 * 인증 URL, 코드 교환·갱신 요청 형식, 오류 메시지에 비밀값이 없는지, 토큰 파일 암호화·원자적 쓰기,
 * 만료 전 갱신과 동시 갱신 합치기, 풀지 못한 파일을 지우지 않는지 본다.
 * 실제 치지직 대신 가짜 서버(포트 4830)를 쓰고, 토큰 파일은 임시 디렉터리에 만든다.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthorizeUrl, exchangeCode, refreshTokens } from "../src/chzzk/oauth.js";
import { createChzzkTokenStore } from "../src/chzzk/token-store.js";
import { ChzzkLoginRequiredError, type ChzzkTokens } from "../src/chzzk/types.js";
import { loadFakeChzzk, type FakeChzzk } from "./chzzk-fake.js";

const PORT = 4830;
const baseUrl = `http://127.0.0.1:${PORT}`;
const { startFakeChzzk, FAKE_CLIENT_ID: clientId, FAKE_CLIENT_SECRET: clientSecret } = await loadFakeChzzk();
let fake: FakeChzzk;

before(async () => {
  fake = await startFakeChzzk({ port: PORT });
});

after(async () => {
  await fake.close();
});

describe("인증 URL", () => {
  test("치지직 account-interlock 주소에 clientId·redirectUri·state를 쿼리로 붙인다", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "abc", redirectUri: "http://localhost:4310/api/chzzk/callback", state: "s 1&2" }));
    assert.equal(`${url.origin}${url.pathname}`, "https://chzzk.naver.com/account-interlock");
    assert.equal(url.searchParams.get("clientId"), "abc");
    assert.equal(url.searchParams.get("redirectUri"), "http://localhost:4310/api/chzzk/callback");
    assert.equal(url.searchParams.get("state"), "s 1&2");
  });
});

describe("토큰 교환과 갱신", () => {
  test("코드를 JSON 본문으로 보내고 content의 토큰과 만료 시각을 돌려준다", async () => {
    const startedAt = Date.now();
    const tokens = await exchangeCode({ clientId, clientSecret, code: fake.issueCode(), state: "state-1", baseUrl });
    assert.match(tokens.accessToken, /^fake-access-/);
    assert.match(tokens.refreshToken, /^fake-refresh-/);
    // expiresIn은 문자열 "86400"(공식 문서 예시)이다.
    assert.ok(tokens.expiresAt >= startedAt + 86400_000 && tokens.expiresAt <= Date.now() + 86400_000);
    const call = fake.calls.filter(entry => entry.path === "/auth/v1/token").at(-1);
    assert.equal(call?.grantType, "authorization_code");
    assert.match(call?.contentType ?? "", /application\/json/);
  });

  test("갱신은 refresh_token으로 보내고 새 Refresh Token을 받는다. 쓴 Refresh Token은 다시 못 쓴다", async () => {
    const first = await exchangeCode({ clientId, clientSecret, code: fake.issueCode(), state: "state-2", baseUrl });
    const second = await refreshTokens({ clientId, clientSecret, refreshToken: first.refreshToken, baseUrl });
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.equal(fake.calls.filter(entry => entry.path === "/auth/v1/token").at(-1)?.grantType, "refresh_token");
    await assert.rejects(refreshTokens({ clientId, clientSecret, refreshToken: first.refreshToken, baseUrl }), (error: Error & { status?: number }) => error.status === 401);
  });

  test("실패하면 상태 코드와 치지직 오류 이름만 알리고 secret·코드·토큰·응답 본문은 넣지 않는다", async () => {
    const code = fake.issueCode();
    fake.options.tokenErrorMessage = `boom ${clientSecret} ${code}`;
    try {
      await assert.rejects(exchangeCode({ clientId, clientSecret, code, state: "state-3", baseUrl }), (error: Error) => {
        assert.match(error.message, /401/);
        assert.ok(!error.message.includes(clientSecret));
        assert.ok(!error.message.includes(code));
        assert.ok(!error.message.includes("boom"));
        return true;
      });
    } finally {
      fake.options.tokenErrorMessage = null;
    }

    const refreshToken = "fake-refresh-not-issued";
    await assert.rejects(refreshTokens({ clientId, clientSecret, refreshToken, baseUrl }), (error: Error) => {
      assert.match(error.message, /INVALID_TOKEN/);
      assert.ok(!error.message.includes(refreshToken));
      return true;
    });
  });

  test("응답에 토큰이 없으면 실패로 본다", async () => {
    const fetchStub: typeof fetch = async () => new Response(JSON.stringify({ code: 200, message: null, content: { accessToken: "x" } }), { status: 200 });
    await assert.rejects(exchangeCode({ clientId, clientSecret, code: "c", state: "s", baseUrl, fetch: fetchStub }), /형식/);
  });

  test("네트워크 오류 메시지에도 secret을 넣지 않는다", async () => {
    const fetchStub: typeof fetch = async () => { throw new Error(`connect failed ${clientSecret}`); };
    await assert.rejects(refreshTokens({ clientId, clientSecret, refreshToken: "r", baseUrl, fetch: fetchStub }), (error: Error) => !error.message.includes(clientSecret));
  });
});

describe("토큰 저장", () => {
  let dir: string;
  let filePath: string;
  const warnings: string[] = [];
  let clock = Date.now();
  const open = (overrides: { filePath?: string } = {}) => createChzzkTokenStore({
    filePath: overrides.filePath ?? filePath, clientId, clientSecret, baseUrl, now: () => clock, warn: message => { warnings.push(message); },
  });
  const login = () => exchangeCode({ clientId, clientSecret, code: fake.issueCode(), state: "s", baseUrl });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bori-chzzk-token-"));
    filePath = join(dir, "chzzk-token.json");
    warnings.length = 0;
    clock = Date.now();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("파일이 없으면 none이고 토큰을 달라고 하면 다시 로그인하라고 한다", async () => {
    const store = open();
    assert.equal(store.load(), "none");
    await assert.rejects(store.getAccessToken(), ChzzkLoginRequiredError);
  });

  test("저장한 토큰은 암호화되어 파일에 남고 다시 읽힌다. 임시 파일은 남지 않는다", async () => {
    const tokens = await login();
    open().save(tokens);
    const raw = readFileSync(filePath, "utf8");
    assert.ok(!raw.includes(tokens.accessToken));
    assert.ok(!raw.includes(tokens.refreshToken));
    assert.deepEqual(readdirSync(dir), ["chzzk-token.json"]);

    const reopened = open();
    assert.equal(reopened.load(), "ready");
    assert.equal(await reopened.getAccessToken(), tokens.accessToken);
  });

  test("만료 1시간 전부터는 갱신해서 주고 새 토큰을 파일에 쓴다", async () => {
    const store = open();
    store.load();
    const tokens = await login();
    store.save(tokens);

    clock = tokens.expiresAt - 2 * 3600_000;
    assert.equal(await store.getAccessToken(), tokens.accessToken);

    clock = tokens.expiresAt - 3600_000 + 1;
    const renewed = await store.getAccessToken();
    assert.notEqual(renewed, tokens.accessToken);
    const reopened = open();
    reopened.load();
    clock = Date.now();
    assert.equal(await reopened.getAccessToken(), renewed);
  });

  test("동시에 여러 번 갱신을 요청해도 한 번만 갱신한다(Refresh Token은 일회용)", async () => {
    const store = open();
    store.load();
    store.save(await login());
    const before = fake.calls.filter(entry => entry.grantType === "refresh_token").length;

    const results = await Promise.all([store.getAccessToken({ forceRefresh: true }), store.getAccessToken({ forceRefresh: true }), store.getAccessToken({ forceRefresh: true })]);
    assert.equal(new Set(results).size, 1);
    assert.equal(fake.calls.filter(entry => entry.grantType === "refresh_token").length - before, 1);
  });

  test("Refresh Token이 거절되면 needs-login이 되고 파일은 지우지 않는다", async () => {
    const store = open();
    store.load();
    store.save(await login());
    const saved = readFileSync(filePath, "utf8");
    fake.expireRefreshTokens();

    await assert.rejects(store.getAccessToken({ forceRefresh: true }), ChzzkLoginRequiredError);
    assert.equal(store.state(), "needs-login");
    assert.equal(readFileSync(filePath, "utf8"), saved);
    await assert.rejects(store.getAccessToken(), ChzzkLoginRequiredError);
  });

  test("갱신 중 네트워크 오류는 로그인 상태를 지우지 않는다", async () => {
    const tokens = await login();
    const failing = createChzzkTokenStore({ filePath, clientId, clientSecret, baseUrl, fetch: async () => { throw new Error("offline"); }, warn: () => {} });
    failing.load();
    failing.save(tokens);
    await assert.rejects(failing.getAccessToken({ forceRefresh: true }), (error: Error) => !(error instanceof ChzzkLoginRequiredError));
    assert.equal(failing.state(), "ready");
  });

  test("풀지 못하는 파일은 needs-login으로 두고 지우거나 덮어쓰지 않는다", async () => {
    const unreadable = JSON.stringify({ accessToken: "enc.v1:AAAA:BBBB:CCCC", refreshToken: "enc.v1:AAAA:BBBB:CCCC", expiresAt: Date.now() + 86400_000 });
    writeFileSync(filePath, unreadable, "utf8");
    const store = open();
    assert.equal(store.load(), "needs-login");
    await assert.rejects(store.getAccessToken(), ChzzkLoginRequiredError);
    assert.equal(readFileSync(filePath, "utf8"), unreadable);
    assert.deepEqual(readdirSync(dir), ["chzzk-token.json"]);
  });

  test("갱신 뒤 파일 쓰기에 실패해도 새 토큰은 이번 실행에서 쓰고, 경고에 토큰을 넣지 않는다", async () => {
    // 파일 자리에 디렉터리가 있으면 rename이 실패한다.
    const blockedPath = join(dir, "blocked.json");
    mkdirSync(blockedPath);
    const tokens = await login();
    const store = open({ filePath: blockedPath });
    store.load();
    assert.throws(() => store.save(tokens));
    assert.equal(store.state(), "ready");

    const renewed = await store.getAccessToken({ forceRefresh: true });
    assert.notEqual(renewed, tokens.accessToken);
    assert.equal(await store.getAccessToken(), renewed);
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every(message => !message.includes(renewed) && !message.includes(tokens.refreshToken)));
  });

  test("저장 형식: 토큰은 enc.v1 암호문, 만료 시각은 숫자", async () => {
    const tokens: ChzzkTokens = await login();
    open().save(tokens);
    const saved = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    assert.match(String(saved.accessToken), /^enc\.v1:/);
    assert.match(String(saved.refreshToken), /^enc\.v1:/);
    assert.equal(saved.expiresAt, tokens.expiresAt);
  });
});
