/**
 * 대시보드 설정(게임 닉네임) 파일 단위 검사. 임시 폴더만 쓴다. 닉네임은 가짜 값이다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardSettings, DashboardSettingsError, parseDashboardSettings } from "../src/er/dashboard-settings.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bori-dash-settings-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const quiet = () => {};

describe("대시보드 설정", () => {
  test("파일이 없으면 닉네임 없음", () => {
    assert.deepEqual(createDashboardSettings(dir, quiet).get(), { nickname: null });
  });

  test("저장하면 파일에 쓰고 다시 열어도 같다", () => {
    const settings = createDashboardSettings(dir, quiet);
    settings.set({ nickname: "가짜닉" });
    assert.ok(existsSync(join(dir, "dashboard-settings.json")));
    assert.deepEqual(createDashboardSettings(dir, quiet).get(), { nickname: "가짜닉" });
    settings.set({ nickname: null });
    assert.deepEqual(createDashboardSettings(dir, quiet).get(), { nickname: null });
  });

  test("앞뒤 공백을 자르고 빈 닉네임은 없음으로 본다", () => {
    assert.deepEqual(parseDashboardSettings({ nickname: "  가짜닉 " }), { nickname: "가짜닉" });
    assert.deepEqual(parseDashboardSettings({ nickname: "   " }), { nickname: null });
    assert.deepEqual(parseDashboardSettings({ nickname: null }), { nickname: null });
  });

  test("제어문자·NUL·방향 바꿈 문자·개행·탭을 지운 뒤 앞뒤 공백을 자른다", () => {
    assert.deepEqual(parseDashboardSettings({ nickname: " 가짜\u202E닉\u0000\n\t " }), { nickname: "가짜닉" });
    assert.deepEqual(parseDashboardSettings({ nickname: "가짜\u2066닉\uFEFF" }), { nickname: "가짜닉" });
    // 지우고 나면 빈 문자열이면 닉네임 없음
    assert.deepEqual(parseDashboardSettings({ nickname: "\u202E\u0000\r\n" }), { nickname: null });
  });

  test("32자 상한은 정리한 뒤의 글자 수로 센다", () => {
    assert.deepEqual(parseDashboardSettings({ nickname: `${"가".repeat(32)}\u202E\u0000` }), { nickname: "가".repeat(32) });
  });

  test("문자열·null이 아니거나 32자를 넘으면 오류", () => {
    for (const value of [null, "가짜닉", { nickname: 3 }, { nickname: "가".repeat(33) }, {}]) {
      assert.throws(() => parseDashboardSettings(value), DashboardSettingsError);
    }
    assert.deepEqual(parseDashboardSettings({ nickname: "가".repeat(32) }), { nickname: "가".repeat(32) });
  });

  test("깨진 파일·틀린 값은 닉네임 없음으로 시작하고 원본을 남긴다", () => {
    writeFileSync(join(dir, "dashboard-settings.json"), JSON.stringify({ nickname: 42 }));
    assert.deepEqual(createDashboardSettings(dir, quiet).get(), { nickname: null });
    assert.ok(readdirSync(dir).some((name) => name.includes("unreadable")));

    writeFileSync(join(dir, "dashboard-settings.json"), "{ 깨짐");
    assert.deepEqual(createDashboardSettings(dir, quiet).get(), { nickname: null });
  });
});
