/**
 * LLM 구조화 출력으로 대사 줄을 만든다(Codex C2 1~3절, 코디네이터 결정 2026-11-21).
 * 예전에는 LLM이 쓴 자유 문장을 숫자 토큰·이름으로 사후 검사했는데, 주체·지표·시간 방향을 바꾼 거짓 문장과
 * 한글 수·소유격 이름이 검사를 빠져나갔다. 이제 LLM은 줄마다 사실 id(factId)·감정·짧은 감상(comment)만 고르고,
 * 줄 문장은 서버가 "사실의 정해진 문장(renderFact) + 통과한 감상"으로 만든다. 수치·이름은 서버 문장에만 있다.
 * - 없는 factId, 이미 고른 factId, 최대 줄 수를 넘는 줄은 버린다.
 * - 감상이 comment.ts 규칙을 어기거나 합친 줄이 글자 상한을 넘으면 감상만 버린다.
 * - 과제 A(2026-11-22): 규칙을 통과한 감상이라도 예시 묶음을 그대로 베꼈으면(copied),
 *   같은 대사에서 이미 붙인 감상과 같으면(repeated, 두 번째부터) 감상만 버린다. 공백·문장부호만 다른 것도 같다고 본다.
 */
import type { NarrationLine } from "@bori/shared";
import { boriEmotionNames } from "@bori/live2d";
import { checkComment, type CommentReason } from "./comment.js";
import { commentKey, isCopiedExample } from "./examples.js";
import type { NarrationFact } from "./facts.js";
import type { NameDictionary } from "./names.js";
import { renderFact } from "./template.js";

/** LLM 구조화 출력의 한 줄 */
export type RawLine = { factId: string; emotion: string; comment: string };

/** 만든 줄. 3줄 채우기가 어떤 사실을 이미 말했는지 알 수 있게 factId를 남긴다. */
export type ComposedLine = NarrationLine & { factId: string };

export type LineDropReason = "fact" | "duplicate" | "count";

/** 감상만 버린 이유. 안전 규칙(comment.ts) 이유에 예시 베낌·되풀이를 더한다 */
export type CommentDropReason = CommentReason | "copied" | "repeated";

export type ComposeOptions = {
  /** 사전의 캐릭터·무기·장비·특성 이름 */
  names: NameDictionary;
  /** 한 줄 글자 상한(코드포인트). LLM 설정 maxReplyLength를 쓴다. 서버 문장만으로 넘으면 감상만 뺀다 */
  maxLineLength?: number;
};

export const MIN_LINES = 3;
export const MAX_LINES = 5;
/** maxReplyLength를 받지 못했을 때 쓰는 한 줄 글자 상한(서버 LLM 설정 기본값과 같다) */
export const DEFAULT_MAX_LINE_LENGTH = 120;
/** 감정 이름이 목록 밖이면 쓰는 기본 감정 */
export const FALLBACK_EMOTION = "calm";

const emotionSet = new Set<string>(boriEmotionNames);

export function composeLines(
  lines: readonly RawLine[],
  facts: readonly NarrationFact[],
  options: ComposeOptions,
): { kept: ComposedLine[]; dropped: LineDropReason[]; commentDropped: CommentDropReason[] } {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const kept: ComposedLine[] = [];
  const dropped: LineDropReason[] = [];
  const commentDropped: CommentDropReason[] = [];
  /** 이번 대사에 붙인 감상의 열쇠(commentKey) */
  const attached = new Set<string>();

  for (const line of lines) {
    const fact = factById.get(line.factId);
    if (!fact) { dropped.push("fact"); continue; }
    if (kept.some(entry => entry.factId === fact.id)) { dropped.push("duplicate"); continue; }
    if (kept.length >= MAX_LINES) { dropped.push("count"); continue; }

    const sentence = renderFact(fact);
    let text = sentence;
    // 안전 규칙을 먼저 본다. 베낌·되풀이는 규칙을 통과한 감상에만 본다
    const comment = checkComment(line.comment, options.names);
    if (comment.ok) {
      const key = commentKey(comment.text);
      const joined = `${sentence} ${comment.text}`;
      if (isCopiedExample(comment.text)) commentDropped.push("copied");
      else if (attached.has(key)) commentDropped.push("repeated");
      else if ([...joined].length > maxLineLength) commentDropped.push("length");
      else { text = joined; attached.add(key); }
    } else if (comment.reason !== "empty") {
      commentDropped.push(comment.reason);
    }
    kept.push({ text, emotion: emotionSet.has(line.emotion) ? line.emotion : FALLBACK_EMOTION, factId: fact.id });
  }

  return { kept, dropped, commentDropped };
}
