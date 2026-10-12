/**
 * API 사용량 단위 검사. 날짜별 누계·보관 기간·원자적 쓰기, 비용 추정, 단가 파일, 어댑터 감싸기를 본다.
 * 임시 디렉터리에만 쓰고 네트워크를 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { LlmAdapter, LlmRequest } from "@bori/llm";
import type { EmbeddingProvider } from "@bori/memory";
import {
  buildUsageReport,
  createUsageStore,
  DEFAULT_PRICES_AS_OF,
  loadPriceTable,
  localDateKey,
  trackAdapter,
  trackEmbedding,
  USAGE_FILE_VERSION,
  type UsageEvent,
} from "../src/usage/index.js";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "bori-usage-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 로컬 시각으로 날짜를 고정한다. 날짜 경계는 로컬 기준이다. */
const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();
const silent = () => {};
const noPrices = { prices: new Map(), fileLoaded: false, fileError: null };

const reply = (extra: Partial<UsageEvent> = {}): UsageEvent => ({ feature: "reply", mode: "broadcast", model: "gpt-4o-mini", ok: true, usage: { inputTokens: 100, outputTokens: 20 }, ...extra });

describe("사용량 저장소", () => {
  test("같은 날·기능·모드·모델은 한 줄로 더하고 실패는 토큰을 세지 않는다", () => {
    const dir = tempDir();
    const store = createUsageStore(join(dir, "usage.json"), { now: () => at(2026, 10, 12), log: silent });
    store.load();
    store.record(reply());
    store.record(reply());
    store.record(reply({ ok: false, usage: undefined }));
    store.record(reply({ usage: undefined }));
    store.record(reply({ mode: "companion" }));

    const today = store.days()["2026-10-12"];
    assert.equal(today.length, 2);
    assert.deepEqual(today[0], { feature: "reply", mode: "broadcast", model: "gpt-4o-mini", calls: 4, failures: 1, inputTokens: 200, outputTokens: 40, callsWithoutTokens: 1, characters: 0 });
    assert.equal(today[1].mode, "companion");
  });

  test("모드가 없는 호출은 none으로, 음성은 글자 수로 센다", () => {
    const store = createUsageStore(join(tempDir(), "usage.json"), { now: () => at(2026, 10, 12), log: silent });
    store.record({ feature: "embedding", mode: null, model: "text-embedding-3-small", ok: true });
    store.record({ feature: "tts", mode: "companion", model: "tts-1", ok: true, characters: 12 });
    const today = store.days()["2026-10-12"];
    assert.equal(today[0].mode, "none");
    assert.equal(today[0].callsWithoutTokens, 1);
    assert.equal(today[1].characters, 12);
    assert.equal(today[1].callsWithoutTokens, 0);
  });

  test("파일에 version과 숫자만 쓰고 다시 읽는다", () => {
    const filePath = join(tempDir(), "usage.json");
    const store = createUsageStore(filePath, { now: () => at(2026, 10, 12), log: silent });
    store.record(reply());

    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(saved.version, USAGE_FILE_VERSION);
    assert.deepEqual(Object.keys(saved.days), ["2026-10-12"]);

    const reloaded = createUsageStore(filePath, { now: () => at(2026, 10, 12), log: silent });
    reloaded.load();
    assert.equal(reloaded.days()["2026-10-12"][0].calls, 1);
  });

  test("오늘을 포함해 31일만 남긴다", () => {
    const filePath = join(tempDir(), "usage.json");
    let now = at(2026, 9, 1);
    const store = createUsageStore(filePath, { now: () => now, log: silent });
    store.record(reply());
    now = at(2026, 10, 1);
    store.record(reply());
    // 9월 1일은 10월 1일 기준 30일 전이라 아직 남는다.
    assert.deepEqual(Object.keys(store.days()).sort(), ["2026-09-01", "2026-10-01"]);
    now = at(2026, 10, 2);
    store.record(reply());
    assert.deepEqual(Object.keys(store.days()).sort(), ["2026-10-01", "2026-10-02"]);

    // 읽을 때도 지난 날은 버린다.
    const reloaded = createUsageStore(filePath, { now: () => at(2026, 11, 5), log: silent });
    reloaded.load();
    assert.deepEqual(Object.keys(reloaded.days()), []);
  });

  test("읽을 수 없는 파일과 형식이 틀린 줄은 버린다", () => {
    const dir = tempDir();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ 깨진", "utf8");
    const logs: string[] = [];
    const store = createUsageStore(broken, { now: () => at(2026, 10, 12), log: message => logs.push(message) });
    store.load();
    assert.deepEqual(store.days(), {});
    assert.equal(logs.length, 1);

    const partial = join(dir, "partial.json");
    writeFileSync(partial, JSON.stringify({
      version: 1,
      days: { "2026-10-12": [{ ...reply(), usage: undefined, calls: 1, failures: 0, inputTokens: 1, outputTokens: 1, callsWithoutTokens: 0, characters: 0, mode: "broadcast" }, { feature: "unknown", mode: "none", model: "x", calls: 1 }] },
    }), "utf8");
    const second = createUsageStore(partial, { now: () => at(2026, 10, 12), log: silent });
    second.load();
    assert.equal(second.days()["2026-10-12"].length, 1);
  });

  test("쓰기에 실패해도 던지지 않고 임시 파일을 남기지 않는다", () => {
    const dir = tempDir();
    const logs: string[] = [];
    const store = createUsageStore(join(dir, "usage.json"), {
      now: () => at(2026, 10, 12),
      log: message => logs.push(message),
      rename: () => { throw new Error("디스크 오류"); },
    });
    assert.doesNotThrow(() => store.record(reply()));
    assert.equal(store.days()["2026-10-12"][0].calls, 1);
    assert.deepEqual(readdirSync(dir), []);
    assert.match(logs[0], /저장하지 못했습니다/);
  });
});

describe("비용 추정", () => {
  const now = at(2026, 10, 12);
  const prices = loadPriceTable(join(tempDir(), "없는-파일.json"));

  test("기본 단가로 토큰 비용을 계산하고 기간을 나눈다", () => {
    const days = {
      "2026-10-12": [{ feature: "reply" as const, mode: "broadcast" as const, model: "gpt-4o-mini", calls: 2, failures: 0, inputTokens: 1_000_000, outputTokens: 1_000_000, callsWithoutTokens: 0, characters: 0 }],
      "2026-10-08": [{ feature: "tts" as const, mode: "companion" as const, model: "tts-1", calls: 1, failures: 0, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 0, characters: 2_000 }],
      "2026-09-20": [{ feature: "summary" as const, mode: "companion" as const, model: "claude-sonnet-5", calls: 1, failures: 0, inputTokens: 500_000, outputTokens: 100_000, callsWithoutTokens: 0, characters: 0 }],
    };
    const report = buildUsageReport(days, prices, now);

    assert.equal(report.today.from, "2026-10-12");
    assert.equal(report.today.totals.calls, 2);
    assert.ok(Math.abs((report.today.totals.estimatedCostUsd ?? 0) - 0.75) < 1e-9);
    assert.equal(report.last7Days.from, "2026-10-06");
    assert.equal(report.last7Days.totals.calls, 3);
    assert.ok(Math.abs((report.last7Days.byFeature.tts.estimatedCostUsd ?? 0) - 0.03) < 1e-9);
    assert.equal(report.last31Days.totals.calls, 4);
    // 500k 입력 × 2 + 100k 출력 × 10 = 1 + 1
    assert.ok(Math.abs((report.last31Days.byFeature.summary.estimatedCostUsd ?? 0) - 2) < 1e-9);
    assert.equal(report.last31Days.byMode.companion.calls, 2);
    assert.equal(report.last31Days.totals.costComplete, true);
    assert.equal(report.prices.defaultAsOf, DEFAULT_PRICES_AS_OF);
    assert.match(report.prices.note, /추정치/);
  });

  test("단가를 모르는 모델은 비용 null과 단가 없음으로 표시하고 합계는 아는 부분만 더한다", () => {
    const days = {
      "2026-10-12": [
        { feature: "reply" as const, mode: "broadcast" as const, model: "알수없는-모델", calls: 1, failures: 0, inputTokens: 10, outputTokens: 10, callsWithoutTokens: 0, characters: 0 },
        { feature: "reply" as const, mode: "companion" as const, model: "gpt-4o-mini", calls: 1, failures: 0, inputTokens: 1_000_000, outputTokens: 0, callsWithoutTokens: 0, characters: 0 },
        { feature: "tts" as const, mode: "broadcast" as const, model: "eleven_multilingual_v2", calls: 1, failures: 0, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 0, characters: 50 },
      ],
    };
    const report = buildUsageReport(days, prices, now);
    const unknown = report.today.rows.find(row => row.model === "알수없는-모델");
    assert.equal(unknown?.estimatedCostUsd, null);
    assert.equal(unknown?.costNote, "단가 없음");
    assert.deepEqual(report.today.unpricedModels.sort(), ["eleven_multilingual_v2", "알수없는-모델"].sort());
    assert.ok(Math.abs((report.today.totals.estimatedCostUsd ?? 0) - 0.15) < 1e-9);
    assert.equal(report.today.totals.costComplete, false);
    assert.equal(report.today.byMode.broadcast.estimatedCostUsd, null);
  });

  test("토큰 정보가 없는 호출은 추측하지 않는다", () => {
    const days = {
      "2026-10-12": [
        { feature: "embedding" as const, mode: "none" as const, model: "text-embedding-3-small", calls: 3, failures: 0, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 3, characters: 0 },
        { feature: "reply" as const, mode: "broadcast" as const, model: "gpt-4o-mini", calls: 2, failures: 0, inputTokens: 100, outputTokens: 0, callsWithoutTokens: 1, characters: 0 },
        { feature: "digest" as const, mode: "companion" as const, model: "모르는-모델", calls: 2, failures: 2, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 0, characters: 0 },
      ],
    };
    const rows = buildUsageReport(days, prices, now).today.rows;
    const embedding = rows.find(row => row.feature === "embedding");
    assert.equal(embedding?.estimatedCostUsd, null);
    assert.equal(embedding?.costNote, "토큰 정보 없음");
    const replyRow = rows.find(row => row.feature === "reply");
    assert.equal(replyRow?.costNote, "일부 호출 토큰 정보 없음");
    assert.equal(replyRow?.costComplete, false);
    // 모두 실패한 호출은 과금되지 않았으므로 단가를 몰라도 0이다.
    const failed = rows.find(row => row.feature === "digest");
    assert.equal(failed?.estimatedCostUsd, 0);
    assert.equal(failed?.costNote, null);
  });

  test("호출이 없으면 비용은 0이고 빠진 것이 없다", () => {
    const report = buildUsageReport({}, noPrices, now);
    assert.equal(report.today.totals.estimatedCostUsd, 0);
    assert.equal(report.today.totals.costComplete, true);
    assert.equal(report.generatedAt, new Date(now).toISOString());
  });
});

describe("단가 파일", () => {
  test("파일 단가가 같은 모델의 기본값을 덮고 나머지 기본값은 남는다", () => {
    const filePath = join(tempDir(), "usage-prices.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, models: { "gpt-4o-mini": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }, "my-model": { inputPerMillionUsd: 3, outputPerMillionUsd: 4 } } }), "utf8");
    const table = loadPriceTable(filePath);
    assert.equal(table.fileLoaded, true);
    assert.equal(table.fileError, null);
    assert.deepEqual(table.prices.get("gpt-4o-mini"), { model: "gpt-4o-mini", inputPerMillionUsd: 1, outputPerMillionUsd: 2, source: "file" });
    assert.equal(table.prices.get("my-model")?.source, "file");
    assert.equal(table.prices.get("tts-1")?.source, "default");
  });

  test("형식이 틀리면 파일 전체를 쓰지 않고 이유를 남긴다", () => {
    const dir = tempDir();
    const cases: [string, unknown][] = [
      ["깨진 JSON", "{"],
      ["version 없음", { models: {} }],
      ["음수 단가", { version: 1, models: { "gpt-4o-mini": { inputPerMillionUsd: -1 } } }],
      ["모르는 필드", { version: 1, models: { "gpt-4o-mini": { price: 1 } } }],
      ["문자열 단가", { version: 1, models: { "gpt-4o-mini": { inputPerMillionUsd: "1" } } }],
    ];
    for (const [label, content] of cases) {
      const filePath = join(dir, `${label}.json`);
      writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content), "utf8");
      const table = loadPriceTable(filePath);
      assert.equal(table.fileLoaded, false, label);
      assert.ok(table.fileError, label);
      assert.equal(table.prices.get("gpt-4o-mini")?.source, "default", label);
    }
  });
});

describe("어댑터·임베딩 감싸기", () => {
  const request = { mode: "companion", content: "비밀 내용", overrideSystemPrompt: "요약" } as LlmRequest;

  test("요청의 모드로 기능별 호출을 세고 내용은 넘기지 않는다", async () => {
    const events: UsageEvent[] = [];
    const adapter: LlmAdapter = { name: "fake", isConfigured: () => true, complete: async () => ({ raw: "{}", latencyMs: 1, usage: { inputTokens: 5, outputTokens: 2 } }) };
    const tracked = trackAdapter(adapter, "gpt-4o-mini", "digest", event => events.push(event));
    await tracked.complete(request);
    assert.deepEqual(events, [{ feature: "digest", mode: "companion", model: "gpt-4o-mini", ok: true, usage: { inputTokens: 5, outputTokens: 2 } }]);
    assert.ok(!JSON.stringify(events).includes("비밀 내용"));
  });

  test("실패는 기록하고 예외를 그대로 던진다", async () => {
    const events: UsageEvent[] = [];
    const adapter: LlmAdapter = { name: "fake", isConfigured: () => true, complete: async () => { throw new Error("업체 오류"); } };
    await assert.rejects(trackAdapter(adapter, "m", "summary", event => events.push(event)).complete({ ...request, mode: "broadcast" }), /업체 오류/);
    assert.deepEqual(events, [{ feature: "summary", mode: "broadcast", model: "m", ok: false }]);
  });

  test("임베딩은 모드 없이 횟수만 센다", async () => {
    const events: UsageEvent[] = [];
    const provider: EmbeddingProvider = { name: "fake", isConfigured: () => true, embed: async texts => texts.map(() => [1]) };
    const vectors = await trackEmbedding(provider, "text-embedding-3-small", event => events.push(event)).embed(["a", "b"]);
    assert.deepEqual(vectors, [[1], [1]]);
    assert.deepEqual(events, [{ feature: "embedding", mode: null, model: "text-embedding-3-small", ok: true }]);
  });

  test("기록이 던져도 결과는 그대로 돌려준다", async () => {
    const adapter: LlmAdapter = { name: "fake", isConfigured: () => true, complete: async () => ({ raw: "{\"ok\":1}", latencyMs: 1 }) };
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await trackAdapter(adapter, "m", "summary", () => { throw new Error("기록 실패"); }).complete(request);
      assert.equal(result.raw, "{\"ok\":1}");
    } finally {
      console.error = originalError;
    }
  });
});

describe("localDateKey", () => {
  test("로컬 날짜 YYYY-MM-DD", () => {
    assert.equal(localDateKey(at(2026, 1, 5, 0)), "2026-01-05");
    assert.equal(localDateKey(at(2026, 12, 31, 23)), "2026-12-31");
  });
});
