import { createConfigFile } from "../config-file.js";
import { decryptSecret, encryptSecret } from "../secret-store.js";
import { refreshTokens } from "./oauth.js";
import { ChzzkApiError, ChzzkLoginRequiredError, type ChzzkTokens } from "./types.js";

/**
 * 치지직 토큰 저장(`data/chzzk-token.json`).
 * - 두 토큰은 secret-store로 암호화하고, 파일은 설정 파일 공통 방식(임시 파일 → fsync → rename)으로 쓴다.
 * - 풀지 못한 파일(다른 PC·사용자 이름 변경)은 지우지 않고 needs-login으로 둔다. 다시 로그인하면 그때 덮어쓴다.
 * - Refresh Token은 일회용이다. 동시에 갱신하면 하나가 다른 하나의 토큰을 무효로 만들므로 진행 중인 갱신 하나를 같이 기다린다.
 * - 갱신 뒤 파일 쓰기에 실패해도 새 토큰은 이번 실행에서 쓴다. 옛 Refresh Token은 이미 무효라 버려도 되돌릴 수 없다.
 */

export type ChzzkTokenState = "none" | "ready" | "needs-login";

/** 만료 전 미리 갱신하는 여유. 연결 직전에 받은 토큰이 방송 중에 만료되지 않게 한다. */
const DEFAULT_REFRESH_BEFORE_MS = 60 * 60 * 1000;

export function createChzzkTokenStore(options: {
  filePath: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  refreshBeforeMs?: number;
  warn?: (message: string) => void;
}) {
  const warn = options.warn ?? (message => console.warn(`[bori-server] ${message}`));
  const now = options.now ?? Date.now;
  const refreshBeforeMs = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
  const file = createConfigFile(options.filePath, "치지직 토큰", warn);
  let tokens: ChzzkTokens | null = null;
  let state: ChzzkTokenState = "none";
  let refreshing: Promise<string> | null = null;

  /** 메모리 토큰을 바꾸고 파일에 쓴다. 쓰기 실패는 예외로 넘긴다. */
  function save(next: ChzzkTokens) {
    tokens = next;
    state = "ready";
    file.write({ accessToken: encryptSecret(next.accessToken), refreshToken: encryptSecret(next.refreshToken), expiresAt: next.expiresAt });
  }

  async function refresh(current: ChzzkTokens): Promise<string> {
    let next: ChzzkTokens;
    try {
      next = await refreshTokens({ clientId: options.clientId, clientSecret: options.clientSecret, refreshToken: current.refreshToken, fetch: options.fetch, baseUrl: options.baseUrl });
    } catch (error) {
      // 401(INVALID_TOKEN·INVALID_CLIENT)이면 Refresh Token으로는 더 못 쓴다. 네트워크·5xx는 다음에 다시 시도한다.
      if (error instanceof ChzzkApiError && error.status === 401) {
        tokens = null;
        state = "needs-login";
        throw new ChzzkLoginRequiredError();
      }
      throw error;
    }
    try {
      save(next);
    } catch {
      warn("치지직 토큰을 파일에 저장하지 못했습니다. 이번 실행에서는 새 토큰을 쓰지만, 서버를 다시 켜면 다시 연결해야 할 수 있습니다.");
    }
    return next.accessToken;
  }

  return {
    state: () => state,

    /** 파일에서 토큰을 읽는다. */
    load(): ChzzkTokenState {
      tokens = null;
      state = "none";
      const stored = file.read();
      if (!stored || typeof stored.accessToken !== "string" || typeof stored.refreshToken !== "string") return state;
      const accessToken = decryptSecret(stored.accessToken);
      const refreshToken = decryptSecret(stored.refreshToken);
      if (accessToken.length === 0 || refreshToken.length === 0) {
        state = "needs-login";
        return state;
      }
      // 만료 시각이 없으면 이미 만료된 것으로 보고 다음 요청에 갱신한다.
      tokens = { accessToken, refreshToken, expiresAt: typeof stored.expiresAt === "number" ? stored.expiresAt : 0 };
      state = "ready";
      return state;
    },

    /** 로그인(코드 교환)으로 받은 토큰을 저장한다. 파일 쓰기 실패는 예외로 넘기지만 메모리 토큰은 바뀐다. */
    save,

    /**
     * 지금 쓸 Access Token. 만료 1시간 전부터는 갱신해서 준다.
     * forceRefresh면 만료 시각과 무관하게 갱신한다(API가 401을 준 경우).
     */
    async getAccessToken(request?: { forceRefresh?: boolean }): Promise<string> {
      if (refreshing) return refreshing;
      if (state !== "ready" || !tokens) throw new ChzzkLoginRequiredError();
      if (!request?.forceRefresh && now() < tokens.expiresAt - refreshBeforeMs) return tokens.accessToken;
      refreshing = refresh(tokens).finally(() => { refreshing = null; });
      return refreshing;
    },
  };
}

export type ChzzkTokenStore = ReturnType<typeof createChzzkTokenStore>;
