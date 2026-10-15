/**
 * OBS 페이지 정적 제공 검사.
 *
 * 서버가 빌드한 OBS 페이지 6종을 /obs/ 아래로 내주는지, 페이지의 모듈 스크립트를 서버 자신의 Origin으로 받을 수 있는지,
 * 경로 탈출 요청을 막는지 실제 서버로 확인한다. fetch는 ..를 미리 풀어 보내므로 탈출 검사는 node:http로 경로를 그대로 보낸다.
 * 방송 화면을 빌드하지 않았으면(npm run build:broadcast) 페이지 대신 503 안내를 확인한다.
 */
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { projectRoot } from "./harness.mjs";

export const meta = {
  name: "OBS 페이지",
  timing: { llm: 100, tts: 100, embed: 50 },
};

const PAGES = ["character", "dashboard", "caption", "chat", "waiting", "ending", "background"];
const distDir = join(projectRoot, "apps/broadcast/dist");

/** 경로를 고치지 않고 그대로 보낸다. */
function rawRequest(baseUrl, path, { method = "GET", headers = {} } = {}) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname, port, path, method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export async function run({ bori, report }) {
  if (!existsSync(distDir)) {
    const response = await rawRequest(bori.baseUrl, "/obs/character.html");
    const body = JSON.parse(response.body || "{}");
    report.check("빌드가 없으면 503으로 빌드 명령을 알린다", response.status === 503 && body.error === "화면을 먼저 빌드하세요: npm run build:broadcast", `status=${response.status}`);
    report.note("방송 화면 빌드가 없어 페이지 응답 검사는 건너뛴다. npm run build:broadcast 후 다시 돌린다.");
    return;
  }

  // ── 페이지 7종 ──────────────────────────────────────────────
  let characterHtml = "";
  for (const name of PAGES) {
    const response = await rawRequest(bori.baseUrl, `/obs/${name}.html?demo=1`);
    if (name === "character") characterHtml = response.body;
    report.check(
      `/obs/${name}.html은 200 text/html, 캐시 없음`,
      response.status === 200 && response.headers["content-type"] === "text/html; charset=utf-8" && response.headers["cache-control"] === "no-store",
      `status=${response.status} type=${response.headers["content-type"]}`,
    );
  }

  // ── 페이지가 부르는 스크립트 ────────────────────────────────
  // 모듈 스크립트(crossorigin)는 서버 자신의 Origin을 보낸다. 가드가 막으면 페이지가 빈 화면이 된다.
  {
    const script = characterHtml.match(/<script type="module" crossorigin src="([^"]+)"/)?.[1] ?? "";
    const response = await rawRequest(bori.baseUrl, script || "/obs/assets/none.js", { headers: { Origin: bori.baseUrl } });
    report.check(
      "페이지의 모듈 스크립트를 서버 자신의 Origin으로 받는다",
      script.startsWith("/obs/assets/") && response.status === 200 && response.headers["content-type"] === "text/javascript; charset=utf-8",
      `src=${script} status=${response.status}`,
    );
  }
  {
    const response = await rawRequest(bori.baseUrl, "/obs/chat.html", { method: "HEAD" });
    report.check("HEAD는 본문 없이 200", response.status === 200 && response.body === "", `status=${response.status}`);
  }

  // ── 경로 탈출 ──────────────────────────────────────────────
  for (const path of ["/obs/../package.json", "/obs/%2e%2e/package.json", "/obs/..%5cpackage.json", "/obs/../../../package.json"]) {
    const response = await rawRequest(bori.baseUrl, path);
    report.check(`${path}는 404이고 파일을 내주지 않는다`, response.status === 404 && !response.body.includes("\"name\""), `status=${response.status}`);
  }

  // 정적 경로는 API 라우트를 가리지 않는다.
  {
    const response = await bori.get("/api/state");
    report.check("정적 경로를 더해도 /api/state는 그대로다", response.status === 200 && response.body?.status === "idle", `status=${response.status}`);
  }
}
