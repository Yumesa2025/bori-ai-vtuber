/**
 * 대사 차례 재생 검사. Live2D·오디오 대신 가짜 함수를 넣어 순서와 분기만 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NarrationLine } from "@bori/shared";
import { createGeneration, createPlayback, playNarration, type PlayerDeps, type SpeechOutcome } from "../src/narration-player";

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
    const result = await playNarration(lines, deps, { audio: () => true, signal: { cancelled: false, restart: false } });
    // 셋째 줄은 음성을 켰는데 음성 id가 없다(서버 TTS 실패) → 자막만 보였다고 알린다
    assert.equal(result, "audioFailed");
    assert.deepEqual(events, [
      "line:0", "react:greeting", "speak:첫 줄:audio",
      "line:1", "react:gaming", "speak:둘째 줄:audio",
      "line:2", "react:happy", "speak:셋째 줄:text",
      "line:null",
    ]);
  });

  test("음성이 꺼져 있으면 음성 id가 있어도 글자로 읽는다", async () => {
    const { deps, events } = recorder();
    await playNarration(lines, deps, { audio: () => false, signal: { cancelled: false, restart: false } });
    assert.ok(events.filter(event => event.startsWith("speak:")).every(event => event.endsWith(":text")));
  });

  test("브라우저가 소리를 막으면 남은 줄은 글자로 계속 읽고 막혔다고 알린다", async () => {
    const { deps, events } = recorder(["audioBlocked"]);
    const result = await playNarration(lines, deps, { audio: () => true, signal: { cancelled: false, restart: false } });
    assert.equal(result, "audioBlocked");
    assert.deepEqual(events.filter(event => event.startsWith("speak:")), ["speak:첫 줄:audio", "speak:둘째 줄:text", "speak:셋째 줄:text"]);
  });

  test("모든 줄을 음성으로 읽었으면 done", async () => {
    const { deps } = recorder();
    const voiced = lines.map((line, index) => ({ ...line, audioId: `a${index}` }));
    assert.equal(await playNarration(voiced, deps, { audio: () => true, signal: { cancelled: false, restart: false } }), "done");
    assert.equal(await playNarration(lines, deps, { audio: () => false, signal: { cancelled: false, restart: false } }), "done", "음성을 끄면 id가 없어도 실패가 아니다");
  });

  test("음성 파일 하나가 실패해도 다음 줄은 음성으로 시도하고, 끝나면 audioFailed로 알린다", async () => {
    const { deps, events } = recorder(["audioFailed"]);
    const result = await playNarration(lines, deps, { audio: () => true, signal: { cancelled: false, restart: false } });
    assert.equal(result, "audioFailed");
    assert.equal(events.filter(event => event.startsWith("speak:"))[1], "speak:둘째 줄:audio");
  });

  test("취소하면 다음 줄로 가지 않고 자막을 내린다", async () => {
    const signal = { cancelled: false, restart: false };
    const { deps, events } = recorder();
    const speak = deps.speak;
    deps.speak = async (line, useAudio) => { const outcome = await speak(line, useAudio); signal.cancelled = true; return outcome; };
    const result = await playNarration(lines, deps, { audio: () => true, signal });
    assert.equal(result, "cancelled");
    assert.deepEqual(events, ["line:0", "react:greeting", "speak:첫 줄:audio", "line:null"]);
  });
});

/** 말하기를 검사가 끝낼 때까지 붙잡는 가짜. stopSpeech는 실제 Live2D처럼 기다리던 말하기를 바로 끝낸다. */
function heldSpeech() {
  const events: Array<Array<string | number | boolean | null>> = [];
  let pending: ((outcome: SpeechOutcome) => void) | null = null;
  const deps = {
    react: (emotion: string) => { events.push(["react", emotion]); },
    speak: (line: NarrationLine, useAudio: boolean) => {
      events.push(["speak", line.text, useAudio]);
      return new Promise<SpeechOutcome>(resolve => { pending = resolve; });
    },
    onLine: (index: number | null) => { events.push(["line", index]); },
    stopSpeech: () => { events.push(["stop"]); const resolve = pending; pending = null; resolve?.("audio"); },
  };
  const finish = async (outcome: SpeechOutcome = "audio") => { const resolve = pending; pending = null; resolve?.(outcome); await flush(); };
  return { deps, events, finish };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const voicedLines: NarrationLine[] = [
  { text: "A0", emotion: "gaming", audioId: "a0" },
  { text: "A1", emotion: "happy", audioId: "a1" },
];

describe("재생 제어기", () => {
  test("C2 4: 재생 중 음성을 끄면 지금 줄을 멈추고 글자로 다시 말하며, 남은 줄도 글자로 읽는다", async () => {
    const { deps, events, finish } = heldSpeech();
    const playback = createPlayback(deps);
    let audio = true;
    const done = playback.play(voicedLines, () => audio);
    await flush();
    audio = false;
    playback.audioModeChanged();
    await flush();
    await finish();
    await finish();
    assert.equal(await done, "done");
    assert.deepEqual(events.filter(event => event[0] === "speak" || event[0] === "stop"), [
      ["stop"], // play 시작 때 이전 재생 정리
      ["speak", "A0", true],
      ["stop"],
      ["speak", "A0", false],
      ["speak", "A1", false],
    ]);
  });

  test("C2 4: 글자로 읽는 중 음성을 켜면 지금 줄부터 음성으로 다시 말한다", async () => {
    const { deps, events, finish } = heldSpeech();
    const playback = createPlayback(deps);
    let audio = false;
    const done = playback.play(voicedLines, () => audio);
    await flush();
    audio = true;
    playback.audioModeChanged();
    await flush();
    await finish();
    await finish();
    assert.equal(await done, "done");
    assert.deepEqual(events.filter(event => event[0] === "speak"), [["speak", "A0", false], ["speak", "A0", true], ["speak", "A1", true]]);
    // 다시 말해도 자막 줄 번호는 한 번만 바뀐다
    assert.deepEqual(events.filter(event => event[0] === "line"), [["line", 0], ["line", 1], ["line", null]]);
  });

  test("C2 5: 새 재생이 이전 재생을 바꾸면 이전 재생의 콜백(자막 내리기 등)이 새 자막을 지우지 않는다", async () => {
    const { deps, events, finish } = heldSpeech();
    const playback = createPlayback(deps);
    const first = playback.play(voicedLines, () => true);
    await flush();
    const second = playback.play([{ text: "B0", emotion: "calm", audioId: "b0" }], () => true);
    assert.equal(await first, "cancelled");
    await flush();
    const afterSwitch = events.slice(events.findIndex(event => event[0] === "speak" && event[1] === "A0") + 1);
    assert.deepEqual(afterSwitch, [["stop"], ["line", 0], ["react", "calm"], ["speak", "B0", true]]);
    await finish();
    assert.equal(await second, "done");
    assert.deepEqual(events.at(-1), ["line", null]);
    assert.ok(!events.some(event => event[1] === "A1"));
    assert.equal(playback.playing, false);
  });

  test("멈추면 다음 줄로 가지 않고 그 재생의 콜백도 부르지 않는다", async () => {
    const { deps, events } = heldSpeech();
    const playback = createPlayback(deps);
    const done = playback.play(voicedLines, () => true);
    await flush();
    assert.equal(playback.playing, true);
    playback.stop();
    assert.equal(await done, "cancelled");
    assert.equal(playback.playing, false);
    assert.deepEqual(events.at(-1), ["stop"]);
  });

  test("C2 7: 해제하면 전체 재생을 취소하고, 해제 뒤의 재생은 아무것도 하지 않는다", async () => {
    const { deps, events, finish } = heldSpeech();
    const playback = createPlayback(deps);
    const done = playback.play(voicedLines, () => true);
    await flush();
    playback.dispose();
    await finish();
    assert.equal(await done, "cancelled");
    const count = events.length;
    assert.equal(await playback.play(voicedLines, () => true), "cancelled");
    playback.audioModeChanged();
    assert.equal(events.length, count);
    assert.ok(!events.some(event => event[1] === "A1"));
  });
});

describe("요청 세대", () => {
  test("C2 7: 새 요청을 시작하거나 무효로 하면 그 전 요청의 늦은 응답은 현재가 아니다", () => {
    const generation = createGeneration();
    const first = generation.next();
    assert.equal(generation.isCurrent(first), true);
    const second = generation.next();
    assert.equal(generation.isCurrent(first), false);
    assert.equal(generation.isCurrent(second), true);
    generation.invalidate();
    assert.equal(generation.isCurrent(second), false);
  });
});
