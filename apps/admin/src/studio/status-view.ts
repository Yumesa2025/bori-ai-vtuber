/**
 * 보리 스튜디오 설정 탭이 화면에 그릴 문구와 판정.
 * React에 묶이지 않아 화면 밖 단위 검사(test/status-view.test.ts)에서 그대로 부른다.
 */
import type { DashboardState, ErConnection, LlmStatus } from "@bori/shared";

/** 연결 표시에 쓰는 상태. 이터널리턴 데이터 상태(ErConnection)와 LLM·TTS 연결, 아직 받지 못한 unknown. */
export type ConnectionState = ErConnection | "connected" | "error" | "off" | "unknown";
export type BadgeTone = "ok" | "warn" | "bad" | "off";

const badges: Record<ConnectionState, { tone: BadgeTone; text: string }> = {
  connected: { tone: "ok", text: "연결됨" },
  ready: { tone: "ok", text: "준비됨" },
  refreshing: { tone: "warn", text: "갱신 중" },
  stale: { tone: "warn", text: "오래됨" },
  error: { tone: "bad", text: "오류" },
  missing: { tone: "bad", text: "데이터 없음" },
  off: { tone: "off", text: "꺼짐" },
  unknown: { tone: "off", text: "확인 중" },
};

export function connectionBadge(state: ConnectionState): { tone: BadgeTone; text: string } {
  return badges[state];
}

/** LLM 연결. 켜져 있고 키가 있어야 쓸 수 있고, 연속 실패로 회로가 열리면 오류다. */
export function llmConnection(status: Pick<LlmStatus, "enabled" | "hasApiKey" | "circuitOpen"> | null): ConnectionState {
  if (!status) return "unknown";
  if (!status.enabled || !status.hasApiKey) return "off";
  return status.circuitOpen ? "error" : "connected";
}

/** TTS 연결. 켜져 있고 키가 있어야 소리가 난다. 합성 실패는 따로 문구로 보여 준다. */
export function ttsConnection(view: { settings: { enabled: boolean }; hasApiKey: boolean } | null): ConnectionState {
  if (!view) return "unknown";
  return view.settings.enabled && view.hasApiKey ? "connected" : "off";
}

/** GET /api/dashboard 응답 중 설정 탭이 쓰는 칸. 조합 표·대사는 대시보드 탭이 그린다. */
export type ErDataView = Pick<DashboardState, "connection" | "refresh" | "basis">;

const pad = (value: number) => String(value).padStart(2, "0");
/** 이 컴퓨터 시간으로 "10월 15일 14:03". 형식이 아니면 원문 그대로. */
function formatCollectedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const count = (value: number) => value.toLocaleString("ko-KR");

/** 설정 탭 "이터널리턴 데이터" 칸의 문구와 갱신 버튼 상태. 지금 어떤 데이터로 분석하는지 바로 보이게 한다. */
export function erSummary(view: ErDataView | null): {
  title: string;
  updated: string;
  description: string;
  progress: string | null;
  badge: { tone: BadgeTone; text: string };
  /** 키가 있고 갱신 중이 아닐 때만 버튼을 켠다 */
  canRefresh: boolean;
  lastError: string | null;
} {
  if (!view) return { title: "확인 중", updated: "", description: "", progress: null, badge: connectionBadge("unknown"), canRefresh: false, lastError: null };
  const { basis, refresh } = view;
  return {
    title: basis ? [basis.seasonName, ...(basis.patch ? [`패치 ${basis.patch}`] : []), `경기 ${count(basis.games)}판`].join(" · ") : "데이터 없음",
    updated: basis ? `마지막 갱신 ${formatCollectedAt(basis.collectedAt)}` : "아직 갱신하지 않았습니다",
    description: basis ? `상위 랭커 ${count(basis.rankers)}명의 랭크 경기 ${count(basis.games)}판(참가자 ${count(basis.participants)}명) 기준` : "",
    progress: refresh.running ? `갱신 중 ${Math.round((refresh.progress ?? 0) * 100)}%` : null,
    badge: connectionBadge(view.connection),
    canRefresh: refresh.available && !refresh.running,
    lastError: refresh.lastError,
  };
}

/** 입력칸 상한. 게임 닉네임 규칙은 여기서 판단하지 않고, 찾을 수 있는지는 서버가 ER API로 본다. */
const NICKNAME_MAX = 32;

/** PUT /api/dashboard/settings 본문. 앞뒤 공백을 떼고, 비우면 null로 저장한 닉네임을 지운다. */
export function nicknameBody(input: string): { ok: true; body: { nickname: string | null } } | { ok: false; error: string } {
  const nickname = input.trim();
  if (nickname.length === 0) return { ok: true, body: { nickname: null } };
  if (Array.from(nickname).length > NICKNAME_MAX) return { ok: false, error: `게임 닉네임은 ${NICKNAME_MAX}자 안으로 적어 주세요.` };
  return { ok: true, body: { nickname } };
}
