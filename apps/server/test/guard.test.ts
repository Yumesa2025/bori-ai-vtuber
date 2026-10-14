/**
 * 보안 경계 단위 검사.
 * 가드와 본문 읽기 헬퍼만 붙인 작은 서버를 임의 포트로 띄워 실제 HTTP로 확인한다.
 * Host 헤더를 직접 지정해야 해서 fetch 대신 node:http로 보낸다.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { allowedOriginsFrom, BODY_LIMIT_BYTES, guardRequest, hostnameOf, isPrivatePathForBroadcast, readBody } from "../src/http/guard.js";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

let server: Server;
let port = 0;

/** 가드를 통과하면 받은 본문 길이를 돌려주는 서버. */
before(async () => {
  const options = { allowedOrigins: allowedOriginsFrom("https://studio.example.com, not-an-origin") };
  server = createServer((request, response) => {
    if (!guardRequest(request, response, options)) return;
    if (request.method === "GET") { response.end(JSON.stringify({ ok: true })); return; }
    readBody(request, response, body => response.end(JSON.stringify({ length: body.length, body })));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>(resolve => server.close(() => resolve())));

function send(method: string, headers: Record<string, string> = {}, body?: string | Buffer, { chunked = false, path = "/api/test" } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    if (body === undefined) { outgoing.end(); return; }
    if (chunked) {
      // 길이를 선언하지 않고 조각으로 보낸다. 가드는 크기를 미리 알 수 없어 readBody가 끊어야 한다.
      const data = Buffer.from(body);
      for (let offset = 0; offset < data.length; offset += 8 * 1024) outgoing.write(data.subarray(offset, offset + 8 * 1024));
      outgoing.end();
      return;
    }
    outgoing.end(body);
  });
}

const json = { "Content-Type": "application/json" };

describe("허용 Origin 목록", () => {
  test("기본값은 클라이언트 포트의 127.0.0.1과 localhost다", () => {
    const origins = allowedOriginsFrom(undefined);
    for (const port of [4173, 4174, 4175, 4176, 5174]) {
      assert.ok(origins.has(`http://127.0.0.1:${port}`));
      assert.ok(origins.has(`http://localhost:${port}`));
    }
    assert.equal(origins.size, 10);
    assert.ok(!origins.has("http://127.0.0.1:4310"));
  });

  test("환경변수 항목을 Origin 형식으로 맞춰 덧붙이고 잘못된 항목은 버린다", () => {
    const origins = allowedOriginsFrom(" http://192.168.0.10:4173/ ,ftp://x.example, , nonsense");
    assert.ok(origins.has("http://192.168.0.10:4173"));
    assert.equal(origins.size, 11);
  });

  test("Host에서 포트를 뺀 호스트명만 본다", () => {
    assert.equal(hostnameOf("127.0.0.1:4310"), "127.0.0.1");
    assert.equal(hostnameOf("LOCALHOST"), "localhost");
    assert.equal(hostnameOf("[::1]:4310"), "[::1]");
    assert.equal(hostnameOf("evil.example:4310"), "evil.example");
  });
});

describe("Origin 검사", () => {
  test("Origin이 없으면 통과하고 CORS 헤더를 붙이지 않는다", async () => {
    const reply = await send("GET");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["access-control-allow-origin"], undefined);
    assert.equal(reply.headers.vary, "Origin");
  });

  test("허용된 Origin은 통과하고 그 Origin을 되돌려 준다", async () => {
    const reply = await send("GET", { Origin: "http://localhost:5174" });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["access-control-allow-origin"], "http://localhost:5174");
  });

  test("환경변수로 덧붙인 Origin도 통과한다", async () => {
    const reply = await send("GET", { Origin: "https://studio.example.com" });
    assert.equal(reply.status, 200);
  });

  test("허용 밖 Origin은 403이고 CORS 헤더가 없다", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:4310", "null", "http://127.0.0.1:41730"]) {
      const reply = await send("GET", { Origin: origin });
      assert.equal(reply.status, 403, origin);
      assert.equal(reply.headers["access-control-allow-origin"], undefined, origin);
      assert.ok(typeof JSON.parse(reply.body).error === "string");
    }
  });

  test("허용 밖 Origin의 사전 요청도 403이다", async () => {
    const reply = await send("OPTIONS", { Origin: "https://evil.example", "Access-Control-Request-Method": "PATCH" });
    assert.equal(reply.status, 403);
  });

  test("허용된 Origin의 사전 요청은 204와 허용 메서드를 돌려준다", async () => {
    const reply = await send("OPTIONS", { Origin: "http://127.0.0.1:4173", "Access-Control-Request-Method": "PATCH" });
    assert.equal(reply.status, 204);
    assert.equal(reply.headers["access-control-allow-origin"], "http://127.0.0.1:4173");
    assert.match(String(reply.headers["access-control-allow-methods"]), /PATCH/);
  });
});

describe("방송 화면 Origin의 경로 제한 (점검 X-1)", () => {
  const privatePaths = ["/api/conversations", "/api/conversations/abc", "/api/me/memories", "/api/me/data", "/api/memory", "/api/memory/m1", "/api/conversations?x=1"];

  test("방송 화면 Origin은 1:1 대화·기억 경로에서 403이고 CORS 헤더가 없다", async () => {
    for (const origin of ["http://127.0.0.1:4173", "http://localhost:4174"]) {
      for (const path of privatePaths) {
        const reply = await send("GET", { Origin: origin }, undefined, { path });
        assert.equal(reply.status, 403, `${origin} ${path}`);
        assert.equal(reply.headers["access-control-allow-origin"], undefined, `${origin} ${path}`);
      }
    }
  });

  test("방송 화면 Origin의 사전 요청도 막는다", async () => {
    const reply = await send("OPTIONS", { Origin: "http://127.0.0.1:4173", "Access-Control-Request-Method": "DELETE" }, undefined, { path: "/api/me/data" });
    assert.equal(reply.status, 403);
  });

  test("방송 화면 Origin도 방송 경로는 그대로 쓴다", async () => {
    for (const path of ["/api/state", "/api/chat", "/api/tts/abc"]) {
      const reply = await send("GET", { Origin: "http://127.0.0.1:4173" }, undefined, { path });
      assert.equal(reply.status, 200, path);
    }
  });

  test("1:1 화면과 관리자 Origin, Origin 없는 요청은 1:1 경로를 쓸 수 있다", async () => {
    const cases: Record<string, string>[] = [{ Origin: "http://127.0.0.1:4175" }, { Origin: "http://localhost:4176" }, { Origin: "http://127.0.0.1:5174" }, {}];
    for (const headers of cases) {
      const reply = await send("GET", headers, undefined, { path: "/api/me/memories" });
      assert.equal(reply.status, 200, JSON.stringify(headers));
    }
  });

  test("접두사만 같은 다른 경로는 막지 않는다", () => {
    assert.equal(isPrivatePathForBroadcast("/api/memorybox"), false);
    assert.equal(isPrivatePathForBroadcast("/api/meta"), false);
    assert.equal(isPrivatePathForBroadcast("/api/me"), true);
  });
});

describe("Host 검사", () => {
  test("루프백 호스트명은 포트와 상관없이 통과한다", async () => {
    for (const host of ["127.0.0.1:4310", "localhost:4173", "[::1]:4310", "localhost"]) {
      assert.equal((await send("GET", { Host: host })).status, 200, host);
    }
  });

  test("다른 호스트명은 421이다 (DNS rebinding)", async () => {
    for (const host of ["evil.example:4310", "127.0.0.1.nip.io:4310", "192.168.0.10:4310"]) {
      assert.equal((await send("GET", { Host: host })).status, 421, host);
    }
  });
});

describe("Content-Type 검사", () => {
  test("본문이 있는 POST가 application/json이 아니면 415다", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      assert.equal((await send("POST", { "Content-Type": type }, '{"content":"x"}')).status, 415, type);
    }
    assert.equal((await send("POST", {}, '{"content":"x"}')).status, 415, "Content-Type 없음");
  });

  test("PATCH·PUT도 같은 규칙이다", async () => {
    assert.equal((await send("PATCH", { "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.equal((await send("PUT", { "Content-Type": "text/plain" }, "{}")).status, 415);
  });

  test("charset이 붙은 application/json은 통과한다", async () => {
    const reply = await send("POST", { "Content-Type": "application/json; charset=utf-8" }, '{"a":1}');
    assert.equal(reply.status, 200);
  });

  test("본문 없는 POST는 Content-Type 없이 통과한다", async () => {
    assert.equal((await send("POST", { "Content-Length": "0" })).status, 200);
  });

  test("본문 없는 POST라도 허용 밖 Origin이면 403이다", async () => {
    assert.equal((await send("POST", { "Content-Length": "0", Origin: "https://evil.example" })).status, 403);
  });
});

describe("본문 크기 제한", () => {
  test("상한까지는 받는다", async () => {
    const body = JSON.stringify({ text: "a".repeat(BODY_LIMIT_BYTES - 20) });
    const reply = await send("POST", json, body);
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(reply.body).length, body.length);
  });

  test("선언된 길이가 상한을 넘으면 413이다", async () => {
    const reply = await send("POST", json, JSON.stringify({ text: "a".repeat(BODY_LIMIT_BYTES) }));
    assert.equal(reply.status, 413);
    assert.ok(typeof JSON.parse(reply.body).error === "string");
  });

  test("길이를 선언하지 않은 본문도 상한을 넘으면 413이다", async () => {
    const reply = await send("POST", json, JSON.stringify({ text: "a".repeat(BODY_LIMIT_BYTES * 2) }), { chunked: true });
    assert.equal(reply.status, 413);
  });

  test("여러 조각에 걸친 한글이 깨지지 않는다", async () => {
    const body = JSON.stringify({ text: "보리".repeat(5000) });
    const reply = await send("POST", json, body, { chunked: true });
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(reply.body).body, body);
  });
});
