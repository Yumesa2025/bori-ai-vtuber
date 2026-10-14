import { isAnonymousViewer } from "./access.js";
import type { MemoryCandidate } from "./types.js";

/** 저장하면 안 되는 내용. 계획서 12장의 제외 대상이다. */
const excludePattern = /(정치|의료|법률|투자|주식|개인정보|비밀번호|전화번호|주소|계좌|주민등록)/;

/**
 * 낱말 목록만으로는 "010-1234-5678", "test@example.com"처럼 값만 적은 문장을 못 막았다(a2 M-08).
 * 저장 직전에 값의 꼴과 건강·정신건강 표현을 함께 본다(S-3). 위기·정신건강 발화는 기억으로 남기지 않는다(ADR-022).
 */
const sensitivePatterns: readonly RegExp[] = [
  // 휴대전화·일반 전화번호
  /01[016-9][-\s.]?\d{3,4}[-\s.]?\d{4}/,
  /0\d{1,2}-\d{3,4}-\d{4}/,
  // 이메일과 연락처 낱말
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/,
  /연락처|이메일|메일\s*주소|카톡\s*아이디/,
  // 주민등록번호 꼴
  /\d{6}\s*-\s*[1-4]\d{6}/,
  // 연도가 붙은 생년월일. "생일은 3월 5일"처럼 연도 없는 생일은 남긴다.
  /생년월일|(19|20)?\d{2}\s*년생|(19|20)\d{2}\s*[년.\/-]\s*\d{1,2}\s*[월.\/-]\s*\d{1,2}\s*일?\s*(생|에\s*태어|태어)/,
  // 병·진단·치료
  /진단|처방|복용|정신과|병원|입원|수술|우울증|공황|조울|양극성|불안\s*장애|ADHD|조현|치매|항우울|약을?\s*먹/,
  // 위기·정신건강 표현
  /자살|자해|죽\s*고\s*싶|사라지고\s*싶|살\s*기\s*(가\s*)?싫|극단\s*적\s*(인\s*)?선택|우울/,
];

/** 저장하면 안 되는 내용인지. 계획서 12장의 제외 낱말과 값의 꼴·건강 표현을 함께 본다. */
const isSensitiveText = (text: string) => excludePattern.test(text) || sensitivePatterns.some(pattern => pattern.test(text));
/**
 * 인사·감탄 낱말과 문장부호. 이것들을 다 지웠을 때 남는 것이 없으면 단순 인사·일회성 반응이다.
 * 예전에는 "안녕"으로 시작하기만 해도 버려서 "안녕 보리! 나는 피아노 연주곡을 좋아해"처럼
 * 인사 뒤에 취향을 말한 문장까지 기억되지 않았다. 메시지 전체가 인사·감탄일 때만 버린다.
 */
const trivialTokenPattern = /안녕하세요|안녕하십니까|안녕|하이|반가워요|반가워|반갑습니다|어서와요|어서와|잘가요|잘가|바이|굿|좋아요|감사합니다|감사해요|감사|고마워요|고마워|ㅋ+|ㅎ+|ㅠ+|ㅜ+|[\s!?.,~^]+/g;

/** 단순 인사와 일회성 반응은 장기 기억으로 남기지 않는다. */
const isTrivialText = (text: string) => text.replace(trivialTokenPattern, "").length === 0;

/** 시청자의 취향·경험이 드러나는 표현. */
const preferencePattern = /(좋아해|좋아합니다|싫어해|싫어합니다|즐겨|자주 (듣|하|봐|가)|최애|덕질|취미|하고 있어|다니고 있어|배우고 있어)/;
/** 시청자의 상황이나 경험. */
const experiencePattern = /(퇴근|출근|시험|졸업|이사|아팠|아파|생일|여행|취직|입사|합격|바빴|힘들었)/;

export type ConversationTurn = { role: "viewer" | "bori"; text: string; viewerId?: string };

/**
 * 발언 하나가 장기 기억 후보인지 규칙으로 판정한다. 후보가 아니면 null이다.
 * 방송과 1:1이 같은 기준을 쓰고, 공개 범위와 소유자는 호출하는 쪽이 정한다.
 */
function classifyMemoryText(raw: string): { text: string; importance: number } | null {
  const text = raw.trim();
  if (text.length < 6) return null;
  if (isSensitiveText(text)) return null;
  if (isTrivialText(text)) return null;

  const isPreference = preferencePattern.test(text);
  const isExperience = experiencePattern.test(text);
  if (!isPreference && !isExperience) return null;

  // 취향은 반복해서 확인되는 편이라 조금 더 높게 잡는다.
  return { text, importance: isPreference ? 0.6 : 0.45 };
}

/**
 * 방송 대화에서 장기 기억 후보를 규칙으로 추린다.
 * 후보는 말한 시청자 소유의 방송 기억이 된다.
 * 익명 발언은 누구의 것인지 알 수 없으므로 후보로 만들지 않는다.
 */
export function extractMemoryCandidates(turns: readonly ConversationTurn[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  for (const turn of turns) {
    if (turn.role !== "viewer") continue;
    if (isAnonymousViewer(turn.viewerId)) continue;

    const classified = classifyMemoryText(turn.text);
    if (!classified) continue;

    candidates.push({
      text: classified.text,
      kind: "viewer",
      scope: "broadcast",
      ownerId: turn.viewerId,
      importance: classified.importance,
      // 규칙으로만 뽑은 단계라 확신은 중간이다. LLM 요약을 거치면 올라간다.
      confidence: 0.5,
    });
  }

  return candidates;
}

/**
 * 1:1 대화의 사용자 메시지에서 개인 기억 후보를 추린다.
 * 후보는 그 사용자 소유의 private 기억이 되고, 방송 기억으로는 만들지 않는다.
 * 소유자를 모르면 누구의 기억인지 알 수 없으므로 후보를 만들지 않는다.
 */
export function extractPrivateMemoryCandidates(texts: readonly string[], ownerId: string): MemoryCandidate[] {
  if (ownerId.trim().length === 0 || isAnonymousViewer(ownerId)) return [];

  return texts.flatMap(text => {
    const classified = classifyMemoryText(text);
    if (!classified) return [];
    // kind는 사람에 관한 기억이라는 뜻으로 viewer를 그대로 쓴다. 누구의 것인지는 scope와 ownerId가 정한다.
    return [{ text: classified.text, kind: "viewer" as const, scope: "private" as const, ownerId, importance: classified.importance, confidence: 0.5 }];
  });
}

/** 위험하거나 개인정보가 섞인 요약은 저장 직전에 한 번 더 막는다. */
export function isStorableMemory(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return !isSensitiveText(trimmed);
}
