/**
 * 대시보드 API 요청의 시간 상한 검사(Codex C2 8절).
 * 서버·프록시가 연결만 받고 응답(머리 또는 본문)을 끝내지 않으면 폴링과 다시 듣기가 영구히 멈췄다.
 * 이제 요청마다 본문 읽기까지 시간 상한이 있고, 넘으면 timeout 오류로 안내·재시도한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createRequest, describeError, errorMessages, loadFailureView } from "../src/api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const kindOf = (error: unknown) => (error instanceof ApiError ? error.kind : "unknown");

describe("요청 시간 상한", () => {
  test("응답 머리가 오지 않으면 시간 상한 뒤 timeout이고 요청을 끊는다", async () => {
    let signal: AbortSignal | undefined;
    const request = createRequest((_input, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => undefined); });
    const started = Date.now();
    await assert.rejects(request("/api/dashboard", { timeoutMs: 30 }), error => kindOf(error) === "timeout");
    assert.ok(Date.now() - started < 1000);
    assert.equal(signal?.aborted, true);
  });

  test("본문이 끝나지 않아도 시간 상한 뒤 timeout이다", async () => {
    const endless = () => new Response(new ReadableStream({ start() { /* 끝내지 않는다 */ } }), { status: 200 });
    const request = createRequest(async () => endless());
    await assert.rejects(request("/api/dashboard", { timeoutMs: 30 }), error => kindOf(error) === "timeout");
  });

  test("제때 온 응답은 그대로 풀고, 방법·캐시 설정을 넘긴다", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const request = createRequest(async (_input, init) => { seen.push(init); return json(200, { started: true }); });
    assert.deepEqual(await request("/api/er/refresh", { method: "POST", timeoutMs: 1000 }), { started: true });
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.cache, "no-store");
  });

  test("네트워크 오류는 disconnected, 서버 오류 응답은 그 종류 그대로다", async () => {
    await assert.rejects(createRequest(async () => { throw new TypeError("fetch failed"); })("/api/dashboard"), error => kindOf(error) === "disconnected");
    await assert.rejects(createRequest(async () => json(409, { error: "x" }))("/api/narration/replay"), error => kindOf(error) === "conflict");
  });

  test("timeout 안내 문구가 있다", () => {
    assert.equal(describeError(new ApiError("timeout", null, null)), errorMessages.timeout);
    assert.match(errorMessages.timeout, /응답/);
  });
});

describe("상태 받기 실패 안내", () => {
  test("시간 초과는 연결 끊김이 아니라 늦다는 안내이고, 끊김은 배너로 알린다", () => {
    assert.deepEqual(loadFailureView(new ApiError("timeout", null, null)), { disconnected: false, notice: errorMessages.timeout });
    assert.deepEqual(loadFailureView(new ApiError("disconnected", null, null)), { disconnected: true, notice: null });
    assert.deepEqual(loadFailureView(new TypeError("x")), { disconnected: true, notice: null });
    assert.deepEqual(loadFailureView(new ApiError("server", 500, "x")), { disconnected: false, notice: errorMessages.server });
  });
});
