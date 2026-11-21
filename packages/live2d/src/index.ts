/** model3.json의 Expressions Name 값. 표정 8개 전부를 등록한다. */
export const boriExpressionNames = [
  "xingxingyan",
  "kuqi",
  "shangxin",
  "shengqi",
  "shoushi",
  "wuyu",
  "chidai",
  "changfa",
] as const;

/** model3.json의 Motions 그룹 이름. 모션 4개 전부를 등록한다. */
export const boriMotionGroupNames = [
  "xingxingyan",
  "kuqi",
  "shengqi",
  "shoushi",
] as const;

export type BoriExpressionName = (typeof boriExpressionNames)[number];
export type BoriMotionGroupName = (typeof boriMotionGroupNames)[number];

/**
 * 모션이 실제로 보이려면 짝이 되는 표정이 함께 켜져 있어야 한다.
 * 표정 파일이 효과를 활성화하고(예: shengqi는 Param66), 모션 파일이 그 효과의
 * 애니메이션 파라미터(Param68)를 돌리는 구조라, 표정 없이 모션만 실행하면 화면에 아무 변화가 없다.
 * 이 모델은 네 모션 모두 같은 이름의 표정과 짝을 이룬다.
 */
export const motionPairedExpression = (motion: BoriMotionGroupName): BoriExpressionName => motion;

/**
 * 감정 이름 → 모델 표정·모션 매핑.
 * 감정 이름은 보리 대사 한 줄(NarrationLine.emotion)이 고르고, 파일 이름은 여기에서만 안다.
 * 모션이 있는 감정은 표정도 같은 이름으로 둔다. 그래야 모션이 화면에 나타난다.
 */
export const boriEmotionMap: Record<string, { expression?: BoriExpressionName; motion?: BoriMotionGroupName }> = {
  happy: { expression: "xingxingyan", motion: "xingxingyan" },
  excited: { expression: "xingxingyan", motion: "xingxingyan" },
  greeting: { expression: "xingxingyan", motion: "xingxingyan" },
  gaming: { expression: "shoushi", motion: "shoushi" },
  crying: { expression: "kuqi", motion: "kuqi" },
  angry: { expression: "shengqi", motion: "shengqi" },
  sad: { expression: "shangxin" },
  embarrassed: { expression: "chidai" },
  awkward: { expression: "wuyu" },
  // 평온·호기심은 특정 효과를 켤 이유가 없다. 표정을 비워 기본 얼굴을 유지한다.
  // 이 모델에는 중립 표정 파일이 없고 changfa는 헤어스타일을 바꾸는 표정이라 기본값으로 쓸 수 없다.
  calm: {},
  curious: {},
};

/**
 * LLM에게 넘길 감정 설명. 감정 이름만 주었을 때 칭찬에 기뻐하는 답에 embarrassed를 골라 멍한(당황한) 얼굴이 나왔다(2026-10-15 리허설).
 * 실제 얼굴과 쓰지 않는 상황을 함께 적는다. [초안 · 검토 필요]
 */
export const boriEmotionDescriptions: Record<string, string> = {
  happy: "눈이 별처럼 반짝이는 밝은 얼굴. 기쁨, 칭찬받아 좋을 때, 고마움, 즐거움.",
  excited: "happy와 같은 반짝이는 얼굴. 신나고 들뜰 때.",
  greeting: "반짝이는 얼굴. 반가운 인사.",
  gaming: "게임패드를 든 얼굴. 게임 데이터·캐릭터 이야기를 할 때.",
  crying: "눈물을 흘리는 얼굴. 많이 슬프거나 안타까울 때만.",
  angry: "머리에서 김이 나는 얼굴. 장난스러운 삐침에만.",
  sad: "시무룩한 얼굴. 아쉬움, 서운함, 위로할 때.",
  embarrassed: "멍하니 굳은, 당황한 얼굴. 예상 못 한 말에 놀라 당황할 때만. 칭찬받아 기쁘거나 쑥스럽게 좋아할 때는 쓰지 않고 happy를 쓴다.",
  awkward: "어이없어 말문이 막힌 얼굴. 황당한 말을 들었을 때만. 기쁜 답에는 쓰지 않는다.",
  calm: "기본 얼굴. 차분한 설명, 안내.",
  curious: "기본 얼굴. 궁금해하거나 생각할 때.",
};

/** 모션 우선순위. Cubism 샘플의 PriorityIdle=1, PriorityNormal=2, PriorityForce=3과 맞춘다. */
export const boriMotionPriority = { idle: 1, normal: 2, force: 3 } as const;

/** LLM이 고를 수 있는 감정 이름. boriEmotionMap의 키와 항상 같다. */
export const boriEmotionNames = Object.keys(boriEmotionMap);

const expressionSet = new Set<string>(boriExpressionNames);
const motionSet = new Set<string>(boriMotionGroupNames);

export const isBoriExpression = (name: string): name is BoriExpressionName => expressionSet.has(name);
export const isBoriMotionGroup = (name: string): name is BoriMotionGroupName => motionSet.has(name);

/**
 * 감정 이름을 표정으로 바꾼다.
 * null이면 표정을 켜지 않고 기본 얼굴을 유지한다는 뜻이다.
 */
export function resolveExpression(emotionPrimary: string): BoriExpressionName | null {
  const mapped = boriEmotionMap[emotionPrimary];
  if (mapped?.expression && isBoriExpression(mapped.expression)) return mapped.expression;
  return null;
}

type ActionLike = { name: string; priority: number; layer: string };

/**
 * actions에서 실행할 몸 모션 하나를 고른다. 대시보드의 대사 줄에는 actions가 없어(apps/companion/src/live2d/reaction.ts) 감정 매핑의 모션을 쓴다.
 * allowlist 밖의 이름은 버리고, 우선순위가 가장 높은 것만 남긴다.
 * actions가 비어 있으면 감정 매핑의 모션을 폴백으로 쓴다.
 */
export function resolveMotion(
  actions: readonly ActionLike[],
  emotionPrimary: string
): { group: BoriMotionGroupName; priority: number } | null {
  const allowed = actions
    .filter(action => action.layer === "body" && isBoriMotionGroup(action.name))
    .sort((a, b) => b.priority - a.priority);

  if (allowed.length > 0) {
    return { group: allowed[0].name as BoriMotionGroupName, priority: allowed[0].priority };
  }

  const fallback = boriEmotionMap[emotionPrimary]?.motion;
  if (fallback && isBoriMotionGroup(fallback)) {
    return { group: fallback, priority: boriMotionPriority.normal };
  }

  return null;
}
