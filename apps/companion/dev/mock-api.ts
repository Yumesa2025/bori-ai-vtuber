import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createMockStore, createToneWav, type MockResult } from "./mock-store";

/**
 * `vite --mode mock`에서만 붙는 가짜 API 미들웨어.
 * Vite 내부 프록시보다 먼저 `/api`를 가로채므로 실제 서버 없이 화면을 확인할 수 있다.
 *
 * 서버 다운 흉내: `POST /__mock/down` 본문 `{ "down": true }`이면 이후 `/api` 요청에
 * 프록시가 서버를 못 찾았을 때처럼 JSON이 아닌 502를 준다. `{ "down": false }`로 되돌린다.
 */
export function mockApi(): Plugin {
  const store = createMockStore();
  let down = false;

  const readBody = (request: IncomingMessage) => new Promise<string>(resolveBody => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => resolveBody(text));
  });

  const sendJson = (response: ServerResponse, result: MockResult) => {
    response.statusCode = result.status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(result.body));
  };

  /** 계약의 경로를 그대로 옮긴 표. 맞는 것이 없으면 404를 준다. */
  const routes: { method: string; pattern: RegExp; handle: (params: string[], body: unknown) => MockResult | Promise<MockResult> }[] = [
    { method: "GET", pattern: /^\/api\/conversations$/, handle: () => store.listConversations() },
    { method: "POST", pattern: /^\/api\/conversations$/, handle: (_, body) => store.createConversation(body) },
    { method: "GET", pattern: /^\/api\/conversations\/([^/]+)\/messages$/, handle: ([id]) => store.getMessages(id) },
    { method: "DELETE", pattern: /^\/api\/conversations\/([^/]+)$/, handle: ([id]) => store.deleteConversation(id) },
    {
      method: "POST",
      pattern: /^\/api\/conversations\/([^/]+)\/messages$/,
      handle: async ([id], body) => {
        const pending = store.sendMessage(id, body);
        if (!pending.finish) return pending;
        await new Promise(resolveDelay => setTimeout(resolveDelay, pending.delayMs ?? 0));
        return pending.finish();
      },
    },
    { method: "GET", pattern: /^\/api\/me\/memories$/, handle: () => store.listMemories() },
    { method: "DELETE", pattern: /^\/api\/me\/memories$/, handle: () => store.deleteAllMemories() },
    { method: "DELETE", pattern: /^\/api\/me\/memories\/([^/]+)$/, handle: ([id]) => store.deleteMemory(id) },
    { method: "DELETE", pattern: /^\/api\/me\/data$/, handle: () => store.deleteAllData() },
    { method: "GET", pattern: /^\/api\/character\/profile$/, handle: () => store.profile() },
    { method: "GET", pattern: /^\/api\/character\/catalog$/, handle: () => store.catalog() },
  ];

  const route = async (method: string, url: string, body: unknown): Promise<MockResult | null> => {
    for (const candidate of routes) {
      const match = candidate.method === method ? candidate.pattern.exec(url) : null;
      if (match) return candidate.handle(match.slice(1).map(decodeURIComponent), body);
    }
    return null;
  };

  return {
    name: "bori-companion-mock-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        const method = request.method ?? "GET";

        if (url === "/__mock/down" && method === "POST") {
          try { down = JSON.parse(await readBody(request)).down === true; } catch { down = !down; }
          sendJson(response, { status: 200, body: { down } });
          return;
        }
        if (!url.startsWith("/api/")) { next(); return; }

        if (down) {
          response.statusCode = 502;
          response.setHeader("Content-Type", "text/plain");
          response.end("mock: server down");
          return;
        }

        if (method === "GET" && url.startsWith("/api/tts/")) {
          const id = decodeURIComponent(url.slice("/api/tts/".length));
          if (!store.hasAudio(id)) { sendJson(response, { status: 404, body: { error: "음성을 찾을 수 없습니다." } }); return; }
          response.statusCode = 200;
          response.setHeader("Content-Type", "audio/wav");
          response.end(createToneWav());
          return;
        }

        let body: unknown = null;
        if (method === "POST") {
          const text = await readBody(request);
          try { body = text ? JSON.parse(text) : {}; } catch { sendJson(response, { status: 400, body: { error: "잘못된 JSON입니다." } }); return; }
        }

        const result = await route(method, url, body);
        sendJson(response, result ?? { status: 404, body: { error: "없는 경로입니다." } });
      });
    },
  };
}
