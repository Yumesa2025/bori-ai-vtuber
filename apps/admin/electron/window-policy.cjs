/**
 * 관리자 창이 열 수 있는 주소와 로드 재시도 규칙.
 * Electron 없이 단위 검사(test/window-policy.test.ts)할 수 있게 main.cjs에서 떼어 둔다.
 */

const DEFAULT_ADMIN_URL = "http://127.0.0.1:5174";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * BORI_ADMIN_URL이 가리킬 주소를 정한다.
 * 관리자 화면은 API 키를 다루므로 이 컴퓨터(loopback)의 http(s) 주소만 연다. 그 밖이면 기본 주소를 쓰고 거절한 값을 알려 준다.
 */
function resolveAdminUrl(value) {
  if (!value) return { url: DEFAULT_ADMIN_URL, rejected: null };
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && LOOPBACK_HOSTS.has(parsed.hostname)) return { url: parsed.href, rejected: null };
  } catch {
    // 주소 형식이 아니면 아래에서 거절한다.
  }
  return { url: DEFAULT_ADMIN_URL, rejected: value };
}

/** 같은 출처(프로토콜·호스트·포트)인지. 관리자 화면 안에서의 이동만 허용한다. */
function isSameOrigin(target, base) {
  try { return new URL(target).origin === new URL(base).origin; } catch { return false; }
}

/** 기본 브라우저로 넘겨도 되는 외부 웹 주소인지. file:·javascript: 같은 것은 넘기지 않는다. */
function isExternalWebUrl(target) {
  try {
    const { protocol } = new URL(target);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 재시도 타이머. 예약은 항상 하나만 남긴다.
 * 로드 실패 한 번에 loadURL의 reject와 did-fail-load가 둘 다 오므로, 두 곳에서 따로 예약하면 재시도가 매번 두 배로 늘어난다.
 */
function createRetryTimer(delayMs, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  return {
    schedule(callback) {
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => { timer = null; callback(); }, delayMs);
    },
    cancel() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { DEFAULT_ADMIN_URL, resolveAdminUrl, isSameOrigin, isExternalWebUrl, createRetryTimer };
