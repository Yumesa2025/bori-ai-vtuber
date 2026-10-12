/**
 * 방송 안정화 검사.
 *
 * 방송 시작·종료와 늦게 도착하는 비동기 결과가 엇갈릴 때, 그리고 LLM·TTS·임베딩이 실패하거나 멈출 때
 * 방송이 멈추지 않고 이전 세션 결과가 새 세션에 섞이지 않는지 본다.
 * 가짜 API의 실패 주입(/__inject)으로 정해진 횟수만큼만 실패시켜, 실패 뒤 다시 정상으로 돌아오는지도 확인한다.
 */
import { baseQueueSettings } from "./harness.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** mock-openai의 정상 답변. 이 문장이 아니면 폴백·규칙 문장이다. */
const MOCK_REPLY = "가짜 답변입니다. 잘 들리시나요.";
/** 방송 답변 요청만 고르는 표시. 누적 요약 요청은 실패 주입에 걸리지 않게 한다. */
const ANSWER_MARK = "[답변할 채팅]";

export const meta = {
  name: "방송 안정화",
  timing: { llm: 300, tts: 200, embed: 100 },
};

export async function run({ bori, mock, report }) {
  const answerCallsFor = async text => (await mock.answerCalls()).filter(entry => entry.user.includes(text));

  // ── 생성 중 종료: 끝난 방송의 답변·음성·오류가 상태에 남지 않는다 ─────────
  {
    await bori.patchSettings(baseQueueSettings);
    await bori.startSession();
    await mock.setTiming({ llm: 1500, tts: 200, embed: 100 });
    await mock.reset();

    await bori.chat("종료경합표시 점심 메뉴 고민 중이에요");
    await sleep(400);
    const endedAt = Date.now();
    await bori.endSession();
    // 대기 1초와 생성 1.5초가 모두 끝날 만큼 기다린다.
    await sleep(2500);

    const state = await bori.state();
    report.check(
      "생성 중에 방송을 끝내면 늦게 온 답변이 상태에 올라오지 않는다",
      state.status === "ended" && state.currentResponse === undefined && state.currentAudioId === undefined,
      `status=${state.status} response=${state.currentResponse?.reply ?? "-"}`,
    );
    const lateTts = (await mock.calls()).filter(entry => entry.kind === "tts" && entry.at >= endedAt);
    report.check("끝난 방송의 답변으로 음성을 만들지 않는다", lateTts.length === 0, `종료 뒤 음성 요청 ${lateTts.length}건`);

    // 종료 뒤에 실패로 끝나는 답변. 끝난 방송의 오류가 관리자 화면에 새로 뜨면 안 된다.
    await bori.patchLlm({ timeoutMs: 800 });
    await bori.startSession();
    await bori.patchSettings({ ...baseQueueSettings });
    const before = (await bori.state()).lastError;
    await mock.inject({ target: "llm", mode: "delay", ms: 2000, match: ANSWER_MARK });
    await bori.chat("종료경합표시 저녁에는 산책을 가요");
    await sleep(300);
    await bori.endSession();
    await sleep(2000);
    const after = (await bori.state()).lastError;
    report.check("끝난 방송의 LLM 실패가 lastError를 바꾸지 않는다", after === before, `전=${before ?? "null"} 후=${after ?? "null"}`);
    await bori.patchLlm({ timeoutMs: 8000 });
    await mock.clearInjections();
  }

  // ── 종료 직후 재시작: 이전 세션의 늦은 답변이 새 세션에 섞이지 않는다 ─────
  {
    await mock.setTiming({ llm: 1500, tts: 200, embed: 100 });
    await bori.startSession();
    await bori.chat("이전세션표시 저녁은 뭐 먹을지 생각 중");
    await sleep(400);
    await bori.endSession();
    await bori.startSession();

    // 이전 세션 답변이 도착할 시간 동안 새 세션 상태를 지켜본다.
    let leaked = false;
    const watchUntil = Date.now() + 2500;
    while (Date.now() < watchUntil) {
      if ((await bori.state()).currentResponse) leaked = true;
      await sleep(50);
    }
    report.check("재시작한 방송에 이전 세션의 늦은 답변이 올라오지 않는다", !leaked);

    await mock.setTiming({ llm: 300, tts: 200, embed: 100 });
    await bori.chat("새세션표시 저녁에 책을 읽었어요");
    const reply = await bori.waitForReply();
    const prompt = (await answerCallsFor("새세션표시")).at(-1)?.user ?? "";
    report.check("새 세션의 첫 답변이 정상으로 나온다", reply.response?.reply === MOCK_REPLY, reply.response?.reply ?? "없음");
    report.check("새 세션 LLM 요청의 최근 대화에 이전 세션 채팅이 없다", prompt.length > 0 && !prompt.includes("이전세션표시"));
    await bori.waitForIdle();
    await bori.endSession();
  }

  // ── 이전 세션 혼잣말이 늦게 끝나도 새 세션의 발화권을 풀지 않는다 ─────────
  // 혼잣말 음성이 만들어지는 사이 방송을 다시 시작하고, 새 세션이 답변을 만드는 중에 그 음성이 도착하게 한다.
  {
    // 이전 혼잣말 음성은 시작 뒤 약 4초에, 첫 답변(LLM 1.5초 + 음성 3초)은 약 6초에 끝난다. 그 사이가 경합 구간이다.
    await mock.setTiming({ llm: 1500, tts: 3000, embed: 100 });
    await bori.patchSettings({ ...baseQueueSettings, monologueEnabled: true, monologueMinSeconds: 1, monologueMaxSeconds: 1 });
    const startedAt = Date.now();
    await bori.startSession();
    await sleep(1300);
    // 혼잣말은 이미 음성을 기다리는 중이다. 새 세션에서는 혼잣말을 끈다.
    await bori.patchSettings({ monologueEnabled: false });
    await bori.endSession();
    await bori.startSession();
    await mock.reset();
    await bori.chat("혼잣말경합 하나 오늘 책을 읽었어요");

    await sleep(Math.max(0, startedAt + 4600 - Date.now()));
    await bori.chat("혼잣말경합 둘 커피 한잔 하고 있어요");
    await sleep(500);
    const second = await answerCallsFor("혼잣말경합 둘");
    report.check("이전 세션 혼잣말이 끝나도 새 세션 답변이 겹쳐 시작되지 않는다", second.length === 0, `둘째 채팅 LLM 요청 ${second.length}건(0이어야 함)`);

    await bori.endSession();
    await mock.setTiming({ llm: 300, tts: 200, embed: 100 });
    await bori.patchSettings(baseQueueSettings);
  }

  // ── 빠른 시작·종료 반복과 종료 중 채팅 ─────────────────────────────
  {
    let rejected = 0;
    for (let i = 0; i < 15; i += 1) {
      await bori.startSession();
      await bori.chat(`반복표시 ${i} 오늘 저녁은 국수`);
      await sleep(i * 10);
      await bori.endSession();
      if ((await bori.chat(`반복표시 종료 중 ${i} 채팅`)).status === 400) rejected += 1;
    }
    report.check("방송이 끝난 동안 들어온 채팅은 받지 않는다", rejected === 15, `거절 ${rejected}/15`);

    await bori.startSession();
    await sleep(1800);
    const settled = await bori.state();
    report.check(
      "반복 뒤 새 방송에 이전 답변·큐가 남지 않는다",
      settled.currentResponse === undefined && settled.queueSize === 0 && settled.visibleChats.length === 0,
      `queue=${settled.queueSize} response=${settled.currentResponse?.reply ?? "-"}`,
    );

    await mock.reset();
    await bori.chat("반복끝표시 이제 진짜 시작해요");
    const reply = await bori.waitForReply();
    const prompt = (await answerCallsFor("반복끝표시")).at(-1)?.user ?? "";
    report.check("반복 뒤에도 답변이 정상으로 나온다", reply.response?.reply === MOCK_REPLY, reply.response?.reply ?? "없음");
    report.check("반복 뒤 LLM 요청에 이전 세션 채팅이 없다", prompt.length > 0 && !prompt.includes("반복표시"));
    await bori.waitForIdle();
  }

  // ── 임베딩이 응답하지 않아도 큐가 멈추지 않는다 ─────────────────────
  {
    await mock.reset();
    await mock.inject({ target: "embed", mode: "delay", ms: 60_000 });
    const startedAt = Date.now();
    // 기억을 묻는 채팅은 규칙을 건너뛰고 기억 검색을 거쳐 LLM으로 간다.
    await bori.chat("임베딩지연표시 지난번 얘기 기억하시나요");
    const reply = await bori.waitForReply(15_000);
    report.check("기억 검색이 멈춰도 정해진 시간 안에 답변이 나온다", reply.response !== null, reply.response ? `${Date.now() - startedAt}ms` : "15초 안에 답변 없음");
    await bori.waitForIdle();

    await bori.chat("임베딩지연표시 다음 채팅도 받아 주세요");
    const next = await bori.waitForReply(15_000);
    report.check("그다음 채팅도 정상으로 처리된다", next.response !== null);
    await bori.waitForIdle();
    await mock.clearInjections();
  }

  // ── TTS 실패 뒤 텍스트로 진행하고 다음 호출에서 복구된다 ──────────────
  {
    await mock.inject({ target: "tts", mode: "500" });
    await bori.chat("음성실패표시 오늘 바람이 시원해요");
    const failed = await bori.waitForReply();
    report.check("TTS가 실패해도 답변은 텍스트로 나온다", failed.response?.reply === MOCK_REPLY && failed.audioId === undefined, `audio=${failed.audioId ?? "없음"}`);
    await bori.waitForIdle();

    await bori.chat("음성실패표시 이제 소리 들리나요");
    const recovered = await bori.waitForReply();
    report.check("다음 답변에서 음성이 다시 붙는다", typeof recovered.audioId === "string", `audio=${recovered.audioId ?? "없음"}`);
    await bori.waitForIdle();
    const tts = (await bori.get("/api/tts")).body;
    report.check("TTS 실패가 관리자 상태에 남는다", tts?.failureCount >= 1, `failureCount=${tts?.failureCount}`);
  }

  // ── LLM 오류 뒤 폴백으로 진행하고 회로가 열렸다가 다시 닫힌다 ──────────
  {
    // 쿨다운은 말풍선 표시(5초)보다 길게 둔다. 답변이 내려간 뒤에도 회로가 열려 있어야 확인할 수 있다.
    const cooldownMs = 8000;
    await bori.patchLlm({ failureThreshold: 2, cooldownSeconds: cooldownMs / 1000, timeoutMs: 1000 });
    const ask = async content => {
      await bori.chat(content);
      const result = await bori.waitForReply();
      await bori.waitForIdle();
      return result.response?.reply ?? null;
    };

    await mock.inject({ target: "llm", mode: "500", match: ANSWER_MARK });
    const on500 = await ask("복구표시 하나 비가 오네요");
    report.check("LLM 500 뒤 폴백 문장으로 진행한다", on500 !== null && on500 !== MOCK_REPLY, on500 ?? "없음");
    report.check("LLM 실패가 lastError에 남는다", ((await bori.state()).lastError ?? "").startsWith("LLM 실패"));

    const ok = await ask("복구표시 둘 우산 챙겼어요");
    report.check("한 번 실패 뒤 다음 답변은 LLM이 한다", ok === MOCK_REPLY, ok ?? "없음");

    await mock.inject({ target: "llm", mode: "badjson", match: ANSWER_MARK });
    const onBadJson = await ask("복구표시 셋 창밖이 흐려요");
    report.check("깨진 JSON 뒤 폴백 문장으로 진행한다", onBadJson !== null && onBadJson !== MOCK_REPLY, onBadJson ?? "없음");

    await mock.inject({ target: "llm", mode: "delay", ms: 2500, match: ANSWER_MARK });
    const onTimeout = await ask("복구표시 넷 오늘 좀 피곤해요");
    const openedAt = Date.now();
    report.check("LLM 타임아웃 뒤 폴백 문장으로 진행한다", onTimeout !== null && onTimeout !== MOCK_REPLY, onTimeout ?? "없음");
    report.check("연속 실패 2번이면 방송 회로가 열린다", (await bori.llm()).status.circuitOpen === true);

    const callsBefore = (await mock.answerCalls()).length;
    const whileOpen = await ask("복구표시 다섯 회로 열린 동안");
    report.check("회로가 열린 동안은 LLM을 부르지 않고 답한다", whileOpen !== null && (await mock.answerCalls()).length === callsBefore);

    await sleep(Math.max(0, openedAt + cooldownMs - Date.now()));
    const afterCooldown = await ask("복구표시 여섯 이제 괜찮나요");
    const status = (await bori.llm()).status;
    report.check("쿨다운이 지나면 다시 LLM을 불러 복구된다", afterCooldown === MOCK_REPLY && !status.circuitOpen && status.consecutiveFailures === 0, `${afterCooldown ?? "없음"} / consecutive=${status.consecutiveFailures}`);

    // 다시 연다. 쿨다운 뒤 첫 시도가 실패하면 바로 다시 열려야 한다(반열림 재시도).
    await mock.inject({ target: "llm", mode: "500", count: 2, match: ANSWER_MARK });
    await ask("복구표시 일곱 다시 실패");
    await ask("복구표시 여덟 또 실패");
    await sleep(cooldownMs - 4000);
    report.check("쿨다운이 지나면 회로가 닫힌 상태로 보인다", (await bori.llm()).status.circuitOpen === false);
    await mock.inject({ target: "llm", mode: "500", match: ANSWER_MARK });
    await ask("복구표시 아홉 시험 호출");
    report.check("쿨다운 뒤 첫 시도가 실패하면 바로 다시 열린다", (await bori.llm()).status.circuitOpen === true);

    await bori.patchLlm({ failureThreshold: 3, cooldownSeconds: 60, timeoutMs: 8000 });
    await mock.clearInjections();
  }

  // ── 큐 상한 ────────────────────────────────────────────────────
  {
    await bori.endSession();
    // 첫 채팅이 답변을 기다리는 동안 나머지가 큐에 쌓이도록 대기를 길게 둔다.
    await bori.patchSettings({ ...baseQueueSettings, responseDelayMinSeconds: 20, responseDelayMaxSeconds: 20, maxQueueSize: 3 });
    await bori.startSession();
    for (let i = 0; i < 6; i += 1) await bori.chat(`큐상한표시 ${i} 채팅`);
    report.check("큐가 maxQueueSize를 넘지 않는다", (await bori.state()).queueSize === 3, `queue=${(await bori.state()).queueSize}`);

    await bori.patchSettings({ maxQueueSize: 2 });
    await bori.chat("큐상한표시 줄인 뒤 채팅");
    report.check("상한을 줄이면 다음 채팅부터 줄인 상한에 맞춘다", (await bori.state()).queueSize === 2, `queue=${(await bori.state()).queueSize}`);
    await bori.endSession();
    await bori.patchSettings(baseQueueSettings);
  }

  // ── 진단 엔드포인트 ─────────────────────────────────────────────
  {
    const diagnostics = await bori.get("/api/diagnostics");
    const body = diagnostics.body ?? {};
    report.check(
      "GET /api/diagnostics가 메모리·큐 상태를 준다",
      diagnostics.status === 200 && body.memory?.rss > 0 && body.memory?.heapUsed > 0 && typeof body.queueSize === "number" && typeof body.speaking === "boolean",
      `status=${diagnostics.status}`,
    );
    report.check("진단 응답에 키가 없다", !JSON.stringify(body).includes("mock-key"));
  }
}

