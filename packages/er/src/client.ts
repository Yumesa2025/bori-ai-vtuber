/**
 * 이터널리턴 Open API 클라이언트.
 * 개인 키는 초당 1회 제한이라 모든 요청을 큐 하나로 직렬화하고 호출 사이를 minIntervalMs 이상 띄운다.
 * 오류 메시지에는 키와 쿼리 문자열(닉네임)을 넣지 않는다.
 */

export type ErClientOptions = { apiKey: string; baseUrl?: string; minIntervalMs?: number; fetch?: typeof fetch; now?: () => number };
/**
 * path가 "/"로 시작하면 API 요청(키 포함, JSON 응답)이다.
 * 절대 주소(언어 데이터 파일)는 키 없이 받아 본문 문자열을 그대로 돌려준다.
 */
export type ErClient = { get<T>(path: string): Promise<T> };

export class ErApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ErApiError";
  }
}

const DEFAULT_BASE_URL = "https://open-api.bser.io";
const DEFAULT_MIN_INTERVAL_MS = 1100;

/** 레이트 리밋 응답. 공식 문서상 403도 레이트 리밋으로 쓰인다. */
const RETRY_STATUSES = new Set([429, 403]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createErClient(options: ErClientOptions): ErClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let lastSentAt: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  async function waitTurn(): Promise<void> {
    if (lastSentAt !== null) {
      const wait = lastSentAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastSentAt = now();
  }

  async function send(path: string): Promise<unknown> {
    const external = /^https?:\/\//i.test(path);
    const url = external ? path : `${baseUrl}${path}`;
    // 오류 메시지용. 쿼리(닉네임)와 외부 주소의 경로를 남기지 않는다.
    const label = external ? "언어 데이터 파일" : path.split("?")[0]!;
    const headers: Record<string, string> = external ? {} : { "x-api-key": options.apiKey, accept: "application/json" };

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) await sleep(minIntervalMs);
      await waitTurn();
      let response: Response;
      try {
        response = await fetchImpl(url, { headers });
      } catch {
        throw new ErApiError(0, null, `이터널리턴 API에 연결하지 못했습니다: ${label}`);
      }
      if (RETRY_STATUSES.has(response.status) && attempt === 0) continue;

      const text = await response.text().catch(() => "");
      if (external) {
        if (!response.ok) throw new ErApiError(response.status, null, `${label}을 받지 못했습니다(HTTP ${response.status})`);
        return text;
      }
      let body: { code?: unknown } | null = null;
      try {
        body = JSON.parse(text) as { code?: unknown };
      } catch {
        body = null;
      }
      const code = typeof body?.code === "number" ? body.code : null;
      if (!response.ok || body === null || code !== 200) {
        throw new ErApiError(response.status, code, `이터널리턴 API 오류: ${label} (HTTP ${response.status}, code ${code ?? "없음"})`);
      }
      return body;
    }
  }

  return {
    get<T>(path: string): Promise<T> {
      const run = tail.then(() => send(path));
      tail = run.catch(() => undefined);
      return run as Promise<T>;
    },
  };
}
