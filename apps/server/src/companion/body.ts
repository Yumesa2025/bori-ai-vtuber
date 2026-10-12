import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http/guard.js";

/**
 * 1:1 라우트의 본문 읽기. 상한(64KB)과 413 처리는 공통 가드의 readBody를 그대로 쓴다.
 * readBody가 413으로 먼저 답했으면 onBody가 불리지 않으므로, 응답이 끝날 때 null로 끝낸다.
 */
export function readBodyText(request: IncomingMessage, response: ServerResponse): Promise<string | null> {
  return new Promise(resolve => {
    response.once("close", () => resolve(null));
    readBody(request, response, resolve);
  });
}
