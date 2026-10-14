/**
 * 방송 운영 검사(점검 O-1~O-5, L-1, Q-4, ADR-024).
 *
 * 방송 중 재시작·두 번 종료·생성 중 종료가 기억을 날리거나 부풀리지 않는지, 큐 만료·시청자별 상한·중복과
 * 버려진 채팅 집계, 거절 이유 코드, lastError 수명, 빈·깨진 음성 거절과 음성 길이에 맞춘 말풍선,
 * 방송 음성 상한, 목소리 목록 캐시, 경로 비교(쿼리·끝 슬래시·HEAD)를 HTTP로 본다.
 */
import { baseQueueSettings } from "./harness.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const MOCK_REPLY = "가짜 답변입니다. 잘 들리시나요.";
const ANSWER_MARK = "[답변할 채팅]";
/** 방송 종료 요약 요청의 지시문 머리. 누적 요약과 구분한다. */
const BROADCAST_SUMMARY_MARK = "방송 기록을 정리하는 도우미";

export const meta = {
  name: "방송 운영",
  timing: { llm: 300, tts: 200, embed: 50 },
};

export async function run({ bori, mock, report }) {
  const send = async (method, path, payload) => {
    const response = await fetch(`${bori.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  async function waitForMemory(predicate) {
    for (let tries = 0; tries < 40; tries += 1) {
      const records = (await bori.memory()).records;
      if (predicate(records)) return records;
      await sleep(250);
    }
    return (await bori.memory()).records;
  }
  const summaryCalls = async () => (await mock.calls()).filter(entry => entry.kind === "llm" && entry.system.includes(BROADCAST_SUMMARY_MARK));

  await bori.patchSettings(baseQueueSettings);

  // ── 경로 비교(Q-4) ──────────────────────────────────────────────
  {
    const withQuery = await bori.get("/api/state?from=obs");
    const withSlash = await bori.get("/api/settings/");
    report.check("쿼리·끝 슬래시가 붙어도 같은 라우트다", withQuery.status === 200 && withSlash.status === 200, `query=${withQuery.status} slash=${withSlash.status}`);
    const head = await fetch(`${bori.baseUrl}/api/health`, { method: "HEAD" });
    report.check("HEAD는 GET 라우트로 답하고 본문이 없다", head.status === 200 && (await head.text()) === "", `status=${head.status}`);
    report.check("없는 경로는 여전히 404다", (await bori.get("/api/statex")).status === 404);
  }

  // ── 방송 중 재시작은 진행 중 방송을 정상 종료해 기억을 저장한다(A4-02) ────────
  {
    await bori.startSession();
    await bori.chat("운영표시 나는 피아노 연주곡을 좋아해", "솔");
    await bori.waitForReply();
    await bori.waitForIdle();
    const restarted = await bori.startSession();
    report.check("방송 중 다시 시작해도 200이고 새 방송이 열린다", restarted.status === 200 && restarted.body?.status === "live");
    const records = await waitForMemory(rows => rows.some(row => row.text.includes("피아노 연주곡")));
    report.check("방송 중 재시작 전 대화가 기억으로 저장된다", records.some(row => row.text.includes("피아노 연주곡")));
  }

  // ── 종료를 두 번 해도 기억이 부풀지 않고 요약을 다시 부르지 않는다(A4-06) ──────
  {
    await bori.chat("운영표시 나는 등산을 좋아해", "산");
    await bori.waitForReply();
    await bori.waitForIdle();
    await mock.reset();
    await bori.endSession();
    const saved = (await waitForMemory(rows => rows.some(row => row.text.includes("등산")))).find(row => row.text.includes("등산"));
    await sleep(800);
    const summariesAfterFirst = (await summaryCalls()).length;
    const second = await bori.endSession();
    await sleep(1500);
    const again = (await bori.memory()).records.find(row => row.text.includes("등산"));
    report.check("두 번째 종료도 200이고 상태는 그대로 ended다", second.status === 200 && second.body?.status === "ended");
    report.check("두 번째 종료가 기억 repeatCount를 올리지 않는다", saved !== undefined && again?.repeatCount === saved.repeatCount, `${saved?.repeatCount} → ${again?.repeatCount}`);
    report.check("두 번째 종료가 종료 요약을 다시 부르지 않는다", summariesAfterFirst === 1 && (await summaryCalls()).length === 1, `첫 종료 ${summariesAfterFirst}건, 뒤 ${(await summaryCalls()).length}건`);
    report.check("종료하면 방송 화면 채팅 목록을 비운다(A4-23)", (await bori.state()).visibleChats.length === 0);
  }

  // ── 생성 중 종료한 채팅의 시청자 발언도 기억 후보로 남는다(A4-19) ───────────
  {
    await bori.startSession();
    await mock.setTiming({ llm: 2000, tts: 200, embed: 50 });
    await bori.chat("운영표시 나는 재즈 피아노를 좋아해", "재즈");
    await sleep(500);
    await bori.endSession();
    const records = await waitForMemory(rows => rows.some(row => row.text.includes("재즈 피아노")));
    report.check("생성 중에 끝낸 채팅도 기억 후보로 저장된다", records.some(row => row.text.includes("재즈 피아노")));
    await sleep(2000);
    report.check("생성 중에 끝낸 답은 화면에 올라오지 않는다", (await bori.state()).currentResponse === undefined);
    await mock.setTiming(meta.timing);
  }

  // ── 고정 규칙 답이 방금 말한 게임을 무시하지 않는다(O-3, A4-14) ──────────────
  {
    await bori.startSession();
    await mock.reset();
    await bori.chat("운영표시 나 요즘 리듬 게임에 완전 빠졌어", "별빛");
    const reply = await bori.waitForReply();
    report.check("LLM이 켜져 있으면 게임 이야기는 LLM이 답한다", reply.response?.source === "llm" && reply.response?.reply === MOCK_REPLY, `${reply.response?.source} ${reply.response?.reply}`);
    await bori.waitForIdle();
  }

  // ── lastError는 다음 정상 답에서 지워진다(A4-10) ────────────────────────
  {
    await mock.inject({ target: "llm", mode: "500", match: ANSWER_MARK });
    await bori.chat("운영표시 오늘 저녁은 국수였어요");
    await bori.waitForReply();
    const failed = (await bori.state()).lastError ?? "";
    await bori.waitForIdle();
    await bori.chat("운영표시 내일은 비빔밥 먹을래요");
    await bori.waitForReply();
    const recovered = (await bori.state()).lastError;
    report.check("LLM 실패는 lastError에 남고 다음 LLM 답에서 지워진다", failed.startsWith("LLM 실패") && recovered === null, `실패=${failed.slice(0, 20)} 뒤=${recovered}`);
    await bori.waitForIdle();
  }

  // ── 음성: 빈·깨진 음성 거절, 음성 길이에 맞춘 말풍선, 방송 음성 상한(O-4) ────────
  {
    const ttsBefore = (await bori.get("/api/tts")).body?.failureCount ?? 0;
    for (const mode of ["empty", "garbage"]) {
      await mock.inject({ target: "tts", mode });
      await bori.chat(`운영표시 음성 ${mode} 확인해요`);
      const reply = await bori.waitForReply();
      report.check(`TTS가 ${mode === "empty" ? "0바이트" : "mp3가 아닌 데이터"}를 주면 음성 없이 글로 나간다(A4-13)`, reply.response?.reply === MOCK_REPLY && reply.audioId === undefined, `audio=${reply.audioId ?? "없음"}`);
      await bori.waitForIdle();
    }
    const tts = (await bori.get("/api/tts")).body;
    report.check("빈·깨진 음성은 TTS 실패로 센다", tts?.failureCount === ttsBefore + 2 && /mp3가 아닙니다/.test(tts?.lastError ?? ""), `failureCount=${tts?.failureCount} lastError=${tts?.lastError}`);

    await mock.inject({ target: "tts", mode: "long", ms: 9000 });
    await bori.chat("운영표시 긴 음성 들려주세요");
    const long = await bori.waitForReply();
    const shownAt = Date.now();
    await bori.waitForIdle(20_000);
    const shownMs = Date.now() - shownAt;
    // 전에는 글자 수로 어림해 이 답(17자)은 5초 만에 내려가 9초 음성이 잘렸다.
    report.check("말풍선을 음성 길이(9초)만큼 둔다(A4-12)", typeof long.audioId === "string" && shownMs >= 9000 && shownMs < 12_000, `${shownMs}ms`);

    // 설정 상한(fixture 12초)보다 방송 상한(6초)이 먼저 걸린다.
    await mock.inject({ target: "tts", mode: "delay", ms: 9000 });
    await bori.chat("운영표시 느린 음성 확인");
    const slow = await bori.waitForReply(20_000);
    report.check("방송 음성은 6초 상한을 넘으면 음성 없이 나간다(A4-18)", slow.response !== null && slow.audioId === undefined && slow.ms < 8500, `${slow.ms}ms audio=${slow.audioId ?? "없음"}`);
    await bori.waitForIdle();
  }

  // ── 음성 캐시 크기 상한(A4-15) ────────────────────────────────────────
  {
    const conversation = (await send("POST", "/api/conversations", { title: "음성 캐시" })).body?.conversation?.id;
    // 한 건 약 4.6MB(300초). 12건이면 55MB라 총 크기 상한(50MB)에 걸린다.
    for (let i = 0; i < 12; i += 1) {
      await mock.inject({ target: "tts", mode: "long", ms: 300_000 });
      await send("POST", `/api/conversations/${encodeURIComponent(conversation)}/messages`, { content: `음성 캐시 ${i}번 노래 이야기`, tts: true });
    }
    const diagnostics = (await bori.get("/api/diagnostics")).body;
    report.check("음성 캐시는 총 50MB를 넘지 않는다", diagnostics?.audioCacheBytes > 0 && diagnostics.audioCacheBytes <= 50 * 1024 * 1024 && diagnostics.audioCacheSize < 12, `${diagnostics?.audioCacheSize}건 ${Math.round((diagnostics?.audioCacheBytes ?? 0) / 1024 / 1024)}MB`);
  }

  // ── 목소리 목록 캐시(A4-08) ───────────────────────────────────────────
  {
    await mock.reset();
    const patched = await send("PATCH", "/api/tts", { provider: "elevenlabs", voice: "mockvoice", elevenLabsApiKey: "mock-el-key", enabled: false });
    for (let i = 0; i < 5; i += 1) await bori.get("/api/tts");
    const voiceCalls = (await mock.calls()).filter(entry => entry.kind === "voices").length;
    report.check("GET /api/tts를 여러 번 불러도 ElevenLabs 목록은 한 번만 묻는다", patched.status === 200 && patched.body?.voices?.[0]?.id === "mockvoice" && voiceCalls === 1, `저장=${patched.status} 목록 요청 ${voiceCalls}건`);
    await send("PATCH", "/api/tts", { provider: "openai", voice: "nova", elevenLabsApiKey: "", enabled: true });
  }

  // ── 큐: 거절 이유 코드, 시청자별 중복, 시청자별 상한, 버려진 채팅 집계(O-2) ─────────
  {
    // 첫 채팅이 답을 기다리는 동안 나머지가 큐에 쌓이도록 대기를 길게 둔다.
    await bori.patchSettings({ ...baseQueueSettings, responseDelayMinSeconds: 70, responseDelayMaxSeconds: 70, maxQueueSize: 20 });
    await bori.startSession();

    const empty = await bori.chat("   ");
    report.check("빈 채팅은 400 empty다", empty.status === 400 && empty.body?.code === "empty", JSON.stringify(empty.body));
    const first = await bori.chat("운영표시 반가워요 여러분", "가");
    const duplicate = await bori.chat("운영표시 반가워요 여러분", "가");
    const otherViewer = await bori.chat("운영표시 반가워요 여러분", "나");
    report.check("같은 시청자의 같은 문장은 400 duplicate다", first.status === 200 && duplicate.status === 400 && duplicate.body?.code === "duplicate", JSON.stringify(duplicate.body));
    report.check("다른 시청자의 같은 인사는 받는다(A4-20)", otherViewer.status === 200);

    // "가"의 첫 채팅이 답을 기다리는 중이다. 큐에는 "나" 1건이 있다.
    for (let i = 0; i < 6; i += 1) await bori.chat(`운영표시 도배 ${i}번 문장을 바꿔 보내요`, "도배");
    await bori.chat("운영표시 저도 한마디 할게요", "다");
    const state = (await bori.get("/api/state")).body;
    const dropped = state?.droppedChats ?? {};
    report.check("한 시청자는 큐에 3건까지만 둔다(A4-05)", state?.queueSize === 5 && dropped.viewerLimit === 3, `queue=${state?.queueSize} viewerLimit=${dropped.viewerLimit}`);
    report.check("버려진 채팅을 이유별로 /api/state에 센다(A4-04)", dropped.duplicate === 1 && dropped.queueLimit === 0 && dropped.expired === 0, JSON.stringify(dropped));

    // ── 큐 만료(A4-03). 60초를 넘긴 채팅은 답하지 않고 버린다. ──
    await sleep(61_000);
    await bori.chat("운영표시 만료 뒤 새 채팅", "라");
    const afterTtl = (await bori.get("/api/state")).body;
    report.check("60초 넘게 기다린 채팅은 만료로 버리고 센다", afterTtl?.queueSize === 1 && afterTtl?.droppedChats?.expired === 5, `queue=${afterTtl?.queueSize} expired=${afterTtl?.droppedChats?.expired}`);
    const diagnostics = (await bori.get("/api/diagnostics")).body;
    report.check("/api/diagnostics에도 버려진 채팅 수와 lastError가 있다", diagnostics?.droppedChats?.expired === 5 && "lastError" in (diagnostics ?? {}));

    await bori.endSession();
    const notLive = await bori.chat("운영표시 방송 끝난 뒤 채팅", "가");
    report.check("방송이 꺼져 있으면 400 not_live다", notLive.status === 400 && notLive.body?.code === "not_live", JSON.stringify(notLive.body));
    await bori.startSession();
    report.check("새 방송을 시작하면 집계를 0으로 돌린다", Object.values((await bori.get("/api/state")).body?.droppedChats ?? { x: 1 }).every(value => value === 0));
    await bori.endSession();
    await bori.patchSettings(baseQueueSettings);
  }
}
