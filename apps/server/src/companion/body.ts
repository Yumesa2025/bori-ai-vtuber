import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 요청 본문 상한. API 보안 작업(apps/server/src/http/guard.ts)의 BODY_LIMIT_BYTES와 같은 값이다.
 * 1:1 라우트의 본문 읽기는 모두 아래 readBody를 거친다. 보안 작업과 병합할 때 이 파일을 그쪽 readBody로 바꾼다.
 */
export const BODY_LIMIT_BYTES = 64 * 1024;
/** 413으로 답한 뒤 흘려보낼 남은 본문의 상한. 넘으면 연결을 끊는다. */
const DRAIN_LIMIT_BYTES = 1024 * 1024;

/** 413으로 답하고 남은 본문은 쌓지 않고 흘려보낸다. */
function rejectTooLarge(request: IncomingMessage, response: ServerResponse) {
  response.setHeader("Connection", "close");
  response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: `요청 본문은 ${BODY_LIMIT_BYTES / 1024}KB를 넘을 수 없습니다.` }));
  let discarded = 0;
  request.on("data", (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > DRAIN_LIMIT_BYTES) request.destroy();
  });
  request.resume();
}

/**
 * 본문을 끝까지 읽어 onBody로 넘긴다.
 * 상한을 넘으면 413으로 답하고 onBody를 부르지 않는다.
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

/**
 * readBody를 기다릴 수 있게 감싼다.
 * readBody가 413으로 먼저 답했으면 onBody가 불리지 않으므로, 응답이 끝날 때 null로 끝낸다.
 */
export function readBodyText(request: IncomingMessage, response: ServerResponse): Promise<string | null> {
  return new Promise(resolve => {
    response.once("close", () => resolve(null));
    readBody(request, response, resolve);
  });
}
