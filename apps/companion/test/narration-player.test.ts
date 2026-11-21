/**
 * 대사 차례 재생 검사. Live2D·오디오 대신 가짜 함수를 넣어 순서와 분기만 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NarrationLine } from "@bori/shared";
import { playNarration, type PlayerDeps, type SpeechOutcome } from "../src/narration-player";

const lines: NarrationLine[] = [
  { text: "첫 줄", emotion: "greeting", audioId: "a1" },
  { text: "둘째 줄", emotion: "gaming", audioId: "a2" },
  { text: "셋째 줄", emotion: "happy" },
];

function recorder(outcomes: SpeechOutcome[] = []) {
  const events: string[] = [];
  const deps: PlayerDeps = {
    react: emotion => { events.push(`react:${emotion}`); },
    speak: async (line, useAudio) => { events.push(`speak:${line.text}:${useAudio ? "audio" : "text"}`); return outcomes.shift() ?? (useAudio ? "audio" : "text"); },
    onLine: index => { events.push(`line:${index}`); },
  };
  return { deps, events };
}

describe("대사 차례 재생", () => {
  test("줄마다 자막 → 표정 → 말하기 순서이고 끝나면 자막을 내린다", async () => {
    const { deps, events } = recorder();
    const result = await playNarration(lines, deps, { audio: true, signal: { cancelled: false } });
    assert.equal(result, "done");
    assert.deepEqual(events, [
      "line:0", "react:greeting", "speak:첫 줄:audio",
      "line:1", "react:gaming", "speak:둘째 줄:audio",
      "line:2", "react:happy", "speak:셋째 줄:text",
      "line:null",
    ]);
  });

  test("음성이 꺼져 있으면 음성 id가 있어도 글자로 읽는다", async () => {
    const { deps, events } = recorder();
    await playNarration(lines, deps, { audio: false, signal: { cancelled: false } });
    assert.ok(events.filter(event => event.startsWith("speak:")).every(event => event.endsWith(":text")));
  });

  test("브라우저가 소리를 막으면 남은 줄은 글자로 계속 읽고 막혔다고 알린다", async () => {
    const { deps, events } = recorder(["audioBlocked"]);
    const result = await playNarration(lines, deps, { audio: true, signal: { cancelled: false } });
    assert.equal(result, "audioBlocked");
    assert.deepEqual(events.filter(event => event.startsWith("speak:")), ["speak:첫 줄:audio", "speak:둘째 줄:text", "speak:셋째 줄:text"]);
  });

  test("음성 파일 하나가 실패해도 다음 줄은 음성으로 시도한다", async () => {
    const { deps, events } = recorder(["audioFailed"]);
    const result = await playNarration(lines, deps, { audio: true, signal: { cancelled: false } });
    assert.equal(result, "done");
    assert.equal(events.filter(event => event.startsWith("speak:"))[1], "speak:둘째 줄:audio");
  });

  test("취소하면 다음 줄로 가지 않고 자막을 내린다", async () => {
    const signal = { cancelled: false };
    const { deps, events } = recorder();
    const speak = deps.speak;
    deps.speak = async (line, useAudio) => { const outcome = await speak(line, useAudio); signal.cancelled = true; return outcome; };
    const result = await playNarration(lines, deps, { audio: true, signal });
    assert.equal(result, "cancelled");
    assert.deepEqual(events, ["line:0", "react:greeting", "speak:첫 줄:audio", "line:null"]);
  });
});
