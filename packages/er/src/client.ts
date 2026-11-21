/**
 * 이터널리턴 Open API 클라이언트.
 * 개인 키는 초당 1회 제한이라 모든 요청을 큐 하나로 직렬화하고 호출 사이를 minIntervalMs 이상 띄운다.
 * 오류 메시지에는 키와 쿼리 문자열(닉네임), 경로 속 uid를 넣지 않는다.
 */

export type ErClientOptions = { apiKey: string; baseUrl?: string; minIntervalMs?: number; timeoutMs?: number; fetch?: typeof fetch; now?: () => number };
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

/** 오류 메시지용 경로. 쿼리(닉네임)를 빼고, /uid/ 뒤 계정 식별자를 가린다(오류는 로그·화면 lastError에 남는다). */
const errorLabel = (path: string) => path.split("?")[0]!.replace(/\/uid\/[^/]+/g, "/uid/…");

export function createErClient(options: ErClientOptions): ErClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs는 양수여야 합니다.");
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
    // 오류 메시지용. 쿼리(닉네임)·uid와 외부 주소의 경로를 남기지 않는다.
    const label = external ? "언어 데이터 파일" : errorLabel(path);
    const headers: Record<string, string> = external ? {} : { "x-api-key": options.apiKey, accept: "application/json" };

    await waitTurn();
    const controller = new AbortController();
    const timeoutError = new ErApiError(0, null, "이터널리턴 요청 시간이 초과되었습니다.");
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(timeoutError); }, timeoutMs);
    });
    const bounded = <T>(work: Promise<T>) => Promise.race([work, deadline]);
    try {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) { await bounded(sleep(minIntervalMs)); await bounded(waitTurn()); }
      let response: Response;
      try {
        response = await bounded(fetchImpl(url, { headers, signal: controller.signal }));
      } catch {
        if (controller.signal.aborted) throw timeoutError;
        throw new ErApiError(0, null, `이터널리턴 API에 연결하지 못했습니다: ${label}`);
      }
      if (RETRY_STATUSES.has(response.status) && attempt === 0) {
        await bounded(response.body?.cancel().catch(() => undefined) ?? Promise.resolve());
        continue;
      }

      const text = await bounded(response.text()).catch(() => {
        if (controller.signal.aborted) throw timeoutError;
        throw new ErApiError(0, null, "이터널리턴 응답 본문을 받지 못했습니다.");
      });
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
    } finally { clearTimeout(timer!); }
  }

  return {
    get<T>(path: string): Promise<T> {
      const run = tail.then(() => send(path));
      tail = run.catch(() => undefined);
      return run as Promise<T>;
    },
  };
}
