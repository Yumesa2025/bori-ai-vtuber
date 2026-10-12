/**
 * 로컬 API 보안 경계.
 *
 * 서버는 127.0.0.1에만 바인딩하지만, 사용자가 브라우저로 연 아무 웹사이트도 이 주소로 요청을 보낼 수 있다.
 * 모든 요청이 라우트에 닿기 전에 여기서 Host·Origin·Content-Type·본문 크기를 검사한다.
 * 라우트마다 따로 검사하면 새 라우트에서 빠뜨리기 쉬우므로 핸들러 맨 앞에서 한 번만 부른다.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** 요청 본문 상한. 설정·채팅·대화 메시지 어느 것도 이보다 클 이유가 없다. */
export const BODY_LIMIT_BYTES = 64 * 1024;

/** 방송 화면 dev·preview, 1:1 화면 dev·preview, 관리자 렌더러. */
const CLIENT_PORTS = [4173, 4174, 4175, 4176, 5174] as const;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);
/**
 * 413으로 끊은 뒤에도 이만큼은 읽어서 버린다.
 * 받지 않은 본문이 남은 채 소켓을 닫으면 TCP RST가 나가 클라이언트가 413 응답을 못 받는 경우가 있다.
 * 쌓지 않고 버리기만 하며, 이 양을 넘으면 연결을 끊는다.
 */
const DRAIN_LIMIT_BYTES = 1024 * 1024;

export type GuardOptions = { allowedOrigins: ReadonlySet<string> };

/** 문자열을 Origin 형식(scheme://host[:port])으로 맞춘다. 형식이 아니면 null. */
function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 허용 Origin 목록. 기본값은 이 저장소의 클라이언트 dev·preview 주소이고,
 * `BORI_ALLOWED_ORIGINS`(쉼표 구분)로 덧붙일 수 있다. 형식이 잘못된 항목은 무시한다.
 */
export function allowedOriginsFrom(extra: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const port of CLIENT_PORTS) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  for (const entry of (extra ?? "").split(",")) {
    if (entry.trim().length === 0) continue;
    const origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
    else console.warn(`[bori-server] BORI_ALLOWED_ORIGINS 항목을 무시합니다: ${entry.trim()}`);
  }
  return origins;
}

/** Host 헤더에서 포트를 뺀 호스트명. IPv6는 대괄호를 남긴다. */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.split(":")[0];
}

function sendError(response: ServerResponse, status: number, error: string) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

function hasBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  return Number(request.headers["content-length"] ?? 0) > 0;
}

/**
 * 경로의 퍼센트 인코딩이 올바른지. 쿼리는 쓰는 라우트가 없어 보지 않는다.
 * 라우트가 경로 조각을 decodeURIComponent로 풀 때 "%E0%A4%A" 같은 값이면 예외가 나고,
 * 요청 처리기 안의 동기 예외는 서버 프로세스를 그대로 종료시킨다.
 */
function hasValidPathEncoding(url: string): boolean {
  try {
    decodeURIComponent(url.split("?")[0]);
    return true;
  } catch {
    return false;
  }
}

function isJsonContentType(value: string | undefined): boolean {
  // charset 같은 매개변수는 허용한다.
  return (value ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

/** 413으로 답하고 남은 본문은 쌓지 않고 흘려보낸다. */
function rejectTooLarge(request: IncomingMessage, response: ServerResponse) {
  response.setHeader("Connection", "close");
  sendError(response, 413, `요청 본문은 ${BODY_LIMIT_BYTES / 1024}KB를 넘을 수 없습니다.`);
  let discarded = 0;
  request.on("data", (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > DRAIN_LIMIT_BYTES) request.destroy();
  });
  request.resume();
}

/**
 * 요청이 라우트로 넘어가도 되는지 검사한다.
 * true면 계속 처리하고, false면 이미 응답을 보냈으므로 호출부는 바로 돌아간다.
 *
 * - Host 호스트명이 루프백이 아니면 421 (DNS rebinding 방지). Vite 프록시가 포트를 바꾸므로 호스트명만 본다.
 * - Origin이 있으면 허용 목록만 통과, 아니면 403. Origin이 없는 요청(curl, 테스트 도구)은 통과한다.
 * - 허용된 Origin에는 `*` 대신 그 Origin을 되돌려 준다. 사전 요청(OPTIONS)은 여기서 끝낸다.
 * - 경로의 퍼센트 인코딩이 깨져 있으면 400. 라우트의 decodeURIComponent 예외로 서버가 죽지 않게 한다.
 * - 본문이 있는 POST·PATCH·PUT은 application/json만 받는다(415). 본문 없는 POST는 Content-Type 없이 통과한다.
 * - 선언된 본문 길이가 상한을 넘으면 읽지 않고 413. 길이를 선언하지 않은 본문은 `readBody`가 끊는다.
 */
export function guardRequest(request: IncomingMessage, response: ServerResponse, options: GuardOptions): boolean {
  // 같은 URL이 Origin에 따라 다른 헤더를 돌려주므로 캐시가 섞이지 않게 한다.
  response.setHeader("Vary", "Origin");

  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(request.headers.host ?? ""))) {
    sendError(response, 421, "허용되지 않은 Host입니다.");
    return false;
  }

  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!options.allowedOrigins.has(origin.toLowerCase())) {
      sendError(response, 403, "허용되지 않은 Origin입니다.");
      return false;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return false;
  }

  if (!hasValidPathEncoding(request.url ?? "/")) {
    sendError(response, 400, "요청 경로의 인코딩이 올바르지 않습니다.");
    return false;
  }

  if (BODY_METHODS.has(request.method ?? "") && hasBody(request)) {
    if (!isJsonContentType(request.headers["content-type"])) {
      sendError(response, 415, "요청 본문은 application/json이어야 합니다.");
      return false;
    }
    if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT_BYTES) {
      rejectTooLarge(request, response);
      return false;
    }
  }

  return true;
}

/**
 * 요청 본문을 문자열로 읽어 넘긴다. 상한을 넘으면 413으로 답하고 콜백을 부르지 않는다.
 * 조각을 Buffer로 모아 마지막에 한 번 디코딩하므로 여러 조각에 걸친 한글이 깨지지 않는다.
 */
export function readBody(request: IncomingMessage, response: ServerResponse, onBody: (body: string) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  let rejected = false;

  request.on("data", (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      rejected = true;
      chunks.length = 0;
      rejectTooLarge(request, response);
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (!rejected) onBody(Buffer.concat(chunks).toString("utf8"));
  });
}
