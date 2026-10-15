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

/** 기쁜 말. 이 말이 든 답에 당황·슬픔·화남 얼굴이 나오면 어긋난다. */
const POSITIVE_WORDS = /좋아(요|졌|서|하|해)|기뻐|기쁘|고마워|고맙|감사해|신나|신났|행복|즐거|설레/;
/** 기쁜 말과 함께 나오면 어긋나는 감정. 표정이 당황(멍함)·말문 막힘·슬픔·울음·화남이다. */
const CLASHING_EMOTIONS = new Set(["embarrassed", "awkward", "sad", "crying", "angry"]);
/** 그 감정의 짝 모션. 감정을 바꾸면 같이 뺀다(모션이 있으면 짝 표정이 감정 표정을 덮어쓴다). */
const CLASHING_MOTIONS = new Set(["kuqi", "shengqi"]);

/**
 * 답의 말과 얼굴을 맞춘다. "기분이 좋아졌어요"에 당황한 얼굴이 나온 일이 있어(2026-10-15 리허설),
 * 기쁜 말이 있는데 감정이 어긋나면 happy로 바꾸고 어긋나는 모션을 뺀다. 그 밖에는 그대로 둔다.
 */
export function withMatchingEmotion<T extends { reply: string; emotion: { primary: string }; actions: readonly { name: string }[] }>(response: T): T {
  if (!POSITIVE_WORDS.test(response.reply) || !CLASHING_EMOTIONS.has(response.emotion.primary)) return response;
  return { ...response, emotion: { ...response.emotion, primary: "happy" }, actions: response.actions.filter(action => !CLASHING_MOTIONS.has(action.name)) };
}
