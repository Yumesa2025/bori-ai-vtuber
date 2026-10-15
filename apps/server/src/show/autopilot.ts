import type { ShowStage } from "@bori/shared";

/**
 * 코너 자동 진행(2026-10-15 사용자 요청). 코너마다 시간을 두고, 시간이 다 되면 보리가 하던 말을 마친 뒤
 * 연결 멘트를 하고 스스로 다음 코너로 넘어간다. 시간은 설계 문서(docs/broadcast/design-spec.md)의 방송 진행표를 따른다.
 * - 시간이 다 된 코너에서는 새 채팅 답·혼잣말을 시작하지 않는다(holding). 하던 말은 끊지 않는다.
 * - 엔딩에서는 멈춘다. 대기(idle)는 운영자가 오프닝을 시작한다.
 * - 운영자가 직접 넘기면(단계 세대가 바뀌면) 그 코너의 시간을 새로 센다.
 */

/** 코너별 시간(초). 방송 진행표: 오프닝 0:00~0:30, 브리핑 ~1:30, 질문 ~3:00, 전적 ~4:00, 엔딩 ~4:30. */
export const CORNER_SECONDS: Record<ShowStage, number> = { idle: 0, opening: 30, briefing: 60, qna: 90, diagnosis: 60, ending: 30 };

/** 시간이 다 됐을 때 다음 코너로 넘어가며 하는 말. 다음 코너의 첫 대사가 이어서 나오므로 짧게 둔다. */
export const BRIDGE_LINES: Partial<Record<ShowStage, string>> = {
  opening: "그럼 바로 시작해 볼게요!",
  briefing: "TOP 5는 여기까지예요. 이제 다음으로 넘어가 볼게요!",
  qna: "질문 고마워요! 시간이 다 돼서 다음 코너로 넘어갈게요.",
  diagnosis: "전적 진단은 여기까지예요. 이제 마무리해 볼게요!",
};

export type AutopilotStatus = {
  enabled: boolean;
  /** 지금 코너에 주어진 시간(초). 시간 제한이 없는 코너는 0. */
  stageSeconds: number;
  /** 지금 코너에 들어온 뒤 지난 시간(초). */
  elapsedSeconds: number;
};

export function createAutopilot(deps: {
  stage: () => ShowStage;
  /** 단계 세대. 단계가 바뀔 때마다 는다. */
  epoch: () => number;
  /** 지금 말하거나 말할 준비 중이면 false. */
  ready: () => boolean;
  say: (line: string, isCurrent: () => boolean) => Promise<void>;
  /** 보리가 말을 다 마칠 때까지 기다린다. */
  waitQuiet: () => Promise<void>;
  next: () => Promise<void>;
  enabled?: boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let enabled = deps.enabled ?? false;
  let seenEpoch = deps.epoch();
  let stageStartedAt = now();
  let advancing = false;

  /** 단계가 바뀌었으면 그 코너의 시작 시각을 지금으로 둔다. */
  function observe() {
    const epoch = deps.epoch();
    if (epoch !== seenEpoch) { seenEpoch = epoch; stageStartedAt = now(); }
  }

  const limitMs = () => CORNER_SECONDS[deps.stage()] * 1000;
  const timed = () => { const stage = deps.stage(); return stage !== "idle" && stage !== "ending" && limitMs() > 0; };
  const overdue = () => { observe(); return timed() && now() - stageStartedAt >= limitMs(); };

  async function advance(at: number) {
    advancing = true;
    try {
      const isCurrent = () => deps.epoch() === at;
      const line = BRIDGE_LINES[deps.stage()];
      if (line) {
        await deps.say(line, isCurrent);
        await deps.waitQuiet();
      }
      if (isCurrent()) await deps.next();
    } catch (error) {
      console.error("[bori-server] 코너 자동 진행 실패:", error instanceof Error ? error.message : String(error));
    } finally {
      advancing = false;
    }
  }

  return {
    /** 주기적으로 부른다. 시간이 다 됐고 보리가 말을 마쳤으면 다음 코너로 넘어간다. */
    tick() {
      if (!enabled || advancing || !overdue() || !deps.ready()) return;
      void advance(deps.epoch());
    },
    /** 새 채팅 답·혼잣말을 미뤄야 하는지. 시간이 다 됐거나 넘어가는 중이다. */
    holding: () => enabled && (advancing || overdue()),
    setEnabled(next: boolean) { enabled = next; },
    status(): AutopilotStatus {
      observe();
      return { enabled, stageSeconds: timed() ? CORNER_SECONDS[deps.stage()] : 0, elapsedSeconds: Math.floor((now() - stageStartedAt) / 1000) };
    },
    /** 진행 중인 자동 넘김이 있으면 끝날 때까지 기다린다. 검사용. */
    isAdvancing: () => advancing,
  };
}
