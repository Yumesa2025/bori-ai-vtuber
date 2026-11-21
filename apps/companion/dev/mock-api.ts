import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createMockStore, createToneWav, mockScenarios, type MockResult } from "./mock-store";

/**
 * `vite --mode mock`에서만 붙는 가짜 대시보드 API 미들웨어.
 * Vite 내부 프록시보다 먼저 `/api`를 가로채므로 실제 서버 없이 화면을 확인할 수 있다.
 *
 * - 상태 바꾸기: `POST /__mock/scenario` 본문 `{ "name": "refreshing" }`. `GET /__mock/scenario`는 지금 상태와 목록.
 *   처음 상태는 환경 변수 `BORI_MOCK_SCENARIO`로도 정할 수 있다(기본 ready).
 * - 서버 다운 흉내: `POST /__mock/down` 본문 `{ "down": true }`이면 이후 `/api` 요청에
 *   프록시가 서버를 못 찾았을 때처럼 JSON이 아닌 502를 준다. `{ "down": false }`로 되돌린다.
 * - 비공개 자산(Cubism SDK)이 없는 체크아웃에서도 화면이 뜨게, SDK 샘플 import를 "SDK 없음" 모듈로 바꿔 준다.
 *   그러면 Live2D는 모델 없음 상태가 되고 자막·음성은 그대로 동작한다. SDK가 있으면 진짜 파일을 쓴다.
 */

/** 별칭 @sdk-sample/lappdelegate가 풀린 경로(확장자 없음) */
const SDK_SAMPLE_PATTERN = /[\\/]Samples[\\/]TypeScript[\\/]Demo[\\/]src[\\/]lappdelegate$/;
const MISSING_SDK_ID = "\0bori-missing-cubism-sdk";
const MISSING_SDK_MODULE = `export class LAppDelegate {
  static getInstance() { throw new Error("Cubism SDK가 없어 Live2D를 띄우지 않습니다(가짜 API 모드)."); }
  static releaseInstance() {}
}`;

export function mockApi(): Plugin {
  const initial = mockScenarios.find(name => name === process.env.BORI_MOCK_SCENARIO) ?? "ready";
  const store = createMockStore(initial);
  let down = false;

  const readBody = (request: IncomingMessage) => new Promise<string>(resolveBody => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => resolveBody(text));
  });

  const sendJson = (response: ServerResponse, result: MockResult) => {
    response.statusCode = result.status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(result.body));
  };

  /** 설계 4절의 경로를 그대로 옮긴 표. 맞는 것이 없으면 404를 준다. */
  const routes: Record<string, (body: unknown) => MockResult> = {
    "GET /api/dashboard": () => store.dashboard(),
    "POST /api/er/refresh": () => store.refresh(),
    "POST /api/narration/replay": () => store.replay(),
    "GET /api/dashboard/settings": () => store.settings(),
    "PUT /api/dashboard/settings": body => store.saveSettings(body),
    "GET /__mock/scenario": () => ({ status: 200, body: { scenario: store.scenario(), scenarios: mockScenarios } }),
    "POST /__mock/scenario": body => store.setScenario(body),
  };

  return {
    name: "bori-dashboard-mock-api",
    // 별칭이 풀린 뒤, Vite가 파일을 찾기 전에 SDK 없음을 가로챈다.
    enforce: "pre",
    resolveId(id) {
      return SDK_SAMPLE_PATTERN.test(id) && !existsSync(`${id}.ts`) ? MISSING_SDK_ID : null;
    },
    load(id) {
      return id === MISSING_SDK_ID ? MISSING_SDK_MODULE : null;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        const method = request.method ?? "GET";

        if (url === "/__mock/down" && method === "POST") {
          try { down = JSON.parse(await readBody(request)).down === true; } catch { down = !down; }
          sendJson(response, { status: 200, body: { down } });
          return;
        }
        if (!url.startsWith("/api/") && !url.startsWith("/__mock/")) { next(); return; }

        if (down && url.startsWith("/api/")) {
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
        if (method === "POST" || method === "PUT") {
          const text = await readBody(request);
          try { body = text ? JSON.parse(text) : {}; } catch { sendJson(response, { status: 400, body: { error: "잘못된 JSON입니다." } }); return; }
        }

        const handler = routes[`${method} ${url}`];
        sendJson(response, handler ? handler(body) : { status: 404, body: { error: "없는 경로입니다." } });
      });
    },
  };
}
