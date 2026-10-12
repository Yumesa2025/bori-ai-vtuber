/**
 * 경로 인코딩 검사.
 * 실제 라우트처럼 경로 조각을 decodeURIComponent로 푸는 작은 서버를 띄운다.
 * 가드가 깨진 인코딩을 먼저 거르지 않으면 이 서버는 첫 요청에 프로세스째 죽는다.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { allowedOriginsFrom, guardRequest } from "../src/http/guard.js";

let server: Server;
let port = 0;

before(async () => {
  const options = { allowedOrigins: allowedOriginsFrom(undefined) };
  server = createServer((request, response) => {
    if (!guardRequest(request, response, options)) return;
    // index.ts의 /api/tts/:id, /api/memory/:id와 같은 방식으로 푼다.
    const id = decodeURIComponent((request.url ?? "").split("?")[0].slice("/api/item/".length));
    response.end(JSON.stringify({ id }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>(resolve => server.close(() => resolve())));

/** fetch는 깨진 인코딩을 고쳐 보내므로 node:http로 경로를 그대로 보낸다. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("경로 인코딩", () => {
  test("깨진 퍼센트 인코딩은 400이고 서버는 계속 응답한다", async () => {
    for (const path of ["/api/item/%E0%A4%A", "/api/item/%", "/api/item/%zz"]) {
      const reply = await get(path);
      assert.equal(reply.status, 400, path);
      assert.equal(typeof JSON.parse(reply.body).error, "string");
    }
    const alive = await get("/api/item/abc");
    assert.equal(alive.status, 200);
  });

  test("올바르게 인코딩한 한글 ID는 통과한다", async () => {
    const reply = await get(`/api/item/${encodeURIComponent("보리-1")}`);
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(reply.body).id, "보리-1");
  });

  test("쿼리의 퍼센트 기호는 보지 않는다", async () => {
    const reply = await get("/api/item/abc?q=100%");
    assert.equal(reply.status, 200);
  });

  test("허용 밖 Origin은 인코딩과 상관없이 403이 먼저다", async () => {
    const reply = await get("/api/item/%E0%A4%A", { Origin: "https://evil.example" });
    assert.equal(reply.status, 403);
  });
});
