/**
 * 빌드한 화면(대시보드·스튜디오)과 Live2D 자산을 서버가 그대로 내주는 정적 파일 제공.
 *
 * 스튜디오와 브라우저가 Vite 없이 서버 주소 하나로 화면을 열 수 있게 한다.
 * 요청 경로는 접두사 폴더 밖으로 나가지 못하고, 캐시하지 않아 다시 빌드하면 바로 반영된다.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * URL 접두사와 빌드 폴더의 대응.
 * 기본은 접두사를 남긴 채 root 아래에서 찾는다(`/private-core/a.js` → `root/private-core/a.js`).
 * stripPrefix면 접두사를 떼고 root 바로 아래에서 찾는다(`/companion/a.html` → `root/a.html`).
 */
export type StaticRoute = { prefix: string; root: string; build: string; stripPrefix?: boolean };

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  // 화면에 함께 넣은 글꼴(Pretendard).
  ".woff2": "font/woff2",
  ".moc3": "application/octet-stream",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  // Live2D 셰이더 원문.
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  return contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 요청 URL이 가리키는 파일 경로. 접두사가 다르거나 접두사 폴더 밖으로 풀리면 null이다.
 * 경로 비교는 `tools/vite/private-assets.ts`의 allowedFilePath와 같이 relative로 본다.
 * 역슬래시·드라이브 문자(`:`)는 운영체제마다 다르게 풀리므로 아예 받지 않는다.
 */
export function resolveStaticPath(url: string, prefix: string, root: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.split("?")[0]);
  } catch {
    return null;
  }
  if (!path.startsWith(prefix) || /[\\:\0]/.test(path)) return null;

  const base = resolve(root, `.${prefix}`);
  const filePath = resolve(root, `.${path}`);
  const rel = relative(base, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return filePath;
}

/**
 * 정적 응답에 붙이는 보안 헤더.
 * 스튜디오(/studio/)는 API 키를 다루므로 다른 웹사이트가 투명 iframe으로 덮어 버튼을 누르게 하지 못하게 한다(클릭재킹).
 * frame-ancestors는 meta CSP로는 효과가 없어 응답 헤더로 준다. 이 헤더 CSP는 frame-ancestors만 담아 화면의 meta CSP를 넓히지 않는다.
 * 스튜디오가 /companion/을 iframe으로 띄우는 것은 같은 출처라 'self'로 그대로 된다. X-Frame-Options는 frame-ancestors를 모르는 브라우저용이다.
 */
export const staticSecurityHeaders: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
};

function sendError(response: ServerResponse, status: number, error: string) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

/** 디렉터리면 그 안의 index.html. 파일이 없으면 null. */
async function readStaticFile(filePath: string): Promise<{ path: string; data: Buffer } | null> {
  try {
    const target = (await stat(filePath)).isDirectory() ? join(filePath, "index.html") : filePath;
    return { path: target, data: await readFile(target) };
  } catch {
    return null;
  }
}

/**
 * 접두사가 맞는 경로를 처리하고 true를 돌려준다. 맞는 접두사가 없으면 응답하지 않고 false.
 * 빌드 폴더가 없으면 503으로 빌드 명령을 알린다. 응답은 미리 정한 JSON Content-Type을 덮어쓴다.
 */
export function serveStatic(request: IncomingMessage, response: ServerResponse, routes: readonly StaticRoute[]): boolean {
  const url = request.url ?? "/";
  const route = routes.find(candidate => url.startsWith(candidate.prefix));
  if (!route) return false;

  // 200·404·503 모두에 붙인다.
  for (const [name, value] of Object.entries(staticSecurityHeaders)) response.setHeader(name, value);
  if (!existsSync(route.root)) { sendError(response, 503, `화면을 먼저 빌드하세요: ${route.build}`); return true; }

  const filePath = route.stripPrefix
    ? resolveStaticPath(`/${url.slice(route.prefix.length)}`, "/", route.root)
    : resolveStaticPath(url, route.prefix, route.root);
  if (!filePath) { sendError(response, 404, "Not found"); return true; }

  void readStaticFile(filePath).then(file => {
    if (!file) { sendError(response, 404, "Not found"); return; }
    response.writeHead(200, { "Content-Type": contentTypeFor(file.path), "Content-Length": file.data.length, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : file.data);
  });
  return true;
}
