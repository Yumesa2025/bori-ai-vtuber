/** 가린 자리에 넣는 표시. */
const MASK = "[가림]";

/**
 * 키 모양 문자열. 업체 오류 본문에 키가 섞여 오는 경우를 막는다.
 * - sk-로 시작하는 OpenAI·Anthropic 키. OpenAI가 일부를 *로 가려 돌려주는 표기(sk-proj-****abcd)도 포함한다.
 * - Authorization 헤더 값(Bearer 토큰)
 * - 32자 이상 이어진 영숫자 토큰(ElevenLabs 키 등). 요청 ID가 함께 가려질 수 있지만 오류 이유를 읽는 데는 지장이 없다.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_*-]{6,}/g, MASK],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  [/[A-Za-z0-9_-]{32,}/g, MASK],
];

/**
 * 외부 API 오류 본문을 메시지에 넣기 전에 키를 가린다.
 * 이 메시지는 서버 로그와 관리자 API(lastError, ttsLastError)로 나간다.
 * 호출한 키를 넘기면 모양과 상관없이 그 값도 가린다. 자르기 전에 불러야 잘린 키 조각이 남지 않는다.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of knownSecrets) {
    const value = secret.trim();
    if (value.length > 0) result = result.split(value).join(MASK);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}
