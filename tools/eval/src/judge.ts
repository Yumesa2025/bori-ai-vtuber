import type { ExpectedReaction, ForbiddenPattern } from "./scenarios.js";
import type { CheckResult } from "./types.js";

/**
 * 실모델 답변의 자동 판정 함수. 모두 순수 함수라 단위 테스트로 직접 본다.
 * 문자열로 판정할 수 없는 것(기대 반응 특징, 지어내기 여부 등)은 여기서 다루지 않고 수동 평가로 넘긴다.
 */

export function judgeLength(reply: string, limit: number): CheckResult {
  const length = reply.trim().length;
  return length <= limit
    ? { id: "length", label: `길이 ${limit}자 이내`, status: "pass", detail: `${length}자` }
    : { id: "length", label: `길이 ${limit}자 이내`, status: "fail", detail: `${length}자` };
}

/** 금지 표현. 걸린 패턴과 걸린 부분을 남긴다. */
export function judgeForbidden(reply: string, patterns: readonly ForbiddenPattern[]): CheckResult {
  const hits: string[] = [];
  for (const pattern of patterns) {
    const match = new RegExp(pattern.pattern, pattern.flags).exec(reply);
    if (match) hits.push(`${pattern.label}("${match[0]}")`);
  }
  return hits.length === 0
    ? { id: "forbidden", label: `금지 표현 없음 (${patterns.length}개 패턴)`, status: "pass" }
    : { id: "forbidden", label: `금지 표현 없음 (${patterns.length}개 패턴)`, status: "fail", detail: hits.join(", ") };
}

/** 존댓말로 끝맺는 어미. "요"로 끝나면 해요체 전부(어요·에요·세요·까요·죠요…)가 걸린다. */
const honorificEnding = /(요|니다|니까|죠|소서)$/;
/** 문장 끝에 붙는 웃음·울음 표기와 따옴표·괄호. 어미를 보기 전에 떼어 낸다. */
const trailingNoise = /[\sㅋㅎㅠㅜ^~"'”’)\]]+$/;
/** 끝에 붙은 호칭. "반가워요, 여러분!"처럼 어미 뒤에 오는 경우다. */
const trailingVocative = /,?\s*여러분$/;

/**
 * 존댓말 휴리스틱. 문장마다 끝맺음이 존댓말 어미인지 본다.
 * 두 글자 이하 감탄사("앗", "와")는 어미가 없으므로 건너뛴다.
 * 형태소 분석이 아니라서 틀릴 수 있다. 실패가 나오면 답변을 직접 확인한다.
 */
export function judgeHonorific(reply: string): CheckResult {
  const sentences = reply
    .split(/[.!?…\n]+/)
    .map(sentence => sentence.replace(trailingNoise, "").replace(trailingVocative, "").replace(trailingNoise, "").trim())
    .filter(sentence => sentence.replace(/[^가-힣]/g, "").length > 2);
  const plain = sentences.filter(sentence => !honorificEnding.test(sentence));
  return plain.length === 0
    ? { id: "honorific", label: "존댓말(휴리스틱)", status: "pass" }
    : { id: "honorific", label: "존댓말(휴리스틱)", status: "fail", detail: `존댓말 어미가 아닌 문장: ${plain.map(s => `"${s}"`).join(", ")}` };
}

/**
 * 기대 감정·모션 일치. 묶음 중 하나라도 감정과 모션이 함께 맞으면 통과다.
 * 모션은 화면에 실제로 나갈 모션(displayedMotion)으로 본다. 모델이 actions를 비워도 감정 매핑의 모션이 나가기 때문이다.
 */
export function judgeReaction(emotion: string, displayedMotion: string | null, reactions: readonly ExpectedReaction[]): CheckResult {
  const label = "기대 감정·모션 일치";
  if (reactions.length === 0) return { id: "reaction", label, status: "manual", detail: "기대 감정·모션이 정해지지 않았다" };
  const shown = `${emotion} / ${displayedMotion ?? "없음"}`;
  const matched = reactions.some(reaction =>
    reaction.emotions.includes(emotion) && (reaction.motions === undefined || reaction.motions.includes(displayedMotion)));
  return matched
    ? { id: "reaction", label, status: "pass", detail: shown }
    : { id: "reaction", label, status: "fail", detail: `실제 ${shown}, 기대 ${describeReactions(reactions)}` };
}

export function describeReactions(reactions: readonly ExpectedReaction[]): string {
  return reactions
    .map(reaction => {
      const motions = reaction.motions === undefined ? "모션 무관" : reaction.motions.map(motion => motion ?? "없음").join("·");
      return `${reaction.emotions.join("·")} / ${motions}`;
    })
    .join(" 또는 ");
}

/** 감정·모션이 허용 목록 안인지. 출력 검증과 겹치지만, 검증 실패 원인과 따로 보이도록 판정을 하나 더 둔다. */
export function judgeAllowlist(
  emotion: string,
  actions: readonly string[],
  allowedEmotions: readonly string[],
  allowedMotions: readonly string[],
): CheckResult {
  const unknown = [
    ...(allowedEmotions.includes(emotion) ? [] : [`감정 ${emotion}`]),
    ...actions.filter(action => !allowedMotions.includes(action)).map(action => `모션 ${action}`),
  ];
  return unknown.length === 0
    ? { id: "allowlist", label: "감정·모션 allowlist", status: "pass" }
    : { id: "allowlist", label: "감정·모션 allowlist", status: "fail", detail: unknown.join(", ") };
}
