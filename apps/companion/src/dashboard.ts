/**
 * 대시보드 화면 규칙 중 React·DOM에 묶이지 않는 부분. 화면 밖 단위 검사에서 그대로 부른다.
 * change는 모두 "이번 값 − 직전 값"이다(코디네이터 확인). 평균 순위는 작아질수록 좋다.
 */
import type { DashboardPlayerStatus, DashboardState, ErComboStat, ErMetaBasisV2, Narration } from "@bori/shared";
import { formatMmr, formatPercent, formatPointChange, formatRank, formatRankChange } from "./format";

export type SortKey = "pickRate" | "avgRank" | "top1Rate" | "avgMmrGain" | "participants";
export type SortDirection = "asc" | "desc";
export type Trend = "up" | "down" | "flat";
export type TrendMetric = "avgRank" | "top1Rate" | "pickRate" | "avgMmrGain";

/** 부위 번호(equipment 0~4) 이름. 이터널리턴 API의 장비 칸 순서다. */
export const EQUIPMENT_SLOT_LABELS = ["무기", "옷", "머리", "팔", "다리"] as const;

/** 갱신 중 폴링 간격과 평소 간격(설계 4절) */
export const POLL_REFRESHING_MS = 2_000;
export const POLL_IDLE_MS = 30_000;
/** 탭이 숨겨져 있을 때 간격. 보이게 되면 바로 다시 받는다(점검 V2 14번). */
export const POLL_HIDDEN_REFRESHING_MS = 10_000;
export const POLL_HIDDEN_IDLE_MS = 120_000;

export const comboKey = (combo: Pick<ErComboStat, "characterCode" | "weaponCode">) => `${combo.characterCode}:${combo.weaponCode}`;

/** "재키 쌍검". 무기를 모르면 캐릭터 이름만. 보리 대사(narration/facts.ts comboLabel)와 같은 모양이다. */
export const comboLabel = (combo: Pick<ErComboStat, "characterName" | "weaponName">) =>
  combo.weaponName ? `${combo.characterName} ${combo.weaponName}` : combo.characterName;

/** 평균 순위만 작은 값이 위로 오는 것이 기본이다. */
export const defaultDirection = (key: SortKey): SortDirection => (key === "avgRank" ? "asc" : "desc");

/**
 * 고른 열로 정렬한 새 배열. 같은 값이면 원래(픽률) 순서를 지킨다.
 * 표본 적은 조합은 극단값이 되기 쉬워 정렬하면 늘 위를 차지하므로, 방향과 상관없이 표본이 충분한 조합 뒤에 둔다(점검 V2 10번).
 * MMR 표본이 없는 조합도 방향과 상관없이 맨 뒤다.
 */
export function sortCombos(combos: readonly ErComboStat[], key: SortKey, direction: SortDirection): ErComboStat[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...combos].sort((a, b) => {
    if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
    const left = a[key];
    const right = b[key];
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (left - right) * sign;
  });
}

/** 조합별 픽률 순번(1부터). 서버가 픽률 순으로 주므로 받은 순서다. 표의 "#"는 정렬과 상관없이 이 값이다. */
export function pickPlaces(combos: readonly ErComboStat[]): Map<string, number> {
  return new Map(combos.map((combo, index) => [comboKey(combo), index + 1]));
}

/**
 * "새로" 태그: 직전 갱신에 없던(비교할 값이 없는) 조합. 직전 갱신 자체가 없으면(첫 수집) 모든 행이 비교 없음이라 붙이지 않는다(점검 V2 9번).
 * 직전이나 이번이 표본 적음이라 비교하지 않은 조합(change null)은 서버가 표본 적음으로 표시하므로, 표본 적은 행에는 붙이지 않는다.
 */
export const isNewCombo = (combo: ErComboStat, basis: ErMetaBasisV2 | null) =>
  basis !== null && basis.previousCollectedAt !== null && combo.change === null && !combo.lowSample;

/** 화면 반올림으로 보이는 변화량 문자열. 0으로 보이면 flat으로 본다. */
const shownChange: Record<TrendMetric, (delta: number) => string> = {
  avgRank: formatRankChange,
  top1Rate: formatPointChange,
  pickRate: formatPointChange,
  avgMmrGain: delta => formatMmr(delta),
};

/** 지난번 대비 좋아졌는지. 평균 순위는 작아지면 up, 나머지는 커지면 up. 직전 값이 없으면 null. */
export function trendOf(metric: TrendMetric, change: ErComboStat["change"]): Trend | null {
  const delta = change?.[metric];
  if (delta === undefined || delta === null) return null;
  const shown = shownChange[metric](delta);
  if (!shown.startsWith("+") && !shown.startsWith("-")) return "flat";
  const better = metric === "avgRank" ? delta < 0 : delta > 0;
  return better ? "up" : "down";
}

/** 변화량을 화면 문자열로. 순위는 "-0.5", 비율은 "+1.2%p", MMR은 "+3.1" */
export const changeText = (metric: TrendMetric, change: ErComboStat["change"]): string | null => {
  const delta = change?.[metric];
  return delta === undefined || delta === null ? null : shownChange[metric](delta);
};

/** 직전 갱신의 평균 순위. */
export const previousRank = (combo: ErComboStat) => combo.avgRank - (combo.change?.avgRank ?? 0);

/**
 * 오르고 내린 조합 칸의 변화량(부호 없이). 화면에 보이는 두 순위(반올림 뒤)의 차라서 "3.8위 → 4.0위 ▼ 0.2"처럼 앞뒤 숫자와 맞는다(점검 V2 16번).
 */
export function moverChangeText(combo: ErComboStat): string {
  const shown = Number(formatRank(combo.avgRank)) - Number(formatRank(previousRank(combo)));
  return formatRankChange(shown).replace(/^[+-]/, "");
}

/**
 * 오르고 내린 조합. 평균 순위 변화로 고르고(작아지면 오름), 표본 적음·직전 값 없음·반올림하면 같은 움직임은 뺀다.
 * 보리 대사(apps/server/src/narration/facts.ts의 rankMovers)와 같은 규칙이다. 서버 검사가 두 결과를 비교한다.
 */
export function selectMovers(combos: readonly ErComboStat[], limit = 5): { risers: ErComboStat[]; fallers: ErComboStat[] } {
  const moved = combos.filter(combo => !combo.lowSample && combo.change !== null && formatRank(previousRank(combo)) !== formatRank(combo.avgRank));
  const delta = (combo: ErComboStat) => combo.change?.avgRank ?? 0;
  return {
    risers: moved.filter(combo => delta(combo) < 0).sort((a, b) => delta(a) - delta(b)).slice(0, limit),
    fallers: moved.filter(combo => delta(combo) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, limit),
  };
}

export type BadgeTone = "ok" | "warn" | "muted" | "busy" | "error";

/** 위 띠의 데이터 상태 배지. 키가 없으면 다른 상태보다 먼저 알린다. */
export function connectionBadge(state: DashboardState): { tone: BadgeTone; label: string } {
  if (!state.refresh.available) return { tone: "error", label: "키 없음" };
  switch (state.connection) {
    case "ready": return { tone: "ok", label: "최신" };
    case "stale": return { tone: "warn", label: "오래됨" };
    case "refreshing": return { tone: "busy", label: "갱신 중" };
    default: return { tone: "muted", label: "데이터 없음" };
  }
}

export type RefreshView = {
  buttonLabel: string;
  disabled: boolean;
  /** 0~1. 갱신 중이 아니거나 모르면 null */
  progress: number | null;
  progressText: string | null;
  notice: string | null;
  /** 안내의 자세한 내용(서버 원문). 화면에는 바로 보이지 않고 마우스를 올리면 보인다 */
  noticeDetail?: string;
};

export function refreshView(state: DashboardState): RefreshView {
  const { available, running, progress, lastError, autoStarted, etaSeconds } = state.refresh;
  if (!available) {
    return { buttonLabel: "갱신", disabled: true, progress: null, progressText: null, notice: "이터널리턴 API 키(ER_API_KEY)가 없어 데이터를 받을 수 없어요. .env에 키를 넣고 서버를 다시 켜 주세요." };
  }
  if (running) {
    const prefix = autoStarted ? "자동 갱신 중" : "갱신 중";
    return {
      buttonLabel: "갱신 중",
      disabled: true,
      progress,
      progressText: progress === null ? "갱신 준비 중" : `${prefix} ${Math.round(progress * 100)}%${etaSeconds != null ? ` · 약 ${Math.max(1, Math.ceil(etaSeconds / 60))}분 남음` : ""}`,
      notice: null,
    };
  }
  if (lastError) {
    // 서버 원문은 개발자용이라 바로 보이지 않는다(api.ts 원칙, 점검 V2 21번).
    return { buttonLabel: "지금 갱신", disabled: false, progress: null, progressText: null, notice: "지난 갱신이 실패했어요. 지난 데이터를 그대로 보여 드려요.", noticeDetail: lastError };
  }
  return { buttonLabel: "지금 갱신", disabled: false, progress: null, progressText: null, notice: null };
}

/** 위 띠 안내: 받기 오류(다음 성공 때 지움), 버튼 안내, 상태 안내를 모두 보인다. 같은 문구는 한 번만(점검 V2 13번). */
export function headerNotices(notices: { load: string | null; action: string | null; view: string | null }): string[] {
  return [...new Set([notices.load, notices.action, notices.view].filter((notice): notice is string => notice !== null))];
}

/** 내 전적 칸 안내. 키가 없어 못 받은 경우는 메타도 못 받으므로 "메타는 그대로"라고 말하지 않는다(점검 V2 18번). */
export function playerMessage(status: Exclude<DashboardPlayerStatus, "ready">, erAvailable: boolean): string {
  switch (status) {
    case "unset": return "스튜디오 설정 탭에서 게임 닉네임을 한 번 저장하면 내 전적이 여기에 보여요.";
    case "loading": return "전적을 불러오는 중이에요.";
    case "not-found": return "저장한 닉네임으로 플레이어를 찾지 못했어요. 설정 탭에서 닉네임을 확인해 주세요.";
    default: return erAvailable
      ? "전적을 불러오지 못했어요. 메타 분석은 그대로 볼 수 있어요."
      : "이터널리턴 API 키가 없어 전적을 불러올 수 없어요.";
  }
}

/** 다음 폴링까지 기다릴 시간. 아직 한 번도 받지 못했으면 평소 간격이다. 탭이 숨겨져 있으면 늦춘다. */
export function pollIntervalMs(state: DashboardState | null, hidden = false): number {
  const running = state?.refresh.running ?? false;
  if (hidden) return running ? POLL_HIDDEN_REFRESHING_MS : POLL_HIDDEN_IDLE_MS;
  return running ? POLL_REFRESHING_MS : POLL_IDLE_MS;
}

/**
 * 이 브라우저에서 아직 읽지 않은 새 대사면 한 번 자동으로 읽는다.
 * 화면이 보이지 않으면(숨긴 탭) 미룬다. 숨긴 채 읽고 "읽음"으로 저장하면 돌아왔을 때 다시 읽지 않는다(점검 V2 14번).
 */
export const shouldAutoPlay = (narration: Narration | null, lastPlayedId: string | null, visible = true) =>
  visible && narration !== null && narration.lines.length > 0 && narration.id !== lastPlayedId;

/** 표·상세에서 같이 쓰는 칸 문자열 */
export const cell = {
  pickRate: (combo: ErComboStat) => formatPercent(combo.pickRate),
  avgRank: (combo: ErComboStat) => `${formatRank(combo.avgRank)}위`,
  top1Rate: (combo: ErComboStat) => formatPercent(combo.top1Rate),
  avgMmrGain: (combo: ErComboStat) => formatMmr(combo.avgMmrGain),
};
