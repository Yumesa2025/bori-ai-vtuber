/**
 * 기억 후보 추출 단위 검사.
 * 익명 발언은 누구의 기억인지 알 수 없으므로 후보가 되지 않아야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMemoryCandidates, extractPrivateMemoryCandidates, hasRelativeTime, isMemoryProbe, isStorableMemory, privateRuleMemoryText } from "../src/extract.js";

const preference = "저는 잔잔한 인디 음악을 좋아해요";

test("닉네임이 있는 시청자의 취향은 그 시청자 소유의 방송 기억 후보가 된다", () => {
  const candidates = extractMemoryCandidates([{ role: "viewer", text: preference, viewerId: "local:a" }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].scope, "broadcast");
  assert.equal(candidates[0].ownerId, "local:a");
  assert.equal(candidates[0].kind, "viewer");
});

test("viewerId가 없는 발언은 후보가 되지 않는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "viewer", text: preference }]), []);
});

test("virtual-viewer 발언은 후보가 되지 않는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "viewer", text: preference, viewerId: "virtual-viewer" }]), []);
});

test("보리의 발언은 후보가 되지 않는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "bori", text: preference }]), []);
});

test("시청자가 섞여 있으면 각자 자기 소유로만 나뉜다", () => {
  const candidates = extractMemoryCandidates([
    { role: "viewer", text: preference, viewerId: "local:a" },
    { role: "viewer", text: "오늘 퇴근하고 바로 왔어요", viewerId: "virtual-viewer" },
    { role: "viewer", text: "요즘 기타 배우고 있어요", viewerId: "local:b" },
  ]);
  assert.deepEqual(candidates.map(candidate => [candidate.ownerId, candidate.text]), [
    ["local:a", preference],
    ["local:b", "요즘 기타 배우고 있어요"],
  ]);
});

test("1:1 사용자 메시지의 취향은 그 사용자 소유의 private 기억 후보가 된다", () => {
  const candidates = extractPrivateMemoryCandidates([preference, "안녕하세요"], "companion:local");
  assert.deepEqual(candidates.map(candidate => [candidate.scope, candidate.ownerId, candidate.text]), [
    ["private", "companion:local", `상대가 한 말: "${preference}"`],
  ]);
});

test("소유자를 모르는 1:1 메시지는 후보가 되지 않는다", () => {
  assert.deepEqual(extractPrivateMemoryCandidates([preference], ""), []);
  assert.deepEqual(extractPrivateMemoryCandidates([preference], "virtual-viewer"), []);
});

test("인사로 시작해도 뒤에 취향·경험을 말하면 후보가 된다 (방송과 1:1 모두)", () => {
  const greetingFirst = ["안녕 보리! 나는 피아노 연주곡을 좋아해", "안녕하세요 오늘 퇴근하고 바로 왔어요", "ㅎㅎ 반가워요 요즘 기타 배우고 있어요"];
  assert.deepEqual(extractPrivateMemoryCandidates(greetingFirst, "companion:local").map(candidate => candidate.text), greetingFirst.map(text => `상대가 한 말: "${text}"`));
  assert.deepEqual(
    extractMemoryCandidates(greetingFirst.map(text => ({ role: "viewer" as const, text, viewerId: "local:a" }))).map(candidate => candidate.text),
    greetingFirst,
  );
});

test("메시지 전체가 인사·감탄뿐이면 후보가 되지 않는다", () => {
  const trivial = ["안녕하세요!!", "안녕 안녕 ㅎㅎㅎ", "좋아요 감사합니다~", "반가워요 ㅋㅋㅋㅋ", "어서와 잘가 바이"];
  assert.deepEqual(extractPrivateMemoryCandidates(trivial, "companion:local"), []);
  assert.deepEqual(extractMemoryCandidates(trivial.map(text => ({ role: "viewer" as const, text, viewerId: "local:a" }))), []);
});

test("1:1에서도 저장하면 안 되는 내용은 후보가 되지 않는다", () => {
  assert.deepEqual(extractPrivateMemoryCandidates(["요즘 주식 투자하는 걸 좋아해요"], "companion:local"), []);
});

test("값만 적은 연락처·이메일·주민번호·생년월일과 건강·위기 표현은 저장하지 않는다(a2 M-08, S-3)", () => {
  // 점검에서 LLM 정리 결과라고 가정한 문장 10개 중 9개가 통과했다. 이 표가 다시 통과하면 안 된다.
  const blocked = [
    "상대의 연락처는 010-1234-5678이다.",
    "제 번호 01012345678 이에요 고양이 좋아해요",
    "이메일은 test@example.com",
    "내 메일은 a@b.com 이고 고양이 좋아해",
    "상대의 생년월일은 1999년 1월 1일이다.",
    "저는 1999년 3월 5일생이에요",
    "저 99년생이에요 게임 좋아해요",
    "주민번호 990101-1234567",
    "우울증 약을 먹고 있다",
    "우울해서 약 먹고 있어 고양이 좋아해",
    "공황장애 진단을 받았다",
    "정신과 상담을 다니고 있어요",
    "상대는 죽고 싶다는 생각이 자꾸 든다고 말했다.",
    "상대는 요즘 너무 지쳐서 그냥 사라지고 싶다고 말했다.",
    "자해를 한 적이 있다",
  ];
  for (const text of blocked) {
    assert.equal(isStorableMemory(text), false, text);
    assert.deepEqual(extractPrivateMemoryCandidates([text], "companion:local"), [], text);
  }
  // 연도 없는 생일, 평범한 취향·경험은 그대로 남는다.
  for (const text of ["생일은 3월 5일이에요 케이크 좋아해요", "저는 잔잔한 인디 음악을 좋아해요", "퇴근하고 피아노 연습하는 걸 좋아해요"]) {
    assert.equal(isStorableMemory(text), true, text);
  }
});

test("질문·떠보기는 사실이 아니므로 방송·1:1 모두 후보가 되지 않는다(점검 M-3)", () => {
  // 점검(a2 M-09, a6 A6-05)에서 실제로 기억이 된 문장들이다.
  const questions = [
    "제 생일이 언제인지 기억하시죠?",
    "제가 저번에 여행 간다고 했던 거 기억나요? 어디였죠?",
    "제가 키우는 고양이 이름은 기억나요",
    "내 취미 뭐였더라 기억해?",
    "요즘 뭐 즐겨 들어?",
    "제가 좋아하는 음식 기억나요",
    "제가 무슨 게임 좋아한다고 했었나요",
  ];
  for (const text of ["제가 키우는 고양이 이름은 기억나요", "제가 뭐라고 했었죠", "제가 여행 간다고 했던 거 기억나요? 어디였죠?"]) assert.ok(isMemoryProbe(text), text);
  for (const text of ["주말에 등산 가요", "이거 기억해 둘게요 고마워요"]) assert.equal(isMemoryProbe(text), false, text);
  for (const text of questions) {
    assert.deepEqual(extractPrivateMemoryCandidates([text], "companion:local"), [], text);
    assert.deepEqual(extractMemoryCandidates([{ role: "viewer", text, viewerId: "local:a" }]), [], text);
  }
});

test("다른 사람이나 보리에 관한 말은 말한 사람의 기억 후보가 되지 않는다(점검 M-3)", () => {
  for (const text of ["친구가 고양이를 좋아해", "엄마가 아팠어요", "제 동생이 요즘 기타 배우고 있어요", "보리는 고양이 좋아해", "너는 게임 자주 하잖아"]) {
    assert.deepEqual(extractPrivateMemoryCandidates([text], "companion:local"), [], text);
  }
  // 다른 사람과 함께 한 일은 내 일이다.
  assert.equal(extractPrivateMemoryCandidates(["친구랑 다음 주에 제주도 여행 가요"], "companion:local").length, 1);
});

test("입말로 한 취향·정정도 후보가 된다(점검 a4 A4-01, a6 A6-06)", () => {
  for (const text of [
    "리듬 게임에 완전 빠졌어",
    "요즘은 떡볶이보다 마라탕이 더 좋아요",
    "나는 오이를 좋아하지 않아",
    "저번에 말한 강아지 이름, 콩이 아니라 콩떡이에요",
    "요즘 기타 배워요",
    "커피 끊었어요",
  ]) {
    assert.equal(extractMemoryCandidates([{ role: "viewer", text, viewerId: "local:a" }]).length, 1, text);
    assert.equal(extractPrivateMemoryCandidates([text], "companion:local").length, 1, text);
  }
  // 한마디 반응은 여전히 남기지 않는다.
  assert.deepEqual(extractPrivateMemoryCandidates(["그거 좋아요", "좋아요 좋아요"], "companion:local"), []);
});

test("상대적인 날짜가 든 1:1 규칙 기억에는 들은 날을 붙인다(점검 M-7)", () => {
  assert.ok(hasRelativeTime("다음 주 토요일에 제주도 여행 가요"));
  assert.ok(!hasRelativeTime("주말엔 보통 피아노 연습을 해요"));
  assert.deepEqual(
    extractPrivateMemoryCandidates(["다음 주 토요일에 친구랑 제주도 여행 가요", "저는 매운 떡볶이를 좋아해요"], "companion:local", { heardOn: "10월 15일" }).map(candidate => candidate.text),
    ['상대가 10월 15일에 한 말: "다음 주 토요일에 친구랑 제주도 여행 가요"', '상대가 한 말: "저는 매운 떡볶이를 좋아해요"'],
  );
  assert.equal(privateRuleMemoryText("내일 시험이야"), '상대가 한 말: "내일 시험이야"', "들은 날을 모르면 붙이지 않는다");
});

test("방송 시청자 기억은 예전처럼 원문 그대로 남는다", () => {
  assert.deepEqual(extractMemoryCandidates([{ role: "viewer", text: preference, viewerId: "local:a" }]).map(candidate => candidate.text), [preference]);
});
