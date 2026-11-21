/**
 * 데이터 파일 손상·쓰기 실패 검사(점검 D-1~D-6).
 *
 * - 깨진·잘린 설정 파일로 서버가 뜨고, 원본을 *.unreadable-*.json으로 남기고, 읽을 수 있는 값만 쓰는지
 * - 풀지 못한 암호문 키를 설정 저장이 지우지 않는지
 * - 설정 파일 쓰기가 실패하면 PATCH가 500으로 끝나고 서버는 살아 있으며 값이 그대로인지
 *
 * 쓰기 실패는 파일 자리를 비어 있지 않은 디렉터리로 바꿔 만든다. rename이 Windows·Linux 모두에서 실패한다.
 * 실행기가 띄운 서버를 내리고, 파일을 준비한 뒤 이 시나리오가 직접 띄운다. 포트와 데이터 디렉터리는 실행기 것을 쓴다.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runningScript, startScript, waitForHttp } from "./harness.mjs";

export const meta = {
  name: "데이터 파일 손상·쓰기 실패",
  timing: { llm: 300, tts: 200, embed: 100 },
};

// 형식은 맞지만 이 컴퓨터의 키로 풀리지 않는 암호문.
const FOREIGN_KEY = "enc.v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";

export async function run({ bori, mock, report, dataDir }) {
  const path = name => join(dataDir, name);
  const backupsOf = async stem => (await readdir(dataDir)).filter(name => name.startsWith(`${stem}.unreadable-`));
  const send = async (method, url, payload) => {
    const response = await fetch(`${bori.baseUrl}${url}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const alive = async () => (await fetch(`${bori.baseUrl}/api/health`).then(response => response.status).catch(() => 0)) === 200;

  /** 파일 자리를 비어 있지 않은 디렉터리로 바꿔 다음 쓰기를 실패하게 한다. 되돌릴 함수를 돌려준다. */
  async function blockWrites(name) {
    const target = path(name);
    const parked = `${target}.parked`;
    await rename(target, parked);
    await mkdir(target);
    await writeFile(join(target, "keep"), "", "utf8");
    return async () => {
      await rm(target, { recursive: true, force: true });
      await rename(parked, target);
    };
  }

  // 실행기가 깔아 둔 LLM 설정(LLM 켜짐).
  const fixtureLlmConfig = await readFile(path("llm-config.json"), "utf8");

  let server = null;
  async function boot(env = {}) {
    await runningScript("bori-server")?.stop();
    await server?.stop();
    server = startScript("apps/server/src/index.ts", {
      loadTypeScript: true,
      label: "bori-server-durability",
      env: {
        BORI_SERVER_PORT: new URL(bori.baseUrl).port,
        BORI_DATA_DIR: dataDir,
        BORI_OPENAI_BASE_URL: `${mock.baseUrl}/v1`,
        OPENAI_API_KEY: "mock-key",
        ...env,
      },
    });
    await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버" });
  }

  try {
    // ── 잘못된 설정 값·풀지 못한 키 ──────────────────────────
    {
      await writeFile(path("tts-config.json"), JSON.stringify({ provider: "bogus", voice: 5, speed: "fast" }), "utf8");
      const llmConfig = JSON.parse(fixtureLlmConfig);
      await writeFile(path("llm-config.json"), JSON.stringify({ ...llmConfig, apiKey: FOREIGN_KEY }), "utf8");

      let started = true;
      try { await boot(); } catch { started = false; }
      report.check("잘못된 음성 설정과 풀지 못한 키가 있어도 서버가 뜬다", started && await alive());

      const tts = (await send("GET", "/api/tts")).body;
      report.check("잘못된 음성 설정 값은 기본값으로 쓰고 원본을 남긴다", tts?.settings?.provider === "openai" && typeof tts?.settings?.voice === "string" && typeof tts?.settings?.speed === "number" && (await backupsOf("tts-config")).length === 1, JSON.stringify(tts?.settings));

      // 고정 자료 llm-config.json에는 1:1 대화를 쓰던 때의 칸(누적 요약·매크로)이 남아 있다.
      report.check("예전 LLM 설정 칸은 잘못된 값으로 보지 않아 원본 백업이 생기지 않는다", (await backupsOf("llm-config")).length === 0, `백업 ${(await backupsOf("llm-config")).length}개`);
      const llm = await bori.llm();
      report.check("풀지 못한 저장 키를 상태로 알린다", llm?.storedKeyUnreadable === true);
      const patched = await send("PATCH", "/api/llm", { cooldownSeconds: 30 });
      const saved = JSON.parse(await readFile(path("llm-config.json"), "utf8"));
      report.check(
        "설정을 바꿔도 풀지 못한 키를 지우지 않는다",
        patched.status === 200 && saved.apiKey === FOREIGN_KEY && saved.settings.cooldownSeconds === 30,
        `status=${patched.status} apiKey=${saved.apiKey === FOREIGN_KEY ? "그대로" : "바뀜"}`,
      );
    }

    // ── 깨진 파일 ───────────────────────────────────────────
    {
      const truncatedLlm = `{"settings":{"enabled":true,"model":"gpt-4.1"},"apiKey":"enc.v1:AAAA`;
      await writeFile(path("llm-config.json"), truncatedLlm, "utf8");
      let started = true;
      try { await boot(); } catch { started = false; }
      report.check("잘린 설정 파일로도 서버가 뜬다", started && await alive());

      const llmBackups = await backupsOf("llm-config");
      const llmBackup = llmBackups.length > 0 ? await readFile(path(llmBackups.at(-1)), "utf8") : "";
      report.check("잘린 설정 파일 원본을 그대로 남긴다", llmBackup === truncatedLlm, `백업 ${llmBackups.length}개`);
      const output = server.output();
      report.check("손상 경고에 설정 내용과 키 조각을 찍지 않는다", output.includes("unreadable-") && !output.includes("gpt-4.1") && !output.includes("enc.v1:AAAA"));
    }

    // ── 쓰기 실패 ───────────────────────────────────────────
    {
      await writeFile(path("llm-config.json"), fixtureLlmConfig, "utf8");
      await boot();
      const before = (await bori.llm()).settings.cooldownSeconds;
      const unblockLlm = await blockWrites("llm-config.json");
      const patched = await send("PATCH", "/api/llm", { cooldownSeconds: before + 7 });
      const after = (await bori.llm()).settings.cooldownSeconds;
      const stillAlive = await alive();
      await unblockLlm();
      report.check(
        "설정 파일에 쓰지 못하면 PATCH는 500이고 값을 바꾸지 않으며 서버는 살아 있다",
        patched.status === 500 && typeof patched.body?.error === "string" && after === before && stillAlive,
        `status=${patched.status} cooldown=${after}/${before}`,
      );

      await server.restart();
      await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버" });
      const restarted = (await bori.llm()).settings.cooldownSeconds;
      report.check("재시작 뒤에도 저장 실패 전 값 그대로다", restarted === before, `cooldown=${restarted}/${before}`);
    }
  } finally {
    await server?.stop();
  }
}
