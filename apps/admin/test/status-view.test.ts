/**
 * 보리 스튜디오 설정 탭이 그릴 문구와 판정 단위 검사.
 * 연결 표시, ER 데이터 상태 문구, 게임 닉네임 저장 본문을 본다. 화면은 띄우지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connectionBadge, erSummary, llmConnection, NICKNAME_MAX, nicknameBody, ttsConnection, type ErDataView } from "../src/studio/status-view";

describe("연결 표시", () => {
  test("상태마다 색과 문구를 준다", () => {
    assert.deepEqual(connectionBadge("connected"), { tone: "ok", text: "연결됨" });
    assert.deepEqual(connectionBadge("ready"), { tone: "ok", text: "준비됨" });
    assert.deepEqual(connectionBadge("refreshing"), { tone: "warn", text: "갱신 중" });
    assert.deepEqual(connectionBadge("stale"), { tone: "warn", text: "오래됨" });
    assert.deepEqual(connectionBadge("error"), { tone: "bad", text: "오류" });
    assert.deepEqual(connectionBadge("missing"), { tone: "bad", text: "데이터 없음" });
    assert.deepEqual(connectionBadge("off"), { tone: "off", text: "꺼짐" });
    assert.deepEqual(connectionBadge("unknown"), { tone: "off", text: "확인 중" });
  });

  test("LLM은 켜져 있고 키가 있어야 연결이고, 회로가 열리면 오류다", () => {
    const base = { enabled: true, hasApiKey: true, circuitOpen: false };
    assert.equal(llmConnection(null), "unknown");
    assert.equal(llmConnection(base), "connected");
    assert.equal(llmConnection({ ...base, circuitOpen: true }), "error");
    assert.equal(llmConnection({ ...base, enabled: false }), "off");
    assert.equal(llmConnection({ ...base, hasApiKey: false }), "off");
  });

  test("TTS는 켜져 있고 키가 있어야 연결이다", () => {
    assert.equal(ttsConnection(null), "unknown");
    assert.equal(ttsConnection({ settings: { enabled: true }, hasApiKey: true }), "connected");
    assert.equal(ttsConnection({ settings: { enabled: false }, hasApiKey: true }), "off");
    assert.equal(ttsConnection({ settings: { enabled: true }, hasApiKey: false }), "off");
  });
});

describe("ER 데이터 상태", () => {
  const basis = {
    seasonId: 43, seasonName: "시즌 13", patch: "13.1", games: 1234, participants: 29616, rankers: 100, gamesPerRanker: 3,
    collectedAt: new Date(2026, 9, 15, 14, 3).toISOString(), previousCollectedAt: null, patchChanged: false,
  };
  const refresh = { available: true, running: false, progress: null, lastError: null, autoStarted: false };
  const view = (overrides: Partial<ErDataView> = {}): ErDataView => ({ connection: "ready", refresh, basis, ...overrides });

  test("기준 시즌·패치·경기 수와 마지막 갱신 시각, 상태 배지를 보여 준다", () => {
    const summary = erSummary(view());
    assert.equal(summary.title, "시즌 13 · 패치 13.1 · 경기 1,234판");
    assert.equal(summary.updated, "마지막 갱신 10월 15일 14:03");
    assert.equal(summary.description, "상위 랭커 100명의 랭크 경기 1,234판(참가자 29,616명) 기준");
    assert.equal(summary.progress, null);
    assert.deepEqual(summary.badge, { tone: "ok", text: "준비됨" });
    assert.equal(summary.canRefresh, true);
  });

  test("패치를 모르면 패치는 빼고 말한다", () => {
    assert.equal(erSummary(view({ basis: { ...basis, patch: null } })).title, "시즌 13 · 경기 1,234판");
  });

  test("갱신 중이면 진행률을 보이고 버튼을 끈다", () => {
    const summary = erSummary(view({ connection: "refreshing", refresh: { ...refresh, running: true, progress: 0.426 } }));
    assert.equal(summary.progress, "갱신 중 43%");
    assert.deepEqual(summary.badge, { tone: "warn", text: "갱신 중" });
    assert.equal(summary.canRefresh, false);
  });

  test("데이터가 없으면 그렇다고 말하고, 키가 없으면 버튼을 끈다", () => {
    const empty = erSummary(view({ connection: "missing", basis: null, refresh: { ...refresh, available: false, lastError: "키 없음" } }));
    assert.equal(empty.title, "데이터 없음");
    assert.equal(empty.updated, "아직 갱신하지 않았습니다");
    assert.equal(empty.description, "");
    assert.equal(empty.canRefresh, false);
    assert.equal(empty.lastError, "키 없음");
  });

  test("아직 받지 못했으면 확인 중이다", () => {
    const unknown = erSummary(null);
    assert.equal(unknown.title, "확인 중");
    assert.deepEqual(unknown.badge, { tone: "off", text: "확인 중" });
    assert.equal(unknown.canRefresh, false);
  });
});

describe("게임 닉네임 저장 본문", () => {
  test("앞뒤 공백을 떼고 보낸다", () => {
    assert.deepEqual(nicknameBody("  보리팬  "), { ok: true, body: { nickname: "보리팬" } });
  });

  test("비우면 null로 보내 저장한 닉네임을 지운다", () => {
    assert.deepEqual(nicknameBody("   "), { ok: true, body: { nickname: null } });
  });

  test("입력칸 상한(32자)을 넘으면 보내지 않는다. 게임 닉네임 규칙은 서버·ER API가 판단한다", () => {
    assert.equal(nicknameBody("가".repeat(32)).ok, true);
    const rejected = nicknameBody("가".repeat(33));
    assert.equal(rejected.ok, false);
    assert.ok(!rejected.ok && rejected.error.includes("32자"));
    // 입력칸 maxLength도 이 값이다(서버 상한 32와 같다)
    assert.equal(NICKNAME_MAX, 32);
  });
});
