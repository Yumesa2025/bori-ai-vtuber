/**
 * 1:1 기록 삭제와 보관 정리 검사.
 *
 * - DELETE /api/me/data가 1:1 대화·메시지·요약·개인 기억을 한 번에 지우고 방송 기억은 남기는지
 * - DELETE /api/me/memories는 지금처럼 개인 기억만 지우는지
 * - 서버를 시작할 때 30일 지난 백업·이전 로그만 지우고 사용자 데이터 원본은 남기는지
 */
import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runningScript, waitForHttp } from "./harness.mjs";

export const meta = {
  name: "1:1 기록 삭제·보관 정리",
  timing: { llm: 300, tts: 200, embed: 100 },
};

const PRIVATE_MEMORY = "저는 퇴근하고 재즈 피아노 듣는 걸 좋아해요";
const DAY_MS = 86_400_000;

export async function run({ bori, mock, report, dataDir }) {
  const send = async (method, path, payload) => {
    const response = await fetch(`${bori.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const broadcastRecords = async () => (await bori.memory()).records.filter(record => record.scope !== "private").map(record => record.id).sort();
  /** 개인 기억이 생길 때까지 잠깐 기다린다. LLM 정리는 답변 뒤에 백그라운드로 끝난다. */
  const privateMemoriesSoon = async () => {
    let memories = [];
    for (let tries = 0; tries < 50 && memories.length === 0; tries += 1) {
      memories = (await send("GET", "/api/me/memories")).body?.memories ?? [];
      if (memories.length === 0) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return memories;
  };

  // ── 1:1 기록 모두 지우기 ───────────────────────────────────
  {
    const broadcastBefore = await broadcastRecords();
    const first = (await send("POST", "/api/conversations", { title: "첫 대화" })).body.conversation;
    const second = (await send("POST", "/api/conversations", { title: "둘째 대화" })).body.conversation;
    await send("POST", `/api/conversations/${first.id}/messages`, { content: PRIVATE_MEMORY });
    // 다른 대화로 옮기면 앞 대화의 남은 메시지를 LLM이 기억으로 정리한다(점검 M-6). 정리는 답변 뒤에 끝난다.
    await send("POST", `/api/conversations/${second.id}/messages`, { content: "안녕" });
    const mine = await privateMemoriesSoon();
    report.check("삭제 전에 1:1 대화와 개인 기억이 있다", mine.length > 0 && broadcastBefore.length > 0, `개인 기억 ${mine.length}건, 방송 기억 ${broadcastBefore.length}건`);

    // 기억만 지우는 기존 동작은 그대로다.
    const memoriesOnly = await send("DELETE", "/api/me/memories");
    const listAfterMemories = (await send("GET", "/api/conversations")).body?.conversations ?? [];
    report.check(
      "DELETE /api/me/memories는 개인 기억만 지우고 대화는 남긴다",
      memoriesOnly.status === 200 && memoriesOnly.body?.deleted === mine.length && listAfterMemories.length === 2,
      `deleted=${memoriesOnly.body?.deleted} 대화=${listAfterMemories.length}`,
    );

    // 기억을 다시 만든 뒤 전체를 지운다. 새 대화를 열어 첫 대화의 남은 메시지를 정리하게 한다.
    await send("POST", `/api/conversations/${first.id}/messages`, { content: PRIVATE_MEMORY });
    await send("POST", "/api/conversations", { title: "셋째 대화" });
    await privateMemoriesSoon();
    const wrongMethod = await send("GET", "/api/me/data");
    const cleared = await send("DELETE", "/api/me/data");
    const list = (await send("GET", "/api/conversations")).body?.conversations ?? [];
    const memories = (await send("GET", "/api/me/memories")).body?.memories ?? [];
    const gone = await send("GET", `/api/conversations/${first.id}/messages`);
    const file = await readFile(join(dataDir, "companion-conversations.json"), "utf8").catch(() => "");
    report.check("GET /api/me/data는 405다", wrongMethod.status === 405, `status=${wrongMethod.status}`);
    report.check(
      "DELETE /api/me/data는 지운 대화·메시지·기억 수를 돌려준다",
      cleared.status === 200 && cleared.body?.deleted?.conversations === 3 && cleared.body.deleted.messages === 6 && cleared.body.deleted.memories >= 1,
      JSON.stringify(cleared.body),
    );
    report.check(
      "전체 삭제 뒤 대화·메시지·개인 기억이 남지 않고 파일에도 없다",
      list.length === 0 && memories.length === 0 && gone.status === 404 && !file.includes(PRIVATE_MEMORY) && !file.includes("첫 대화"),
    );
    report.check("전체 삭제는 방송 기억을 건드리지 않는다", JSON.stringify(await broadcastRecords()) === JSON.stringify(broadcastBefore));
  }

  // ── 진행 중인 정리와 관리자 삭제(점검 M-9, a2 race-adminall) ─────
  {
    // 정리 요청만 늦게 오게 한다. 그 사이 관리자가 기억을 모두 지운다.
    await mock.inject({ target: "llm", mode: "delay", ms: 1500, match: "오래 기억할 내용" });
    const conversation = (await send("POST", "/api/conversations", { title: "경합" })).body.conversation;
    await send("POST", `/api/conversations/${conversation.id}/messages`, { content: PRIVATE_MEMORY });
    await send("POST", "/api/conversations", { title: "경합 다음" });
    await new Promise(resolve => setTimeout(resolve, 300));
    const cleared = await send("DELETE", "/api/memory/all");
    await new Promise(resolve => setTimeout(resolve, 2500));
    const mine = (await send("GET", "/api/me/memories")).body?.memories ?? [];
    const file = await readFile(join(dataDir, "memories.json"), "utf8").catch(() => "");
    report.check(
      "관리자 전체 삭제 뒤에 끝난 1:1 정리는 기억을 되살리지 않는다",
      cleared.status === 200 && mine.length === 0 && !file.includes("정리표시") && !file.includes("재즈 피아노"),
      `status=${cleared.status} 개인 기억 ${mine.length}건`,
    );
    await mock.clearInjections();
    await send("DELETE", "/api/me/data");
  }

  // ── 백업·로그 보관 정리 ─────────────────────────────────────
  {
    const server = runningScript("bori-server");
    await server.stop();

    const old = new Date(Date.now() - 40 * DAY_MS);
    const recent = new Date(Date.now() - 5 * DAY_MS);
    const files = {
      oldMemoryBackup: "memories.v1-backup-2026-08-01T00-00-00-000Z.json",
      oldUnreadable: "companion-conversations.unreadable-2026-08-01T00-00-00-000Z-1.json",
      oldPreviousLog: "admin-renderer.previous.log",
      recentBackup: "memories.v1-backup-2026-10-07T00-00-00-000Z.json",
      // 이름이 비슷해도 정해진 형식이 아니면 지우지 않는다.
      lookalike: "memories.v1-backup-notes.txt",
      // 사용자 데이터 원본과 지금 쓰는 로그는 오래돼도 지우지 않는다.
      original: "companion-conversations.json",
      currentLog: "admin-renderer.log",
      macros: "macros.json",
    };
    for (const [key, name] of Object.entries(files)) {
      const path = join(dataDir, name);
      if (key !== "original" && key !== "macros") await writeFile(path, "{}", "utf8");
      await utimes(path, key === "recentBackup" ? recent : old, key === "recentBackup" ? recent : old);
    }

    await server.restart();
    await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버" });
    const left = new Set(await readdir(dataDir));
    report.check(
      "서버를 시작할 때 30일 지난 백업과 이전 관리자 로그를 지운다",
      !left.has(files.oldMemoryBackup) && !left.has(files.oldUnreadable) && !left.has(files.oldPreviousLog),
      [...left].sort().join(", "),
    );
    report.check(
      "30일 안의 백업, 형식이 다른 파일, 사용자 데이터 원본과 지금 로그는 남긴다",
      [files.recentBackup, files.lookalike, files.original, files.currentLog, files.macros].every(name => left.has(name)),
    );
  }
}
