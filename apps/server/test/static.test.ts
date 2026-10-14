/**
 * OBS 페이지·1:1·스튜디오 빌드를 서버가 그대로 내주는 정적 파일 제공 검사.
 * 경로 탈출(.., 인코딩된 .., 역슬래시, 드라이브 경로)을 막는지, 파일이 없을 때 JSON으로 답하는지 본다.
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
const root = resolve(tmpdir(), "bori-static-root/apps/broadcast/dist");
test("접두사 아래 파일을 루트 안 경로로 푼다", () => {
  assert.equal(resolveStaticPath("/obs/character.html", "/obs/", root), join(root, "obs", "character.html"));
});
test("상위 경로 탈출은 거부한다", () => {
  for (const url of ["/obs/../secret.json", "/obs/%2e%2e/secret.json", "/obs/..\\secret.json", "/obs/C:/Windows/win.ini"]) {
    assert.equal(resolveStaticPath(url, "/obs/", root), null, url);
  }
});
test("쿼리스트링은 경로에서 뺀다", () => {
  assert.equal(resolveStaticPath("/obs/chat.html?demo=1", "/obs/", root), join(root, "obs", "chat.html"));
});
test("접두사가 다르거나 인코딩이 깨지면 null", () => {
  assert.equal(resolveStaticPath("/obsx/a.html", "/obs/", root), null);
  assert.equal(resolveStaticPath("/obs/%E0%A4%A", "/obs/", root), null);
});
test("MIME", () => {
  assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("a.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("a.moc3"), "application/octet-stream");
  assert.equal(contentTypeFor("a.frag"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("a.model3.json"), "application/json; charset=utf-8");
});

describe("serveStatic", () => {
  let server: Server;
  let port = 0;
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bori-static-"));
    await mkdir(join(dir, "dist/obs/assets"), { recursive: true });
    await writeFile(join(dir, "dist/obs/chat.html"), "<p>채팅</p>");
    await writeFile(join(dir, "dist/obs/assets/a.js"), "export {};");
    await writeFile(join(dir, "dist/secret.json"), "{}");
    await mkdir(join(dir, "companion"), { recursive: true });
    await writeFile(join(dir, "companion/index.html"), "<p>1:1</p>");
    const routes: StaticRoute[] = [
      { prefix: "/obs/", root: join(dir, "dist"), build: "npm run build:broadcast" },
      // 1:1 빌드는 접두사를 떼고 dist 바로 아래에서 찾는다.
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
  function send(path: string, method = "GET"): Promise<{ status: number; type: string; cache: string; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port, path, method }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          type: String(response.headers["content-type"] ?? ""),
          cache: String(response.headers["cache-control"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  test("파일을 MIME과 캐시 없음으로 내준다", async () => {
    const page = await send("/obs/chat.html?demo=1");
    assert.equal(page.status, 200);
    assert.equal(page.type, "text/html; charset=utf-8");
    assert.equal(page.cache, "no-store");
    assert.equal(page.body, "<p>채팅</p>");
    assert.equal((await send("/obs/assets/a.js")).type, "text/javascript; charset=utf-8");
  });

  test("HEAD는 본문 없이 헤더만", async () => {
    const head = await send("/obs/chat.html", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.type, "text/html; charset=utf-8");
    assert.equal(head.body, "");
  });

  test("없는 파일과 접두사 밖 경로는 404 JSON", async () => {
    for (const path of ["/obs/none.html", "/obs/../secret.json", "/obs/%2e%2e/secret.json"]) {
      const result = await send(path);
      assert.equal(result.status, 404, path);
      assert.match(result.type, /application\/json/, path);
    }
  });

  test("디렉터리는 index.html, 접두사를 떼는 경로", async () => {
    const result = await send("/companion/");
    assert.equal(result.status, 200);
    assert.equal(result.body, "<p>1:1</p>");
  });

  test("빌드가 없으면 503과 빌드 명령 안내", async () => {
    const result = await send("/studio/");
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { error: "화면을 먼저 빌드하세요: npm run build:admin" });
  });

  test("다른 경로는 넘긴다", async () => {
    assert.equal((await send("/api/state")).status, 404);
  });
});
