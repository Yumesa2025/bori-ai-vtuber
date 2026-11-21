/**
 * LLM이 쓴 대사 검사(설계 3절 3, 점검 V2 1~4·17번). 어긋난 줄은 고치지 않고 버린다.
 * - 한 줄이 밝히는 사실(factIds)은 최대 2개이고, 없는 id가 있으면 버린다.
 * - 줄의 숫자 토큰(tokens.ts)마다 인용한 사실에 단위·값이 같은 토큰이 있어야 한다.
 *   숫자 앞 낱말로 뜻을 짐작했으면(픽률·평균 순위·1등 비율…) 뜻도 맞아야 한다.
 * - 사전의 캐릭터 이름이 나오면 인용한 사실에 있어야 하고, "캐릭터 무기" 조합은 인용한 사실의 조합이어야 한다.
 * 검사 전에 꾸밈(마크다운·이모지)과 보이지 않는 제어 문자를 지운다. 자막과 TTS에 기호가 나가지 않게 한다(점검 V3 7절).
 */
import type { NarrationLine } from "@bori/shared";
import { boriEmotionNames } from "@bori/live2d";
import { replyLengthOf, stripDecorations } from "@bori/llm";
import { cleanInputText } from "../input-text.js";
import type { NarrationFact } from "./facts.js";
import { findCharacterNames, findPairs, type NameDictionary } from "./names.js";
import { extractTokens, HINT_MEANINGS, type NumberToken } from "./tokens.js";

/** LLM 구조화 출력의 한 줄. 아직 검사 전이다. */
export type RawLine = { text: string; emotion: string; factIds: string[] };

/** 검사를 통과한 줄. 3줄 채우기가 어떤 사실을 이미 말했는지 알 수 있게 factIds를 남긴다. */
export type CheckedLine = NarrationLine & { factIds: string[] };

export type DropReason = "empty" | "length" | "facts" | "number" | "name" | "count";

export type CheckOptions = {
  /** 사전의 캐릭터·무기 이름 */
  names: NameDictionary;
  /** 한 줄 글자 상한(코드포인트). LLM 설정 maxReplyLength를 쓴다 */
  maxLineLength?: number;
};

export const MAX_LINES = 5;
/** 한 줄이 밝힐 수 있는 사실 수 */
export const MAX_FACT_IDS = 2;
/** maxReplyLength를 받지 못했을 때 쓰는 한 줄 글자 상한(서버 LLM 설정 기본값과 같다) */
export const DEFAULT_MAX_LINE_LENGTH = 120;
/** 감정 이름이 목록 밖이면 쓰는 기본 감정 */
export const FALLBACK_EMOTION = "calm";

const emotionSet = new Set<string>(boriEmotionNames);

/** 자막·음성에 보낼 글: 제어 문자·꾸밈을 지우고 앞뒤 공백을 정리한다. */
export const cleanLineText = (text: string) => stripDecorations(cleanInputText(text)).trim();

const tokenAllowed = (token: NumberToken, cited: readonly NumberToken[]) =>
  cited.some(candidate => candidate.unit === token.unit
    && candidate.value === token.value
    && (!token.hint || (candidate.meaning !== undefined && HINT_MEANINGS[token.hint].includes(candidate.meaning))));

function reasonFor(text: string, line: RawLine, factById: Map<string, NarrationFact>, options: CheckOptions): DropReason | null {
  if (text.length === 0) return "empty";
  if (replyLengthOf(text) > (options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH)) return "length";
  if (line.factIds.length > MAX_FACT_IDS || line.factIds.some(id => !factById.has(id))) return "facts";
  const cited = line.factIds.map(id => factById.get(id)!);
  const tokens = cited.flatMap(fact => fact.tokens);
  if (!extractTokens(text).every(token => tokenAllowed(token, tokens))) return "number";
  const names = new Set(cited.flatMap(fact => fact.names));
  if (findCharacterNames(text, options.names).some(name => !names.has(name))) return "name";
  const pairs = cited.flatMap(fact => fact.pairs);
  if (findPairs(text, options.names).some(pair => !pairs.some(known => known.character === pair.character && known.weapon === pair.weapon))) return "name";
  return null;
}

export function checkLines(
  lines: readonly RawLine[],
  facts: readonly NarrationFact[],
  options: CheckOptions,
): { kept: CheckedLine[]; dropped: { text: string; reason: DropReason }[] } {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const kept: CheckedLine[] = [];
  const dropped: { text: string; reason: DropReason }[] = [];

  for (const line of lines) {
    const text = cleanLineText(line.text);
    const reason = reasonFor(text, line, factById, options) ?? (kept.length >= MAX_LINES ? "count" : null);
    if (reason) { dropped.push({ text, reason }); continue; }
    kept.push({ text, emotion: emotionSet.has(line.emotion) ? line.emotion : FALLBACK_EMOTION, factIds: [...line.factIds] });
  }

  return { kept, dropped };
}
