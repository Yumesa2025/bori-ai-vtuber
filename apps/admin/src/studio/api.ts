/**
 * 스튜디오 탭들이 서버를 부르는 방법.
 * 화면은 서버가 /studio/로 내주므로 API는 같은 출처의 절대 경로(/api/...)로 부른다. 개발 서버는 vite.config.ts가 넘긴다.
 */
import type { ShowConnections } from '@bori/shared';
import { REQUEST_TIMEOUT_MS } from '../poll';

/** 저장·삭제처럼 상태를 바꾸는 요청의 제한 시간. 음성 설정 저장은 서버가 업체에 목소리 목록을 묻느라 더 걸린다. */
export const MUTATION_TIMEOUT_MS = 15_000;
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 서버가 죽으면 버튼을 눌러도 아무 일이 없어 원인을 알 수 없다.
// Vite dev 프록시는 백엔드가 죽어도 5xx 응답을 돌려주므로, fetch 예외만으로는 판단할 수 없다.
// 제한 시간을 넘긴 요청도 서버에 닿지 못한 것으로 본다.
export async function request(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response | null> {
  try { return await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
}

// 타입 가드로 두면 이 검사를 통과한 뒤에는 response를 그대로 쓸 수 있다.
export const isServerUp = (response: Response | null): response is Response => response !== null && response.status < 500;

/** 응답 본문을 JSON으로 읽는다. JSON이 아니면 null이다(프록시 오류 페이지 등). */
export async function readJson<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

/** 성공한 GET 응답의 본문. 실패·서버 끊김이면 null이다. */
export async function getJson<T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T | null> {
  const response = await request(path, undefined, timeoutMs);
  return response?.ok ? readJson<T>(response) : null;
}

/** 본문 없는 동작 요청. 서버 가드가 JSON Content-Type을 요구하므로 빈 객체를 보낸다. */
export function postAction(path: string, timeoutMs = MUTATION_TIMEOUT_MS): Promise<Response | null> {
  return request(path, { method: 'POST', headers: JSON_HEADERS, body: '{}' }, timeoutMs);
}

/** GET /api/chzzk/status, GET /api/obs/status 응답(구현 계획 1.2). */
export type ChzzkStatusView = { state: ShowConnections['chzzk']; channelName: string | null; lastError: string | null };
export type ObsStatusView = { state: ShowConnections['obs']; currentScene: string | null; lastError: string | null };

/**
 * 치지직 로그인 페이지를 기본 브라우저로 연다.
 * 스튜디오 창은 새 창을 열지 않고 http(s) 주소를 기본 브라우저로 넘긴다(electron/main.cjs).
 * 앱 키가 없으면 서버가 503으로 이유를 주므로, 먼저 물어보고 열 수 있을 때만 연다. 이동은 따라가지 않는다.
 * 치지직 Redirect URL이 http://localhost:4310/api/chzzk/callback이라, 로그인은 기본 포트(4310)로 띄운 서버에서 끝난다.
 */
export async function openChzzkLogin(): Promise<string | null> {
  const response = await request('/api/chzzk/login', { redirect: 'manual' });
  if (response === null) return '서버에 연결할 수 없어 치지직 로그인을 열지 못했습니다.';
  if (response.type !== 'opaqueredirect' && !response.ok) return (await readJson<{ error?: string }>(response))?.error ?? '치지직 로그인을 열지 못했습니다.';
  window.open(new URL('/api/chzzk/login', window.location.href).href, '_blank');
  return null;
}
