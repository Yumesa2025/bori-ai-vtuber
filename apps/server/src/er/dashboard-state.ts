import { estimateRemainingSeconds } from "./refresh-eta.js";
import type { ErPlayerLookup } from "@bori/er";
import type { DashboardPlayerStatus, DashboardSettings, DashboardState, ErComboStat, ErPlayerSummary } from "@bori/shared";
import { createDailyGate, refreshReason } from "./auto-refresh.js";
import { dashboardCombos, toBasisV2 } from "./combos.js";
import type { DashboardSettingsStore } from "./dashboard-settings.js";
import type { ErData } from "./er-data.js";

/**
 * 대시보드 상태 중 이터널리턴 부분(DashboardState에서 narration을 뺀 것)을 만든다.
 * - GET /api/dashboard: maybeAutoRefresh()를 부른 뒤 state()를 돌려준다.
 * - GET /api/dashboard/status: status()(연결·갱신·기준만, 자동 갱신 판정 없음). 스튜디오 설정 탭이 몇 초마다 묻는다.
 * - POST /api/er/refresh: refresh()
 * - GET/PUT /api/dashboard/settings: settings() / setSettings()
 * - 보리 대사: onRefreshed()에서 새 상태로 사실 목록을 만든다.
 * 닉네임은 로그에 찍지 않는다.
 */

export type DashboardDataState = Omit<DashboardState, "narration">;
/** 연결·갱신·기준만. 조합 계산과 자동 갱신 판정을 하지 않는 가벼운 상태 */
export type DashboardStatus = Pick<DashboardState, "connection" | "refresh" | "basis">;

export type DashboardData = {
  state(): DashboardDataState;
  status(): DashboardStatus;
  /** 갱신할 이유가 있으면 시작한다. 시작은 하루에 한 번만 한다(이유가 없을 때는 하루 문을 닫지 않는다). 시작했으면 true */
  maybeAutoRefresh(): boolean;
  /** 버튼 갱신. 시작했으면 true(이미 도는 중이거나 키가 없으면 false) */
  refresh(): boolean;
  settings(): DashboardSettings;
  /** 저장하고 전적을 다시 조회한다. 조회가 끝나면 풀린다(갱신 중이면 갱신 뒤로 미루고 바로 풀린다). 틀린 값은 DashboardSettingsError */
  setSettings(next: DashboardSettings): Promise<void>;
  /** 갱신이 성공하고 전적을 다시 조회한 뒤 부른다. 돌려준 함수로 그만 듣는다 */
  onRefreshed(listener: (state: DashboardDataState) => void): () => void;
};

type PlayerState = { status: DashboardPlayerStatus; lookup: ErPlayerLookup | null };

/**
 * 주캐릭터마다 조합 순위(픽률 순)에서 그 캐릭터가 처음 나오는 자리. 표본이 충분한 조합 안에서만 센다(설계 1.1).
 * 픽률 순이라 표본 적은 조합은 늘 뒤에 있어, 충분한 조합의 자리는 화면 표 순서와 같다. 표본 적은 조합만 있으면 null.
 */
export function toPlayerSummary(lookup: ErPlayerLookup, combos: ErComboStat[]): ErPlayerSummary {
  const ranked = combos.filter((combo) => !combo.lowSample);
  return {
    ...lookup,
    mainCharacters: lookup.mainCharacters.map(({ code, name, games, avgRank }) => {
      const index = ranked.findIndex((combo) => combo.characterCode === code);
      return { name, games, avgRank, metaRank: index >= 0 ? index + 1 : null };
    }),
  };
}

export function createDashboardData(options: { erData: ErData; settings: DashboardSettingsStore; now?: () => number }): DashboardData {
  const { erData, settings } = options;
  const now = options.now ?? Date.now;
  const gate = createDailyGate(now);
  const listeners = new Set<(state: DashboardDataState) => void>();
  let autoStarted = false;
  let player: PlayerState = { status: "unset", lookup: null };
  /** 늦게 끝난 옛 조회가 새 결과를 덮지 않게 센다. */
  let lookupSeq = 0;
  /** 갱신이 한 번이라도 끝났는지. 그 뒤에도 사전이 없으면 전적은 기다리지 않고 error다. */
  let refreshEnded = false;
  let combosCache: { key: unknown[]; combos: ErComboStat[] } | null = null;

  /** 집계·직전 집계·사전이 그대로면 다시 계산하지 않는다(대시보드는 몇 초마다 묻는다). */
  function combos(): ErComboStat[] {
    const meta = erData.meta();
    if (!meta) return [];
    const key = [meta, erData.previousMeta(), erData.dictionary()];
    if (!combosCache || combosCache.key.some((value, i) => value !== key[i])) {
      combosCache = { key, combos: dashboardCombos(meta, erData.previousMeta(), erData.dictionary()) };
    }
    return combosCache.combos;
  }

  function status(): DashboardStatus {
    const meta = erData.meta();
    const refresh = erData.status();
    return {
      // 키가 없으면 데이터가 있어도 받을 수 없으니 missing으로 보인다(설계 6절)
      connection: erData.hasClient() ? erData.connection() : "missing",
      refresh: { available: erData.hasClient(), running: refresh.refreshing, progress: refresh.progress, etaSeconds: refresh.refreshing && refresh.startedAt != null ? estimateRemainingSeconds(refresh.progress, now() - refresh.startedAt) : null, lastError: refresh.lastError, autoStarted },
      basis: meta ? toBasisV2(meta.basis, erData.previousMeta()?.basis ?? null) : null,
    };
  }

  function state(): DashboardDataState {
    const current = combos();
    return {
      ...status(),
      combos: current,
      player: { status: player.status, summary: player.lookup ? toPlayerSummary(player.lookup, current) : null },
    };
  }

  /**
   * 저장된 닉네임으로 전적을 조회한다. 갱신 중이면 loading으로 두고 갱신이 끝난 뒤(성공·실패 모두) 다시 한다.
   * 사전이 없으면 첫 갱신을 기다리는 동안 loading, 갱신이 끝났는데도 없으면 error다.
   */
  async function lookupPlayer(): Promise<void> {
    const seq = ++lookupSeq;
    const { nickname } = settings.get();
    if (!nickname) {
      player = { status: "unset", lookup: null };
      return;
    }
    if (!erData.hasClient()) {
      player = { status: "error", lookup: null };
      return;
    }
    if (!erData.available()) {
      const waiting = erData.status().refreshing || (erData.dictionary() === null && !refreshEnded);
      player = { status: waiting ? "loading" : "error", lookup: null };
      return;
    }
    player = { status: "loading", lookup: null };
    try {
      const found = await erData.lookupPlayerSummary(nickname);
      if (seq !== lookupSeq) return;
      player = found ? { status: "ready", lookup: found } : { status: "not-found", lookup: null };
    } catch (error) {
      if (seq !== lookupSeq) return;
      player = { status: "error", lookup: null };
      // 오류 메시지에는 닉네임이 없다(@bori/er가 쿼리를 빼고 만든다)
      console.warn("[bori-server] 대시보드 전적 조회 실패:", error instanceof Error ? error.message : "알 수 없는 오류");
    }
  }

  // 갱신이 실패해도 지난 사전으로 조회하거나(있으면) error로 바꿔 loading에 갇히지 않게 한다
  erData.onRefreshFailed(() => {
    refreshEnded = true;
    if (player.status === "loading") void lookupPlayer();
  });

  erData.onRefreshed(() => {
    refreshEnded = true;
    void (async () => {
      await lookupPlayer();
      const next = state();
      for (const listener of listeners) {
        try {
          listener(next);
        } catch (error) {
          console.error("[bori-server] 대시보드 갱신 알림 처리 실패:", error instanceof Error ? error.message : "알 수 없는 오류");
        }
      }
    })();
  });

  // 켤 때 닉네임과 사전이 있으면 바로 조회한다
  void lookupPlayer();

  return {
    state,
    status,

    maybeAutoRefresh(): boolean {
      if (!erData.hasClient() || erData.status().refreshing) return false;
      const meta = erData.meta();
      const dictionary = erData.dictionary();
      const reason = refreshReason({
        collectedAt: meta && dictionary ? meta.basis.collectedAt : null,
        metaSeasonId: meta?.basis.seasonId ?? null,
        dictionarySeasonId: dictionary?.seasonId ?? null,
        seasonEnd: dictionary?.seasonEnd ?? null,
        now: now(),
      });
      // 이유가 있을 때만 하루 문을 닫는다. 새것이라 넘긴 날도 나중에 24시간을 넘기면 그날 갱신한다.
      // 시작한 갱신이 실패하면 그날은 다시 시도하지 않는다(설계 6절).
      if (!reason || !gate.tryToday() || !erData.refresh()) return false;
      autoStarted = true;
      console.log(`[bori-server] 이터널리턴 자동 갱신 시작 (${reason})`);
      return true;
    },

    refresh(): boolean {
      const started = erData.refresh();
      if (started) autoStarted = false;
      return started;
    },

    settings: () => settings.get(),

    async setSettings(next: DashboardSettings) {
      settings.set(next);
      await lookupPlayer();
    },

    onRefreshed(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
