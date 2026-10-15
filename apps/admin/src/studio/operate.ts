/**
 * 보리 스튜디오 운영 탭이 화면에 그릴 문구와 판정.
 * React에 묶이지 않아 화면 밖 단위 검사(test/operate.test.ts)에서 그대로 부른다.
 */
import type { BroadcastState, ErMetaBasis, LlmStatus, ShowConnections, ShowStage } from "@bori/shared";

/** 단계 이름. 설계 5절의 번호를 그대로 붙인다. */
const stageLabels: Record<ShowStage, string> = {
  idle: "대기",
  opening: "① 오프닝",
  briefing: "② 메타 브리핑",
  qna: "③ 질문 코너",
  diagnosis: "④ 전적 진단",
  ending: "⑤ 엔딩",
};

/** "다음 단계" 버튼 문구. 누르면 시작될 단계를 말한다. */
const nextLabels: Record<ShowStage, string> = {
  idle: "오프닝 시작",
  opening: "메타 브리핑 시작",
  briefing: "질문 코너 시작",
  qna: "전적 진단 시작",
  diagnosis: "엔딩 시작",
  ending: "끝",
};

export const stageLabel = (stage: ShowStage): string => stageLabels[stage];
export const nextLabel = (stage: ShowStage): string => nextLabels[stage];

/** 연결 표시에 쓰는 상태. 서버의 ShowConnections 값에, 아직 받지 못한 unknown을 더한다. */
export type ConnectionState = ShowConnections[keyof ShowConnections] | "unknown";
export type BadgeTone = "ok" | "warn" | "bad" | "off";

const badges: Record<ConnectionState, { tone: BadgeTone; text: string }> = {
  connected: { tone: "ok", text: "연결됨" },
  ready: { tone: "ok", text: "준비됨" },
  connecting: { tone: "warn", text: "연결 중" },
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

/** OBS 브라우저 소스 주소. 구현 계획 1.4의 6개에, 메인·전적 장면 맨 아래 불투명 배경(tools/obs/setup-show.mjs)을 더한다. */
const obsPages = [
  { name: "character", label: "캐릭터" },
  { name: "dashboard", label: "대시보드" },
  { name: "caption", label: "자막" },
  { name: "chat", label: "채팅" },
  { name: "waiting", label: "대기 화면" },
  { name: "ending", label: "엔딩 화면" },
  { name: "background", label: "메인 배경" },
] as const;

export function obsUrls(base: string): Array<{ name: string; label: string; url: string }> {
  const root = base.replace(/\/+$/, "");
  return obsPages.map(page => ({ ...page, url: `${root}/obs/${page.name}.html` }));
}

/** GET /api/er/status 응답(구현 계획 1.2). */
export type ErStatusView = { basis: ErMetaBasis | null; refreshing: boolean; progress: number | null; lastError: string | null };

const pad = (value: number) => String(value).padStart(2, "0");
/** 이 컴퓨터 시간으로 "10월 15일 14:03". 형식이 아니면 원문 그대로. */
function formatCollectedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 운영 탭 "데이터 갱신" 칸의 문구. 리허설 때 어떤 데이터로 방송하는지 바로 보이게 한다. */
export function erSummary(status: ErStatusView | null): { title: string; updated: string; description: string; progress: string | null } {
  if (!status) return { title: "확인 중", updated: "", description: "", progress: null };
  const { basis } = status;
  return {
    title: basis ? `${basis.seasonName} · ${basis.sampleGames.toLocaleString("ko-KR")}판` : "데이터 없음",
    updated: basis ? `마지막 갱신 ${formatCollectedAt(basis.collectedAt)}` : "아직 갱신하지 않았습니다",
    description: basis?.description ?? "",
    progress: status.refreshing ? `갱신 중 ${Math.round((status.progress ?? 0) * 100)}%` : null,
  };
}

/** 운영 탭에 남길 채팅·보리 답 줄 수. */
export const SHOW_LOG_LIMIT = 10;
export type ShowLogLine = { key: string; kind: "chat" | "reply"; text: string };
/**
 * 채팅·답 로그. 서버는 지금 화면의 채팅과 지금 답만 주므로 스튜디오가 모아 둔다.
 * seenChats는 지금 화면에 있는 채팅 중 이미 넣은 것이다. 로그에서 밀려난 채팅을 다시 넣지 않는다.
 */
export type ShowLog = { lines: ShowLogLine[]; seenChats: string[]; lastReply: string; seq: number };
export const emptyShowLog: ShowLog = { lines: [], seenChats: [], lastReply: "", seq: 0 };

export function mergeShowLog(log: ShowLog, state: Pick<BroadcastState, "visibleChats" | "currentResponse">, limit = SHOW_LOG_LIMIT): ShowLog {
  let seq = log.seq;
  const lines = [...log.lines];
  for (const chat of state.visibleChats) {
    if (log.seenChats.includes(chat.id)) continue;
    lines.push({ key: `chat-${seq++}`, kind: "chat", text: chat.content });
  }
  // 답이 비었다가 같은 문장이 다시 나오면 새 답이다. 같은 답이 이어지는 동안만 한 번으로 본다.
  const reply = state.currentResponse?.reply ?? "";
  if (reply && reply !== log.lastReply) lines.push({ key: `reply-${seq++}`, kind: "reply", text: reply });
  return { lines: lines.slice(-limit), seenChats: state.visibleChats.map(chat => chat.id), lastReply: reply, seq };
}

type ShortcutEvent = { key: string; repeat: boolean; isComposing: boolean; target: { tagName: string; isContentEditable: boolean } | null };
const typingTags = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

/**
 * "다음 단계" 단축키(Space)인지.
 * 입력칸에서는 띄어쓰기이고, 버튼에 포커스가 있으면 Space가 그 버튼을 누르므로 둘 다 뺀다.
 * 누르고 있어 반복되는 입력과 한글 조합 중 입력도 뺀다. 한 번 눌러 한 단계만 넘어간다.
 */
export function isNextShortcut(event: ShortcutEvent): boolean {
  if (event.key !== " " || event.repeat || event.isComposing) return false;
  if (!event.target) return true;
  return !typingTags.has(event.target.tagName) && !event.target.isContentEditable;
}

/**
 * 운영 탭 시청자 채팅의 요청 본문. 리허설에서는 치지직 채팅 대신 여기서 시청자 채팅을 친다.
 * 닉네임은 방송 화면에 나오지 않고 시청자를 구분하는 데만 쓴다. 서버가 한 시청자의 채팅을 대기열에 3건까지만 두므로
 * 익명 하나로 빠르게 치면 뒤 채팅이 버려진다. 비우면 익명 채팅이다.
 */
export function viewerChatBody(content: string, nickname: string): { content: string; nickname?: string } | null {
  const text = content.trim();
  if (!text) return null;
  const name = nickname.trim();
  return name ? { content: text, nickname: name } : { content: text };
}

/** 초를 m:ss로. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * 코너 자동 진행 안내 한 줄. 시간 제한이 없는 코너(대기·엔딩)나 꺼져 있으면 빈 문자열이다.
 * 시간이 다 되면 보리가 하던 말을 마치고 다음 코너로 넘어간다(서버 show/autopilot.ts).
 */
export function cornerTimeText(auto: { enabled: boolean; stageSeconds: number; elapsedSeconds: number } | undefined): string {
  if (!auto || !auto.enabled || auto.stageSeconds <= 0) return '';
  const left = auto.stageSeconds - auto.elapsedSeconds;
  if (left <= 0) return '코너 시간이 끝났습니다. 보리가 하던 말을 마치면 다음 코너로 넘어갑니다.';
  return `코너 남은 시간 ${clock(left)} / ${clock(auto.stageSeconds)}`;
}
