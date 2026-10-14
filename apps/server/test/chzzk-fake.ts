/**
 * 치지직 검사가 같이 쓰는 가짜 서버(tools/test/fixtures/fake-chzzk.mjs) 로더와 기다림 도우미.
 * 파일 이름이 *.test.ts가 아니라 검사로 직접 돌지 않는다.
 */

export type FakeChzzkCall = { path: string; grantType?: string | null; contentType?: string; authorized?: boolean; sessionKeyIn?: "query" | "body" | "none" };

export type FakeChzzk = {
  calls: FakeChzzkCall[];
  options: { sessionUrlHost: string; stringPayload: boolean; tokenErrorMessage: string | null };
  issueCode(): string;
  issueTokens(): { accessToken: string; refreshToken: string; tokenType: string; expiresIn: string };
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  connectedSockets(): number;
  sendChat(chat: unknown, options?: { raw?: unknown }): void;
  sendSystem(message: unknown): void;
  dropSockets(): void;
  close(): Promise<void>;
};

type FakeModule = {
  startFakeChzzk(options: { port: number; accessTokenTtlSec?: number }): Promise<FakeChzzk>;
  FAKE_CLIENT_ID: string;
  FAKE_CLIENT_SECRET: string;
};

/** .mjs 가짜 서버에는 타입 선언이 없어 경로를 문자열로 넘겨 불러온다. */
const fakeModuleUrl = new URL("../../../tools/test/fixtures/fake-chzzk.mjs", import.meta.url).href;
export const loadFakeChzzk = async () => (await import(fakeModuleUrl)) as FakeModule;

/** 조건이 참이 될 때까지 기다린다. 시간이 지나면 실패한다. */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
