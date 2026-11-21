import { boriMotionPriority, motionPairedExpression, resolveExpression, resolveMotion, type BoriExpressionName, type BoriMotionGroupName } from "@bori/live2d";

/** 대사 한 줄의 감정. 대시보드 대사는 감정 이름만 준다. 세기·지속 시간은 없으면 기본값이다. */
export type ReactionEmotion = { primary: string; intensity?: number; durationSeconds?: number };
/** 몸 모션 요청. allowlist 밖 이름은 실행하지 않는다. */
export type ReactionAction = { name: string; layer: string; priority: number };

export type Reaction = {
  /** null이면 표정을 해제해 기본 얼굴을 유지한다. */
  expression: BoriExpressionName | null;
  motion: { group: BoriMotionGroupName; priority: number } | null;
  /** 표정을 유지할 시간. 끝나면 기본 얼굴로 돌아온다. */
  holdMs: number;
};

/** 감정 지속 시간이 비정상이면 이 범위 안으로 맞춘다. LLM 출력이라 그대로 믿지 않는다. */
const HOLD_MIN_MS = 1000;
const HOLD_MAX_MS = 15000;
const HOLD_DEFAULT_MS = 4000;

/**
 * 대사의 감정·actions를 실행할 표정·모션으로 바꾼다.
 * 이름은 `@bori/live2d` allowlist를 통과한 것만 남는다. 목록 밖 이름은 실행하지 않는다.
 * 규칙은 방송 화면과 같다. 모션은 짝 표정이 켜져 있어야 보이므로 모션이 있으면 그 짝 표정을 쓴다.
 */
export function planReaction(emotion: ReactionEmotion | undefined, actions: readonly ReactionAction[] | undefined): Reaction {
  const primary = typeof emotion?.primary === "string" ? emotion.primary : "calm";
  const resolved = resolveMotion(Array.isArray(actions) ? actions : [], primary);
  // 우선순위도 LLM이 정한 값이라 SDK가 아는 범위(대기~강제)로 맞춘다.
  const motion = resolved && {
    group: resolved.group,
    priority: Math.min(boriMotionPriority.force, Math.max(boriMotionPriority.idle, Math.round(resolved.priority) || boriMotionPriority.normal)),
  };
  const expression = motion ? motionPairedExpression(motion.group) : resolveExpression(primary);

  const seconds = Number(emotion?.durationSeconds);
  const holdMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, seconds * 1000))
    : HOLD_DEFAULT_MS;

  return { expression, motion, holdMs };
}
