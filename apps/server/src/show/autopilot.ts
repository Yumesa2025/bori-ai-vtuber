import type { ShowStage } from "@bori/shared";

/**
 * 코너 자동 진행(2026-10-15 사용자 요청). 코너마다 목표 시간을 두고, 시간이 다 되면 보리가 하던 말을 마친 뒤
 * 연결 멘트를 하고 스스로 다음 코너로 넘어간다. 시간은 4분 시연 구성(docs/broadcast/plan.md 방송 타임라인)을 따른다.
 * - 목표 시간이 지나도 대사를 자르지 않는다. 시간이 다 된 코너에서는 새 채팅 답·혼잣말을 시작하지 않고(holding) 말이 끝나면 넘어간다.
 * - 대기(idle)는 "방송 켜기" 뒤 대기 화면을 잠깐 보여 준 다음 오프닝을 시작한다. 방송 켜기 전에는 기다린다.
 * - 엔딩은 말하지 않는다. 엔딩 화면을 잠깐 보여 준 뒤 배경음악을 서서히 줄여 끝낸다(finish, 엔딩마다 한 번).
 * - 운영자가 직접 넘기면(단계 세대가 바뀌면) 그 코너의 시간을 새로 센다.
 */

/**
 * 코너별 목표 시간(초). 4분 시연 구성: 대기 8초 · 오프닝 22초 · 브리핑 55초 · 질문 70초 · 전적 65초(떠날 때 마무리 인사 약 8초)
 * · 엔딩 12초(6초 보여 준 뒤 6초 동안 음악을 줄인다). 실제 길이는 보리 대사 길이에 따라 조금 늘어난다.
 */
export const CORNER_SECONDS: Record<ShowStage, number> = { idle: 8, opening: 22, briefing: 55, qna: 70, diagnosis: 65, ending: 6 };

/** 시간이 다 됐을 때 다음 코너로 넘어가며 하는 말. 다음 코너의 첫 대사가 이어서 나오므로 짧게 둔다. */
export const BRIDGE_LINES: Partial<Record<ShowStage, string>> = {
  opening: "그럼 바로 시작해 볼게요!",
  briefing: "TOP 5는 여기까지예요. 이제 다음으로 넘어가 볼게요!",
  qna: "질문 고마워요! 시간이 다 돼서 다음 코너로 넘어갈게요.",
  // 전적 진단은 진행기가 떠날 때 마무리 인사(stages.ts outro)를 하므로 따로 연결 멘트를 두지 않는다.
};

export type AutopilotStatus = {
  enabled: boolean;
  /** 지금 코너에 주어진 시간(초). 시간 제한이 없는 코너는 0. */
  stageSeconds: number;
  /** 지금 코너에 들어온 뒤 지난 시간(초). */
  elapsedSeconds: number;
};

/**
 * 질문 코너에서 아직 답하지 않은 캐릭터·메타 질문이 남아 있으면 목표 시간을 이만큼 더 쓴다(2026-10-15 사용자 요청:
 * 질문 코너에 나온 캐릭터 이름은 무시하지 말고 다 봐 주기). 끝없이 늘지 않게 상한을 둔다.
 */
export const QNA_EXTRA_SECONDS = 30;

/** 보리가 말하는 코너. 이 코너에서만 시간이 되면 채팅 답을 미룬다. */
const TALK_STAGES: ReadonlySet<ShowStage> = new Set(["opening", "briefing", "qna", "diagnosis"]);

export function createAutopilot(deps: {
  stage: () => ShowStage;
  /** 단계 세대. 단계가 바뀔 때마다 는다. */
  epoch: () => number;
  /** "방송 켜기"를 눌렀는지. 대기 단계의 시간은 이때부터 센다. */
  onAir: () => boolean;
  /** 지금 말하거나 말할 준비 중이면 false. */
  ready: () => boolean;
  say: (line: string, isCurrent: () => boolean) => Promise<void>;
  /** 보리가 말을 다 마칠 때까지 기다린다. */
  waitQuiet: () => Promise<void>;
  /** 다음 단계로. 대기에서는 방송 세션도 연다. */
  next: () => Promise<void>;
  /** 엔딩 화면을 보여 준 뒤 한 번 부른다(배경음악을 서서히 줄여 멈춘다). */
  finish: () => Promise<void>;
  /** 지금 코너에 아직 답하지 않은 캐릭터·메타 질문이 있는지. 질문 코너는 있으면 시간을 더 쓴다. */
  pendingFocus?: () => boolean;
  enabled?: boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let enabled = deps.enabled ?? false;
  let seenEpoch = deps.epoch();
  let seenOnAir = deps.onAir();
  let stageStartedAt = now();
  let advancing = false;
  /** finish를 부른 엔딩 세대. 같은 엔딩에서 두 번 부르지 않는다. */
  let finishedEpoch: number | null = null;

  /** 단계가 바뀌었거나 방송을 막 켰으면 그 코너의 시작 시각을 지금으로 둔다. */
  function observe() {
    const epoch = deps.epoch();
    const onAir = deps.onAir();
    if (epoch !== seenEpoch || (onAir && !seenOnAir)) stageStartedAt = now();
    seenEpoch = epoch;
    seenOnAir = onAir;
  }

  const timed = () => {
    const stage = deps.stage();
    if (stage === "idle") return deps.onAir();
    return CORNER_SECONDS[stage] > 0;
  };
  const limitMs = () => {
    const stage = deps.stage();
    const extra = stage === "qna" && deps.pendingFocus?.() ? QNA_EXTRA_SECONDS : 0;
    return (CORNER_SECONDS[stage] + extra) * 1000;
  };
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
    /** 주기적으로 부른다. 시간이 다 됐고 보리가 말을 마쳤으면 다음 코너로 넘어간다. 엔딩에서는 한 번 마무리한다. */
    tick() {
      if (!enabled || advancing || !overdue()) return;
      if (deps.stage() === "ending") {
        const epoch = deps.epoch();
        if (finishedEpoch === epoch) return;
        finishedEpoch = epoch;
        void deps.finish().catch(error => console.error("[bori-server] 엔딩 마무리 실패:", error instanceof Error ? error.message : String(error)));
        return;
      }
      if (!deps.ready()) return;
      void advance(deps.epoch());
    },
    /** 새 채팅 답·혼잣말을 미뤄야 하는지. 말하는 코너에서 시간이 다 됐거나 넘어가는 중이다. */
    holding: () => enabled && (advancing || (TALK_STAGES.has(deps.stage()) && overdue())),
    setEnabled(next: boolean) { enabled = next; },
    status(): AutopilotStatus {
      observe();
      return { enabled, stageSeconds: timed() ? CORNER_SECONDS[deps.stage()] : 0, elapsedSeconds: Math.floor((now() - stageStartedAt) / 1000) };
    },
    /** 진행 중인 자동 넘김이 있는지. 검사용. */
    isAdvancing: () => advancing,
  };
}
