/**
 * 방송 답 끝맺음 다듬기. 규칙(packages/character)만으로는 "여러분은 어떻게 생각하시나요?"가 계속 나와(2026-10-15 리허설),
 * 시청자에게 생각·의견을 묻는 문장은 서버가 지운다. 그 문장뿐인 답은 그대로 둔다(말할 것이 없어지므로).
 */

/** 시청자에게 생각·의견을 묻는 문장. "어떻게 생각하세요?", "여러분의 의견을 듣고 싶어요" 같은 것. */
const OPINION_QUESTION = /(어떻게\s*생각하(시나요|세요|셔요|나요|십니까|시는지)|생각은\s*(어떠|어때)|의견(을|도|이)?\s*(듣고|들려|알려|남겨|궁금|어떠|어때|있으)|어떤\s*생각(이|을)\s*(드시|하시|들어|있으))/;

/** 끝맺음 부호 뒤 띄어쓰기에서 문장을 나눈다. 소수점(8.1%)은 뒤에 띄어쓰기가 없어 끊기지 않는다. */
function sentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?…~])\s+/).filter(Boolean);
}

export function withoutOpinionQuestions(reply: string): string {
  const parts = sentences(reply);
  const kept = parts.filter(part => !OPINION_QUESTION.test(part));
  if (kept.length === 0 || kept.length === parts.length) return reply;
  return kept.join(" ");
}
