/**
 * 대시보드 라우트(설계 4절). 서버 본체(index.ts)가 보안 경계(guard)를 통과시킨 뒤 부른다.
 * - GET  /api/dashboard           DashboardState. 갱신할 이유가 있으면 자동 갱신을 시작한다(하루 한 번)
 * - GET  /api/dashboard/status    연결·갱신·기준만. 자동 갱신 판정·조합 계산을 하지 않는다(스튜디오 설정 탭이 몇 초마다 묻는다)
 * - POST /api/er/refresh          갱신 시작. { started }
 * - GET  /api/dashboard/settings  { nickname }
 * - PUT  /api/dashboard/settings  닉네임 저장 후 전적을 다시 조회한다. 앞뒤 공백을 떼고 빈 문자열은 null, 32자 상한
 * - POST /api/narration/replay    다시 듣기. { narration }, 대사가 없으면 404
 * 닉네임은 로그와 오류 응답에 넣지 않는다.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DashboardSettingsError, parseDashboardSettings } from "../er/dashboard-settings.js";
import type { DashboardData } from "../er/dashboard-state.js";
import type { Narrator } from "../narration/index.js";
import { readBody } from "./guard.js";

export type DashboardRouteDeps = {
  dashboard: DashboardData;
  narrator: Pick<Narrator, "latest" | "replay">;
};

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.name : "오류");

/** 예상하지 못한 실패. 오류 메시지에 닉네임이 섞일 수 있어 로그에는 코드만 남긴다. */
function sendFailure(response: ServerResponse, label: string, error: unknown) {
  console.error(`[bori-server] ${label}:`, errorCode(error));
  if (response.headersSent) { response.end(); return; }
  send(response, 500, { error: `${label}. 잠시 후 다시 시도해 주세요.` });
}

async function saveSettings(body: string, response: ServerResponse, dashboard: DashboardData) {
  let next;
  try {
    next = parseDashboardSettings(JSON.parse(body));
  } catch (error) {
    if (error instanceof SyntaxError) { send(response, 400, { error: "Invalid JSON" }); return; }
    if (error instanceof DashboardSettingsError) { send(response, 400, { error: error.message }); return; }
    sendFailure(response, "대시보드 설정을 읽지 못했습니다", error);
    return;
  }
  try {
    // 저장한 뒤 전적 조회가 끝날 때까지 기다린다. 갱신 중이면 loading으로 두고 바로 끝난다.
    await dashboard.setSettings(next);
  } catch (error) {
    if (error instanceof DashboardSettingsError) { send(response, 400, { error: error.message }); return; }
    sendFailure(response, "대시보드 설정을 저장하지 못했습니다", error);
    return;
  }
  send(response, 200, dashboard.settings());
}

async function replay(response: ServerResponse, narrator: DashboardRouteDeps["narrator"]) {
  try {
    const narration = await narrator.replay();
    if (!narration) { send(response, 404, { error: "아직 읽을 대사가 없습니다." }); return; }
    send(response, 200, { narration });
  } catch (error) {
    sendFailure(response, "대사를 다시 준비하지 못했습니다", error);
  }
}

/** 이 파일의 라우트면 처리하고 true. 아니면 false를 돌려 다음 라우트로 넘긴다. */
export function handleDashboardRoute(method: string | undefined, path: string, request: IncomingMessage, response: ServerResponse, deps: DashboardRouteDeps): boolean {
  const { dashboard, narrator } = deps;
  if (method === "GET" && path === "/api/dashboard") {
    dashboard.maybeAutoRefresh();
    send(response, 200, { ...dashboard.state(), narration: narrator.latest() });
    return true;
  }
  if (method === "GET" && path === "/api/dashboard/status") { send(response, 200, dashboard.status()); return true; }
  if (method === "POST" && path === "/api/er/refresh") { send(response, 200, { started: dashboard.refresh() }); return true; }
  if (method === "GET" && path === "/api/dashboard/settings") { send(response, 200, dashboard.settings()); return true; }
  if (method === "PUT" && path === "/api/dashboard/settings") {
    readBody(request, response, body => { void saveSettings(body, response, dashboard); });
    return true;
  }
  if (method === "POST" && path === "/api/narration/replay") { void replay(response, narrator); return true; }
  return false;
}
