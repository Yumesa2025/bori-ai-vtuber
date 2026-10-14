/**
 * API 사용량·LLM 설정 검증 검사.
 *
 * - 방송 채팅과 1:1 메시지가 /api/usage의 모드별 답변 호출 수와 토큰 수를 올린다
 * - 사용량 파일과 응답에 대화 내용·닉네임·소유자 ID가 없다
 * - 재시작해도 오늘 사용량이 남는다
 * - /api/companion/stats는 숫자만 돌려준다
 * - 잘못된 PATCH /api/llm(모르는 키, 잘못된 타입)은 400이고 설정도 키도 바뀌지 않는다
 * - 관리자 앱 Origin은 사용량 API를 읽을 수 있고 허용 밖 Origin은 막힌다
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { baseQueueSettings, runningScript, waitForHttp } from "./harness.mjs";

export const meta = {
  name: "API 사용량",
  timing: { llm: 200, tts: 100, embed: 50 },
};

/** 방송 채팅·1:1 메시지·닉네임에만 넣는 표시. 사용량 기록에 나오면 새어 나간 것이다. */
const BROADCAST_MARK = "사용량방송표시";
const COMPANION_MARK = "사용량일대일표시";
const NICKNAME = "사용량닉네임";
const OWNER = "companion:local";
/** mock-openai가 답변 생성 응답에 붙이는 토큰 수. 값은 mock-openai.mjs와 맞춘다. */
const MOCK_INPUT_TOKENS = 120;
const MOCK_OUTPUT_TOKENS = 30;
/** gpt-4o-mini 기본 단가(입력 0.15, 출력 0.6 USD / 1M 토큰)로 계산한 한 번의 비용. */
const MOCK_REPLY_COST = (MOCK_INPUT_TOKENS * 0.15 + MOCK_OUTPUT_TOKENS * 0.6) / 1_000_000;
const ADMIN_ORIGIN = "http://127.0.0.1:5174";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rowOf = (period, feature, mode) => period?.rows?.find(row => row.feature === feature && row.mode === mode && row.model === "gpt-4o-mini");

async function waitUntil(check, { tries = 50, interval = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

export async function run({ bori, mock, report, dataDir }) {
  const send = async (method, path, payload, headers = {}) => {
    const response = await fetch(`${bori.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const usage = async () => (await send("GET", "/api/usage")).body;
  const usageFile = () => readFile(join(dataDir, "usage.json"), "utf8").catch(() => "");

  // ── 시작 상태 ───────────────────────────────────────────────
  {
    const initial = await usage();
    report.check(
      "처음에는 오늘 사용량이 0이고 단가 기준 날짜가 있다",
      initial?.today?.totals?.calls === 0 && typeof initial?.prices?.defaultAsOf === "string" && initial?.prices?.fileLoaded === false,
      `calls=${initial?.today?.totals?.calls} asOf=${initial?.prices?.defaultAsOf}`,
    );
  }

  // ── 방송 채팅 1회 ───────────────────────────────────────────
  await bori.patchSettings(baseQueueSettings);
  await bori.startSession();
  await mock.reset();
  await bori.chat(`요즘 ${BROADCAST_MARK} 이야기 들으셨어요`, NICKNAME);
  const broadcastReply = await bori.waitForReply();
  await bori.waitForIdle();
  {
    const answers = await mock.answerCalls();
    const after = await usage();
    const row = rowOf(after?.today, "reply", "broadcast");
    report.check("방송 채팅이 LLM으로 답했다", broadcastReply.response?.source === "llm" && answers.length === 1, `source=${broadcastReply.response?.source} calls=${answers.length}`);
    report.check(
      "방송 답변 호출이 broadcast 모드 reply로 1회 늘고 mock 토큰 수가 그대로 쌓인다",
      row?.calls === 1 && row?.failures === 0 && row?.inputTokens === MOCK_INPUT_TOKENS && row?.outputTokens === MOCK_OUTPUT_TOKENS,
      JSON.stringify(row ?? null),
    );
    report.check(
      "방송 답변 추정 비용이 기본 단가로 계산된다",
      row?.costComplete === true && Math.abs((row?.estimatedCostUsd ?? -1) - MOCK_REPLY_COST) < 1e-12,
      `cost=${row?.estimatedCostUsd}`,
    );
    const tts = after?.today?.rows?.find(entry => entry.feature === "tts" && entry.mode === "broadcast");
    report.check("방송 음성 합성이 broadcast 모드 tts로 글자 수와 함께 쌓인다", tts?.calls === 1 && tts?.characters > 0 && tts?.model === "tts-1", JSON.stringify(tts ?? null));
  }

  // ── 1:1 메시지 1회 ──────────────────────────────────────────
  const created = await send("POST", "/api/conversations", { title: "사용량 대화" });
  const conversationId = created.body?.conversation?.id;
  const before = await usage();
  const message = await send("POST", `/api/conversations/${encodeURIComponent(conversationId)}/messages`, { content: `안녕하세요 ${COMPANION_MARK}`, tts: true });
  {
    const after = await usage();
    const row = rowOf(after?.today, "reply", "companion");
    report.check("1:1 메시지가 LLM으로 답했다", message.status === 200 && message.body?.reply?.source === "llm", `status=${message.status}`);
    report.check(
      "1:1 답변 호출이 companion 모드 reply로 1회 늘고 방송 reply는 그대로다",
      row?.calls === 1 && row?.inputTokens === MOCK_INPUT_TOKENS && rowOf(after?.today, "reply", "broadcast")?.calls === 1
        && after?.today?.byMode?.companion?.calls > (before?.today?.byMode?.companion?.calls ?? 0),
      JSON.stringify(row ?? null),
    );
    const tts = after?.today?.rows?.find(entry => entry.feature === "tts" && entry.mode === "companion");
    report.check("1:1 음성 합성은 companion 모드 tts로 센다", tts?.calls === 1 && tts?.characters > 0, JSON.stringify(tts ?? null));
    report.check(
      "최근 7일·31일 합계가 오늘 합계 이상이다",
      after?.last7Days?.totals?.calls >= after?.today?.totals?.calls && after?.last31Days?.totals?.calls >= after?.last7Days?.totals?.calls,
    );
  }

  // ── 실패 수 ─────────────────────────────────────────────────
  {
    await mock.fail(true);
    await send("POST", `/api/conversations/${encodeURIComponent(conversationId)}/messages`, { content: "실패를 세는지 봐요" });
    await mock.fail(false);
    const row = rowOf((await usage())?.today, "reply", "companion");
    report.check("업체 호출이 실패하면 failures가 늘고 토큰은 늘지 않는다", row?.calls === 2 && row?.failures === 1 && row?.inputTokens === MOCK_INPUT_TOKENS, JSON.stringify(row ?? null));
  }

  // ── 기록에 내용이 없다 ──────────────────────────────────────
  {
    // 기록은 호출마다 바로 쓰지만 백그라운드 호출(임베딩)이 늦게 끝날 수 있어 잠시 기다린다.
    const file = await waitUntil(async () => {
      const text = await usageFile();
      return text.includes("\"reply\"") ? text : null;
    });
    const parsed = file ? JSON.parse(file) : null;
    const response = JSON.stringify(await usage());
    const leaks = [BROADCAST_MARK, COMPANION_MARK, NICKNAME, OWNER, "local:", "안녕하세요"];
    report.check("사용량 파일이 version 1로 저장된다", parsed?.version === 1 && typeof parsed?.days === "object");
    report.check(
      "사용량 파일에 대화 내용·닉네임·소유자 ID가 없다",
      file !== null && leaks.every(text => !file.includes(text)),
      leaks.filter(text => file?.includes(text)).join(", "),
    );
    report.check("사용량 응답에도 대화 내용·닉네임·소유자 ID가 없다", leaks.every(text => !response.includes(text)));
    const allowedKeys = new Set(["feature", "mode", "model", "calls", "failures", "inputTokens", "outputTokens", "callsWithoutTokens", "characters"]);
    const keys = Object.values(parsed?.days ?? {}).flat().flatMap(entry => Object.keys(entry));
    report.check("사용량 파일의 각 줄은 숫자와 기능·모드·모델 이름뿐이다", keys.length > 0 && keys.every(key => allowedKeys.has(key)), [...new Set(keys)].join(","));
  }

  // ── 1:1 통계 ────────────────────────────────────────────────
  {
    const stats = await send("GET", "/api/companion/stats");
    const keys = Object.keys(stats.body ?? {}).sort().join(",");
    report.check(
      "/api/companion/stats는 대화 수·메시지 수·private 기억 수만 숫자로 돌려준다",
      stats.status === 200 && keys === "conversations,messages,privateMemories" && Object.values(stats.body).every(value => Number.isInteger(value)),
      JSON.stringify(stats.body),
    );
    report.check("1:1 통계가 지금 대화를 센다", stats.body?.conversations === 1 && stats.body?.messages >= 2, JSON.stringify(stats.body));
  }

  // ── PATCH /api/llm 검증 ─────────────────────────────────────
  {
    const original = await bori.llm();
    const invalid = [
      [{ unknownKey: 1 }, "모르는 키"],
      [{ timeoutMs: "9000" }, "문자열 숫자"],
      [{ enabled: "yes" }, "문자열 불리언"],
      [{ provider: "gemini" }, "어댑터 없는 업체"],
      [{ model: "" }, "빈 모델 이름"],
      [{ apiKey: 12345 }, "숫자 키"],
      // 옳은 값과 틀린 값을 섞으면 옳은 값도 반영하지 않는다.
      [{ model: "gpt-4o", maxReplyLength: 5 }, "범위 밖 값과 섞인 옳은 값"],
      [{ apiKey: "", failureThreshold: 0 }, "키 삭제와 섞인 범위 밖 값"],
    ];
    const statuses = [];
    for (const [patch] of invalid) statuses.push((await bori.patchLlm(patch)).status);
    const after = await bori.llm();
    report.check("잘못된 PATCH /api/llm은 모두 400이다", statuses.every(status => status === 400), invalid.map(([, label], index) => `${label}=${statuses[index]}`).join(" "));
    report.check(
      "잘못된 PATCH 뒤에도 설정과 키가 그대로다",
      JSON.stringify(after?.settings) === JSON.stringify(original?.settings) && after?.status?.hasApiKey === original?.status?.hasApiKey && original?.status?.hasApiKey === true,
    );

    const valid = await bori.patchLlm({ rollingSummaryTurns: 2, cooldownSeconds: 45 });
    report.check(
      "옳은 PATCH는 반영되고 요약 주기 4 미만은 기존대로 4로 올린다",
      valid.status === 200 && valid.body?.settings?.rollingSummaryTurns === 4 && valid.body?.settings?.cooldownSeconds === 45,
      `status=${valid.status} turns=${valid.body?.settings?.rollingSummaryTurns}`,
    );
  }

  // ── 관리자 앱 Origin ────────────────────────────────────────
  {
    const admin = await send("GET", "/api/usage", undefined, { Origin: ADMIN_ORIGIN });
    const adminStats = await send("GET", "/api/companion/stats", undefined, { Origin: ADMIN_ORIGIN });
    const evil = await send("GET", "/api/usage", undefined, { Origin: "https://evil.example" });
    report.check("관리자 앱 Origin은 사용량·1:1 통계를 읽는다", admin.status === 200 && adminStats.status === 200, `usage=${admin.status} stats=${adminStats.status}`);
    report.check("허용 밖 Origin은 사용량을 읽지 못한다", evil.status === 403, `status=${evil.status}`);
  }

  // ── 재시작 뒤에도 남는다 ────────────────────────────────────
  {
    // 백그라운드 호출(누적 요약)이 끝나 숫자가 멈출 때까지 기다린 뒤 비교한다.
    // 고정 800ms 대신 400ms 간격으로 두 번 같은 값이 나올 때까지 본다. 느린 러너에서는 그만큼 더 기다린다.
    let beforeRestart = (await usage())?.today?.totals?.calls;
    for (let tries = 0; tries < 25; tries += 1) {
      await sleep(400);
      const next = (await usage())?.today?.totals?.calls;
      if (next === beforeRestart && tries > 0) break;
      beforeRestart = next;
    }
    await runningScript("bori-server").restart();
    await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "다시 띄운 보리 서버" });
    const afterRestart = await usage();
    report.check(
      "재시작 뒤에도 오늘 사용량이 남는다",
      typeof beforeRestart === "number" && beforeRestart > 0 && afterRestart?.today?.totals?.calls === beforeRestart && rowOf(afterRestart?.today, "reply", "companion")?.calls === 2,
      `before=${beforeRestart} after=${afterRestart?.today?.totals?.calls}`,
    );
  }
}
