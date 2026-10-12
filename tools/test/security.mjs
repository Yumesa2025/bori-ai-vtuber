/**
 * 보안 경계 검사.
 *
 * 브라우저로 연 다른 웹사이트가 보리 서버의 응답을 읽거나 상태를 바꿀 수 없는지 실제 서버로 확인한다.
 * 브라우저가 붙이는 Origin 헤더를 직접 넣어 흉내 낸다. Host는 fetch로 바꿀 수 없어 node:http로 보낸다.
 */
import { request as httpRequest } from "node:http";

export const meta = {
  name: "보안 경계",
  timing: { llm: 300, tts: 200, embed: 100 },
};

const EVIL = "https://evil.example";
const ALLOWED = "http://127.0.0.1:4173";

/** Host 헤더를 지정해 GET을 보낸다. */
function getWithHost(baseUrl, path, host) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname, port, path, headers: { Host: host } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export async function run({ bori, report }) {
  const url = path => `${bori.baseUrl}${path}`;

  // ── Origin ─────────────────────────────────────────────────
  {
    const response = await fetch(url("/api/state"), { headers: { Origin: EVIL } });
    report.check("허용 밖 Origin의 GET은 403이다", response.status === 403, `status=${response.status}`);
    report.check("허용 밖 Origin에는 CORS 헤더를 주지 않는다", response.headers.get("access-control-allow-origin") === null);
    const body = await response.json().catch(() => null);
    report.check("거부 응답은 { error } 형식이고 상태를 담지 않는다", typeof body?.error === "string" && body.status === undefined);
  }
  {
    const response = await fetch(url("/api/session/start"), { method: "POST", headers: { Origin: EVIL } });
    const state = await bori.state();
    report.check("허용 밖 Origin은 본문 없는 POST로도 방송을 시작하지 못한다", response.status === 403 && state.status === "idle", `status=${response.status} 방송=${state.status}`);
  }
  {
    const response = await fetch(url("/api/state"), { headers: { Origin: ALLOWED } });
    report.check(
      "허용된 Origin은 통과하고 Allow-Origin에 그 Origin을 돌려준다",
      response.status === 200 && response.headers.get("access-control-allow-origin") === ALLOWED && response.headers.get("vary") === "Origin",
      `status=${response.status} allow=${response.headers.get("access-control-allow-origin")}`,
    );
  }
  {
    const response = await fetch(url("/api/state"));
    report.check("Origin이 없는 요청(도구·curl)은 통과하고 Allow-Origin: *를 주지 않는다", response.status === 200 && response.headers.get("access-control-allow-origin") === null);
  }

  // ── Host ───────────────────────────────────────────────────
  {
    const rebinding = await getWithHost(bori.baseUrl, "/api/state", "evil.example:4310");
    const loopback = await getWithHost(bori.baseUrl, "/api/state", "localhost:4310");
    report.check("루프백이 아닌 Host는 421이다 (DNS rebinding)", rebinding === 421, `status=${rebinding}`);
    report.check("localhost Host는 포트가 달라도 통과한다", loopback === 200, `status=${loopback}`);
  }

  // ── 경로 인코딩 ────────────────────────────────────────────
  {
    // 예전에는 /api/tts/:id의 decodeURIComponent 예외로 서버 프로세스가 그대로 죽었다.
    const host = new URL(bori.baseUrl).host;
    const statuses = [
      await getWithHost(bori.baseUrl, "/api/tts/%E0%A4%A", host),
      await getWithHost(bori.baseUrl, "/api/memory/%", host),
    ];
    const alive = await fetch(url("/api/health")).then(response => response.status).catch(() => 0);
    report.check("깨진 경로 인코딩은 400이고 서버는 계속 응답한다", statuses.every(status => status === 400) && alive === 200, `status=${statuses.join(",")} health=${alive}`);
  }

  // ── Content-Type과 본문 크기 ───────────────────────────────
  await bori.startSession();
  {
    // 사전 요청 없이 보낼 수 있는 폼 형식. 예전에는 이대로 채팅이 들어갔다.
    const response = await fetch(url("/api/chat"), { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ content: "text/plain으로 보낸 채팅" }) });
    const state = await bori.state();
    report.check("text/plain POST는 415이고 채팅이 들어가지 않는다", response.status === 415 && state.visibleChats.length === 0, `status=${response.status} 채팅=${state.visibleChats.length}`);
  }
  {
    const response = await fetch(url("/api/chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "가".repeat(40_000) }) });
    report.check("64KB를 넘는 본문은 413이다", response.status === 413, `status=${response.status}`);
  }
  {
    const response = await bori.reloadMacros();
    report.check("본문 없는 POST는 Content-Type 없이 통과한다", response.status === 200, `status=${response.status}`);
  }
  await bori.endSession();

  // ── 설정 검증 ──────────────────────────────────────────────
  {
    const before = (await bori.get("/api/settings")).body;
    const rejected = [
      await bori.patchSettings({ maxQueueSize: -1 }),
      await bori.patchSettings({ maxQueueSize: "100" }),
      await bori.patchSettings({ visibleChatLimit: 5, unknownKey: true }),
      await bori.patchSettings({ responseDelayMinSeconds: 30, responseDelayMaxSeconds: 10 }),
    ];
    const after = (await bori.get("/api/settings")).body;
    report.check("잘못된 큐 설정은 400이다", rejected.every(entry => entry.status === 400 && typeof entry.body?.error === "string"), rejected.map(entry => entry.status).join(","));
    report.check("거부된 큐 설정은 일부도 병합되지 않는다", JSON.stringify(before) === JSON.stringify(after));
  }
  {
    const before = (await bori.get("/api/memory")).body.settings;
    const rejected = [
      await sendPatch(url("/api/memory"), { maxMemories: 0 }),
      await sendPatch(url("/api/memory"), { minSimilarity: 2 }),
      await sendPatch(url("/api/memory"), { enabled: false, retentionDays: "30" }),
    ];
    const after = (await bori.get("/api/memory")).body.settings;
    report.check("잘못된 기억 설정은 400이고 값이 그대로다", rejected.every(status => status === 400) && JSON.stringify(before) === JSON.stringify(after), rejected.join(","));
  }
  {
    const before = (await bori.get("/api/tts")).body.settings;
    const rejected = [
      await sendPatch(url("/api/tts"), { voice: "../../voices" }),
      await sendPatch(url("/api/tts"), { speed: 10 }),
      await sendPatch(url("/api/tts"), { provider: "azure" }),
      await sendPatch(url("/api/tts"), { enabled: false, voice: "not-a-voice" }),
    ];
    const after = (await bori.get("/api/tts")).body.settings;
    report.check("잘못된 음성 설정은 400이고 값이 그대로다", rejected.every(status => status === 400) && JSON.stringify(before) === JSON.stringify(after), rejected.join(","));

    const accepted = await sendPatch(url("/api/tts"), { voice: "shimmer", speed: 1.25 });
    const changed = (await bori.get("/api/tts")).body.settings;
    report.check("올바른 음성 설정은 저장된다", accepted === 200 && changed.voice === "shimmer" && changed.speed === 1.25, `status=${accepted}`);
  }
}

async function sendPatch(target, payload) {
  const response = await fetch(target, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  await response.arrayBuffer();
  return response.status;
}
