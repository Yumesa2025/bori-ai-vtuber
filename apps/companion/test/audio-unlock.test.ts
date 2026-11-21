/**
 * 자동 재생 대비(점검 V2 5번). 사용자 조작 전에는 AudioContext.resume()이 거절되지 않고 끝나지 않을 수 있다.
 * 그때 재생이 1줄째에서 멈추지 않게 짧은 시간 상한으로 판정한다. 브라우저 없이 가짜 컨텍스트로 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resumeAudio, type ResumableContext } from "../src/live2d/audio-unlock";

const context = (state: string, resume: () => Promise<void>): ResumableContext => ({ state, resume });

describe("오디오 컨텍스트 깨우기", () => {
  test("이미 돌고 있으면 바로 running", async () => {
    let called = false;
    assert.equal(await resumeAudio(context("running", async () => { called = true; }), 50), "running");
    assert.equal(called, false);
  });

  test("resume이 끝나고 running이 되면 running", async () => {
    const ctx = context("suspended", async () => { ctx.state = "running"; });
    assert.equal(await resumeAudio(ctx, 50), "running");
  });

  test("resume이 끝나지 않으면(자동 재생 막힘) 시간 상한 뒤 blocked", async () => {
    const started = Date.now();
    assert.equal(await resumeAudio(context("suspended", () => new Promise(() => undefined)), 30), "blocked");
    assert.ok(Date.now() - started < 1000);
  });

  test("resume이 거절되거나 끝나도 running이 아니면 blocked", async () => {
    assert.equal(await resumeAudio(context("suspended", async () => { throw new DOMException("x", "NotAllowedError"); }), 50), "blocked");
    assert.equal(await resumeAudio(context("suspended", async () => undefined), 50), "blocked");
  });
});
