/**
 * OBS 페이지가 그리는 값의 계산 검사. 그리기와 계산을 나눠 브라우저 없이 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BroadcastState } from "@bori/shared";
import { captionText, chatEmptyHint, chatStripLines, formatPercent, formatRank, playerStatusText, visibleTop5 } from "../src/obs/view";

test("픽률은 소수 한 자리 퍼센트", () => assert.equal(formatPercent(0.0812), "8.1%"));
test("평균 순위", () => assert.equal(formatRank(3.42), "3.4위"));
test("TOP5는 revealed만큼만 보인다", () => {
  const items = [1, 2, 3, 4, 5].map(i => ({ code: i, name: `c${i}`, picks: 1, pickRate: 0.1, avgRank: 3, top1Rate: 0.1, mainWeapon: "" }));
  assert.deepEqual(visibleTop5(items, 2).map(x => x.name), ["c1", "c2"]);
  assert.equal(visibleTop5(items, 9).length, 5);
  assert.equal(visibleTop5(items, -1).length, 0);
});
test("채팅 띠는 최근 4줄, 명령은 강조 표시", () => {
  const chats = ["a", "b", "!전적 보리팬", "c", "d"].map((content, i) => ({ id: String(i), content, receivedAt: "", category: "normal" as const }));
  const lines = chatStripLines(chats);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(l => l.text), ["b", "!전적 보리팬", "c", "d"]);
  assert.equal(lines.find(l => l.text.startsWith("!전적"))?.command, true);
  assert.equal(lines.find(l => l.text === "b")?.command, false);
});
test("채팅이 없을 때 띠에 단계별 참여 안내를 보여 준다", () => {
  assert.equal(chatEmptyHint("diagnosis"), "채팅에 !전적 닉네임을 적어 주세요");
  assert.equal(chatEmptyHint("qna"), "궁금한 캐릭터를 채팅으로 물어봐 주세요");
  for (const stage of ["idle", "opening", "briefing", "ending", undefined] as const) assert.equal(chatEmptyHint(stage), "채팅으로 함께해 주세요");
});

const base: BroadcastState = { status: "live", layout: "chat", currentEmotion: "calm", queueSize: 0, visibleChatCount: 0, lastError: null, visibleChats: [], unprocessedCount: 0 };
const response = { reply: "보리 답", emotion: { primary: "happy", intensity: 0.5, durationSeconds: 3 }, actions: [], source: "llm" as const };

test("자막은 show.caption, 없으면 현재 답", () => {
  assert.equal(captionText(base), "");
  assert.equal(captionText({ ...base, currentResponse: response }), "보리 답");
  const show = { stage: "opening", scene: "보리-메인", dashboard: { kind: "season", basis: null }, caption: "진행 자막", connections: { chzzk: "off", obs: "off", er: "missing" }, erRefreshProgress: null } as const;
  assert.equal(captionText({ ...base, currentResponse: response, show }), "진행 자막");
  assert.equal(captionText({ ...base, currentResponse: response, show: { ...show, caption: "" } }), "보리 답");
});

test("전적 카드 상태 문구", () => {
  assert.equal(playerStatusText("waiting"), "채팅에 !전적 닉네임을 적어 주세요");
  assert.equal(playerStatusText("loading"), "찾아보는 중…");
  assert.equal(playerStatusText("not-found"), "닉네임을 찾지 못했어요");
  assert.equal(playerStatusText("ready"), null);
});
