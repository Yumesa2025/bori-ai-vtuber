/** 음성 켜기/끄기는 이 브라우저에만 저장한다. 기본은 끔이다. 1:1 화면 때와 같은 키라 예전 설정이 이어진다. */
const TTS_KEY = "bori-companion-tts";

// 사생활 보호 모드 등에서는 저장소 접근이 예외를 던지므로 기본값으로 동작한다.
export function loadTtsEnabled(): boolean {
  try { return localStorage.getItem(TTS_KEY) === "on"; } catch { return false; }
}

export function saveTtsEnabled(enabled: boolean) {
  try { localStorage.setItem(TTS_KEY, enabled ? "on" : "off"); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다. */ }
}

/** 마지막으로 자동으로 읽은 대사 id. 새로고침하거나 다시 켜도 같은 대사를 또 자동으로 읽지 않게 한다. */
const LAST_NARRATION_KEY = "bori-dashboard-last-narration";

export function loadLastNarrationId(): string | null {
  try { return localStorage.getItem(LAST_NARRATION_KEY); } catch { return null; }
}

export function saveLastNarrationId(id: string) {
  try { localStorage.setItem(LAST_NARRATION_KEY, id); } catch { /* 저장하지 못하면 새로고침 때 한 번 더 읽을 뿐이다. */ }
}
