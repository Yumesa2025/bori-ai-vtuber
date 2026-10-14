import { DEFAULT_CHZZK_BASE_URL, requestChzzk, type ChzzkTokens } from "./types.js";

/**
 * 치지직 OAuth(Authorization 문서).
 * 인증 코드는 Open API와 다른 도메인에서 받고, 토큰 발급·갱신은 Open API 도메인의 `POST /auth/v1/token`에
 * JSON 본문으로 보낸다(본문 키는 문서의 Request Body 표, Content-Type은 참고사항의 공통 헤더).
 */

const AUTHORIZE_URL = "https://chzzk.naver.com/account-interlock";
/** 토큰 요청 하나의 상한. 응답이 없으면 연결 시도가 멈추지 않게 끊는다. */
const TOKEN_TIMEOUT_MS = 10_000;

export function buildAuthorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({ clientId: options.clientId, redirectUri: options.redirectUri, state: options.state });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

type TokenRequestOptions = { clientId: string; clientSecret: string; fetch?: typeof fetch; baseUrl?: string };

/** 토큰 응답을 읽는다. expiresIn은 문서상 문자열("86400")이지만 숫자도 받는다. */
async function requestTokens(action: string, options: TokenRequestOptions, body: Record<string, string>): Promise<ChzzkTokens> {
  const doFetch = options.fetch ?? fetch;
  const content = await requestChzzk(action, () => doFetch(`${options.baseUrl ?? DEFAULT_CHZZK_BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, clientId: options.clientId, clientSecret: options.clientSecret }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  }));

  const record = typeof content === "object" && content !== null ? content as Record<string, unknown> : {};
  const expiresIn = Number(record.expiresIn);
  if (typeof record.accessToken !== "string" || record.accessToken.length === 0
    || typeof record.refreshToken !== "string" || record.refreshToken.length === 0
    || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`치지직 ${action} 응답 형식이 예상과 다릅니다.`);
  }
  return { accessToken: record.accessToken, refreshToken: record.refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export function exchangeCode(options: TokenRequestOptions & { code: string; state: string }): Promise<ChzzkTokens> {
  return requestTokens("토큰 발급", options, { grantType: "authorization_code", code: options.code, state: options.state });
}

/** Refresh Token은 일회용이다. 성공하면 응답의 새 Refresh Token을 저장해야 한다. */
export function refreshTokens(options: TokenRequestOptions & { refreshToken: string }): Promise<ChzzkTokens> {
  return requestTokens("토큰 갱신", options, { grantType: "refresh_token", refreshToken: options.refreshToken });
}
