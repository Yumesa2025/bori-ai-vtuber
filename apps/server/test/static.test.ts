/**
 * 대시보드·스튜디오 빌드와 Live2D 자산을 서버가 그대로 내주는 정적 파일 제공 검사.
 * 경로 탈출(.., 인코딩된 .., 역슬래시, 드라이브 경로)을 막는지, 파일이 없을 때 JSON으로 답하는지,
 * 다른 출처가 iframe으로 띄우지 못하게 하는 헤더(클릭재킹 방지)가 붙는지 본다.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentTypeFor, resolveStaticPath, serveStatic, type StaticRoute } from "../src/http/static.js";

// 운영체제마다 절대 경로 모양이 달라(Windows 드라이브 문자) 실제 임시 폴더 아래 경로로 비교한다.
const root = resolve(tmpdir(), "bori-static-root/apps/companion/dist");
test("접두사 아래 파일을 루트 안 경로로 푼다", () => {
  assert.equal(resolveStaticPath("/private-model/page.html", "/private-model/", root), join(root, "private-model", "page.html"));
});
test("상위 경로 탈출은 거부한다", () => {
  for (const url of ["/private-model/../secret.json", "/private-model/%2e%2e/secret.json", "/private-model/..\\secret.json", "/private-model/C:/Windows/win.ini"]) {
    assert.equal(resolveStaticPath(url, "/private-model/", root), null, url);
  }
});
test("쿼리스트링은 경로에서 뺀다", () => {
  assert.equal(resolveStaticPath("/private-model/page.html?demo=1", "/private-model/", root), join(root, "private-model", "page.html"));
});
test("접두사가 다르거나 인코딩이 깨지면 null", () => {
  assert.equal(resolveStaticPath("/private-modelx/a.html", "/private-model/", root), null);
  assert.equal(resolveStaticPath("/private-model/%E0%A4%A", "/private-model/", root), null);
});
test("MIME", () => {
  assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("a.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("a.moc3"), "application/octet-stream");
  assert.equal(contentTypeFor("a.frag"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("a.woff2"), "font/woff2");
  assert.equal(contentTypeFor("a.model3.json"), "application/json; charset=utf-8");
});

describe("serveStatic", () => {
  let server: Server;
  let port = 0;
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bori-static-"));
    await mkdir(join(dir, "dist/private-model/assets"), { recursive: true });
    await writeFile(join(dir, "dist/private-model/page.html"), "<p>화면</p>");
    await writeFile(join(dir, "dist/private-model/assets/a.js"), "export {};");
    await writeFile(join(dir, "dist/secret.json"), "{}");
    await mkdir(join(dir, "companion"), { recursive: true });
    await writeFile(join(dir, "companion/index.html"), "<p>대시보드</p>");
    const routes: StaticRoute[] = [
      { prefix: "/private-model/", root: join(dir, "dist"), build: "npm run build:companion" },
      // 대시보드 빌드는 접두사를 떼고 dist 바로 아래에서 찾는다.
      { prefix: "/companion/", root: join(dir, "companion"), build: "npm run build:companion", stripPrefix: true },
      { prefix: "/studio/", root: join(dir, "missing"), build: "npm run build:admin", stripPrefix: true },
    ];
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (serveStatic(request, response, routes)) return;
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Not found" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** fetch는 ..를 미리 풀어 보내므로 node:http로 경로를 그대로 보낸다. */
  function send(path: string, method = "GET"): Promise<{ status: number; type: string; cache: string; csp: string; frameOptions: string; nosniff: string; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port, path, method }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          type: String(response.headers["content-type"] ?? ""),
          cache: String(response.headers["cache-control"] ?? ""),
          csp: String(response.headers["content-security-policy"] ?? ""),
          frameOptions: String(response.headers["x-frame-options"] ?? ""),
          nosniff: String(response.headers["x-content-type-options"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  test("파일을 MIME과 캐시 없음으로 내준다", async () => {
    const page = await send("/private-model/page.html?demo=1");
    assert.equal(page.status, 200);
    assert.equal(page.type, "text/html; charset=utf-8");
    assert.equal(page.cache, "no-store");
    assert.equal(page.body, "<p>화면</p>");
    assert.equal((await send("/private-model/assets/a.js")).type, "text/javascript; charset=utf-8");
  });

  test("HEAD는 본문 없이 헤더만", async () => {
    const head = await send("/private-model/page.html", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.type, "text/html; charset=utf-8");
    assert.equal(head.body, "");
  });

  test("없는 파일과 접두사 밖 경로는 404 JSON", async () => {
    for (const path of ["/private-model/none.html", "/private-model/../secret.json", "/private-model/%2e%2e/secret.json"]) {
      const result = await send(path);
      assert.equal(result.status, 404, path);
      assert.match(result.type, /application\/json/, path);
    }
  });

  test("디렉터리는 index.html, 접두사를 떼는 경로", async () => {
    const result = await send("/companion/");
    assert.equal(result.status, 200);
    assert.equal(result.body, "<p>대시보드</p>");
  });

  test("빌드가 없으면 503과 빌드 명령 안내", async () => {
    const result = await send("/studio/");
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { error: "화면을 먼저 빌드하세요: npm run build:admin" });
  });

  test("모든 정적 응답은 다른 출처의 iframe을 막고 MIME 추측을 끈다", async () => {
    // 스튜디오(/studio/)는 API 키를 다룬다. 다른 웹사이트가 투명 iframe으로 덮어 버튼을 누르게 하지 못하게 한다(클릭재킹).
    // 200·404·503 모두 붙는다. 스튜디오가 /companion/을 iframe으로 띄우는 것은 같은 출처라 'self'로 허용된다.
    for (const path of ["/private-model/page.html", "/companion/", "/private-model/none.html", "/private-model/../secret.json", "/studio/"]) {
      const result = await send(path);
      assert.equal(result.csp, "frame-ancestors 'self'", path);
      assert.equal(result.frameOptions, "SAMEORIGIN", path);
      assert.equal(result.nosniff, "nosniff", path);
    }
  });

  test("다른 경로는 넘긴다", async () => {
    assert.equal((await send("/api/state")).status, 404);
  });
});
