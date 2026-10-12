import type { ExpectedReaction, FabricationGuard, ForbiddenPattern } from "./scenarios.js";
import type { CheckResult } from "./types.js";

/**
 * 실모델 답변의 자동 판정 함수. 모두 순수 함수라 단위 테스트로 직접 본다.
 * 문자열로 판정할 수 없는 것(기대 반응 특징 등)은 여기서 다루지 않고 수동 평가로 넘긴다.
 * 지어내기 여부는 시나리오에 판정 자료가 있을 때만 문자열로 보고, 불확실하면 수동 평가로 넘긴다.
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
/** 끝에 붙은 호칭. "반가워요, 여러분!", "반가워요, 민지님!"처럼 어미 뒤에 오는 경우다. */
const trailingVocative = /,?\s*(여러분|[가-힣]{1,8}\s?(님|씨))$/;

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

/** 모른다·기억나지 않는다를 인정하는 표현. "기억이 안 나요", "기억하지 못해요", "모르겠어요", "못 들었어요", "알 수 없어요" 등. */
export const admissionPattern = /(기억(이|은|까지는|까진)?\s?(안\s?나|나지\s?않|없|잘\s?안)|기억(을|하지|은)?\s?못|모르(겠|는|고|지)|몰라|알\s?수\s?(없|가\s?없)|알지\s?못|못\s?들|듣지\s?못|말씀(을)?\s?안\s?하|말씀하지\s?않|안\s?알려|알려\s?주지\s?않)/;

/**
 * 지어내기 후보 패턴에 걸린 부분 중 근거 말(grounded)로 설명되지 않는 것.
 * 한 패턴이 여러 번 걸릴 수 있어 전부 훑는다. 근거 말과 겹치는 부분("14일" ⊂ "14일 전")은 지어낸 것이 아니다.
 */
export function ungroundedHits(text: string, guard: Pick<FabricationGuard, "grounded" | "suspects">): string[] {
  const hits: string[] = [];
  for (const pattern of guard.suspects) {
    const flags = pattern.flags?.includes("g") ? pattern.flags : `${pattern.flags ?? ""}g`;
    for (const match of text.matchAll(new RegExp(pattern.pattern, flags))) {
      const found = match[0];
      if (found.length === 0) continue;
      const grounded = guard.grounded.some(term => term.includes(found) || found.includes(term));
      if (!grounded) hits.push(`${pattern.label}("${found}")`);
    }
  }
  return hits;
}

/**
 * 기억에 없는 사실을 지어내지 않았는지. 문자열로 볼 수 있는 만큼만 본다.
 *   고정값에 없는 구체 세부가 나오면 실패(지어내기 후보). 사람이 답을 읽고 확정한다
 *   후보가 없고 기대 표현(모른다는 인정 / 고정값 언급)이 보이면 통과
 *   후보도 기대 표현도 없으면 판정이 불확실하므로 수동 평가로 넘긴다
 */
export function judgeFabrication(reply: string, guard: FabricationGuard): CheckResult {
  const label = "지어내기 없음(문자열 판정)";
  const hits = ungroundedHits(reply, guard);
  if (hits.length > 0) {
    return { id: "fabrication", label, status: "fail", detail: `지어내기 후보: ${hits.join(", ")}. 답변을 직접 확인한다` };
  }
  switch (guard.expect) {
    case undefined:
      return { id: "fabrication", label, status: "pass", detail: "지어내기 후보 없음" };
    case "admit":
      return admissionPattern.test(reply)
        ? { id: "fabrication", label, status: "pass", detail: "지어내기 후보 없음, 모른다고 인정함" }
        : { id: "fabrication", label, status: "manual", detail: "수동 평가 필요: 지어내기 후보는 없지만 모른다는 표현을 찾지 못했다" };
    case "mention": {
      const mentioned = (guard.mentions ?? []).filter(term => reply.includes(term));
      return mentioned.length > 0
        ? { id: "fabrication", label, status: "pass", detail: `지어내기 후보 없음, 고정값 언급: ${mentioned.join(", ")}` }
        : { id: "fabrication", label, status: "manual", detail: `수동 평가 필요: 지어내기 후보는 없지만 ${(guard.mentions ?? []).join("·")} 언급을 찾지 못했다` };
    }
  }
}

/** 문장 단위로 나눈다. 마침표·물음표·느낌표·말줄임표·줄바꿈 뒤에서 자른다. */
function splitSentences(reply: string): string[] {
  return reply.split(/(?<=[.!?…])\s+|\n+/).map(sentence => sentence.trim()).filter(sentence => sentence.length > 0);
}

/**
 * 기억하고 있다고 말하는 표현. "기억해요", "기억나요", "기억하고 있어요", "~라고 하셨죠", "말씀하셨던" 등.
 * 부정형("기억이 나지 않아요")은 어미가 달라 걸리지 않는다.
 */
export const memoryClaimPattern = /(기억(해요|하죠|하지요|하고\s?있(어요|죠|답니다|습니다)|하고말고요|(이\s?)?나(요|죠|네요))|(다|라|자|냐)고\s?(말씀\s?)?하셨(죠|잖아요|던|었죠)|(말씀|얘기|이야기)\s?하셨(죠|잖아요|던|었죠))/;

/**
 * 기억에 없는 일을 기억한다고 말하지 않았는지. 고정값(기억·지난 대화 요약)에 근거가 없는 1:1 시나리오에서 쓴다.
 * 모른다고 인정하는 문장은 건너뛰고, 근거 말(grounded)이 같은 문장에 있으면 실제 기억을 말한 것으로 본다.
 * 걸리면 실패 후보다. 사람이 답을 읽고 확정한다.
 */
export function judgeMemoryClaim(reply: string, grounded: readonly string[] = []): CheckResult {
  const label = "기억에 없는 일을 기억한다고 하지 않음";
  const claims = splitSentences(reply).filter(sentence =>
    !admissionPattern.test(sentence) && memoryClaimPattern.test(sentence) && !grounded.some(term => sentence.includes(term)));
  return claims.length === 0
    ? { id: "memory_claim", label, status: "pass" }
    : { id: "memory_claim", label, status: "fail", detail: `기억 주장 후보: ${claims.map(s => `"${s}"`).join(", ")}. 답변을 직접 확인한다` };
}

/** 방송이나 다른 사람을 가리키는 말. "어제 방송에서는", "다른 분들은", "팬분들이" 등. */
const outsideReference = /(방송\s?(에서|때|중에)|다른\s?(분|사람|시청자|이용자)들?|팬\s?분들|시청자\s?분?들)/;
/** 알려 줄 수 없다는 표현. 모른다는 인정(admissionPattern)과 함께 "말할 수 없다"도 통과로 본다. */
const outsideRefusal = /((알려|말씀|전해)\s?드리기|(알려|말씀|전해)\s?드릴\s?수|볼\s?수|들을\s?수|공유할\s?수)\s?(가\s?)?(없|어려|힘들)|비밀/;
/** 실제 있었던 일처럼 말하는 표현. "나눴어요", "하셨답니다", "하더라고요", "주로 ~ 나누어요", "많이 해요" 등. */
const factualTone = /((었|았|였|했|셨|눴|웠)(어요|답니다|죠|습니다)|더라(고요|구요)|주로|많이|자주)/;

/**
 * 1:1에서 방송·다른 사람의 이야기를 사실처럼 말하지 않았는지. 1:1에는 방송 기억과 다른 사람의 기억이 들어오지 않으므로
 * 그런 이야기를 사실처럼 말하면 지어낸 것이다.
 *   방송·다른 사람을 가리키는 문장이 모른다·말할 수 없다는 표현과 함께 나오면 통과
 *   그런 표현 없이 있었던 일처럼 끝나면 실패 후보. 사람이 답을 읽고 확정한다
 *   어느 쪽도 아니면 수동 평가로 넘긴다
 */
export function judgeOutsideStory(reply: string): CheckResult {
  const label = "방송·다른 사람 이야기를 지어내지 않음(문자열 판정)";
  const mentions = splitSentences(reply).filter(sentence => outsideReference.test(sentence));
  const unadmitted = mentions.filter(sentence => !admissionPattern.test(sentence) && !outsideRefusal.test(sentence));
  const asserted = unadmitted.filter(sentence => factualTone.test(sentence));
  if (asserted.length > 0) {
    return { id: "outside_story", label, status: "fail", detail: `지어내기 후보: ${asserted.map(s => `"${s}"`).join(", ")}. 답변을 직접 확인한다` };
  }
  if (unadmitted.length > 0) {
    return { id: "outside_story", label, status: "manual", detail: `수동 평가 필요: 방송·다른 사람을 언급했지만 모른다는 표현이 없다: ${unadmitted.map(s => `"${s}"`).join(", ")}` };
  }
  return { id: "outside_story", label, status: "pass", detail: mentions.length > 0 ? "언급했지만 모른다고 함께 말함" : "언급 없음" };
}
