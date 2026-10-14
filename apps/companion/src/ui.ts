/**
 * 1:1 대화 화면의 화면 규칙 중 React·DOM에 묶이지 않는 부분.
 * 화면 밖 단위 검사(test/ui.test.ts)에서 그대로 부른다.
 */

type EnterKeyEvent = { key: string; shiftKey?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } };

/**
 * 전송으로 처리할 Enter인지. Shift+Enter는 줄바꿈이다.
 * 한글 조합 중 Enter는 글자 확정이라 보내면 안 된다. Chrome은 조합 중 keydown을 keyCode 229로 주므로 둘 다 본다.
 * 방송 화면(`apps/broadcast/src/chat-input.ts`)과 같은 규칙이다.
 */
export function isSubmitEnter(event: EnterKeyEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !(event.nativeEvent?.isComposing || event.keyCode === 229);
}

/**
 * 답변이 폴백 문장이었을 때 원인별 안내.
 * 1:1은 규칙 문장 없이 LLM이 답하므로, LLM을 쓸 수 없으면 모든 답이 폴백이 된다. 설정 문제인지 잠시 쉬는 것인지 알려 준다.
 * 한 번 실패한 호출(call·validation)은 메시지 아래 보조 문구로 충분하므로 따로 안내하지 않는다.
 */
export function failureNotice(kind: string | undefined): string | null {
  if (kind === "disabled") return "LLM이 꺼져 있거나 API 키가 없어 기본 문장으로 답했어요. 관리자 화면에서 LLM 사용과 API 키를 확인해 주세요.";
  if (kind === "circuit") return "LLM 호출이 연달아 실패해 잠시 쉬는 중이에요. 조금 뒤 다시 보내 주세요.";
  return null;
}

/** 음성 재생 결과별 안내. 자동 재생 차단만 화면을 눌러 풀 수 있다. */
export function speechNotice(outcome: "audio" | "text" | "audioBlocked" | "audioFailed"): string | null {
  if (outcome === "audioBlocked") return "브라우저가 소리 재생을 막았어요. 화면을 한 번 누른 뒤 다음 답부터 들을 수 있어요.";
  if (outcome === "audioFailed") return "음성을 재생하지 못했어요. 이번 답은 글자로만 보여 드려요.";
  return null;
}

/**
 * 이름 뒤 조사를 받침에 맞춘다. 예: withParticle("보리", "와", "과") → "보리와".
 * 한글이 아닌 글자로 끝나면 받침 없는 쪽을 쓴다.
 */
export function withParticle(name: string, withoutFinal: string, withFinal: string): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return `${name}${hasFinal ? withFinal : withoutFinal}`;
}

/** 입력이 최대 길이를 넘었을 때 안내. 넘지 않았으면 null이다. 붙여 넣은 글을 말없이 자르지 않는다. */
export function overLengthNotice(length: number, max: number): string | null {
  return length > max ? `${max}자를 넘었어요. ${length - max}자를 줄여야 보낼 수 있어요.` : null;
}
