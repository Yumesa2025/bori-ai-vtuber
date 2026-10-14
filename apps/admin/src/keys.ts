type EnterKeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean } };

/**
 * 전송으로 처리할 Enter인지.
 * 한글 조합 중 Enter는 글자 확정이라 보내면 안 된다. 응답이 IME 확정보다 빠르면 마지막 글자가 따로 한 번 더 나간다.
 * Chrome은 조합 중 keydown을 keyCode 229로 주므로 둘 다 본다. 방송 화면·1:1 대화 화면과 같은 규칙이다.
 */
export function isSubmitEnter(event: EnterKeyEvent): boolean {
  if (event.key !== "Enter") return false;
  return !(event.nativeEvent?.isComposing || event.keyCode === 229);
}
