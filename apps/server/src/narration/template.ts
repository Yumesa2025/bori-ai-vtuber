/**
 * 정해진 문장 대사. LLM이 꺼졌거나 실패했거나, 검사에서 사실을 말한 줄이 하나도 남지 않았을 때 읽는다(설계 3절 3, 6절).
 * 사실마다 둔 spoken 문장을 정해진 순서로 3줄 고른다. spoken은 사실 문장의 숫자 토큰만 쓴다.
 * 패치가 바뀌었으면 그 줄을 1위 다음에 두고 3줄에 세지 않는다(점검 V2 21번: 주캐릭터 줄이 빠지지 않게).
 *
 * LLM 줄이 일부만 남으면(점검 V2 6번) fillLines가 아직 말하지 않은 사실의 정해진 문장으로 3줄을 채운다.
 */
import type { NarrationLine } from "@bori/shared";
import type { CheckedLine } from "./check.js";
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

/** 고르는 순서: 픽률 1위, 크게 오른 조합, 내 주캐릭터, 픽률 2위, 집계 기준. 그 밖의 사실은 목록 순서로 뒤에 둔다. */
const PRIORITY: Array<{ kind: NarrationFactKind; nth: number }> = [
  { kind: "top", nth: 0 },
  { kind: "riser", nth: 0 },
  { kind: "main", nth: 0 },
  { kind: "top", nth: 1 },
  { kind: "basis", nth: 0 },
];

/** 패치 줄을 뺀 사실을 고르는 순서대로 */
function ordered(facts: readonly NarrationFact[]): NarrationFact[] {
  const first = PRIORITY
    .map(({ kind, nth }) => facts.filter(fact => fact.kind === kind)[nth])
    .filter((fact): fact is NarrationFact => fact !== undefined);
  return [...first, ...facts.filter(fact => fact.kind !== "patch" && !first.includes(fact))];
}

const spokenLine = (fact: NarrationFact): CheckedLine => ({ text: fact.spoken, emotion: EMOTION_BY_KIND[fact.kind], factIds: [fact.id] });

export function templateLines(facts: readonly NarrationFact[]): NarrationLine[] {
  const picked = ordered(facts).slice(0, TEMPLATE_LINE_COUNT).map(spokenLine);
  if (picked.length === 0) return [EMPTY_TEMPLATE_LINE];
  const patch = facts.find(fact => fact.kind === "patch");
  if (patch) picked.splice(1, 0, spokenLine(patch));
  return picked.map(({ text, emotion }) => ({ text, emotion }));
}

/**
 * 검사를 통과한 LLM 줄로 대사를 만든다.
 * 사실을 말한 줄이 하나도 없으면(인사뿐이거나 빈 목록) null — 부르는 쪽이 전체를 정해진 문장으로 바꾼다.
 * 3줄이 안 되면 남은 줄 뒤에 아직 말하지 않은 사실의 정해진 문장을 붙인다. 사실이 모자라면 있는 만큼만.
 */
export function fillLines(kept: readonly CheckedLine[], facts: readonly NarrationFact[]): NarrationLine[] | null {
  if (!kept.some(line => line.factIds.length > 0)) return null;
  const used = new Set(kept.flatMap(line => line.factIds));
  const patch = facts.find(fact => fact.kind === "patch");
  const candidates = [...(patch ? [patch] : []), ...ordered(facts)].filter(fact => !used.has(fact.id));
  const lines = [...kept, ...candidates.slice(0, Math.max(0, TEMPLATE_LINE_COUNT - kept.length)).map(spokenLine)];
  return lines.map(({ text, emotion }) => ({ text, emotion }));
}
