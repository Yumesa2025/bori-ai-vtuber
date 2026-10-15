/**
 * 방송 진행기 통합 검사(W4, ADR-026).
 *
 * mock LLM + 가짜 OBS(4842) + 가짜 치지직(4844) + 가짜 ER(4846)에 실제 보리 서버를 붙여 5단계 방송 한 판을 돌린다.
 * 1. 치지직 로그인(state 검사) → 콜백 → 채팅 연결, OBS 자동 연결
 * 2. next×5로 장면이 대기→메인→메인→메인→전적→엔딩 순서로 바뀌고 단계마다 보리가 말한다
 * 3. 치지직 채팅 "재키 어때?" → 대시보드 character, LLM 요청에 [게임 데이터]와 "8.1%"
 * 4. "!전적 테스트닉" → 대시보드 player ready, 화면 상태에 원래 닉네임 없이 가린 닉네임만
 * 5. OBS를 꺼도 진행된다
 * 6. /api/er/refresh가 가짜 ER로 집계해 파일을 쓴다
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseQueueSettings } from "./harness.mjs";
import { startFakeChzzk, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "./fixtures/fake-chzzk.mjs";
import { PLAYER_NICKNAME, startFakeEr } from "./fixtures/fake-er.mjs";
import { startFakeObs } from "./fixtures/fake-obs.mjs";

const OBS_PORT = Number(process.env.FAKE_OBS_PORT ?? 4842);
const CHZZK_PORT = Number(process.env.FAKE_CHZZK_PORT ?? 4844);
const ER_PORT = Number(process.env.FAKE_ER_PORT ?? 4846);
const OBS_PASSWORD = "fake-obs-password";
const CHZZK_NICKNAME = "치지직시청자";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const meta = {
  name: "방송 진행기",
  timing: { llm: 100, tts: 50, embed: 20 },
};

/** 화면에 보일 집계. 재키를 픽 수 1위로 두고 픽률 8.1%로 맞춘다. 시즌은 가짜 ER과 같은 41(API Season21, 게임 표기 시즌 12)이다. */
function seedMeta() {
  const stat = (code, name, picks, pickRate, avgRank, top1Rate, mainWeapon) => ({ code, name, picks, pickRate, avgRank, top1Rate, mainWeapon });
  return {
    stats: [
      stat(1, "재키", 583, 0.081, 3.4, 0.12, "쌍검"),
      stat(2, "아야", 500, 0.069, 3.1, 0.15, "권총"),
      stat(3, "피오라", 420, 0.058, 4.2, 0.08, "레이피어"),
      stat(11, "유키", 380, 0.053, 3.9, 0.1, "양손검"),
      stat(33, "니키", 300, 0.042, 4.4, 0.07, "글러브"),
      stat(10, "리 다이린", 200, 0.028, 4.8, 0.05, "글러브"),
    ],
    basis: { seasonName: "시즌 12", sampleGames: 7200, collectedAt: new Date().toISOString(), description: "최근 상위 랭커 7,200판 기준" },
    // 게임 시즌 번호로 쓴 파일이라는 표시. 없으면 서버가 예전 API 번호로 보고 9를 뺀다.
    seasonLabel: "official",
  };
}

const seedDictionary = {
  characters: [
    { code: 1, name: "재키", weapons: ["단검", "양손검", "도끼", "쌍검"] },
    { code: 2, name: "아야", weapons: ["권총", "돌격 소총", "저격총"] },
    { code: 3, name: "피오라", weapons: ["양손검", "레이피어", "창"] },
    { code: 10, name: "리 다이린", weapons: ["글러브"] },
    { code: 11, name: "유키", weapons: ["양손검"] },
    { code: 33, name: "니키", weapons: ["글러브"] },
    { code: 46, name: "얀", weapons: ["글러브"] },
  ],
  weaponNames: {},
  seasonId: 41,
  seasonName: "시즌 12",
  seasonLabel: "official",
};

/** 가짜 외부 서비스를 띄우고 사전·메타 파일을 미리 둔다. 서버는 이 env로 뜬다. */
export async function prepare({ dataDir }) {
  await writeFile(join(dataDir, "er-dictionary.json"), JSON.stringify(seedDictionary));
  await writeFile(join(dataDir, "er-meta.json"), JSON.stringify(seedMeta()));
  const obs = await startFakeObs({ port: OBS_PORT, password: OBS_PASSWORD });
  const chzzk = await startFakeChzzk({ port: CHZZK_PORT });
  const er = await startFakeEr({ port: ER_PORT });
  return {
    obs,
    chzzk,
    er,
    env: {
      OBS_WEBSOCKET_URL: `ws://127.0.0.1:${OBS_PORT}`,
      OBS_WEBSOCKET_PASSWORD: OBS_PASSWORD,
      CHZZK_CLIENT_ID: FAKE_CLIENT_ID,
      CHZZK_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      BORI_CHZZK_BASE_URL: `http://127.0.0.1:${CHZZK_PORT}`,
      ER_API_KEY: "fake-er-key",
      BORI_ER_BASE_URL: `http://127.0.0.1:${ER_PORT}`,
      BORI_ER_RANKERS: "2",
      BORI_ER_GAMES_PER_RANKER: "2",
    },
    async cleanup() {
      await Promise.allSettled([obs.close(), chzzk.close(), er.close()]);
    },
  };
}

export async function run({ bori, mock, report, dataDir, prepared }) {
  const { obs, chzzk } = prepared;
  const post = path => fetch(`${bori.baseUrl}${path}`, { method: "POST" }).then(response => response.json());
  const show = async () => (await bori.state()).show;
  async function waitUntil(check, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await sleep(50);
    }
    return null;
  }
  /** 진행 대사(채팅 없이 지시로 만든 답) 요청. */
  const directiveCalls = async () => (await mock.calls()).filter(entry => entry.kind === "llm" && entry.system.includes("[방송 단계]"));
  /** 다음 단계로 가고 그 단계 대사가 화면에 올라올 때까지 기다린다. 진행 잠금은 대사가 화면에 오르면 풀린다. */
  async function nextAndSpeak() {
    const before = (await directiveCalls()).length;
    // 가짜 LLM 답은 늘 같은 문장이라 음성 id가 바뀌는 것으로 새 대사가 올라왔는지 본다.
    const previousAudio = (await bori.state()).currentAudioId;
    const moved = await post("/api/show/next");
    const spoke = await waitUntil(async () => {
      if ((await directiveCalls()).length <= before) return false;
      const state = await bori.state();
      return Boolean(state.currentResponse && state.currentAudioId && state.currentAudioId !== previousAudio);
    });
    return { moved, spoke };
  }

  await bori.patchSettings(baseQueueSettings);

  // ── 연결: OBS 자동 연결, 치지직 로그인 ───────────────────────────
  {
    const obsReady = await waitUntil(async () => (await bori.get("/api/obs/status")).body?.state === "connected");
    report.check("OBS 비밀번호가 있으면 시작 때 OBS에 연결한다", Boolean(obsReady));
    const initial = await show();
    report.check("처음 진행 상태는 idle·대기 장면·ER ready다", initial?.stage === "idle" && initial?.scene === "보리-대기" && initial?.connections?.er === "ready",
      JSON.stringify({ stage: initial?.stage, scene: initial?.scene, connections: initial?.connections }));

    const login = await fetch(`${bori.baseUrl}/api/chzzk/login`, { redirect: "manual" });
    const location = login.headers.get("location") ?? "";
    const state = new URL(location || "http://invalid").searchParams.get("state") ?? "";
    report.check("/api/chzzk/login은 치지직 인증 페이지로 302 한다", login.status === 302 && location.startsWith("https://chzzk.naver.com/account-interlock") && state.length > 0, `status=${login.status}`);

    const wrong = await fetch(`${bori.baseUrl}/api/chzzk/callback?code=${chzzk.issueCode()}&state=wrong-state`);
    const wrongBody = await wrong.text();
    report.check("state가 맞지 않는 콜백은 400이고 토큰을 교환하지 않는다", wrong.status === 400 && !wrongBody.includes("wrong-state"), `status=${wrong.status}`);

    const code = chzzk.issueCode();
    const callback = await fetch(`${bori.baseUrl}/api/chzzk/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    const callbackBody = await callback.text();
    report.check("맞는 콜백은 연결 완료 화면이고 코드·state를 보이지 않는다",
      callback.status === 200 && callbackBody.includes("연결했습니다") && !callbackBody.includes(code) && !callbackBody.includes(state), `status=${callback.status}`);
    const connected = await waitUntil(async () => (await bori.get("/api/chzzk/status")).body?.state === "connected");
    report.check("콜백 뒤 치지직 채팅에 연결한다", Boolean(connected));
    const tokenFile = await readFile(join(dataDir, "chzzk-token.json"), "utf8").catch(() => "");
    report.check("치지직 토큰 파일은 암호화되어 있다", tokenFile.length > 0 && !tokenFile.includes("fake-access-") && !tokenFile.includes("fake-refresh-"));
  }

  // ── 방송 켜기: 대기 장면에서 대기 영상과 배경음악을 처음부터 튼다 ──────────────
  {
    const before = obs.requests.length;
    const onAir = await post("/api/show/on-air");
    const media = obs.requests.slice(before).filter(entry => entry.requestType === "TriggerMediaInputAction");
    report.check("방송 켜기는 대기 영상과 배경음악을 처음부터 튼다", onAir.onAir === true && onAir.stage === "idle"
      && media.some(entry => entry.inputName === "보리 배경음악" && entry.mediaAction.endsWith("RESTART"))
      && media.some(entry => entry.inputName === "보리 대기 영상" && entry.mediaAction.endsWith("RESTART")), JSON.stringify(media));
    report.check("방송 켜기 뒤에도 장면은 보리-대기다", obs.currentScene() === "보리-대기");
  }

  // ── next×5: 장면 순서와 단계 대사 ────────────────────────────────
  {
    const scenes = [obs.currentScene()];
    const stages = [];
    for (let i = 0; i < 4; i += 1) {
      const { moved, spoke } = await nextAndSpeak();
      stages.push(moved.stage);
      report.check(`${moved.stage} 단계에 들어가면 보리가 그 단계 대사를 말한다`, Boolean(spoke));
      scenes.push(obs.currentScene());
      if (moved.stage === "opening") {
        const state = await bori.state();
        report.check("idle에서 next하면 방송 세션을 연다", state.status === "live");
        report.check("자막은 보리의 지금 답과 같다", state.show.caption === state.currentResponse?.reply && state.show.caption.length > 0);
      }
      if (moved.stage === "briefing") {
        const call = (await directiveCalls()).at(-1);
        report.check("briefing 대사 요청에 TOP 5 게임 데이터가 들어간다", Boolean(call?.user.includes("[게임 데이터]") && call.user.includes("1위: 재키") && call.user.includes("8.1%")));
        const revealed = await waitUntil(async () => { const view = (await show()).dashboard; return view.kind === "top5" && view.revealed === 5; }, 15_000);
        report.check("briefing 대사 뒤 TOP 5가 5까지 열린다", Boolean(revealed));
      }
      if (moved.stage === "diagnosis") {
        report.check("diagnosis 대시보드는 전적 대기 카드다", JSON.stringify((await show()).dashboard) === JSON.stringify({ kind: "player", status: "waiting", report: null }));
      }
    }
    // 전적 진단을 떠날 때 마무리 인사를 한 번 하고 엔딩으로 간다. 엔딩에서는 보리가 말하지 않는다(사용자 결정 2026-10-15).
    await bori.waitForIdle();
    const outroAt = (await directiveCalls()).length;
    await post("/api/show/next");
    const reachedEnding = await waitUntil(async () => (await show()).stage === "ending", 30_000);
    stages.push((await show()).stage);
    await waitUntil(async () => obs.currentScene() === "보리-엔딩", 5000);
    scenes.push(obs.currentScene());
    const outros = (await directiveCalls()).slice(outroAt);
    report.check("전적 진단을 떠날 때 마무리 인사를 한 번 하고 엔딩으로 간다", Boolean(reachedEnding) && outros.length === 1 && outros[0].system.includes("오늘 방송을 마무리한다"), `directives=${outros.length}`);
    const directivesBefore = (await directiveCalls()).length;
    const endingChat = await bori.chat("엔딩에서도 대답해 줘?");
    await new Promise(resolve => setTimeout(resolve, 4000));
    const endingAnswers = (await mock.answerCalls()).filter(entry => entry.user.includes("엔딩에서도 대답해 줘?"));
    report.check("ending에 들어가도 단계 대사를 만들지 않는다", (await directiveCalls()).length === directivesBefore);
    report.check("ending에서 들어온 채팅에 보리가 답하지 않는다", endingChat.status === 200 && endingAnswers.length === 0, `status=${endingChat.status} answers=${endingAnswers.length}`);

    report.check("next×5 단계 순서는 opening→briefing→qna→diagnosis→ending이다", stages.join(",") === "opening,briefing,qna,diagnosis,ending", stages.join(","));
    report.check("장면은 대기→메인→메인→메인→전적→엔딩 순서로 바뀐다", scenes.join(",") === "보리-대기,보리-메인,보리-메인,보리-메인,보리-전적,보리-엔딩", scenes.join(","));
    const extra = await post("/api/show/next");
    report.check("ending에서 next는 그대로 ending이다", extra.stage === "ending");

    const resetFrom = obs.requests.length;
    const reset = await post("/api/show/reset");
    await waitUntil(async () => obs.requests.slice(resetFrom).some(entry => entry.inputName === "보리 배경음악"), 5000);
    report.check("처음으로 돌아가면 배경음악을 멈추고 방송 켜기 전으로 돌린다", reset.onAir === false && obs.requests.slice(resetFrom).some(entry => entry.inputName === "보리 배경음악" && entry.mediaAction.endsWith("STOP")));
    await waitUntil(async () => obs.currentScene() === "보리-대기", 5000);
    const state = await bori.state();
    report.check("reset은 idle·대기 장면으로 가고 방송을 끝낸다", reset.stage === "idle" && obs.currentScene() === "보리-대기" && state.status === "ended");
  }

  // ── 치지직 채팅 "재키 어때?" → 캐릭터 카드와 게임 데이터 ─────────────────
  {
    for (let i = 0; i < 3; i += 1) await nextAndSpeak();
    report.check("다시 qna까지 진행했다", (await show()).stage === "qna");
    await bori.waitForIdle();
    await mock.reset();
    chzzk.sendChat({ senderChannelId: "viewer-1", profile: { nickname: CHZZK_NICKNAME }, userRoleCode: "common_user", content: "재키 어때?" });
    const answered = await waitUntil(async () => {
      const calls = await mock.answerCalls();
      return calls.find(entry => entry.user.includes("\"재키 어때?\""));
    });
    report.check("치지직 채팅이 ingestChat을 거쳐 보리 답 요청이 된다", Boolean(answered));
    report.check("그 요청에 [게임 데이터]와 수치 8.1%가 들어간다", Boolean(answered?.user.includes("[게임 데이터]") && answered.user.includes("랭커 픽률: 8.1%")));
    const card = await waitUntil(async () => { const view = (await show()).dashboard; return view.kind === "character" ? view : null; });
    report.check("답이 나가면 대시보드가 재키 캐릭터 카드다", card?.stat?.name === "재키" && card?.query === "재키 어때?", JSON.stringify(card));
    const state = await bori.state();
    report.check("치지직 채팅도 화면 채팅 목록에 내용만 오르고 닉네임은 없다",
      state.visibleChats.some(chat => chat.content === "재키 어때?") && !JSON.stringify(state).includes(CHZZK_NICKNAME));
  }

  // ── !전적 → 전적 카드, 닉네임 가림 ───────────────────────────────
  {
    await bori.waitForIdle();
    await nextAndSpeak();
    report.check("diagnosis 단계로 갔다", (await show()).stage === "diagnosis");
    await bori.waitForIdle();
    await mock.reset();
    chzzk.sendChat({ senderChannelId: "viewer-2", profile: { nickname: "다른시청자" }, userRoleCode: "common_user", content: `!전적 ${PLAYER_NICKNAME}` });
    const ready = await waitUntil(async () => { const view = (await show()).dashboard; return view.kind === "player" && view.status === "ready" ? view : null; }, 30_000);
    report.check("!전적 닉네임 → 대시보드 player ready", Boolean(ready));
    report.check("전적 카드에는 가린 닉네임이 있다", ready?.report?.maskedNickname === "테스**", ready?.report?.maskedNickname);
    const state = await bori.state();
    const stateText = JSON.stringify(state);
    report.check("화면 상태 어디에도 원래 닉네임이 없다", !stateText.includes(PLAYER_NICKNAME));
    report.check("채팅 띠에는 닉네임을 가린 명령이 뜬다", state.visibleChats.some(chat => chat.content === "!전적 테스**"), JSON.stringify(state.visibleChats.map(chat => chat.content)));
    const analysis = await waitUntil(async () => (await directiveCalls()).find(entry => entry.system.includes("방금 검색한 전적 결과")));
    report.check("전적 분석 대사 요청에 전적 줄이 들어가고 닉네임은 없다",
      Boolean(analysis?.user.includes("평균 순위:")) && !analysis.user.includes(PLAYER_NICKNAME) && !analysis.user.includes("테스**") && !analysis.system.includes(PLAYER_NICKNAME));
  }

  // ── OBS를 꺼도 진행된다 ──────────────────────────────────────────
  {
    await bori.waitForIdle();
    await obs.close();
    const down = await waitUntil(async () => (await bori.get("/api/obs/status")).body?.state !== "connected", 10_000);
    report.check("OBS가 꺼지면 OBS 상태가 connected가 아니다", Boolean(down));
    // 엔딩은 말하지 않으므로 질문 단계로 한 칸 돌아갔다가(prev는 말하지 않는다) 전적 단계로 넘어가며 대사를 본다.
    await post("/api/show/prev");
    // 질문 코너에 들어온 채팅은 코너가 바뀌면 읽지 않는다(지난 코너 채팅). 답 대기(1초) 안에 바로 넘긴다.
    const expiredBefore = (await bori.state()).droppedChats?.expired ?? 0;
    await bori.chat("지난 코너 채팅이에요");
    const { moved, spoke } = await nextAndSpeak();
    const stale = await waitUntil(async () => ((await bori.state()).droppedChats?.expired ?? 0) > expiredBefore, 10_000);
    report.check("코너가 바뀌면 지난 코너 채팅은 버리고 답하지 않는다", Boolean(stale) && !JSON.stringify((await bori.state()).currentResponse ?? {}).includes("지난 코너"));
    report.check("OBS가 꺼져 있어도 다음 단계로 가고 보리가 말한다", moved.stage === "diagnosis" && Boolean(spoke));
    report.check("진행 상태의 OBS 연결도 connected가 아니다", (await show()).connections.obs !== "connected");
  }

  // ── ER 메타 갱신(가짜 ER) ───────────────────────────────────────
  {
    const first = await post("/api/er/refresh");
    const second = await post("/api/er/refresh");
    report.check("ER 갱신은 한 번만 시작한다", first.started === true && second.started === false);
    const refreshing = (await show()).connections.er;
    report.check("갱신 중에는 ER 연결이 refreshing이다", refreshing === "refreshing", refreshing);
    const done = await waitUntil(async () => { const status = (await bori.get("/api/er/status")).body; return status && !status.refreshing ? status : null; }, 60_000);
    report.check("가짜 ER로 갱신을 끝내고 오류가 없다", done?.lastError === null && done?.basis?.sampleGames === 8, JSON.stringify(done));
    const saved = JSON.parse(await readFile(join(dataDir, "er-meta.json"), "utf8"));
    report.check("갱신 결과를 er-meta.json에 쓴다", saved.basis?.sampleGames === 8 && saved.stats?.[0]?.name === "아야");
    report.check("ER 요청에는 키 헤더가 붙는다", prepared.er.calls.filter(call => call.path.startsWith("/v")).every(call => call.hasKey));
  }

  // ── 치지직 끊기 ─────────────────────────────────────────────────
  {
    const disconnected = await post("/api/chzzk/disconnect");
    const status = (await bori.get("/api/chzzk/status")).body;
    report.check("치지직 끊기 뒤 상태는 off다", disconnected.ok === true && status?.state === "off");
  }
}
