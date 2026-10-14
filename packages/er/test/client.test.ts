/**
 * 이터널리턴 API 클라이언트 단위 검사. 실제 네트워크 없이 가짜 fetch로 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createErClient, ErApiError } from "../src/client.js";

const KEY = "test-key-secret-123";

type Call = { url: string; headers: Record<string, string>; at: number };

/** 정해 둔 응답을 차례로 돌려주는 가짜 fetch. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, at: performance.now() });
    const next = responses.shift();
    if (!next) throw new Error("응답이 더 없습니다");
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status });
  }) as typeof fetch;
}

const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { code: 200, message: "Success", ...extra } });

test("요청에 x-api-key 헤더를 붙이고 기본 주소를 쓴다", async () => {
  const calls: Call[] = [];
  const client = createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([ok({ data: [1] })], calls) });
  const body = await client.get<{ data: number[] }>("/v2/data/Season");
  assert.deepEqual(body.data, [1]);
  assert.equal(calls[0]!.url, "https://open-api.bser.io/v2/data/Season");
  assert.equal(calls[0]!.headers["x-api-key"], KEY);
});

test("가짜 시계가 충분히 흘렀으면 기다리지 않는다", async () => {
  const calls: Call[] = [];
  let clock = 0;
  const client = createErClient({
    apiKey: KEY,
    minIntervalMs: 5_000,
    fetch: fakeFetch([ok(), ok(), ok()], calls),
    now: () => (clock += 10_000),
  });
  const started = performance.now();
  await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
  assert.equal(calls.length, 3);
  assert.ok(performance.now() - started < 1_000);
});

test("가짜 시계가 멈춰 있으면 호출 사이를 minIntervalMs 이상 띄운다", async () => {
  const calls: Call[] = [];
  const client = createErClient({ apiKey: KEY, minIntervalMs: 60, fetch: fakeFetch([ok(), ok(), ok()], calls), now: () => 1_000 });
  await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/a", "/b", "/c"]);
  // 타이머 오차를 감안해 몇 ms 여유를 둔다
  assert.ok(calls[1]!.at - calls[0]!.at >= 55, `간격 ${calls[1]!.at - calls[0]!.at}`);
  assert.ok(calls[2]!.at - calls[1]!.at >= 55, `간격 ${calls[2]!.at - calls[1]!.at}`);
});

test("HTTP 200이어도 본문 code가 200이 아니면 ErApiError", async () => {
  const client = createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([{ status: 200, body: { code: 404, message: "Not Found" } }], []) });
  await assert.rejects(client.get("/v1/user/nickname?query=x"), (error: unknown) => {
    assert.ok(error instanceof ErApiError);
    assert.equal(error.status, 200);
    assert.equal(error.code, 404);
    return true;
  });
});

test("HTTP 오류는 상태와 본문 code를 담는다", async () => {
  const client = createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([{ status: 404, body: { code: 404, message: "Not Found" } }], []) });
  await assert.rejects(client.get("/v1/games/1"), (error: unknown) => {
    assert.ok(error instanceof ErApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 404);
    return true;
  });
});

test("JSON이 아닌 응답은 code가 null인 ErApiError", async () => {
  const client = createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([{ status: 502, body: "<html>bad gateway</html>" }], []) });
  await assert.rejects(client.get("/v1/games/1"), (error: unknown) => error instanceof ErApiError && error.status === 502 && error.code === null);
});

for (const status of [429, 403]) {
  test(`${status}이면 한 번 기다렸다 재시도한다`, async () => {
    const calls: Call[] = [];
    const client = createErClient({
      apiKey: KEY,
      minIntervalMs: 20,
      fetch: fakeFetch([{ status, body: { code: status, message: "Too Many" } }, ok({ data: "ok" })], calls),
      now: () => 0,
    });
    const body = await client.get<{ data: string }>("/a");
    assert.equal(body.data, "ok");
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.at - calls[0]!.at >= 15);
  });

  test(`${status}이 두 번 연속이면 재시도를 멈추고 ErApiError`, async () => {
    const calls: Call[] = [];
    const fail = { status, body: { code: status, message: "Too Many" } };
    const client = createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([fail, fail, ok()], calls) });
    await assert.rejects(client.get("/a"), (error: unknown) => error instanceof ErApiError && error.status === status);
    assert.equal(calls.length, 2);
  });
}

test("실패한 요청 뒤에도 큐가 계속 돈다", async () => {
  const client = createErClient({
    apiKey: KEY,
    minIntervalMs: 0,
    fetch: fakeFetch([{ status: 500, body: { code: 500, message: "err" } }, ok({ data: 2 })], []),
  });
  const [first, second] = await Promise.allSettled([client.get("/a"), client.get<{ data: number }>("/b")]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status === "fulfilled" && second.value.data, 2);
});

test("키가 오류 메시지에 들어가지 않고, 닉네임 같은 쿼리도 빠진다", async () => {
  const failing = (async () => {
    throw new Error(`connect failed with x-api-key ${KEY}`);
  }) as typeof fetch;
  const cases: Array<ReturnType<typeof createErClient>> = [
    createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([{ status: 500, body: { code: 500, message: `bad key ${KEY}` } }], []) }),
    createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: failing }),
  ];
  for (const client of cases) {
    await assert.rejects(client.get("/v1/user/nickname?query=보리팬클럽"), (error: unknown) => {
      assert.ok(error instanceof ErApiError);
      const text = `${error.message} ${error.stack ?? ""}`;
      assert.ok(!text.includes(KEY), text);
      assert.ok(!text.includes("보리팬클럽"), text);
      assert.ok(text.includes("/v1/user/nickname"), text);
      return true;
    });
  }
});

test("절대 주소(언어 데이터 파일)는 키 없이 받아 본문 문자열을 돌려준다", async () => {
  const calls: Call[] = [];
  const client = createErClient({ apiKey: KEY, minIntervalMs: 0, fetch: fakeFetch([{ status: 200, body: "Character/Name/1┃재키\n" }], calls) });
  const text = await client.get<string>("https://cdn.example.com/l10n/ko.txt");
  assert.equal(text, "Character/Name/1┃재키\n");
  assert.equal(calls[0]!.url, "https://cdn.example.com/l10n/ko.txt");
  assert.equal(calls[0]!.headers["x-api-key"], undefined);
});
