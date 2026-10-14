/**
 * 방송 화면과 채팅창(chat.html)이 같이 쓰는 입력 처리.
 * 화면 밖에서 검사할 수 있게 DOM·React에 묶이지 않는 함수만 둔다.
 */

type EnterKeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean } };

/**
 * 전송으로 처리할 Enter인지.
 * 한글 조합 중 Enter는 글자 확정이라 보내면 안 된다. 보내고 입력을 비우면 IME가 마지막 글자를 다시 넣어
 * 다음 Enter에 그 글자만 따로 나간다. Chrome은 조합 중 keydown을 keyCode 229로 주므로 둘 다 본다.
 */
export function isSubmitEnter(event: EnterKeyEvent): boolean {
  if (event.key !== "Enter") return false;
  return !(event.nativeEvent?.isComposing || event.keyCode === 229);
}

/** 사생활 보호 모드 등에서는 저장소 접근이 예외를 던진다. 화면 전체가 멈추지 않게 기본값으로 동작한다. */
export function readStored(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}

export function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다. */ }
}

/**
 * 채팅 전송 실패 안내.
 * 서버는 거절 이유를 { error } 한국어 문장으로 주므로 있으면 그대로 보여 준다.
 */
export function chatSendError(status: number | null, serverMessage: string | null): string {
  if (status === null) return "서버에 연결할 수 없어요.";
  if (serverMessage) return serverMessage;
  if (status === 429) return "채팅이 너무 많아요. 잠시 뒤 다시 보내 주세요.";
  if (status >= 500) return "서버에서 문제가 생겼어요. 잠시 뒤 다시 보내 주세요.";
  return "지금은 이 채팅을 보낼 수 없어요.";
}

/** 응답 본문에서 서버가 준 오류 문장을 꺼낸다. JSON이 아니거나 없으면 null이다. */
export async function readServerError(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body?.error === "string" && body.error.trim() ? body.error : null;
  } catch {
    return null;
  }
}
