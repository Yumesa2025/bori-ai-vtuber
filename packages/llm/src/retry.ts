/**
 * 업체의 속도 제한(429) 응답. 서비스가 고장 난 것이 아니라 잠시 기다리라는 뜻이라
 * 회로 차단기의 연속 실패로 세지 않는다(a3 F15, ADR-024).
 */
export class RateLimitError extends Error {
  readonly rateLimited = true;

  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export const isRateLimitError = (error: unknown): error is RateLimitError => error instanceof RateLimitError;

/** Retry-After가 없을 때 기다리는 시간. */
export const DEFAULT_RETRY_AFTER_MS = 1000;
/** 다시 보낸 요청이 응답할 시간. 기다린 뒤 이만큼도 남지 않으면 다시 보내 봐야 타임아웃이다. */
const RETRY_RESPONSE_MARGIN_MS = 1000;

/** Retry-After 헤더(초 또는 HTTP 날짜)를 밀리초로 읽는다. 읽을 수 없으면 null. */
export function retryAfterMsOf(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim().length === 0) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * 요청을 보내고, 429면 Retry-After만큼 기다렸다 한 번만 다시 보낸다.
 * 기다림과 다음 응답이 호출 상한(deadline) 안에 들어갈 때만 다시 보낸다. 상한을 넘겨 기다리면 방송 답이 그만큼 늦는다.
 * 다시 보내지 않으면 429 응답을 그대로 돌려준다. 오류로 바꾸는 일은 부르는 쪽이 한다.
 */
export async function sendWithRateLimitRetry(send: () => Promise<Response>, deadline: number, now: () => number = Date.now): Promise<Response> {
  const first = await send();
  if (first.status !== 429) return first;

  const waitMs = retryAfterMsOf(first.headers.get("retry-after"), now()) ?? DEFAULT_RETRY_AFTER_MS;
  if (now() + waitMs + RETRY_RESPONSE_MARGIN_MS > deadline) return first;

  // 읽지 않은 본문이 연결을 붙잡지 않게 버린다.
  await first.body?.cancel().catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return send();
}
