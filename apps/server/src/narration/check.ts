/**
 * LLM이 쓴 대사 검사(설계 3절 3). 어긋난 줄은 고치지 않고 버린다.
 * - 줄 속 숫자(\d+(\.\d+)?)는 모두 그 줄이 밝힌 사실(factIds)의 numbers 안에 있어야 한다.
 * - 알려진 캐릭터·무기 이름이 줄에 나오면 그 이름은 밝힌 사실의 names에 있어야 한다.
 *   LLM이 지어낸 이름은 알 길이 없어 막지 못한다. 알려진 이름을 엉뚱한 수치에 붙이는 것을 막는다.
 */
import type { NarrationLine } from "@bori/shared";
import { boriEmotionNames } from "@bori/live2d";
import type { NarrationFact } from "./facts.js";
import { extractNumbers } from "./format.js";

/** LLM 구조화 출력의 한 줄. 아직 검사 전이다. */
export type RawLine = { text: string; emotion: string; factIds: string[] };

export type DropReason = "empty" | "length" | "number" | "name";

export const MAX_LINES = 5;
/** 한 줄 글자 상한. 지시는 80자 안쪽이고, 조금 넘는 것까지는 살린다. */
export const MAX_LINE_LENGTH = 120;
/** 감정 이름이 목록 밖이면 쓰는 기본 감정 */
export const FALLBACK_EMOTION = "calm";
/**
 * 이름 검사에서 뺄 짧은 이름 길이. "활"·"검" 같은 한 글자 무기는 "활약"처럼 다른 낱말 안에 흔히 들어 있어
 * 맞는 줄까지 버리게 되므로 두 글자 이상만 본다.
 */
const MIN_CHECKED_NAME_LENGTH = 2;

const emotionSet = new Set<string>(boriEmotionNames);

export function checkLines(
  lines: readonly RawLine[],
  facts: readonly NarrationFact[],
  knownNames: readonly string[],
): { kept: NarrationLine[]; dropped: { text: string; reason: DropReason }[] } {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const checkedNames = [...new Set(knownNames.filter(name => name.length >= MIN_CHECKED_NAME_LENGTH))];
  const kept: NarrationLine[] = [];
  const dropped: { text: string; reason: DropReason }[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    const cited = line.factIds.map(id => factById.get(id)).filter((fact): fact is NarrationFact => fact !== undefined);
    const allowedNumbers = new Set(cited.flatMap(fact => fact.numbers));
    const allowedNames = new Set(cited.flatMap(fact => fact.names));

    let reason: DropReason | null = null;
    if (text.length === 0) reason = "empty";
    else if (text.length > MAX_LINE_LENGTH) reason = "length";
    else if (!extractNumbers(text).every(number => allowedNumbers.has(number))) reason = "number";
    else if (checkedNames.some(name => text.includes(name) && !allowedNames.has(name))) reason = "name";

    if (reason) { dropped.push({ text, reason }); continue; }
    if (kept.length < MAX_LINES) kept.push({ text, emotion: emotionSet.has(line.emotion) ? line.emotion : FALLBACK_EMOTION });
  }

  return { kept, dropped };
}
