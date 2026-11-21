/**
 * 대시보드 흐름 검사(설계 7절, 총괄 계획 F.2).
 *
 * 가짜 이터널리턴 API(fixtures/fake-er.mjs)와 가짜 OpenAI(mock-openai.mjs)로 서버를 띄워 다음을 본다.
 * - 대시보드를 처음 열면(GET /api/dashboard) 데이터가 없어 자동 갱신이 시작되고, 끝나면 조합이 있다
 * - 갱신이 끝나면 보리 대사가 생긴다(source llm). 가짜 LLM이 숫자를 지어낸 줄은 검사에서 빠진다
 * - 줄마다 음성 id가 있고 /api/tts/:id로 받을 수 있다. 사용량은 모드 narration으로 센다
 * - 게임 닉네임을 저장하면 전적을 다시 조회한다(ready / not-found / unset). 본문 검사는 400
 * - 다시 듣기는 같은 대사를 { narration }으로 돌려준다
 * - LLM이 실패하면 정해진 문장(source template)이다
 * - 다시 켜면 data/narration.json의 마지막 대사를 바로 보여 준다
 * - 서버 로그에 게임 닉네임이 없다
 *
 * 가짜 ER의 사전 시즌은 끝 시각이 지난 값이라, 재시작 뒤 첫 요청도 자동 갱신을 다시 시작한다(하루 한 번 판정).
 * 개인 키 속도 제한(호출 사이 1.1초)이 그대로라 갱신 한 번에 10초 남짓 걸린다.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runningScript, waitForHttp } from "./harness.mjs";
import { PLAYER_NICKNAME, startFakeEr } from "./fixtures/fake-er.mjs";

export const meta = {
  name: "대시보드 흐름",
  timing: { llm: 100, tts: 50, embed: 50 },
};

const ER_PORT = Number(process.env.BORI_TEST_ER_PORT ?? 4392);
const UNKNOWN_NICKNAME = "없는가짜닉";
/** mock-openai.mjs가 숫자를 지어낸 줄에 붙이는 표식(그 파일의 NARRATION_FABRICATED_MARK와 같은 값). */
const NARRATION_FABRICATED_MARK = "지어낸 수치";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 조건이 참이 될 때까지 대시보드 상태를 다시 받는다. 시간이 지나면 마지막 상태로 실패한다. */
async function waitForDashboard(bori, label, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await bori.dashboard();
    if (state && check(state)) return state;
    await sleep(300);
  }
  throw new Error(`${label}: ${timeoutMs}ms 안에 되지 않았습니다 (connection=${state?.connection}, running=${state?.refresh?.running}, lastError=${state?.refresh?.lastError})`);
}

export async function prepare() {
  const er = await startFakeEr({ port: ER_PORT });
  return {
    er,
    env: {
      ER_API_KEY: "fake-er-key",
      BORI_ER_BASE_URL: `http://127.0.0.1:${ER_PORT}`,
      BORI_ER_RANKERS: "2",
      BORI_ER_GAMES_PER_RANKER: "2",
    },
    cleanup: () => er.close(),
  };
}

export async function run({ bori, mock, report, dataDir }) {
  // ── 처음 열기 → 자동 갱신 ───────────────────────────────────
  const first = await bori.dashboard();
  report.check(
    "처음 대시보드를 열면 데이터가 없어 자동 갱신이 시작된다",
    first?.connection === "refreshing" && first?.refresh?.running === true && first?.refresh?.autoStarted === true && first?.refresh?.available === true,
    `connection=${first?.connection} refresh=${JSON.stringify(first?.refresh)}`,
  );
  report.check("아직 대사가 없으면 narration은 null이다", first?.narration === null);

  const refreshed = await waitForDashboard(bori, "자동 갱신", state => state.refresh.running === false);
  report.check(
    "갱신이 끝나면 ready이고 조합과 기준(경기 수·참가자 수)이 있다",
    refreshed.connection === "ready" && refreshed.combos.length > 0 && refreshed.basis?.games === 2 && refreshed.basis?.participants === 8 && refreshed.refresh.lastError === null,
    `connection=${refreshed.connection} combos=${refreshed.combos.length} basis=${JSON.stringify(refreshed.basis)}`,
  );
  report.check("기준 패치는 게임 표기(시즌.패치)다", refreshed.basis?.patch === "12.7", String(refreshed.basis?.patch));

  // ── 보리 대사 ────────────────────────────────────────────────
  const narrated = await waitForDashboard(bori, "첫 대사", state => state.narration !== null, 30_000);
  const lines = narrated.narration.lines;
  report.check("갱신이 끝나면 LLM이 쓴 대사가 생긴다", narrated.narration.source === "llm" && lines.length > 0, `source=${narrated.narration.source} lines=${lines.length}`);
  report.check(
    "LLM이 숫자를 지어낸 줄은 검사에서 빠진다",
    lines.every(line => !line.text.includes(NARRATION_FABRICATED_MARK)) && /검사에서 1줄을 버렸습니다 \(number\)/.test(runningScript("bori-server").output()),
    lines.map(line => line.text).join(" / "),
  );
  const llmCalls = await mock.llmCalls();
  report.check(
    "대사 요청은 가짜 OpenAI로 갔고 사실 목록을 담았다",
    llmCalls.length === 1 && llmCalls[0].user.startsWith("[사실 목록]"),
    `calls=${llmCalls.length}`,
  );
  report.check("대사를 data/narration.json에 남긴다", existsSync(join(dataDir, "narration.json")));

  const audioIds = lines.map(line => line.audioId);
  const audioStatuses = await Promise.all(audioIds.map(async id => {
    if (!id) return { status: 0, type: "" };
    const response = await fetch(`${bori.baseUrl}/api/tts/${encodeURIComponent(id)}`);
    await response.arrayBuffer();
    return { status: response.status, type: response.headers.get("content-type") ?? "" };
  }));
  report.check(
    "줄마다 음성 id가 있고 /api/tts/:id가 200 audio/mpeg다",
    audioStatuses.length > 0 && audioStatuses.every(entry => entry.status === 200 && entry.type.startsWith("audio/mpeg")),
    JSON.stringify(audioStatuses),
  );

  const usage = (await bori.get("/api/usage")).body;
  const narrationRow = feature => usage?.today?.rows?.find(row => row.feature === feature && row.mode === "narration");
  report.check(
    "LLM·음성 사용량을 모드 narration으로 센다",
    (narrationRow("reply")?.calls ?? 0) >= 1 && (narrationRow("tts")?.calls ?? 0) >= lines.length,
    `reply=${narrationRow("reply")?.calls} tts=${narrationRow("tts")?.calls}`,
  );

  // ── 게임 닉네임 ──────────────────────────────────────────────
  const settings = await bori.get("/api/dashboard/settings");
  report.check("처음 설정은 닉네임 없음이고 내 전적은 unset이다", settings.status === 200 && settings.body?.nickname === null && narrated.player.status === "unset");

  const tooLong = await bori.putSettings({ nickname: "가".repeat(33) });
  const wrongType = await bori.putSettings({ nickname: 3 });
  report.check("32자를 넘거나 문자열이 아닌 닉네임은 400이다", tooLong.status === 400 && wrongType.status === 400, `${tooLong.status} ${wrongType.status}`);

  const saved = await bori.putSettings({ nickname: `  ${PLAYER_NICKNAME}  ` });
  report.check("닉네임을 저장하면 앞뒤 공백을 떼고 돌려준다", saved.status === 200 && saved.body?.nickname === PLAYER_NICKNAME, `${saved.status} ${JSON.stringify(saved.body)}`);
  const ready = await bori.dashboard();
  report.check(
    "닉네임을 저장하면 전적을 다시 조회해 ready가 된다",
    ready?.player?.status === "ready" && ready.player.summary?.nickname === PLAYER_NICKNAME && ready.player.summary.recent.length > 0,
    `status=${ready?.player?.status}`,
  );

  await bori.putSettings({ nickname: UNKNOWN_NICKNAME });
  report.check("찾을 수 없는 닉네임이면 not-found다", (await bori.dashboard())?.player?.status === "not-found");
  const cleared = await bori.putSettings({ nickname: "" });
  report.check("빈 닉네임은 지우는 뜻이고 unset으로 돌아간다", cleared.body?.nickname === null && (await bori.dashboard())?.player?.status === "unset");

  // ── 다시 듣기 ────────────────────────────────────────────────
  const replay = await bori.post("/api/narration/replay");
  report.check(
    "다시 듣기는 같은 대사를 { narration }으로 돌려준다",
    replay.status === 200 && replay.body?.narration?.id === narrated.narration.id && replay.body.narration.lines.length === lines.length,
    `${replay.status} id=${replay.body?.narration?.id}`,
  );

  // ── LLM 실패 → 정해진 문장 ───────────────────────────────────
  await mock.fail(true);
  const started = await bori.post("/api/er/refresh");
  report.check("갱신 버튼은 시작했다고 답하고, 버튼으로 시작하면 autoStarted가 아니다", started.body?.started === true && (await bori.dashboard())?.refresh?.autoStarted === false);
  const templated = await waitForDashboard(bori, "LLM 실패 뒤 대사", state => state.refresh.running === false && state.narration !== null && state.narration.id !== narrated.narration.id);
  await mock.fail(false);
  report.check(
    "LLM이 실패하면 정해진 문장으로 읽는다",
    templated.narration.source === "template" && templated.narration.lines.length > 0 && templated.narration.lines.every(line => line.audioId),
    `source=${templated.narration.source} lines=${templated.narration.lines.length}`,
  );
  report.check("두 번째 갱신부터는 직전 갱신과 비교한다", templated.basis?.previousCollectedAt === refreshed.basis?.collectedAt);

  // ── 다시 켜기 ────────────────────────────────────────────────
  const server = runningScript("bori-server");
  await server.restart();
  await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "다시 띄운 보리 서버" });
  const reopened = await bori.dashboard();
  report.check(
    "다시 켜면 갱신을 기다리지 않고 마지막 대사를 보여 준다",
    reopened?.narration?.id === templated.narration.id && reopened.combos.length > 0,
    `id=${reopened?.narration?.id}`,
  );

  // ── 개인정보 ─────────────────────────────────────────────────
  const output = server.output();
  report.check("서버 로그에 게임 닉네임이 없다", !output.includes(PLAYER_NICKNAME) && !output.includes(UNKNOWN_NICKNAME));
}
