/**
 * 관리자 Electron 창 정책 단위 검사.
 * 원격 주소를 열지 않는지, 화면 밖 이동·외부 링크를 가르는지, 로드 실패 재시도가 한 번만 예약되는지 본다.
 * Electron은 띄우지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_ADMIN_URL, createRetryTimer, isExternalWebUrl, isSameOrigin, resolveAdminUrl } = require("../electron/window-policy.cjs") as {
  DEFAULT_ADMIN_URL: string;
  createRetryTimer: (delayMs: number, timers?: { setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }) => { schedule: (callback: () => void) => void; cancel: () => void };
  isExternalWebUrl: (target: string) => boolean;
  isSameOrigin: (target: string, base: string) => boolean;
  resolveAdminUrl: (value: string | undefined) => { url: string; rejected: string | null };
};

describe("BORI_ADMIN_URL", () => {
  test("이 컴퓨터 주소만 연다", () => {
    // 점검 A5-27·a7 F14: 환경변수로 원격 URL을 열 수 있었다.
    assert.deepEqual(resolveAdminUrl(undefined), { url: DEFAULT_ADMIN_URL, rejected: null });
    assert.equal(resolveAdminUrl("http://127.0.0.1:5175").url, "http://127.0.0.1:5175/");
    assert.equal(resolveAdminUrl("http://localhost:5174/").rejected, null);
    assert.equal(resolveAdminUrl("http://[::1]:5174").rejected, null);
  });

  test("원격·다른 프로토콜·형식 오류는 기본 주소로 바꾸고 거절한 값을 알린다", () => {
    for (const value of ["https://example.com", "http://192.168.0.10:5174", "file:///C:/index.html", "http://127.0.0.1.example.com", "not a url"]) {
      assert.deepEqual(resolveAdminUrl(value), { url: DEFAULT_ADMIN_URL, rejected: value }, value);
    }
  });
});

describe("이동·새 창", () => {
  test("같은 출처 안에서만 이동을 허용한다", () => {
    assert.equal(isSameOrigin("http://127.0.0.1:5174/settings", "http://127.0.0.1:5174/"), true);
    assert.equal(isSameOrigin("http://127.0.0.1:4310/api/state", "http://127.0.0.1:5174/"), false);
    assert.equal(isSameOrigin("https://example.com/", "http://127.0.0.1:5174/"), false);
  });

  test("기본 브라우저로는 http(s) 링크만 넘긴다", () => {
    assert.equal(isExternalWebUrl("https://example.com/docs"), true);
    assert.equal(isExternalWebUrl("file:///C:/Windows/system32/calc.exe"), false);
    assert.equal(isExternalWebUrl("javascript:alert(1)"), false);
  });
});

describe("로드 재시도", () => {
  test("같은 실패로 두 번 예약해도 재시도는 한 번만 돈다", () => {
    // 점검 A5-12: loadURL reject와 did-fail-load가 각각 재시도를 예약해 매번 두 배로 늘었다.
    const pending = new Map<number, () => void>();
    let next = 1;
    const retry = createRetryTimer(1000, {
      setTimeout: callback => { const id = next++; pending.set(id, callback); return id; },
      clearTimeout: handle => { pending.delete(handle as number); },
    });
    let loads = 0;
    retry.schedule(() => { loads += 1; });
    retry.schedule(() => { loads += 1; });
    assert.equal(pending.size, 1);
    for (const [id, callback] of [...pending]) { pending.delete(id); callback(); }
    assert.equal(loads, 1);
    retry.schedule(() => { loads += 1; });
    retry.cancel();
    assert.equal(pending.size, 0);
  });
});
