/**
 * 정해진 문장 대사. LLM이 꺼졌거나 실패했거나, 검사에서 모든 줄이 버려졌을 때 읽는다(설계 3절 3, 6절).
 * 사실마다 둔 spoken 문장을 정해진 우선순위로 최대 3줄 고른다. spoken은 사실 문장의 숫자만 쓴다.
 */
import type { NarrationLine } from "@bori/shared";
import type { NarrationFact, NarrationFactKind } from "./facts.js";

export const TEMPLATE_LINE_COUNT = 3;

export const EMPTY_TEMPLATE_LINE: NarrationLine = { text: "아직 정리할 메타 데이터가 없어요. 데이터를 갱신하면 읽어 드릴게요.", emotion: "calm" };

/** 감정은 @bori/live2d 감정 표의 이름이다. */
const EMOTION_BY_KIND: Record<NarrationFactKind, string> = {
  top: "gaming",
  riser: "happy",
  faller: "sad",
  newTop: "excited",
  main: "gaming",
  patch: "curious",
  basis: "calm",
};

/** 고르는 순서: 메타 1위, 크게 오른 조합, 패치 바뀜, 내 주캐릭터, 메타 2위, 집계 기준 */
const PRIORITY: Array<{ kind: NarrationFactKind; nth: number }> = [
  { kind: "top", nth: 0 },
  { kind: "riser", nth: 0 },
  { kind: "patch", nth: 0 },
  { kind: "main", nth: 0 },
  { kind: "top", nth: 1 },
  { kind: "basis", nth: 0 },
];

export function templateLines(facts: readonly NarrationFact[]): NarrationLine[] {
  const picked = PRIORITY
    .map(({ kind, nth }) => facts.filter(fact => fact.kind === kind)[nth])
    .filter((fact): fact is NarrationFact => fact !== undefined)
    .slice(0, TEMPLATE_LINE_COUNT);
  if (picked.length === 0) return [EMPTY_TEMPLATE_LINE];
  return picked.map(fact => ({ text: fact.spoken, emotion: EMOTION_BY_KIND[fact.kind] }));
}
