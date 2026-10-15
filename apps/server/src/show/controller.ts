import { showStages, type DashboardView, type ErCharacterStat, type ErMetaBasis, type ObsSceneName, type ShowStage } from "@bori/shared";
import { stageGameData } from "./game-data.js";
import { stageConfig, type StageContext } from "./stages.js";

/**
 * 방송 진행기. 운영자가 누르는 next·prev·reset으로 단계를 옮기고, 단계마다 OBS 장면·대시보드·보리 대사를 맞춘다.
 * 화면에 보일 값(단계·장면·대시보드)만 여기서 갖는다. 자막·연결 상태는 서버가 붙인다.
 */
export type ShowControllerDeps = {
  /** 실패해도 진행한다. OBS가 꺼져 있어도 방송은 이어진다. */
  obs: { setScene(name: ObsSceneName): Promise<void> };
  /**
   * 지시와 게임 데이터로 보리 대사를 만들어 화면에 올린다. 올리면 끝나고, 못 만들면 실패한다.
   * isCurrent가 false가 되면 그 사이 단계가 바뀐 것이라 대사를 올리지 않는다.
   */
  speak: (directive: string, gameData: readonly string[], isCurrent: () => boolean) => Promise<void>;
  /** 정해진 문장을 그대로 말한다. 대사를 못 만들었을 때 쓴다. */
  say: (line: string, isCurrent: () => boolean) => Promise<void>;
  er: { basis(): ErMetaBasis | null; top5(): ErCharacterStat[] };
  /** TOP 5를 한 줄씩 여는 간격. 기본 1.2초. */
  revealIntervalMs?: number;
};

export type ShowView = { stage: ShowStage; scene: ObsSceneName; dashboard: DashboardView };

const DEFAULT_REVEAL_INTERVAL_MS = 1200;

export function createShowController(deps: ShowControllerDeps) {
  const revealIntervalMs = deps.revealIntervalMs ?? DEFAULT_REVEAL_INTERVAL_MS;
  let stage: ShowStage = "idle";
  let dashboard: DashboardView = stageConfig.idle.dashboard({ basis: deps.er.basis(), top5: [], mentioned: [] });
  /** 이번 방송에서 대시보드에 띄운 캐릭터. 처음 띄운 순서를 지킨다. */
  let mentioned: string[] = [];
  /** 단계를 옮기는 중(장면 전환·대사 생성). 이 동안 next·prev는 무시한다. 빠른 두 번 누르기를 막는다. */
  let busy = false;
  /** 단계 세대. 단계가 바뀔 때마다 올려, 늦게 끝난 대사·공개 타이머가 지금 단계를 건드리지 못하게 한다. */
  let epoch = 0;
  let revealTimer: ReturnType<typeof setInterval> | undefined;

  const context = (): StageContext => ({ basis: deps.er.basis(), top5: deps.er.top5(), mentioned: [...mentioned] });

  function stopReveal() {
    if (revealTimer) clearInterval(revealTimer);
    revealTimer = undefined;
  }

  /** 단계를 바꾸고 장면을 맞춘다. 대사는 부르는 쪽이 정한다. */
  function enter(next: ShowStage): { epoch: number; ctx: StageContext } {
    stopReveal();
    epoch += 1;
    stage = next;
    const ctx = context();
    dashboard = stageConfig[next].dashboard(ctx);
    return { epoch, ctx };
  }

  async function setScene(name: ObsSceneName) {
    try {
      await deps.obs.setScene(name);
    } catch (error) {
      // OBS 제어기는 실패를 스스로 기록한다. 여기서는 진행만 막지 않는다.
      console.error("[bori-server] OBS 장면 전환 실패:", error instanceof Error ? error.message : String(error));
    }
  }

  /** briefing 대사가 나간 뒤 TOP 5를 한 줄씩 연다. */
  function startReveal(current: number) {
    revealTimer = setInterval(() => {
      if (current !== epoch || dashboard.kind !== "top5") { stopReveal(); return; }
      if (dashboard.revealed >= dashboard.items.length) { stopReveal(); return; }
      dashboard = { ...dashboard, revealed: dashboard.revealed + 1 };
    }, revealIntervalMs);
  }

  async function move(next: ShowStage, options: { speak: boolean }) {
    const { epoch: current, ctx } = enter(next);
    const isCurrent = () => current === epoch;
    await setScene(stageConfig[next].scene);
    const { directive, fallbackLines } = stageConfig[next];
    if (!options.speak || directive.length === 0 || !isCurrent()) return;

    try {
      await deps.speak(directive, stageGameData(next, ctx), isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      console.error("[bori-server] 진행 대사 생성 실패, 고정 문장으로 말합니다:", error instanceof Error ? error.message : String(error));
      const line = fallbackLines[0];
      if (line) await deps.say(line, isCurrent).catch(sayError => console.error("[bori-server] 진행 고정 문장 실패:", sayError));
    }
    if (next === "briefing" && isCurrent()) startReveal(current);
  }

  /** 잠금 안에서 한 번만 옮긴다. 잠겨 있으면 아무것도 하지 않는다. */
  async function step(offset: 1 | -1) {
    if (busy) return;
    const index = showStages.indexOf(stage);
    const target = showStages[Math.min(showStages.length - 1, Math.max(0, index + offset))];
    if (target === stage) return;
    busy = true;
    try {
      await move(target, { speak: offset === 1 });
    } finally {
      busy = false;
    }
  }

  return {
    view: (): ShowView => ({ stage, scene: stageConfig[stage].scene, dashboard }),
    /** 지금 단계 세대. 단계가 바뀌었는지 비교하는 데 쓴다. */
    epoch: () => epoch,
    next: () => step(1),
    prev: () => step(-1),
    /** 잠금과 상관없이 idle로 간다. 진행 중이던 대사는 버려진다. 띄운 캐릭터 기록도 지운다. */
    async reset() {
      mentioned = [];
      if (stage === "idle") return;
      enter("idle");
      await setScene(stageConfig.idle.scene);
    },
    /** 채팅 답과 함께 캐릭터 카드를 띄운다. 찾은 캐릭터는 엔딩 요약에 남긴다. */
    showCharacter(view: Extract<DashboardView, { kind: "character" }>) {
      dashboard = view;
      const name = view.stat?.name;
      if (name && !mentioned.includes(name)) mentioned.push(name);
    },
    /** 전적 진단 카드처럼 대시보드를 바꾼다. 단계 세대가 다르면 바꾸지 않는다. */
    setDashboard(view: DashboardView, at: number) {
      if (at === epoch) dashboard = view;
    },
  };
}

export type ShowController = ReturnType<typeof createShowController>;
