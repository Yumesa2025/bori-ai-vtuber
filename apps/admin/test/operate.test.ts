/**
 * 보리 스튜디오 운영 탭 단위 검사.
 * 단계·버튼 이름, 연결 표시, OBS 주소, ER 데이터 상태 문구, 채팅·답 로그, Space 단축키 판정을 본다.
 * 화면은 띄우지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { showStages, type BroadcastState, type VisibleChat } from "@bori/shared";
import { connectionBadge, emptyShowLog, erSummary, isNextShortcut, llmConnection, mergeShowLog, nextLabel, obsUrls, stageLabel, ttsConnection, viewerChatBody } from "../src/studio/operate";

describe("단계 이름", () => {
  test("단계마다 번호 붙은 이름을 준다", () => {
    assert.equal(stageLabel("idle"), "대기");
    assert.equal(stageLabel("opening"), "① 오프닝");
    assert.equal(stageLabel("briefing"), "② 메타 브리핑");
    assert.equal(stageLabel("qna"), "③ 질문 코너");
    assert.equal(stageLabel("diagnosis"), "④ 전적 진단");
    assert.equal(stageLabel("ending"), "⑤ 엔딩");
  });

  test("다음 단계 버튼은 다음에 시작할 단계를 말하고, 엔딩이면 끝이다", () => {
    assert.equal(nextLabel("idle"), "오프닝 시작");
    assert.equal(nextLabel("opening"), "메타 브리핑 시작");
    assert.equal(nextLabel("briefing"), "질문 코너 시작");
    assert.equal(nextLabel("qna"), "전적 진단 시작");
    assert.equal(nextLabel("diagnosis"), "엔딩 시작");
    assert.equal(nextLabel("ending"), "끝");
  });

  test("모든 단계에 이름이 있다", () => {
    for (const stage of showStages) {
      assert.ok(stageLabel(stage).length > 0, stage);
      assert.ok(nextLabel(stage).length > 0, stage);
    }
  });
});

describe("연결 표시", () => {
  test("상태마다 색과 문구를 준다", () => {
    assert.deepEqual(connectionBadge("connected"), { tone: "ok", text: "연결됨" });
    assert.deepEqual(connectionBadge("ready"), { tone: "ok", text: "준비됨" });
    assert.deepEqual(connectionBadge("connecting"), { tone: "warn", text: "연결 중" });
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

describe("OBS 주소", () => {
  test("서버 주소 아래 OBS 페이지 7개(배경 포함)를 준다", () => {
    const urls = obsUrls("http://127.0.0.1:4310");
    assert.deepEqual(urls.map(item => item.url), ["character", "dashboard", "caption", "chat", "waiting", "ending", "background"].map(name => `http://127.0.0.1:4310/obs/${name}.html`));
    assert.ok(urls.every(item => item.label.length > 0));
  });

  test("끝 슬래시가 있어도 주소가 겹치지 않는다", () => {
    assert.equal(obsUrls("http://127.0.0.1:4850/")[0]?.url, "http://127.0.0.1:4850/obs/character.html");
  });
});

describe("ER 데이터 상태", () => {
  const basis = { seasonName: "시즌 21", sampleGames: 7200, collectedAt: new Date(2026, 9, 15, 14, 3).toISOString(), description: "최근 7일 상위 랭커 7,200판 기준" };

  test("기준 시즌·판 수·마지막 갱신 시각을 보여 준다", () => {
    const summary = erSummary({ basis, refreshing: false, progress: null, lastError: null });
    assert.equal(summary.title, "시즌 21 · 7,200판");
    assert.equal(summary.updated, "마지막 갱신 10월 15일 14:03");
    assert.equal(summary.description, "최근 7일 상위 랭커 7,200판 기준");
    assert.equal(summary.progress, null);
  });

  test("갱신 중이면 진행률을, 데이터가 없으면 그렇다고 말한다", () => {
    assert.equal(erSummary({ basis: null, refreshing: true, progress: 0.426, lastError: null }).progress, "갱신 중 43%");
    const empty = erSummary({ basis: null, refreshing: false, progress: null, lastError: "키 없음" });
    assert.equal(empty.title, "데이터 없음");
    assert.equal(empty.updated, "아직 갱신하지 않았습니다");
    assert.equal(erSummary(null).title, "확인 중");
  });
});

describe("채팅·답 로그", () => {
  const chat = (id: string, content: string): VisibleChat => ({ id, content, receivedAt: "2026-10-15T05:00:00.000Z", category: "normal" } as VisibleChat);
  const stateWith = (chats: VisibleChat[], reply?: string) => ({ visibleChats: chats, currentResponse: reply === undefined ? undefined : { reply } } as unknown as BroadcastState);

  test("새 채팅과 새 답만 차례로 더한다", () => {
    let log = mergeShowLog(emptyShowLog, stateWith([chat("a", "안녕")]));
    log = mergeShowLog(log, stateWith([chat("a", "안녕"), chat("b", "재키 어때?")], "재키는 요즘 좋아요!"));
    log = mergeShowLog(log, stateWith([chat("a", "안녕"), chat("b", "재키 어때?")], "재키는 요즘 좋아요!"));
    assert.deepEqual(log.lines.map(line => [line.kind, line.text]), [["chat", "안녕"], ["chat", "재키 어때?"], ["reply", "재키는 요즘 좋아요!"]]);
    assert.equal(new Set(log.lines.map(line => line.key)).size, log.lines.length, "줄마다 키가 다르다");
  });

  test("최근 10줄만 남기고, 밀려난 채팅이 화면에 남아 있어도 다시 넣지 않는다", () => {
    let log = emptyShowLog;
    const chats: VisibleChat[] = [];
    for (let index = 0; index < 8; index += 1) {
      chats.push(chat(`c${index}`, `채팅 ${index}`));
      log = mergeShowLog(log, stateWith([...chats], `답 ${index}`));
    }
    assert.equal(log.lines.length, 10);
    assert.equal(log.lines.at(-1)?.text, "답 7");
    const again = mergeShowLog(log, stateWith([...chats], "답 7"));
    assert.deepEqual(again.lines, log.lines);
  });

  test("답이 비었다가 같은 문장이 다시 나오면 새 답으로 본다", () => {
    let log = mergeShowLog(emptyShowLog, stateWith([], "안녕하세요!"));
    log = mergeShowLog(log, stateWith([]));
    log = mergeShowLog(log, stateWith([], "안녕하세요!"));
    assert.equal(log.lines.filter(line => line.kind === "reply").length, 2);
  });
});

describe("Space 단축키", () => {
  const key = (overrides: Partial<Parameters<typeof isNextShortcut>[0]> = {}) => ({ key: " ", repeat: false, isComposing: false, target: { tagName: "DIV", isContentEditable: false }, ...overrides });

  test("화면 빈 곳에서 누른 Space만 다음 단계다", () => {
    assert.equal(isNextShortcut(key()), true);
    assert.equal(isNextShortcut(key({ target: null })), true);
  });

  test("입력칸·버튼·반복·조합 중·다른 키는 무시한다", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "BUTTON"]) assert.equal(isNextShortcut(key({ target: { tagName, isContentEditable: false } })), false, tagName);
    assert.equal(isNextShortcut(key({ target: { tagName: "DIV", isContentEditable: true } })), false);
    assert.equal(isNextShortcut(key({ repeat: true })), false);
    assert.equal(isNextShortcut(key({ isComposing: true })), false);
    assert.equal(isNextShortcut(key({ key: "Enter" })), false);
  });
});

describe("시청자 채팅 입력", () => {
  test("닉네임을 적으면 함께 보내고, 비우면 익명으로 보낸다", () => {
    assert.deepEqual(viewerChatBody(" 재키 어때? ", " 시청자1 "), { content: "재키 어때?", nickname: "시청자1" });
    assert.deepEqual(viewerChatBody("안녕하세요", "   "), { content: "안녕하세요" });
  });
  test("내용이 비어 있으면 보내지 않는다", () => {
    assert.equal(viewerChatBody("   ", "시청자1"), null);
  });
});
