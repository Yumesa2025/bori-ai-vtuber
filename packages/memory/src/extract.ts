import { isAnonymousViewer } from "./access.js";
import type { MemoryCandidate } from "./types.js";

/** 저장하면 안 되는 내용. 계획서 12장의 제외 대상이다. */
const excludePattern = /(정치|의료|법률|투자|주식|개인정보|비밀번호|전화번호|주소|계좌|주민등록)/;
/** 단순 인사와 일회성 반응은 장기 기억으로 남기지 않는다. */
const trivialPattern = /^(안녕|하이|반가|ㅋ+|ㅎ+|어서와|잘가|바이|굿|좋아요|감사)/;

/** 시청자의 취향·경험이 드러나는 표현. */
const preferencePattern = /(좋아해|좋아합니다|싫어해|싫어합니다|즐겨|자주 (듣|하|봐|가)|최애|덕질|취미|하고 있어|다니고 있어|배우고 있어)/;
/** 시청자의 상황이나 경험. */
const experiencePattern = /(퇴근|출근|시험|졸업|이사|아팠|아파|생일|여행|취직|입사|합격|바빴|힘들었)/;

export type ConversationTurn = { role: "viewer" | "bori"; text: string; viewerId?: string };

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

    const text = turn.text.trim();
    if (text.length < 6) continue;
    if (excludePattern.test(text)) continue;
    if (trivialPattern.test(text)) continue;

    const isPreference = preferencePattern.test(text);
    const isExperience = experiencePattern.test(text);
    if (!isPreference && !isExperience) continue;

    candidates.push({
      text,
      kind: "viewer",
      scope: "broadcast",
      ownerId: turn.viewerId,
      // 취향은 반복해서 확인되는 편이라 조금 더 높게 잡는다.
      importance: isPreference ? 0.6 : 0.45,
      // 규칙으로만 뽑은 단계라 확신은 중간이다. LLM 요약을 거치면 올라간다.
      confidence: 0.5,
    });
  }

  return candidates;
}

/** 위험하거나 개인정보가 섞인 요약은 저장 직전에 한 번 더 막는다. */
export function isStorableMemory(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return !excludePattern.test(trimmed);
}
