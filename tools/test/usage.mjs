/**
 * API 사용량·LLM 설정 검증 검사.
 *
 * - 방송·1:1 대화를 쓰던 때의 사용량 줄(broadcast·companion 모드)을 버리지 않고 /api/usage에 그대로 보여 준다(R5)
 * - 사용량 응답에 숫자와 기능·모드·모델 이름만 있다
 * - 재시작해도 예전 줄이 남는다
 * - 잘못된 PATCH /api/llm(모르는 키, 잘못된 타입)은 400이고 설정도 키도 바뀌지 않는다
 * - 관리자 앱 Origin은 사용량 API를 읽을 수 있고 허용 밖 Origin은 막힌다
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runningScript, waitForHttp } from "./harness.mjs";

export const meta = {
  name: "API 사용량",
  timing: { llm: 200, tts: 100, embed: 50 },
};

const ADMIN_ORIGIN = "http://127.0.0.1:5174";

const pad = value => String(value).padStart(2, "0");
/** 서버 사용량 저장소와 같은 로컬 날짜 키(YYYY-MM-DD). */
const localDateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 예전 앱이 남긴 줄. 이 앱은 broadcast·companion을 새로 쓰지 않지만 읽기는 해야 한다. */
const legacyRows = [
  { feature: "reply", mode: "broadcast", model: "gpt-4o-mini", calls: 3, failures: 1, inputTokens: 300, outputTokens: 60, callsWithoutTokens: 0, characters: 0 },
  { feature: "tts", mode: "companion", model: "tts-1", calls: 2, failures: 0, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 0, characters: 40 },
  { feature: "embedding", mode: "none", model: "text-embedding-3-small", calls: 1, failures: 0, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 1, characters: 0 },
];

/** 서버를 띄우기 전에 예전 사용량 파일을 깐다. */
export async function prepare({ dataDir }) {
  await writeFile(join(dataDir, "usage.json"), JSON.stringify({ version: 1, days: { [localDateKey(new Date())]: legacyRows } }), "utf8");
  return null;
}

export async function run({ bori, report }) {
  const send = async (method, path, payload, headers = {}) => {
    const response = await fetch(`${bori.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const usage = async () => (await send("GET", "/api/usage")).body;
  const rowOf = (period, feature, mode) => period?.rows?.find(row => row.feature === feature && row.mode === mode);

  // ── 예전 줄 읽기(R5) ────────────────────────────────────────
  {
    const report_ = await usage();
    const broadcast = rowOf(report_?.today, "reply", "broadcast");
    const companion = rowOf(report_?.today, "tts", "companion");
    report.check(
      "예전 broadcast·companion 사용량 줄을 버리지 않고 오늘 사용량에 보여 준다",
      broadcast?.calls === 3 && broadcast?.failures === 1 && companion?.characters === 40 && report_?.today?.totals?.calls === 6,
      `broadcast=${JSON.stringify(broadcast ?? null)} companion=${JSON.stringify(companion ?? null)} total=${report_?.today?.totals?.calls}`,
    );
    report.check(
      "모드별 합계에 예전 모드가 그대로 있다",
      report_?.today?.byMode?.broadcast?.calls === 3 && report_?.today?.byMode?.companion?.calls === 2,
      JSON.stringify(Object.keys(report_?.today?.byMode ?? {})),
    );
    const allowedKeys = new Set(["feature", "mode", "model", "calls", "failures", "inputTokens", "outputTokens", "callsWithoutTokens", "characters", "estimatedCostUsd", "costComplete", "costNote"]);
    const keys = (report_?.today?.rows ?? []).flatMap(row => Object.keys(row));
    report.check("사용량 응답의 각 줄은 숫자와 기능·모드·모델 이름뿐이다", keys.length > 0 && keys.every(key => allowedKeys.has(key)), [...new Set(keys)].join(","));
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

    const valid = await bori.patchLlm({ cooldownSeconds: 45 });
    report.check("옳은 PATCH는 반영된다", valid.status === 200 && valid.body?.settings?.cooldownSeconds === 45, `status=${valid.status}`);
  }

  // ── 관리자 앱 Origin ────────────────────────────────────────
  {
    const admin = await send("GET", "/api/usage", undefined, { Origin: ADMIN_ORIGIN });
    const evil = await send("GET", "/api/usage", undefined, { Origin: "https://evil.example" });
    report.check("관리자 앱 Origin은 사용량을 읽는다", admin.status === 200, `usage=${admin.status}`);
    report.check("허용 밖 Origin은 사용량을 읽지 못한다", evil.status === 403, `status=${evil.status}`);
  }

  // ── 재시작 뒤에도 남는다 ────────────────────────────────────
  {
    await runningScript("bori-server").restart();
    await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "다시 띄운 보리 서버" });
    const afterRestart = await usage();
    report.check(
      "재시작 뒤에도 예전 사용량 줄이 남는다",
      rowOf(afterRestart?.today, "reply", "broadcast")?.calls === 3 && afterRestart?.today?.totals?.calls === 6,
      `total=${afterRestart?.today?.totals?.calls}`,
    );
  }
}
