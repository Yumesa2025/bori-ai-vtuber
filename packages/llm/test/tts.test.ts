/**
 * 음성 합성 단위 검사(점검 O-4·U-3: a4 A4-08·A4-12·A4-13·A4-15).
 * 빈·깨진 오디오를 실패로 보는지, mp3 길이를 세는지, 크기 상한, 목소리 목록 캐시와 상한을 본다.
 * fetch를 가짜로 바꿔 네트워크를 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { AUDIO_MAX_BYTES, createVoiceListCache, defaultTtsSettings, listVoices, mp3DurationMs, synthesizeSpeech, VOICE_LIST_CACHE_MS, VOICE_LIST_FAILURE_CACHE_MS, type TtsVoiceOption } from "../src/tts.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const credentials = { openAiApiKey: "fake-openai", elevenLabsApiKey: "fake-eleven" };

/** MPEG1 Layer III 128kbps 44.1kHz 프레임. 한 프레임은 417바이트, 1152표본(약 26.1ms)이다. */
function mp3Frames(count: number): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: count }, () => frame));
}

const respondWith = (body: Buffer | string, headers: Record<string, string> = {}) => {
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200, headers })) as typeof fetch;
};

describe("mp3 길이", () => {
  test("프레임 수로 재생 길이를 센다", () => {
    assert.equal(mp3DurationMs(mp3Frames(100)), Math.round(100 * 1152 / 44100 * 1000));
  });

  test("앞의 ID3 태그를 건너뛴다", () => {
    const tag = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20)]);
    assert.equal(mp3DurationMs(Buffer.concat([tag, mp3Frames(10)])), Math.round(10 * 1152 / 44100 * 1000));
  });

  test("머리만 온전한 짧은 응답도 mp3로 본다(가짜 API의 6바이트)", () => {
    assert.equal(mp3DurationMs(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00])), 26);
  });

  test("빈 데이터와 mp3가 아닌 데이터는 null이다", () => {
    assert.equal(mp3DurationMs(Buffer.alloc(0)), null);
    assert.equal(mp3DurationMs(Buffer.from("{\"error\":\"oops\"}")), null);
    assert.equal(mp3DurationMs(Buffer.alloc(2000)), null);
  });
});

describe("음성 합성 응답 검사", () => {
  test("0바이트 응답은 실패다(A4-13)", async () => {
    respondWith(Buffer.alloc(0));
    await assert.rejects(synthesizeSpeech(credentials, defaultTtsSettings, "안녕"), /비어 있습니다/);
  });

  test("mp3가 아닌 응답은 실패다", async () => {
    respondWith("<html>error</html>");
    await assert.rejects(synthesizeSpeech(credentials, defaultTtsSettings, "안녕"), /mp3가 아닙니다/);
  });

  test("정상 응답은 재생 길이를 같이 돌려준다", async () => {
    respondWith(mp3Frames(200));
    const result = await synthesizeSpeech(credentials, { ...defaultTtsSettings, provider: "elevenlabs", voice: "voice1" }, "안녕");
    assert.equal(result.durationMs, Math.round(200 * 1152 / 44100 * 1000));
  });

  test("크기 상한을 넘는 응답은 실패다(A4-15)", async () => {
    respondWith(mp3Frames(Math.ceil((AUDIO_MAX_BYTES + 1) / 417)));
    await assert.rejects(synthesizeSpeech(credentials, defaultTtsSettings, "안녕"), /바이트를 넘습니다/);
  });

  test("길이 헤더가 상한을 넘으면 본문을 받기 전에 끊는다", async () => {
    respondWith(mp3Frames(1), { "Content-Length": String(AUDIO_MAX_BYTES + 1) });
    await assert.rejects(synthesizeSpeech(credentials, defaultTtsSettings, "안녕"), /바이트를 넘습니다/);
  });
});

describe("목소리 목록", () => {
  test("ElevenLabs 목록 요청은 상한 안에 끝난다(A4-08)", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as typeof fetch;
    const startedAt = Date.now();
    await assert.rejects(listVoices(credentials, "elevenlabs", 100), /100ms 안에 오지 않았습니다/);
    assert.ok(Date.now() - startedAt < 2000);
  });

  test("캐시는 같은 업체·키면 10분 동안 다시 묻지 않는다", async () => {
    let now = 0;
    let calls = 0;
    const voices: TtsVoiceOption[] = [{ id: "v1", name: "보리" }];
    const cache = createVoiceListCache({ now: () => now, load: async () => { calls += 1; return voices; } });

    assert.deepEqual(await cache.get(credentials, "elevenlabs"), voices);
    now += VOICE_LIST_CACHE_MS - 1;
    await cache.get(credentials, "elevenlabs");
    assert.equal(calls, 1);

    now += 1;
    await cache.get(credentials, "elevenlabs");
    assert.equal(calls, 2);

    // 키가 바뀌면 바로 새로 묻는다.
    await cache.get({ ...credentials, elevenLabsApiKey: "other" }, "elevenlabs");
    assert.equal(calls, 3);

    // 저장할 때 비우면 다시 묻는다.
    cache.clear();
    await cache.get({ ...credentials, elevenLabsApiKey: "other" }, "elevenlabs");
    assert.equal(calls, 4);
  });

  test("동시에 들어온 요청은 진행 중인 요청 하나를 같이 기다린다", async () => {
    let calls = 0;
    const cache = createVoiceListCache({ load: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return []; } });
    await Promise.all([cache.get(credentials, "elevenlabs"), cache.get(credentials, "elevenlabs"), cache.get(credentials, "elevenlabs")]);
    assert.equal(calls, 1);
  });

  test("실패하면 빈 목록을 주고 30초 동안 다시 묻지 않는다", async () => {
    let now = 0;
    let calls = 0;
    const cache = createVoiceListCache({ now: () => now, load: async () => { calls += 1; throw new Error("ElevenLabs 목소리 목록 503"); } });
    assert.deepEqual(await cache.get(credentials, "elevenlabs"), []);
    now += VOICE_LIST_FAILURE_CACHE_MS - 1;
    assert.deepEqual(await cache.get(credentials, "elevenlabs"), []);
    assert.equal(calls, 1);
    now += 1;
    await cache.get(credentials, "elevenlabs");
    assert.equal(calls, 2);
  });
});
