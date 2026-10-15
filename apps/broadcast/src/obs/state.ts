/**
 * OBS 페이지 공통 상태. 모든 페이지는 서버의 `/api/state`를 읽어 그리기만 한다.
 * `?demo=1`이면 서버 없이 고정 예시 상태로 그린다(디자인 확인·스크린샷용).
 * 대시보드 예시는 `?view=season|top5|character|missing|player|waiting|summary`로 고른다.
 */
import { createElement, StrictMode, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { BroadcastState, DashboardView, ErCharacterStat, ErMetaBasis, ShowState } from "@bori/shared";
import "./obs.css";

const query = new URLSearchParams(location.search);
export const isDemo = query.get("demo") === "1";

export const emptyState: BroadcastState = { status: "idle", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };

// ── 예시 상태 ──
// 화면 확인용 가짜 값이다. 실제 집계로 오해하지 않게 기준 문구에 "예시"를 밝힌다.
const demoBasis: ErMetaBasis = {
  seasonName: "시즌 21",
  sampleGames: 7200,
  collectedAt: "2026-10-15T09:00:00.000Z",
  description: "예시 데이터 · 최근 상위 랭커 7,200판 기준",
};

const demoTop5: ErCharacterStat[] = [
  { code: 1, name: "재키", picks: 585, pickRate: 0.0812, avgRank: 3.42, top1Rate: 0.12, mainWeapon: "쌍검" },
  { code: 9, name: "피오라", picks: 497, pickRate: 0.069, avgRank: 3.81, top1Rate: 0.104, mainWeapon: "레이피어" },
  { code: 2, name: "아야", picks: 461, pickRate: 0.064, avgRank: 3.95, top1Rate: 0.097, mainWeapon: "권총" },
  { code: 10, name: "매그너스", picks: 403, pickRate: 0.056, avgRank: 4.12, top1Rate: 0.088, mainWeapon: "방망이" },
  { code: 11, name: "자히르", picks: 367, pickRate: 0.051, avgRank: 4.3, top1Rate: 0.081, mainWeapon: "투척" },
];

export const demoDashboards: Record<string, DashboardView> = {
  season: { kind: "season", basis: demoBasis },
  top5: { kind: "top5", items: demoTop5, revealed: 5, basis: demoBasis },
  character: { kind: "character", query: "재키", stat: demoTop5[0], suggestions: [], basis: demoBasis },
  missing: { kind: "character", query: "잭키", stat: null, suggestions: ["재키", "레니", "키아라"], basis: demoBasis },
  player: {
    kind: "player",
    status: "ready",
    report: {
      maskedNickname: "보리팬**",
      seasonName: "시즌 21",
      games: 48,
      avgRank: 3.6,
      top1Rate: 0.146,
      recentRanks: [1, 4, 2, 7, 3, 1, 5, 2, 6, 3],
      mainCharacters: [{ name: "재키", games: 21, avgRank: 3.1 }, { name: "아야", games: 15, avgRank: 3.9 }, { name: "피오라", games: 12, avgRank: 4.2 }],
    },
  },
  waiting: { kind: "player", status: "waiting", report: null },
  summary: { kind: "summary", characters: ["재키", "피오라", "아야", "매그너스", "자히르"] },
};

function demoShow(dashboard: DashboardView): ShowState {
  return {
    stage: "briefing",
    scene: "보리-메인",
    dashboard,
    caption: "이번 랭커 데이터 TOP 5를 볼게요! 1위는 재키예요. 픽률이 8.1%나 돼요!",
    connections: { chzzk: "connected", obs: "connected", er: "ready" },
    erRefreshProgress: null,
  };
}

/** `?demo=1`일 때 쓰는 고정 상태. 채팅·자막·대시보드가 모두 채워져 있다. */
export const demoState: BroadcastState = {
  ...emptyState,
  status: "live",
  visibleChats: [
    { id: "d1", content: "보리 안녕하세요!", receivedAt: "2026-10-15T09:00:01.000Z", category: "normal" },
    { id: "d2", content: "재키 요즘 어때?", receivedAt: "2026-10-15T09:00:05.000Z", category: "question" },
    { id: "d3", content: "!전적 보리팬클럽", receivedAt: "2026-10-15T09:00:09.000Z", category: "normal" },
    { id: "d4", content: "오늘 데이터 재밌다 ㅋㅋ", receivedAt: "2026-10-15T09:00:12.000Z", category: "normal" },
  ],
  currentResponse: {
    reply: "이번 랭커 데이터 TOP 5를 볼게요! 1위는 재키예요. 픽률이 8.1%나 돼요!",
    emotion: { primary: "surprised", intensity: 0.7, durationSeconds: 4 },
    actions: [],
    source: "llm",
  },
  // 엔딩 페이지는 요약을 그리므로 기본 예시도 요약이다. 나머지는 TOP 5.
  show: demoShow(demoDashboards[query.get("view") ?? (location.pathname.endsWith("/ending.html") ? "summary" : "top5")] ?? demoDashboards.top5),
};

/**
 * 서버 상태를 250ms마다 읽는다. 옛 방송 화면(main.tsx)과 같은 방식이다.
 * - 앞 요청이 끝나기 전에는 다음 요청을 보내지 않는다(서버가 느릴 때 쌓이지 않게).
 * - 원문이 그대로면 다시 넣지 않는다. 같은 내용으로 setState하면 객체 참조가 바뀌어 효과가 다시 돈다.
 */
export function useBroadcastState(): BroadcastState {
  const [state, setState] = useState<BroadcastState>(isDemo ? demoState : emptyState);

  useEffect(() => {
    if (isDemo) return;
    let inFlight = false;
    let lastText: string | null = null;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      fetch("/api/state")
        .then(response => response.ok ? response.text() : null)
        .then(text => {
          if (text === null || text === lastText) return;
          lastText = text;
          setState(JSON.parse(text) as BroadcastState);
        })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };

    refresh();
    const timer = window.setInterval(refresh, 250);
    return () => window.clearInterval(timer);
  }, []);

  return state;
}

/**
 * OBS 페이지를 그린다. 겹쳐 얹는 페이지(transparent)는 배경을 비우고,
 * 대기·엔딩처럼 화면 전체를 덮는 페이지는 불투명 배경을 쓴다.
 * `?frame=video`이면 배경 영상이 패널 틀을 그리므로 패널 자체 테두리·바탕을 지운다(framed).
 */
export function renderObsPage(App: ComponentType, options: { transparent: boolean }) {
  document.documentElement.classList.add("obs", options.transparent ? "transparent" : "opaque");
  if (query.get("frame") === "video") document.documentElement.classList.add("framed");
  createRoot(document.getElementById("root")!).render(createElement(StrictMode, null, createElement(App)));
}
