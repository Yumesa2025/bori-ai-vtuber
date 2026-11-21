/**
 * LLM 출력 글을 화면·음성에 맞게 다듬는 도우미.
 * 2026-11-21 대화 답 검증(validateLlmOutput)을 지우고, 대사 줄에도 쓸 수 있는 부분만 남겼다.
 */

/** 허용 목록 밖 감정 대신 쓰는 값(ADR-024). */
export const DEFAULT_EMOTION = "calm";

/** 답 길이는 코드포인트로 센다. UTF-16으로 세면 이모지·일부 한자가 두 글자로 잡힌다(a3 F14). */
export const replyLengthOf = (text: string) => Array.from(text).length;

// 그림 문자와 그 부속(이음 문자, 변형 선택자, 피부색, 국기 문자, 키캡).
const emojiPattern = /\p{Extended_Pictographic}|‍|️|⃣|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * 출력 규칙(이모지·마크다운 금지)을 어긴 기호를 지운다(a3 F12). 화면과 TTS가 기호를 그대로 보이거나 읽는다.
 * 내용 글자는 남기고 꾸밈만 뺀다: 링크는 글자만, 굵게·기울임·코드 표시와 줄머리 기호, 꺾쇠 태그는 지운다.
 * 한국어 답에서 *·_·# 같은 기호를 내용으로 쓰는 경우가 거의 없어 단순하게 지운다.
 */
export function stripDecorations(text: string): string {
  return text
    .replace(emojiPattern, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__|\*|~~|`+)/g, "")
    .replace(/^\s*(#{1,6}|>|[-+]|\d+\.)\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
