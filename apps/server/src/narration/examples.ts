/**
 * 지시에 싣는 좋은 감상 예시 묶음(과제 A, 2026-11-22).
 * Z1(#63) 측정에서 gpt-4o-mini는 지시의 예시를 그대로 베껴 갱신마다 같은 말을 했다(고정 사실 50줄 중 48줄).
 * 그래서 사실 종류마다 예시를 넉넉히 두고, 부를 때마다 종류별로 몇 개만 무작위로 골라 싣는다.
 * 묶음의 예시를 그대로(공백·문장부호만 다르게) 쓴 감상은 check.ts가 copied로 버린다(지시에 실렸는지와 관계없이 묶음 전체).
 * 예시는 모두 comment.ts 규칙을 통과해야 한다(narration-examples 검사가 본다).
 */
import type { NarrationFactKind } from "./facts.js";

/** 종류마다 지시에 싣는 예시 수 */
export const EXAMPLES_PER_KIND = 2;

/** 사실 종류별 좋은 감상 예시. 수치·순서·지표·이름·평가·지어내기 없이 느낌만 말한다 */
export const COMMENT_EXAMPLE_POOL: Readonly<Record<NarrationFactKind, readonly string[]>> = {
  top: [
    "요즘 정말 자주 보여요.", "다들 좋아하나 봐요.", "인기가 대단하네요!", "어딜 가나 보이는 느낌이에요.",
    "역시 다들 손이 가나 봐요.", "꾸준히 사랑받고 있네요.", "요즘 대세라는 게 느껴져요.", "인기가 식을 줄 모르네요.",
    "다들 믿고 쓰는 느낌이에요.", "눈에 정말 자주 띄네요.",
  ],
  riser: [
    "기세가 정말 좋네요!", "앞으로가 기대돼요.", "점점 힘이 붙네요.", "흐름을 제대로 탔네요!",
    "요즘 물이 올랐나 봐요.", "상승세가 반가워요!", "쭉 이어지면 좋겠어요.", "분위기가 확 살아났네요.",
    "눈에 띄게 좋아졌네요.", "한결 든든해 보여요.",
  ],
  faller: [
    "조금 아쉽네요.", "다시 올라오길 바라요.", "잠깐 숨 고르는 중일까요?", "살짝 주춤하네요.",
    "금방 다시 힘낼 거예요.", "쉬어 가는 시기인가 봐요.", "조금 기운이 빠졌나 봐요.", "아직 실망하긴 일러요.",
    "잠시 쉬어 가는 느낌이에요.", "조용히 응원하고 싶어요.",
  ],
  newTop: [
    "새 얼굴이 반가워요!", "어디까지 갈지 궁금해요.", "요즘 부쩍 눈에 띄네요.", "깜짝 등장이네요!",
    "신선한 바람이 부네요.", "떠오르는 기대주 같아요.", "반가운 손님이 왔네요.", "앞으로 자주 보게 될까요?",
    "이런 흐름은 처음 보네요.", "깜짝 놀랐어요!",
  ],
  main: [
    "손에 익으셨나 봐요.", "애정이 느껴져요.", "든든한 선택이네요.", "역시 믿음직하네요.",
    "꾸준함이 멋져요.", "오래 함께한 느낌이에요.", "정이 많이 드셨나 봐요.", "손맛이 남다르시죠?",
    "함께라서 든든해요.", "늘 응원하고 있어요.",
  ],
  patch: [
    "새 흐름이 궁금해요.", "천천히 지켜봐요.", "판도가 어떻게 바뀔까요?", "분위기가 달라질지 궁금해요.",
    "어떻게 흘러갈지 기대돼요.", "조금 지켜보면 보이겠죠?", "새로운 바람이 불까요?", "다들 적응 중이겠네요.",
    "변화가 기대되네요.", "낯선 흐름이 설레요.",
  ],
  basis: [
    "제법 많이 모였네요.", "참고하기 좋겠어요.", "든든한 자료예요.", "꽤 믿을 만하네요.",
    "차곡차곡 모였네요.", "넉넉히 살펴봤어요.", "꼼꼼히 모아 봤어요.", "이 정도면 충분하죠?",
    "탄탄한 자료네요.", "살펴보기 좋겠어요.",
  ],
};

/** 같은 감상인지 견주는 열쇠. 글자·숫자만 남기고 공백·문장부호는 지운다 */
export const commentKey = (text: string) => text.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");

const EXAMPLE_KEYS: ReadonlySet<string> = new Set(Object.values(COMMENT_EXAMPLE_POOL).flat().map(commentKey));

/** 묶음의 예시를 그대로(공백·문장부호만 다르게) 쓴 감상인지 */
export function isCopiedExample(comment: string): boolean {
  const key = commentKey(comment);
  return key.length > 0 && EXAMPLE_KEYS.has(key);
}

export type PickedExamples = ReadonlyArray<{ kind: NarrationFactKind; comments: readonly string[] }>;

/** 종류마다 perKind개를 겹치지 않게 무작위로 고른다(부분 Fisher–Yates). random은 0 이상 1 미만 */
export function pickCommentExamples(random: () => number, perKind = EXAMPLES_PER_KIND): PickedExamples {
  return (Object.keys(COMMENT_EXAMPLE_POOL) as NarrationFactKind[]).map(kind => {
    const comments = [...COMMENT_EXAMPLE_POOL[kind]];
    const count = Math.min(perKind, comments.length);
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(random() * (comments.length - i));
      [comments[i], comments[j]] = [comments[j], comments[i]];
    }
    return { kind, comments: comments.slice(0, count) };
  });
}

/** 시드로 정해지는 난수(mulberry32). 검사·측정에서 예시 고르기를 고정한다 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
