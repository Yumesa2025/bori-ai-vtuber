/**
 * 스튜디오 탭 활성 메시지 검사(Codex C2 6절).
 * 스튜디오는 설정 탭으로 가도 대시보드 iframe을 숨기기만 해서, iframe의 문서 가시성은 계속 visible이었다.
 * 그래서 숨긴 대시보드가 새 대사를 자동으로 읽고 "읽음"으로 저장했다. 이제 스튜디오가 탭 활성 상태를 알린다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pageActive, readStudioTabMessage, STUDIO_TAB_MESSAGE, studioTabMessage } from "../src/studio-tab";

const parent = { name: "parent" };
const self = { name: "self" };
const here = { origin: "http://127.0.0.1:4317", parent, self };
const event = (data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: here.origin, source: parent, data, ...overrides });

describe("스튜디오 탭 메시지", () => {
  test("같은 출처의 부모 창이 보낸 메시지만 읽는다", () => {
    assert.equal(readStudioTabMessage(event(studioTabMessage(false)), here), false);
    assert.equal(readStudioTabMessage(event(studioTabMessage(true)), here), true);
  });

  test("출처가 다르거나 부모가 아닌 창이 보내면 무시한다", () => {
    assert.equal(readStudioTabMessage(event(studioTabMessage(false), { origin: "http://evil.example" }), here), null);
    assert.equal(readStudioTabMessage(event(studioTabMessage(false), { origin: "null" }), here), null);
    assert.equal(readStudioTabMessage(event(studioTabMessage(false), { source: { name: "other" } }), here), null);
    assert.equal(readStudioTabMessage(event(studioTabMessage(false), { source: null }), here), null);
  });

  test("혼자 띄운 대시보드(부모가 자기 자신)는 메시지를 받지 않는다", () => {
    assert.equal(readStudioTabMessage(event(studioTabMessage(false), { source: self }), { ...here, parent: self }), null);
  });

  test("모양이 틀린 메시지는 무시한다", () => {
    for (const data of [null, "x", { type: STUDIO_TAB_MESSAGE }, { type: STUDIO_TAB_MESSAGE, active: "false" }, { type: "other", active: false }]) {
      assert.equal(readStudioTabMessage(event(data), here), null, JSON.stringify(data));
    }
  });

  test("메시지 모양을 고정한다(스튜디오 apps/admin DashboardTab과 같은 값)", () => {
    assert.deepEqual(studioTabMessage(true), { type: "bori-studio-tab", active: true });
  });

  test("화면이 보이고 스튜디오 탭도 활성일 때만 보이는 것으로 본다", () => {
    assert.equal(pageActive(true, true), true);
    assert.equal(pageActive(true, false), false);
    assert.equal(pageActive(false, true), false);
  });
});
