/**
 * 대시보드 라우트와 보리 대사 LLM 감싸개 단위 검사.
 * 라우트는 가짜 대시보드 데이터·가짜 narrator를 주입한 작은 HTTP 서버로 실제 요청을 보내 본다.
 * 보안 경계(guard)는 guard.test.ts가 따로 본다. 여기서는 본문 검사·닉네임 정리·다시 듣기만 본다.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DashboardSettings, LlmSettings, Narration } from "@bori/shared";
import type { LlmRequest } from "@bori/llm";
import type { DashboardData, DashboardDataState } from "../src/er/dashboard-state.js";
import { handleDashboardRoute } from "../src/http/dashboard-routes.js";
import { narrationLlmFrom, parseNarrationJson, type CompleteFn } from "../src/narration-llm.js";

// ── 가짜 의존성 ───────────────────────────────────────────────

const STATE: DashboardDataState = {
  connection: "ready",
  refresh: { available: true, running: false, progress: null, lastError: null, autoStarted: false },
  basis: null,
  combos: [],
  player: { status: "unset", summary: null },
};

const NARRATION: Narration = { id: "n1", createdAt: "2026-11-21T00:00:00.000Z", source: "template", lines: [{ text: "안녕하세요.", emotion: "calm", audioId: "a1" }] };

/** 부른 순서를 남기는 가짜 대시보드 데이터. */
function fakeDashboard() {
  const calls: string[] = [];
  const saved: DashboardSettings[] = [];
  let current: DashboardSettings = { nickname: null };
  let setError: Error | null = null;
  let refreshResult = true;
  const dashboard: DashboardData = {
    state: () => { calls.push("state"); return STATE; },
    status: () => { calls.push("status"); return { connection: STATE.connection, refresh: STATE.refresh, basis: STATE.basis }; },
    maybeAutoRefresh: () => { calls.push("maybeAutoRefresh"); return false; },
    refresh: () => { calls.push("refresh"); return refreshResult; },
    settings: () => ({ ...current }),
    async setSettings(next) {
      if (setError) throw setError;
      saved.push(next);
      current = next;
    },
    onRefreshed: () => () => undefined,
  };
  return {
    dashboard,
    calls,
    saved,
    failSave(error: Error) { setError = error; },
    setRefreshResult(value: boolean) { refreshResult = value; },
  };
}

let fake = fakeDashboard();
let latest: Narration | null = NARRATION;
let replayed: Narration | null = NARRATION;

let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const handled = handleDashboardRoute(request.method, path, request, response, {
      dashboard: fake.dashboard,
      narrator: { latest: () => latest, replay: async () => replayed },
    });
    if (!handled) { response.writeHead(404); response.end(JSON.stringify({ error: "다음 라우트" })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  fake = fakeDashboard();
  latest = NARRATION;
  replayed = NARRATION;
});

async function send(method: string, path: string, body?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const putSettings = (payload: unknown) => send("PUT", "/api/dashboard/settings", JSON.stringify(payload));

// ── 라우트 ────────────────────────────────────────────────────

describe("대시보드 라우트", () => {
  test("GET /api/dashboard는 자동 갱신을 먼저 판정하고 상태와 최신 대사를 함께 돌려준다", async () => {
    const reply = await send("GET", "/api/dashboard");
    assert.equal(reply.status, 200);
    assert.deepEqual(fake.calls, ["maybeAutoRefresh", "state"]);
    assert.deepEqual(reply.body, { ...STATE, narration: NARRATION });
  });

  test("대사가 아직 없으면 narration은 null이다", async () => {
    latest = null;
    const reply = await send("GET", "/api/dashboard");
    assert.equal(reply.body.narration, null);
  });

  test("POST /api/er/refresh는 시작했는지 돌려준다", async () => {
    assert.deepEqual((await send("POST", "/api/er/refresh")).body, { started: true });
    fake.setRefreshResult(false);
    assert.deepEqual((await send("POST", "/api/er/refresh")).body, { started: false });
    assert.deepEqual(fake.calls, ["refresh", "refresh"]);
  });

  test("GET /api/dashboard/settings는 저장한 닉네임을 돌려준다", async () => {
    assert.deepEqual((await send("GET", "/api/dashboard/settings")).body, { nickname: null });
  });

  test("PUT은 앞뒤 공백을 떼고 저장한 뒤 저장한 값을 돌려준다", async () => {
    const reply = await putSettings({ nickname: "  가짜닉  " });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { nickname: "가짜닉" });
    assert.deepEqual(fake.saved, [{ nickname: "가짜닉" }]);
  });

  test("빈 문자열·공백·null은 닉네임을 지우는 뜻이다", async () => {
    for (const nickname of ["", "   ", null]) {
      const reply = await putSettings({ nickname });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { nickname: null });
    }
    assert.deepEqual(fake.saved, [{ nickname: null }, { nickname: null }, { nickname: null }]);
  });

  test("32자를 넘는 닉네임은 400이고 저장하지 않는다", async () => {
    assert.equal((await putSettings({ nickname: "가".repeat(32) })).status, 200);
    const reply = await putSettings({ nickname: "가".repeat(33) });
    assert.equal(reply.status, 400);
    assert.match(String(reply.body.error), /32자/);
    assert.equal(fake.saved.length, 1);
  });

  test("모양이 틀린 본문은 400이고 저장하지 않는다", async () => {
    for (const payload of [{ nickname: 3 }, {}, [], "가짜닉", { nickname: ["가짜닉"] }]) {
      const reply = await putSettings(payload);
      assert.equal(reply.status, 400, JSON.stringify(payload));
      assert.equal(typeof reply.body.error, "string");
    }
    assert.equal(fake.saved.length, 0);
  });

  test("JSON이 아닌 본문은 400 Invalid JSON이다", async () => {
    const reply = await send("PUT", "/api/dashboard/settings", "{ 깨짐");
    assert.deepEqual(reply, { status: 400, body: { error: "Invalid JSON" } });
  });

  test("저장이 실패하면 500이고 응답에 닉네임을 넣지 않는다", async () => {
    fake.failSave(new Error("EPERM 가짜닉"));
    const reply = await putSettings({ nickname: "가짜닉" });
    assert.equal(reply.status, 500);
    assert.ok(!JSON.stringify(reply.body).includes("가짜닉"));
  });

  test("POST /api/narration/replay는 최신 대사를 { narration }으로 돌려준다", async () => {
    replayed = { ...NARRATION, lines: [{ text: "안녕하세요.", emotion: "calm", audioId: "a2" }] };
    const reply = await send("POST", "/api/narration/replay");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { narration: replayed });
  });

  test("다시 들을 대사가 없으면 404다", async () => {
    replayed = null;
    const reply = await send("POST", "/api/narration/replay");
    assert.equal(reply.status, 404);
    assert.equal(typeof reply.body.error, "string");
  });

  test("모르는 경로와 메서드는 다음 라우트로 넘긴다", async () => {
    for (const [method, path] of [["GET", "/api/llm"], ["DELETE", "/api/dashboard"], ["GET", "/api/er/refresh"], ["GET", "/api/narration/replay"]] as const) {
      const reply = await send(method, path);
      assert.deepEqual(reply.body, { error: "다음 라우트" }, `${method} ${path}`);
    }
    assert.deepEqual(fake.calls, []);
  });
});

// ── LLM 감싸개 ────────────────────────────────────────────────

const SETTINGS: LlmSettings = { enabled: true, provider: "openai", model: "gpt-4o-mini", maxReplyLength: 120, timeoutMs: 8000, failureThreshold: 3, cooldownSeconds: 60 };

describe("narrationLlmFrom", () => {
  test("요청을 override 칸으로 넘기고, 지금 설정과 키를 쓰고, 성공하면 푼 값을 raw로 돌려준다", async () => {
    const seen: Array<{ settings: LlmSettings; apiKey: string; request: LlmRequest }> = [];
    const complete: CompleteFn = async (settings, apiKey, request, parse) => {
      seen.push({ settings, apiKey, request });
      const parsed = parse('{"lines":[{"text":"안녕","emotion":"calm","factIds":[]}]}');
      return parsed.ok ? { ok: true, value: parsed.value, latencyMs: 1 } : { ok: false, reason: parsed.reason, kind: "validation" };
    };
    let key = "첫 키";
    const llm = narrationLlmFrom(complete, () => ({ settings: SETTINGS, apiKey: key }));
    const result = await llm({ systemPrompt: "S", userPrompt: "U", schema: { type: "object" }, timeoutMs: 20000, maxOutputTokens: 512 });
    assert.deepEqual(result, { ok: true, raw: { lines: [{ text: "안녕", emotion: "calm", factIds: [] }] } });
    assert.deepEqual(seen[0]?.request, { overrideSystemPrompt: "S", overrideUserPrompt: "U", overrideSchema: { type: "object" }, timeoutMs: 20000, maxOutputTokens: 512 });
    assert.equal(seen[0]?.apiKey, "첫 키");
    // 키를 바꾸면 다음 호출부터 새 키를 쓴다
    key = "새 키";
    await llm({ systemPrompt: "S", userPrompt: "U", schema: {}, timeoutMs: 1000 });
    assert.equal(seen[1]?.apiKey, "새 키");
    assert.equal("maxOutputTokens" in (seen[1]?.request ?? {}), false);
  });

  test("꺼짐·회로·호출 실패는 ok:false이고 이유에 종류가 붙는다", async () => {
    for (const kind of ["disabled", "circuit", "call", "validation"] as const) {
      const complete: CompleteFn = async () => ({ ok: false, reason: "이유", kind });
      const result = await narrationLlmFrom(complete, () => ({ settings: SETTINGS, apiKey: "k" }))({ systemPrompt: "", userPrompt: "", schema: {}, timeoutMs: 1 });
      assert.deepEqual(result, { ok: false, reason: `${kind}: 이유` });
    }
  });

  test("parse는 JSON 객체에 lines 배열이 있어야 통과한다(아니면 validation으로 회로 차단에 센다)", () => {
    assert.deepEqual(parseNarrationJson('{"lines":[]}'), { ok: true, value: { lines: [] } });
    for (const raw of ["{ 깨짐", "null", "[]", '{"lines":"아님"}', '{"reply":"옛 모양"}']) {
      assert.equal(parseNarrationJson(raw).ok, false, raw);
    }
  });
});
