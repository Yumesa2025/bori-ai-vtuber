/**
 * 장시간 운영 검사. 기본 통합 검사(run.mjs)에는 넣지 않는다.
 *
 * 가짜 API에 붙인 보리 서버로 방송을 켜 두고, 일정 간격 방송 채팅과 주기적 1:1 메시지를 보내면서
 * 1분마다 서버 RSS·heap, 큐 길이, 응답 지연 p50/p95, 오류 수, 데이터 파일 크기를 기록한다.
 * 끝에 처음과 끝을 비교해 증가 추세를 판정한다.
 *
 *   npm run test:soak                    기본 2분
 *   npm run test:soak -- --minutes 30    30분
 *   npm run test:soak -- --minutes 30 --out soak.json   분 단위 기록을 JSON으로도 남긴다
 *
 * 포트는 MOCK_PORT(기본 4522), BORI_TEST_PORT(기본 4523)로 바꾼다. 실제 data/는 건드리지 않는다.
 * 가짜 API 기준이다. 실제 LLM·TTS의 지연과 오류, 방송 화면·Live2D의 장시간 동작은 이 검사로 알 수 없다.
 */
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  baseQueueSettings,
  createBoriClient,
  createMockClient,
  prepareDataDir,
  startScript,
  stopAll,
  toolsTestDir,
  waitForHttp,
} from "./harness.mjs";

const { values: args } = parseArgs({
  options: {
    minutes: { type: "string", default: "2" },
    "chat-interval": { type: "string", default: "8" },
    "companion-interval": { type: "string", default: "20" },
    out: { type: "string" },
  },
});
const minutes = Math.max(1, Number(args.minutes));
const chatIntervalMs = Number(args["chat-interval"]) * 1000;
const companionIntervalMs = Number(args["companion-interval"]) * 1000;
if (![minutes, chatIntervalMs, companionIntervalMs].every(value => Number.isFinite(value) && value > 0)) {
  console.error("--minutes, --chat-interval, --companion-interval은 0보다 큰 숫자여야 합니다.");
  process.exit(1);
}

const mockPort = Number(process.env.MOCK_PORT ?? 4522);
const boriPort = Number(process.env.BORI_TEST_PORT ?? 4523);
const mockUrl = `http://127.0.0.1:${mockPort}`;
const boriUrl = `http://127.0.0.1:${boriPort}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mb = bytes => (bytes / 1024 / 1024).toFixed(1);
const kb = bytes => (bytes / 1024).toFixed(1);

/** 정렬한 값에서 백분위를 고른다. 값이 없으면 null이다. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** 최소제곱 기울기(분당 변화량). 표본이 둘보다 적으면 0이다. */
function slopePerMinute(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  const numerator = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denominator = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

async function dataFileSizes(dir) {
  const sizes = {};
  for (const name of await readdir(dir)) sizes[name] = (await stat(join(dir, name))).size;
  return sizes;
}

const mockServer = startScript(join(toolsTestDir, "mock-openai.mjs"), { env: { MOCK_PORT: String(mockPort) }, label: "mock-openai" });
const data = await prepareDataDir();
let boriServer;
let exitCode = 0;

try {
  await waitForHttp(`${mockUrl}/__calls`, { describe: "가짜 API 서버" });
  const mock = createMockClient(mockUrl);
  // 실제 API보다 약간 느린 쪽으로 둔다.
  await mock.setTiming({ llm: 600, tts: 300, embed: 100 });

  boriServer = startScript("apps/server/src/index.ts", {
    loadTypeScript: true,
    label: "bori-server",
    env: {
      BORI_SERVER_PORT: String(boriPort),
      BORI_DATA_DIR: data.path,
      BORI_OPENAI_BASE_URL: `${mockUrl}/v1`,
      OPENAI_API_KEY: "mock-key",
    },
  });
  await waitForHttp(`${boriUrl}/api/health`, { describe: "보리 서버" });
  const bori = createBoriClient(boriUrl);
  const diagnostics = async () => (await bori.get("/api/diagnostics")).body;

  await bori.patchSettings({
    ...baseQueueSettings,
    responseDelayMinSeconds: 1,
    responseDelayMaxSeconds: 2,
    duplicateWindowMinutes: 5,
    monologueEnabled: true,
    monologueMinSeconds: 20,
    monologueMaxSeconds: 40,
  });
  await bori.startSession();
  const conversation = (await fetch(`${boriUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "장시간 검사" }),
  }).then(response => response.json())).conversation;

  console.log(`장시간 검사 ${minutes}분 — 방송 채팅 ${chatIntervalMs / 1000}초 간격, 1:1 메시지 ${companionIntervalMs / 1000}초 간격`);
  console.log(`데이터 디렉터리: ${data.path}`);

  const startedAt = Date.now();
  const endAt = startedAt + minutes * 60_000;
  /** 방송 채팅을 보낸 시각. 질문·규칙 문장이 없는 채팅만 보내므로 들어온 순서대로 답한다. */
  const pending = [];
  /** 이번 분의 측정값. 1분마다 기록하고 비운다. */
  let window = { broadcast: [], companion: [], chatErrors: 0, companionErrors: 0, requestErrors: 0, chats: 0, companionMessages: 0, monologues: 0 };
  const all = { broadcast: [], companion: [], chatErrors: 0, companionErrors: 0, requestErrors: 0, chats: 0, companionMessages: 0, monologues: 0 };
  const samples = [];
  let running = true;
  /** 답변 감시는 보내기를 멈춘 뒤에도 남은 답변을 세야 하므로 따로 끈다. */
  let watching = true;

  // 방송 채팅. 규칙·질문에 걸리지 않는 문장이라 모두 LLM으로 가고 들어온 순서대로 답한다.
  const chatLoop = (async () => {
    let n = 0;
    while (running && Date.now() < endAt) {
      n += 1;
      try {
        const sentAt = Date.now();
        const result = await bori.chat(`장시간 ${n}번째 채팅 저녁 메뉴 이야기`, `soak${n % 7}`);
        if (result.status === 200) { pending.push(sentAt); window.chats += 1; all.chats += 1; }
        else { window.chatErrors += 1; all.chatErrors += 1; }
      } catch {
        window.requestErrors += 1; all.requestErrors += 1;
      }
      // 간격을 조금씩 흔든다. 일정한 박자만 보면 겹치는 경우를 놓친다.
      await sleep(chatIntervalMs * (0.6 + Math.random() * 0.8));
    }
  })();

  // 1:1 메시지. 한 대화에서 차례로 보낸다.
  const companionLoop = (async () => {
    let n = 0;
    while (running && Date.now() < endAt && conversation) {
      n += 1;
      const sentAt = Date.now();
      try {
        const response = await fetch(`${boriUrl}/api/conversations/${encodeURIComponent(conversation.id)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `장시간 1:1 ${n}번째 메시지 오늘 있었던 일` }),
        });
        await response.json().catch(() => null);
        if (response.status === 200) { window.companion.push(Date.now() - sentAt); all.companion.push(Date.now() - sentAt); window.companionMessages += 1; all.companionMessages += 1; }
        else { window.companionErrors += 1; all.companionErrors += 1; }
      } catch {
        window.requestErrors += 1; all.requestErrors += 1;
      }
      await sleep(companionIntervalMs);
    }
  })();

  // 방송 답변 감시. 말풍선이 새로 뜰 때마다 가장 오래 기다린 채팅의 지연으로 센다.
  const watchLoop = (async () => {
    let showing = false;
    while (watching) {
      try {
        const state = await bori.state();
        const response = state?.currentResponse;
        if (response && !showing) {
          if (response.source === "monologue") { window.monologues += 1; all.monologues += 1; }
          else if (pending.length > 0) {
            const latency = Date.now() - pending.shift();
            window.broadcast.push(latency);
            all.broadcast.push(latency);
          }
        }
        showing = Boolean(response);
      } catch {
        window.requestErrors += 1; all.requestErrors += 1;
      }
      await sleep(100);
    }
  })();

  // 1분마다 기록한다.
  let minute = 0;
  const record = async () => {
    const diag = await diagnostics();
    const files = await dataFileSizes(data.path);
    const sample = {
      minute,
      rss: diag.memory.rss,
      heapUsed: diag.memory.heapUsed,
      queueSize: diag.queueSize,
      sessionTurns: diag.sessionTurns,
      audioCacheSize: diag.audioCacheSize,
      broadcastP50: percentile(window.broadcast, 50),
      broadcastP95: percentile(window.broadcast, 95),
      companionP50: percentile(window.companion, 50),
      companionP95: percentile(window.companion, 95),
      chats: window.chats,
      answered: window.broadcast.length,
      monologues: window.monologues,
      companionMessages: window.companionMessages,
      errors: window.chatErrors + window.companionErrors + window.requestErrors,
      dataBytes: Object.values(files).reduce((sum, size) => sum + size, 0),
      files,
    };
    samples.push(sample);
    console.log(
      `[${String(minute).padStart(2)}분] RSS ${mb(sample.rss)}MB heap ${mb(sample.heapUsed)}MB 큐 ${sample.queueSize} ` +
      `방송 p50/p95 ${sample.broadcastP50 ?? "-"}/${sample.broadcastP95 ?? "-"}ms (채팅 ${sample.chats}, 답변 ${sample.answered}, 혼잣말 ${sample.monologues}) ` +
      `1:1 p50/p95 ${sample.companionP50 ?? "-"}/${sample.companionP95 ?? "-"}ms (${sample.companionMessages}건) ` +
      `오류 ${sample.errors} 데이터 ${kb(sample.dataBytes)}KB 세션 발언 ${sample.sessionTurns}`,
    );
    window = { broadcast: [], companion: [], chatErrors: 0, companionErrors: 0, requestErrors: 0, chats: 0, companionMessages: 0, monologues: 0 };
    // 가짜 API의 요청 기록은 서버와 상관없이 계속 쌓이므로 비운다.
    await mock.reset();
  };

  await record();
  while (Date.now() < endAt) {
    const nextAt = startedAt + (minute + 1) * 60_000;
    await sleep(Math.max(0, Math.min(nextAt, endAt) - Date.now()));
    minute += 1;
    await record();
  }

  running = false;
  await Promise.all([chatLoop, companionLoop]);
  // 남은 답변이 나올 시간을 조금 준 뒤 방송을 끝낸다. 종료 시 기억 저장도 돈다.
  await sleep(8000);
  watching = false;
  await watchLoop;
  await bori.endSession();
  await sleep(3000);
  const finalDiag = await diagnostics();
  const finalFiles = await dataFileSizes(data.path);
  const lateErrors = (await bori.state()).lastError;

  // ── 요약 ──────────────────────────────────────────────────
  // 첫 표본은 기동 직후라 비교에서 뺀다. 나머지를 앞·뒤 3분의 1로 나눠 평균을 비교한다.
  const steady = samples.slice(1);
  const third = Math.max(1, Math.floor(steady.length / 3));
  const avg = (list, key) => list.reduce((sum, sample) => sum + sample[key], 0) / list.length;
  const head = steady.slice(0, third);
  const tail = steady.slice(-third);
  const heapSlope = slopePerMinute(steady.map(sample => [sample.minute, sample.heapUsed]));
  const rssSlope = slopePerMinute(steady.map(sample => [sample.minute, sample.rss]));
  const heapGrowth = steady.length > 0 ? avg(tail, "heapUsed") - avg(head, "heapUsed") : 0;
  const rssGrowth = steady.length > 0 ? avg(tail, "rss") - avg(head, "rss") : 0;
  // 앞쪽 평균보다 20% 넘게, 그리고 10MB 넘게 늘었으면 증가 추세로 본다. GC 시점에 따라 흔들리는 값이라 둘 다 본다.
  const growing = (growth, base) => growth > 10 * 1024 * 1024 && growth > base * 0.2;
  const heapTrend = steady.length >= 3 && growing(heapGrowth, avg(head, "heapUsed"));
  const rssTrend = steady.length >= 3 && growing(rssGrowth, avg(head, "rss"));
  const totalErrors = all.chatErrors + all.companionErrors + all.requestErrors;

  const summary = {
    minutes,
    start: { rss: samples[0].rss, heapUsed: samples[0].heapUsed },
    end: { rss: finalDiag.memory.rss, heapUsed: finalDiag.memory.heapUsed },
    heapSlopeMbPerMinute: Number(mb(heapSlope)),
    rssSlopeMbPerMinute: Number(mb(rssSlope)),
    heapTrend,
    rssTrend,
    broadcast: { chats: all.chats, answered: all.broadcast.length, monologues: all.monologues, p50: percentile(all.broadcast, 50), p95: percentile(all.broadcast, 95), max: all.broadcast.length ? Math.max(...all.broadcast) : null },
    companion: { messages: all.companionMessages, p50: percentile(all.companion, 50), p95: percentile(all.companion, 95), max: all.companion.length ? Math.max(...all.companion) : null },
    errors: { chat: all.chatErrors, companion: all.companionErrors, request: all.requestErrors, total: totalErrors },
    lastError: lateErrors,
    maxQueueSize: Math.max(...samples.map(sample => sample.queueSize)),
    finalQueueSize: finalDiag.queueSize,
    dataFiles: finalFiles,
  };

  console.log("\n── 요약 ─────────────────────────────────────────────");
  console.log(`실행 ${minutes}분, 방송 채팅 ${all.chats}건 / 답변 ${all.broadcast.length}건 / 혼잣말 ${all.monologues}건, 1:1 메시지 ${all.companionMessages}건`);
  console.log(`RSS  시작 ${mb(summary.start.rss)}MB → 끝 ${mb(summary.end.rss)}MB, 기울기 ${summary.rssSlopeMbPerMinute}MB/분 → ${rssTrend ? "증가 추세 의심" : "뚜렷한 증가 없음"}`);
  console.log(`heap 시작 ${mb(summary.start.heapUsed)}MB → 끝 ${mb(summary.end.heapUsed)}MB, 기울기 ${summary.heapSlopeMbPerMinute}MB/분 → ${heapTrend ? "증가 추세 의심" : "뚜렷한 증가 없음"}`);
  console.log(`방송 지연 p50 ${summary.broadcast.p50 ?? "-"}ms, p95 ${summary.broadcast.p95 ?? "-"}ms, 최대 ${summary.broadcast.max ?? "-"}ms (채팅 전송부터 말풍선까지, 답변 대기 1~2초 포함)`);
  console.log(`1:1 지연 p50 ${summary.companion.p50 ?? "-"}ms, p95 ${summary.companion.p95 ?? "-"}ms, 최대 ${summary.companion.max ?? "-"}ms`);
  console.log(`오류 ${totalErrors}건 (방송 채팅 ${all.chatErrors}, 1:1 ${all.companionErrors}, 요청 ${all.requestErrors}), 서버 lastError ${lateErrors ?? "없음"}`);
  console.log(`큐 최대 ${summary.maxQueueSize}, 끝 ${summary.finalQueueSize}`);
  console.log(`데이터 파일: ${Object.entries(finalFiles).map(([name, size]) => `${name} ${kb(size)}KB`).join(", ")}`);

  if (args.out) {
    await writeFile(args.out, JSON.stringify({ summary, samples }, null, 2), "utf8");
    console.log(`기록: ${args.out}`);
  }

  // 오류가 났거나 답을 못 받은 채팅이 많으면 실패로 끝낸다. 증가 추세는 판정만 하고 실패로 보지 않는다.
  if (totalErrors > 0 || all.broadcast.length < all.chats * 0.9) exitCode = 1;
} catch (error) {
  console.error("장시간 검사가 중간에 멈췄습니다:", error);
  if (boriServer) console.log(`\n[서버 출력]\n${boriServer.output().slice(-4000)}`);
  exitCode = 1;
} finally {
  await boriServer?.stop();
  await mockServer.stop();
  await stopAll();
  await data.cleanup();
}

process.exit(exitCode);
