/**
 * 데이터 파일 손상·쓰기 실패 검사(점검 D-1~D-6, L-4).
 *
 * - 깨진 기억·설정 파일로 서버가 뜨고, 원본을 *.unreadable-*.json으로 남기고, 읽을 수 있는 것만 쓰는지
 * - 풀지 못한 암호문 키를 설정 저장이 지우지 않는지
 * - 파일 쓰기가 실패하면 삭제·설정 변경이 500으로 끝나고 서버는 살아 있으며, 지운 것이 되돌려져 재시작 뒤에도 같은지
 * - 개행이 섞인 키가 lastError와 서버 로그에 남지 않는지
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

const PRIVATE_MEMORY = "저는 퇴근하고 재즈 피아노 듣는 걸 좋아해요";
// 형식은 맞지만 이 컴퓨터의 키로 풀리지 않는 암호문.
const FOREIGN_KEY = "enc.v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";
// 가짜 키. 실제 업체로 나가지 않는다(가짜 API 서버를 쓴다).
const NEWLINE_KEY = "fake-AUDIT0123456789\nTAILSECRETPART";

const record = (id, extra = {}) => ({
  id,
  text: `방송 기억 ${id}`,
  kind: "broadcast",
  scope: "broadcast",
  importance: 0.5,
  confidence: 0.5,
  repeatCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...extra,
});

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
  /**
   * 방금 보낸 1:1 메시지를 개인 기억으로 만든다. LLM을 쓸 수 있으면 기억은 LLM 정리가 만들고(ADR-023),
   * 새 대화를 열 때 앞 대화의 남은 메시지를 정리한다. 정리가 끝날 때까지 기다려 개인 기억 목록을 돌려준다.
   */
  async function makePrivateMemory() {
    await send("POST", "/api/conversations", { title: "정리용" });
    let memories = [];
    for (let tries = 0; tries < 50 && memories.length === 0; tries += 1) {
      memories = (await send("GET", "/api/me/memories")).body?.memories ?? [];
      if (memories.length === 0) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return memories;
  }

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

  // 실행기가 깔아 둔 LLM 설정(LLM 켜짐). 마지막 단계에서 다시 쓴다.
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
    // ── 깨진 레코드·잘못된 설정 값·풀지 못한 키 ──────────────
    {
      await writeFile(path("memories.json"), JSON.stringify({ version: 2, records: [null, record("ok"), { id: "missing-fields" }] }), "utf8");
      await writeFile(path("memory-config.json"), JSON.stringify({ retentionDays: "abc", maxMemories: -5 }), "utf8");
      await writeFile(path("tts-config.json"), JSON.stringify({ provider: "bogus", voice: 5, speed: "fast" }), "utf8");
      const llmConfig = JSON.parse(fixtureLlmConfig);
      await writeFile(path("llm-config.json"), JSON.stringify({ ...llmConfig, apiKey: FOREIGN_KEY }), "utf8");

      let started = true;
      try { await boot(); } catch { started = false; }
      report.check("null 레코드와 필드가 빠진 레코드가 있어도 서버가 뜬다", started && await alive());

      const memory = await bori.memory();
      report.check("깨진 레코드만 버리고 나머지 기억은 읽는다", memory?.records?.map(entry => entry.id).join(",") === "ok", `ids=${memory?.records?.map(entry => entry.id).join(",")}`);
      report.check("버리기 전에 기억 파일 원본을 남긴다", (await backupsOf("memories")).length === 1);
      report.check(
        "잘못된 기억 설정 값은 기본값으로 쓰고 원본을 남긴다",
        memory?.settings?.retentionDays === 30 && memory?.settings?.maxMemories === 5 && (await backupsOf("memory-config")).length === 1,
        `retentionDays=${memory?.settings?.retentionDays} maxMemories=${memory?.settings?.maxMemories}`,
      );
      const tts = (await send("GET", "/api/tts")).body;
      report.check("잘못된 음성 설정 값은 기본값으로 쓴다", tts?.settings?.provider === "openai" && typeof tts?.settings?.voice === "string" && typeof tts?.settings?.speed === "number", JSON.stringify(tts?.settings));

      const conversation = (await send("POST", "/api/conversations", { title: "내구성" })).body.conversation;
      await send("POST", `/api/conversations/${conversation.id}/messages`, { content: PRIVATE_MEMORY });
      const mine = await makePrivateMemory();
      report.check("기억 설정 값을 고친 뒤 1:1 개인 기억이 저장된다", mine.length > 0, `개인 기억 ${mine.length}건`);

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
      await writeFile(path("memories.json"), "", "utf8");
      let started = true;
      try { await boot(); } catch { started = false; }
      report.check("빈 기억 파일과 잘린 설정 파일로도 서버가 뜬다", started && await alive());

      const llmBackups = await backupsOf("llm-config");
      const llmBackup = llmBackups.length > 0 ? await readFile(path(llmBackups.at(-1)), "utf8") : "";
      report.check("잘린 설정 파일 원본을 그대로 남긴다", llmBackup === truncatedLlm, `백업 ${llmBackups.length}개`);
      const memoryBackups = await backupsOf("memories");
      report.check("빈 기억 파일도 원본을 남긴다", memoryBackups.length === 2, `백업 ${memoryBackups.length}개`);
      const output = server.output();
      report.check("손상 경고에 설정 내용과 키 조각을 찍지 않는다", output.includes("unreadable-") && !output.includes("gpt-4.1") && !output.includes("enc.v1:AAAA"));
    }

    // ── 쓰기 실패 ───────────────────────────────────────────
    {
      await writeFile(path("memories.json"), JSON.stringify({ version: 2, records: [record("b1"), record("b2")] }), "utf8");
      await boot();
      const conversation = (await send("POST", "/api/conversations", { title: "삭제 실패" })).body.conversation;
      await send("POST", `/api/conversations/${conversation.id}/messages`, { content: PRIVATE_MEMORY });
      const privateBefore = (await makePrivateMemory()).length;
      const conversationsBefore = (await send("GET", "/api/conversations")).body?.conversations?.length ?? 0;

      const unblock = await blockWrites("memories.json");
      const single = await send("DELETE", "/api/memory/b1");
      const all = await send("DELETE", "/api/memory/all");
      const data = await send("DELETE", "/api/me/data");
      const stillAlive = await alive();
      const memoryAfter = await bori.memory();
      const conversationsAfter = (await send("GET", "/api/conversations")).body?.conversations ?? [];
      const privateAfter = (await send("GET", "/api/me/memories")).body?.memories?.length ?? 0;
      await unblock();

      report.check("기억 파일에 쓰지 못하면 관리자 기억 삭제는 500이고 서버는 살아 있다", single.status === 500 && all.status === 500 && stillAlive, `single=${single.status} all=${all.status}`);
      report.check("삭제가 실패하면 지운 기억을 되돌린다", memoryAfter?.count === 2 + privateBefore && memoryAfter.records.some(entry => entry.id === "b1"), `count=${memoryAfter?.count}`);
      report.check(
        "/api/me/data가 기억을 지우지 못하면 실패로 답하고 대화·개인 기억을 남긴다",
        data.status === 500 && conversationsAfter.length === conversationsBefore && conversationsBefore > 0 && privateAfter === privateBefore && privateBefore > 0,
        `status=${data.status} 대화=${conversationsAfter.length}/${conversationsBefore} 개인 기억=${privateAfter}/${privateBefore}`,
      );

      await server.restart();
      await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버" });
      const restartedPrivate = (await send("GET", "/api/me/memories")).body?.memories?.length ?? 0;
      report.check("재시작 뒤에도 화면에 보이던 것과 같다", restartedPrivate === privateBefore, `개인 기억 ${restartedPrivate}건`);

      const cleared = await send("DELETE", "/api/me/data");
      await server.restart();
      await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버" });
      const finalPrivate = (await send("GET", "/api/me/memories")).body?.memories?.length ?? -1;
      const finalConversations = (await send("GET", "/api/conversations")).body?.conversations?.length ?? -1;
      report.check("쓰기가 되살아나면 /api/me/data가 지우고 재시작 뒤에도 남지 않는다", cleared.status === 200 && finalPrivate === 0 && finalConversations === 0, `status=${cleared.status} 개인 기억=${finalPrivate} 대화=${finalConversations}`);

      const before = (await bori.llm()).settings.cooldownSeconds;
      const unblockLlm = await blockWrites("llm-config.json");
      const patched = await send("PATCH", "/api/llm", { cooldownSeconds: before + 7 });
      const after = (await bori.llm()).settings.cooldownSeconds;
      await unblockLlm();
      report.check(
        "설정 파일에 쓰지 못하면 PATCH는 500이고 값을 바꾸지 않는다",
        patched.status === 500 && typeof patched.body?.error === "string" && after === before,
        `status=${patched.status} cooldown=${after}/${before}`,
      );
    }

    // ── 개행이 섞인 키(L-4) ─────────────────────────────────
    {
      await writeFile(path("llm-config.json"), fixtureLlmConfig, "utf8");
      await boot({ OPENAI_API_KEY: NEWLINE_KEY });
      const conversation = (await send("POST", "/api/conversations", { title: "키" })).body.conversation;
      const sent = await send("POST", `/api/conversations/${conversation.id}/messages`, { content: "안녕하세요" });
      const llm = await bori.llm();
      const lastError = llm?.companionStatus?.lastError ?? "";
      const leaks = text => text.includes("AUDIT0123456789") || text.includes("TAILSECRETPART");
      report.check("개행이 섞인 키로 실패해도 답은 폴백으로 나간다", sent.status === 200 && sent.body?.failure?.kind === "call", JSON.stringify(sent.body?.failure));
      report.check("lastError에 키가 없다", lastError.length > 0 && !leaks(lastError), lastError);
      report.check("서버 로그에 키가 없다", !leaks(server.output()));
    }
  } finally {
    await server?.stop();
  }
}
