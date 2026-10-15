import { maskNickname } from "@bori/er";
import type { DashboardView, ErPlayerReport, ShowStage } from "@bori/shared";

/**
 * 채팅 명령 `!전적 닉네임`. 전적 진단 단계에서 이터널리턴 전적을 찾아 대시보드에 띄우고 보리가 한마디 한다.
 * - 흐름(2026-10-15 사용자 요청): 채팅 띠에 "!전적 가린닉네임"이 뜨고 → 보리가 "검색해 볼까요?" 하며 조회하고 → 결과 카드와 분석 대사.
 * - 한 번에 하나만 본다. 조회·대사가 끝나기 전에 온 명령은 기다려 달라고 안내만 한다.
 * - 리포트는 대시보드(메모리)에만 둔다. 다음 `!전적`이나 단계 이동 때 대시보드가 바뀌며 버려진다.
 * - 닉네임은 조회에만 쓴다. 화면에는 가린 닉네임만 보이고, 보리 대사 줄에는 닉네임을 넣지 않는다.
 * - 명령 채팅은 보리 답 큐에 넣지 않는다(부르는 쪽이 handle의 true를 보고 넘긴다). 화면 채팅 띠에는 닉네임을 가린 명령만 올린다.
 */

/** 전적을 받은 뒤 보리에게 주는 지시. */
export const PLAYER_DIRECTIVE = "방금 검색한 전적 결과가 [게임 데이터]에 있다. 이 전적은 보리의 것이 아니라 채팅으로 요청한 시청자의 것이다. '제 전적', '저는'처럼 보리 것으로 말하지 말고 '이분', '요청해 주신 분'처럼 말한다. 판수·평균 순위·최근 순위 흐름·많이 한 캐릭터 중 눈에 띄는 것을 두세 문장으로 정리하고 조언을 한마디 붙인다. 수치는 주어진 것만 쓴다. 닉네임은 말하지 않고, 명령어 사용법은 다시 안내하지 않는다.";

const COMMAND = /^!전적(?:\s+(.*))?$/s;
/** 닉네임 길이 상한(글자). 넘으면 조회하지 않는다. */
const NICKNAME_MAX_LENGTH = 30;
/** 같은 안내 문장을 다시 말하기까지 기다리는 시간. 명령 도배로 보리가 같은 말을 되풀이하지 않게 한다. */
const NOTICE_COOLDOWN_MS = 15_000;

const LINES = {
  // 전적 검색 안내는 여러 번 나오므로 문장을 돌려 쓴다(같은 대사 되풀이 방지, 2026-10-15 리허설).
  searching: [
    "오, 전적이 들어왔네요! 한번 검색해 볼까요? 잠깐만요!",
    "좋아요, 이번 전적도 바로 찾아볼게요! 잠시만요.",
    "전적 요청 또 왔네요! 어떤 기록일지 검색해 볼게요.",
  ],
  otherStage: "전적 진단 때 봐 드릴게요!",
  busy: "잠깐만요, 지금 보고 있어요!",
  noNickname: "닉네임도 같이 적어 주세요! 예를 들면 '!전적 닉네임'처럼요.",
  unavailable: "지금은 전적을 볼 수 없어요. 조금 뒤에 다시 해 볼게요.",
  notFound: "그 닉네임으로는 전적을 찾지 못했어요. 철자를 한 번 확인해 주세요.",
  error: "지금은 전적을 불러오지 못했어요. 잠시 뒤에 다시 해 볼게요.",
  speakFailed: "전적을 화면에 띄웠어요! 같이 봐 주세요.",
} as const;

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const rank = (value: number) => `${value.toFixed(1)}위`;

/** 보리 대사에 붙이는 전적 줄. 닉네임은 넣지 않는다. */
/** 보리 대사에 붙이는 전적 줄의 머리. 보리가 자기 전적처럼 말한 일이 있어(2026-10-15 리허설) 누구 전적인지 밝힌다. */
export const REPORT_OWNER_LINE = "아래는 채팅으로 요청한 시청자의 전적이다(보리의 전적이 아니다).";

export function reportLines(report: ErPlayerReport): string[] {
  if (report.games === 0) return [REPORT_OWNER_LINE, `기준: ${report.seasonName}`, "이번 기준으로 기록된 경기가 없다."];
  return [
    REPORT_OWNER_LINE,
    `기준: ${report.seasonName}`,
    `판수: ${report.games}판`,
    `평균 순위: ${rank(report.avgRank)}`,
    `1등 비율: ${percent(report.top1Rate)}`,
    ...(report.recentRanks.length > 0 ? [`최근 순위(최신부터): ${report.recentRanks.join(", ")}`] : []),
    ...(report.mainCharacters.length > 0
      ? [`많이 한 캐릭터: ${report.mainCharacters.map(character => `${character.name} ${character.games}판(평균 ${rank(character.avgRank)})`).join(", ")}`]
      : []),
  ];
}

export function createPlayerCommand(deps: {
  stage: () => ShowStage;
  /** 진행기 단계 세대. 조회 중에 바뀌면 결과를 버린다. */
  epoch: () => number;
  /** ER 키와 사전이 있어 조회할 수 있는지. */
  available: () => boolean;
  /** 없으면 null. 실패하면 throw. */
  lookup: (nickname: string) => Promise<ErPlayerReport | null>;
  /** 세대가 다르면 바꾸지 않는다. */
  setDashboard: (view: DashboardView, epoch: number) => void;
  speak: (directive: string, gameData: readonly string[], isCurrent: () => boolean) => Promise<void>;
  say: (line: string, isCurrent: () => boolean) => Promise<void>;
  /** 화면 채팅 띠에 한 줄 올린다. 닉네임은 가린 채로 받는다. */
  showChat: (text: string) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** 지금 처리 중인 조회. 없으면 null. */
  let running: Promise<void> | null = null;
  /** 검색 안내 문장을 돌려 쓰는 순번. */
  let searchCount = 0;
  const lastNoticeAt = new Map<string, number>();

  /** 안내 문장. 같은 문장은 NOTICE_COOLDOWN_MS 안에 다시 말하지 않는다. */
  function notice(line: string) {
    const at = now();
    const last = lastNoticeAt.get(line);
    if (last !== undefined && at - last < NOTICE_COOLDOWN_MS) return;
    lastNoticeAt.set(line, at);
    void deps.say(line, () => true).catch(error => console.error("[bori-server] 전적 안내 문장 실패:", error));
  }

  async function run(nickname: string, at: number) {
    const isCurrent = () => deps.epoch() === at;
    const player = (status: Extract<DashboardView, { kind: "player" }>["status"], report: ErPlayerReport | null = null) =>
      deps.setDashboard({ kind: "player", status, report }, at);

    if (!deps.available()) {
      player("error");
      await deps.say(LINES.unavailable, isCurrent);
      return;
    }
    player("loading");
    // 보리가 "검색해 볼까요?" 하는 동안 조회를 같이 돌린다. 결과는 그 말이 끝난 뒤에 보여 준다.
    const searching = deps.say(LINES.searching[searchCount++ % LINES.searching.length], isCurrent).catch(error => console.error("[bori-server] 전적 검색 안내 실패:", error));
    let report: ErPlayerReport | null;
    try {
      report = await deps.lookup(nickname);
    } catch (error) {
      // 오류 메시지에는 닉네임이 없다(@bori/er이 쿼리를 빼고 만든다).
      console.error("[bori-server] 전적 조회 실패:", error instanceof Error ? error.message : String(error));
      await searching;
      if (!isCurrent()) return;
      player("error");
      await deps.say(LINES.error, isCurrent);
      return;
    }
    await searching;
    if (!isCurrent()) return;
    if (!report) {
      player("not-found");
      await deps.say(LINES.notFound, isCurrent);
      return;
    }
    player("ready", report);
    try {
      await deps.speak(PLAYER_DIRECTIVE, reportLines(report), isCurrent);
    } catch (error) {
      console.error("[bori-server] 전적 분석 대사 생성 실패, 고정 문장으로 말합니다:", error instanceof Error ? error.message : String(error));
      if (isCurrent()) await deps.say(LINES.speakFailed, isCurrent);
    }
  }

  return {
    /** 명령이면 처리하고 true. 명령이 아니면 아무것도 하지 않고 false. */
    handle(content: string): boolean {
      const parsed = COMMAND.exec(content.trim());
      if (!parsed) return false;
      if (deps.stage() !== "diagnosis") { notice(LINES.otherStage); return true; }
      const nickname = (parsed[1] ?? "").trim();
      deps.showChat(nickname.length > 0 ? `!전적 ${maskNickname(nickname)}` : "!전적");
      if (nickname.length === 0 || Array.from(nickname).length > NICKNAME_MAX_LENGTH) { notice(LINES.noNickname); return true; }
      if (running) { notice(LINES.busy); return true; }

      running = run(nickname, deps.epoch())
        .catch(error => console.error("[bori-server] 전적 명령 처리 실패:", error))
        .finally(() => { running = null; });
      return true;
    },
    /** 처리 중인 조회가 끝날 때까지 기다린다. 검사용. */
    idle: (): Promise<void> => running ?? Promise.resolve(),
  };
}
