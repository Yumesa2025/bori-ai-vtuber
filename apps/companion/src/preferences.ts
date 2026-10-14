/** 음성 켜기/끄기는 이 브라우저에만 저장한다. 기본은 끔이다. */
const TTS_KEY = "bori-companion-tts";

// 사생활 보호 모드 등에서는 저장소 접근이 예외를 던지므로 기본값으로 동작한다.
export function loadTtsEnabled(): boolean {
  try { return localStorage.getItem(TTS_KEY) === "on"; } catch { return false; }
}

export function saveTtsEnabled(enabled: boolean) {
  try { localStorage.setItem(TTS_KEY, enabled ? "on" : "off"); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다. */ }
}

/** 새로고침해도 열려 있던 대화로 돌아가도록 이 탭에만 기억한다. 탭을 닫으면 지워진다. */
const ACTIVE_CONVERSATION_KEY = "bori-companion-active-conversation";

export function loadActiveConversation(): string | null {
  try { return sessionStorage.getItem(ACTIVE_CONVERSATION_KEY); } catch { return null; }
}

export function saveActiveConversation(id: string | null) {
  try {
    if (id) sessionStorage.setItem(ACTIVE_CONVERSATION_KEY, id); else sessionStorage.removeItem(ACTIVE_CONVERSATION_KEY);
  } catch { /* 저장하지 못하면 새로고침 때 새 대화로 시작할 뿐이다. */ }
}
