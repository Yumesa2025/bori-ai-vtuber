export type Live2DModelManifest = {
  modelFile: string;
  physicsFile?: string;
  expressions: Record<string, string>;
  motions: Record<string, string>;
};

export type Live2DModelPort = {
  load(manifest: Live2DModelManifest): Promise<void>;
  playExpression(name: string): void;
  playMotion(name: string, priority: number): void;
  setMouthOpen(value: number): void;
  reset(): void;
};

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

export const boriLocalManifest: Live2DModelManifest = {
  modelFile: "maolili/maolili.model3.json",
  physicsFile: "maolili/maolili.physics3.json",
  expressions: {
    xingxingyan: "maolili/biaoqing/xingxingyan.exp3.json",
    kuqi: "maolili/biaoqing/kuqi.exp3.json",
    shangxin: "maolili/biaoqing/shangxin.exp3.json",
    shengqi: "maolili/biaoqing/shengqi.exp3.json",
    shoushi: "maolili/biaoqing/shoushi.exp3.json",
    wuyu: "maolili/biaoqing/wuyu.exp3.json",
    chidai: "maolili/biaoqing/chidai.exp3.json",
    changfa: "maolili/biaoqing/changfa.exp3.json",
  },
  motions: {
    xingxingyan: "maolili/xingxingyan.motion3.json",
    kuqi: "maolili/kuqi.motion3.json",
    shengqi: "maolili/shengqi.motion3.json",
    shoushi: "maolili/shoushi.motion3.json",
  },
};

/**
 * 화면 표시용 한국어 이름. 파일 이름은 모델이 정한 중국어 병음이라 그대로 두고
 * 관리자·로그에 보여줄 이름만 여기에서 관리한다.
 */
export const boriExpressionLabels: Record<BoriExpressionName, string> = {
  xingxingyan: "반짝이는 눈",
  kuqi: "울음",
  shangxin: "슬픔",
  shengqi: "화남",
  shoushi: "게임패드",
  wuyu: "어이없음",
  chidai: "멍함",
  changfa: "긴 머리",
};

export const boriMotionLabels: Record<BoriMotionGroupName, string> = {
  xingxingyan: "반짝이는 눈",
  kuqi: "울음",
  shengqi: "화남",
  shoushi: "게임패드",
};

/**
 * LLM에게 넘길 모션 설명.
 * 모션 이름이 중국어 병음이라 이름만으로는 무슨 동작인지 알 수 없다.
 * 어떤 상황에 쓰는지까지 적어야 모델이 제대로 고른다.
 */
export const boriMotionDescriptions: Record<BoriMotionGroupName, string> = {
  xingxingyan: "눈이 별처럼 반짝이는 밝은 표현. 기쁨, 설렘, 신남, 칭찬을 받았을 때, 반가운 인사에 쓴다.",
  kuqi: "눈물을 흘리며 우는 표현. 슬픔, 서운함, 안타까움, 위로를 건넬 때 쓴다.",
  shengqi: "머리에서 김이 나며 화내는 표현. 삐침, 발끈, 장난스러운 투정에 쓴다.",
  shoushi: "게임패드를 들고 조작하는 표현. 게임 이야기를 할 때 쓴다.",
};

export const expressionLabel = (name: string): string =>
  isBoriExpression(name) ? boriExpressionLabels[name] : name;

export const motionLabel = (name: string): string =>
  isBoriMotionGroup(name) ? boriMotionLabels[name] : name;

/**
 * 모션이 실제로 보이려면 짝이 되는 표정이 함께 켜져 있어야 한다.
 * 표정 파일이 효과를 활성화하고(예: shengqi는 Param66), 모션 파일이 그 효과의
 * 애니메이션 파라미터(Param68)를 돌리는 구조라, 표정 없이 모션만 실행하면 화면에 아무 변화가 없다.
 * 이 모델은 네 모션 모두 같은 이름의 표정과 짝을 이룬다.
 */
export const motionPairedExpression = (motion: BoriMotionGroupName): BoriExpressionName => motion;

/**
 * 서버 CharacterResponse.emotion.primary → 모델 표정·모션 매핑.
 * 감정 이름은 방송 로직이 정하고, 파일 이름은 여기에서만 안다.
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
 * 응답의 actions에서 실행할 몸 모션 하나를 고른다.
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

export function createUnavailableLive2DPort(): Live2DModelPort {
  return {
    async load() { throw new Error("Cubism SDK for Web is not connected yet."); },
    playExpression() {}, playMotion() {}, setMouthOpen() {}, reset() {},
  };
}
