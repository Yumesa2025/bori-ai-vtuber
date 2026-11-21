/**
 * 대시보드 화면 규칙 검사: 정렬, 지난번 대비 ▲▼, 배지·갱신 버튼, 폴링 간격, 자동 읽기 판단.
 * 오르고 내린 조합 규칙이 보리 대사와 같은지는 서버 검사(narration-facts)가 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardState, ErComboStat } from "@bori/shared";
import { comboKey, comboLabel, connectionBadge, defaultDirection, pollIntervalMs, refreshView, shouldAutoPlay, sortCombos, trendOf } from "../src/dashboard";
import { createMockStore } from "../dev/mock-store";

const ready = () => createMockStore("ready").dashboard().body as DashboardState;
const combos = () => ready().combos;

describe("메타 표 정렬", () => {
  test("평균 순위만 오름차순이 기본이다", () => {
    assert.equal(defaultDirection("avgRank"), "asc");
    for (const key of ["pickRate", "top1Rate", "avgMmrGain", "participants"] as const) assert.equal(defaultDirection(key), "desc");
  });

  test("고른 열로 정렬하고 원본을 바꾸지 않는다", () => {
    const list = combos();
    const before = list.map(comboKey);
    const sorted = sortCombos(list, "avgRank", "asc");
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i - 1].avgRank <= sorted[i].avgRank);
    assert.deepEqual(list.map(comboKey), before);
    const desc = sortCombos(list, "pickRate", "desc");
    for (let i = 1; i < desc.length; i += 1) assert.ok(desc[i - 1].pickRate >= desc[i].pickRate);
  });

  test("MMR 표본이 없는 조합은 방향과 상관없이 맨 뒤다", () => {
    const list = combos().map((entry, index) => (index === 0 ? { ...entry, avgMmrGain: null } : entry));
    assert.equal(sortCombos(list, "avgMmrGain", "desc").at(-1)?.avgMmrGain, null);
    assert.equal(sortCombos(list, "avgMmrGain", "asc").at(-1)?.avgMmrGain, null);
  });
});

describe("지난번 대비", () => {
  const change = (avgRank: number, rate: number): ErComboStat["change"] => ({ avgRank, top1Rate: rate, pickRate: rate, avgMmrGain: rate * 100 });

  test("평균 순위는 작아지면 좋아짐(up), 비율·MMR은 커지면 up", () => {
    assert.equal(trendOf("avgRank", change(-0.3, 0)), "up");
    assert.equal(trendOf("avgRank", change(0.3, 0)), "down");
    assert.equal(trendOf("pickRate", change(0, 0.01)), "up");
    assert.equal(trendOf("top1Rate", change(0, -0.01)), "down");
    assert.equal(trendOf("avgMmrGain", change(0, 0.05)), "up");
  });

  test("반올림하면 0인 변화는 flat, 직전 값이 없으면 null", () => {
    assert.equal(trendOf("avgRank", change(0.04, 0)), "flat");
    assert.equal(trendOf("pickRate", change(0, 0.0004)), "flat");
    assert.equal(trendOf("avgRank", null), null);
    assert.equal(trendOf("avgMmrGain", { avgRank: 0, top1Rate: 0, pickRate: 0, avgMmrGain: null }), null);
  });

  test("조합 이름은 무기를 모르면 캐릭터 이름만", () => {
    assert.equal(comboLabel({ characterName: "재키", weaponName: "쌍검" }), "재키 쌍검");
    assert.equal(comboLabel({ characterName: "재키", weaponName: "" }), "재키");
  });
});

describe("상태 배지와 갱신 버튼", () => {
  const state = (patch: Omit<Partial<DashboardState>, "refresh"> & { refresh?: Partial<DashboardState["refresh"]> }): DashboardState => {
    const base = ready();
    return { ...base, ...patch, refresh: { ...base.refresh, ...patch.refresh } };
  };

  test("연결 상태별 배지", () => {
    assert.deepEqual(connectionBadge(state({ connection: "ready" })), { tone: "ok", label: "최신" });
    assert.deepEqual(connectionBadge(state({ connection: "stale" })), { tone: "warn", label: "오래됨" });
    assert.deepEqual(connectionBadge(state({ connection: "missing" })), { tone: "muted", label: "데이터 없음" });
    assert.deepEqual(connectionBadge(state({ connection: "refreshing" })), { tone: "busy", label: "갱신 중" });
    assert.deepEqual(connectionBadge(state({ connection: "missing", refresh: { available: false } })), { tone: "error", label: "키 없음" });
  });

  test("갱신 중이면 진행률을 보이고 버튼을 끈다", () => {
    const view = refreshView(state({ connection: "refreshing", refresh: { running: true, progress: 0.424 } }));
    assert.equal(view.disabled, true);
    assert.equal(view.buttonLabel, "갱신 중");
    assert.equal(view.progressText, "갱신 중 42%");
    assert.equal(view.progress, 0.424);
    assert.equal(refreshView(state({ refresh: { running: true, progress: null } })).progressText, "갱신 준비 중");
  });

  test("키가 없으면 안내하고 버튼을 끈다", () => {
    const view = refreshView(state({ connection: "missing", refresh: { available: false } }));
    assert.equal(view.disabled, true);
    assert.match(view.notice ?? "", /ER_API_KEY/);
  });

  test("지난 갱신이 실패했으면 오류를 보이고 다시 누를 수 있다", () => {
    const view = refreshView(state({ refresh: { lastError: "이터널리턴 API가 응답하지 않았습니다." } }));
    assert.equal(view.disabled, false);
    assert.equal(view.notice, "지난 갱신 실패: 이터널리턴 API가 응답하지 않았습니다.");
  });

  test("자동으로 시작한 갱신은 그렇다고 알린다", () => {
    assert.equal(refreshView(state({ refresh: { running: true, progress: 0.1, autoStarted: true } })).progressText, "자동 갱신 중 10%");
  });
});

describe("폴링과 자동 읽기", () => {
  test("갱신 중에는 2초, 평소와 아직 못 받았을 때는 30초", () => {
    assert.equal(pollIntervalMs({ ...ready(), refresh: { ...ready().refresh, running: true } }), 2000);
    assert.equal(pollIntervalMs(ready()), 30_000);
    assert.equal(pollIntervalMs(null), 30_000);
  });

  test("이 브라우저에서 아직 읽지 않은 대사만 한 번 자동으로 읽는다", () => {
    const narration = ready().narration;
    assert.ok(narration);
    assert.equal(shouldAutoPlay(narration, null), true);
    assert.equal(shouldAutoPlay(narration, narration.id), false);
    assert.equal(shouldAutoPlay(null, null), false);
    assert.equal(shouldAutoPlay({ ...narration, lines: [] }, null), false);
  });
});
