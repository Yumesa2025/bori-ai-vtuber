import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boriPersonaLines, boriProfileLines, boriScopeLines, conversationModes, conversationPolicies } from "../src/index.js";

test("모든 모드에 정책이 있고 키와 mode 값이 같다", () => {
  for (const mode of conversationModes) {
    const policy = conversationPolicies[mode];
    assert.equal(policy.mode, mode);
    assert.ok(policy.rules.length > 0);
    assert.ok(policy.noMemoryLine.length > 0);
  }
});

test("공통 페르소나에는 모드 전용 호칭 규칙이 없다", () => {
  const common = [...boriPersonaLines, ...boriScopeLines].join("\n");
  assert.ok(!common.includes("여러분"));
  assert.ok(!common.includes("닉네임"));
});

test("1:1 대화 정책에 방송 호칭·닉네임 규칙이 섞이지 않는다", () => {
  const companion = JSON.stringify(conversationPolicies.companion);
  assert.ok(!companion.includes("여러분"));
  assert.ok(!companion.includes("닉네임"));
  assert.ok(!companion.includes("시청자"));
});

test("방송은 규칙 문장·무반응·서버 폴백을 그대로 쓰고, 1:1은 규칙 없이 거절·폴백 문장을 갖는다", () => {
  const { broadcast, companion } = conversationPolicies;
  assert.equal(broadcast.ruleReplies, true);
  assert.deepEqual(broadcast.refusalReplies, []);
  assert.equal(broadcast.fallbackReplies, null);

  assert.equal(companion.ruleReplies, false);
  assert.ok(companion.refusalReplies.length > 0);
  assert.ok((companion.fallbackReplies ?? []).length > 0);
});

test("1:1 정책에 관계 맥락 지침(초안)이 있고, 방송 정책 문장은 그대로다", () => {
  const rules = conversationPolicies.companion.rules.join("\n");
  for (const phrase of ["'오늘 처음 대화한다'고 되어 있을 때만", "반가움을 표현한다", "[기억]이나 지난 대화 요약에 있는 것만", "아는 척하지 않는다", "그 상황에 먼저 반응한다"]) {
    assert.ok(rules.includes(phrase), phrase);
  }
  assert.deepEqual(conversationPolicies.broadcast.rules, [
    "- 밝고 편안한 소통 방송 진행자다.",
    "- 시청자를 부를 때는 '여러분'이라고 한다.",
    "- 시청자 닉네임은 절대 부르지 않는다.",
    "- 답은 두 문장까지만 쓴다. 되묻는 말도 그 두 문장 안에 넣고, 매번 되묻지는 않는다.",
    "- 답은 보리의 생각이나 반응으로 끝낸다. 시청자에게 생각을 묻는 말은 서너 번에 한 번만, 그때그때 다른 말로 한다.",
    "- [최근 대화]에서 보리가 이미 한 말과 같은 문장이나 같은 시작을 되풀이하지 않고, 매번 다른 표현으로 말한다.",
  ]);
});

test("1:1 정책에 지어내기 방지 지침(초안)이 있다", () => {
  const rules = conversationPolicies.companion.rules.join("\n");
  for (const phrase of ["2인칭 대명사 없이", "'키우시는 고양이'처럼 상대의 것", "일반적인 예도 지어내지 않는다", "제 기억에 없어요. 다시 들려주실래요?", "다시 와 준 것을 반가워하는", "방송이 어땠는지도 여기서는 모른다"]) {
    assert.ok(rules.includes(phrase), phrase);
  }
  // 금지할 낱말을 그대로 적으면 모델이 따라 쓰는 경우가 있어 정책 문장에 넣지 않는다.
  for (const word of ["당신", "저희", "기억해요"]) {
    assert.ok(!rules.includes(word), word);
  }
});

test("첫 인사는 '오늘 처음 대화한다'는 첫 답에만 하고, 인사를 나눈 뒤에는 되풀이하지 않는다", () => {
  // 점검 C-5: 서버가 첫 대화의 둘째 메시지부터 넣는 "인사는 이미 나눴다" 문장과 짝을 이룬다.
  const rules = conversationPolicies.companion.rules.join("\n");
  assert.ok(rules.includes("'오늘 처음 대화한다'고 되어 있을 때만 가볍게 자기소개를 하며 인사한다"));
  assert.ok(rules.includes("이미 인사를 나눈 대화에서는 다시 인사하지 않는다"));
});

test("예시 문장은 여러 표현을 두고 같은 문장을 되풀이하지 않게 한다", () => {
  // 점검 A6-14: 예시 한 문장이 13회 그대로 반복됐다.
  const rules = conversationPolicies.companion.rules.join("\n");
  assert.ok(rules.includes("같은 문장을 되풀이하지 않는다"));
  assert.ok(rules.includes("'제가 그 이야기를 놓친 것 같아요'"));
  assert.ok(rules.includes("'방송 이야기는 여기까지 들리지 않아요'"));
  // 상대에게 되묻는 빈도(점검 C-4)
  assert.ok(rules.includes("되묻기는 두세 번에 한 번만"));
});

describe("보리 자기 설정과 존댓말 고정 (ADR-025)", () => {
  // 사용자 결정(2026-10-15): 자기 설정은 정해진 답을 두고, 반말 요청에도 존댓말만 쓴다.
  const persona = boriPersonaLines.join("\n");

  test("자기 설정 답이 공통 페르소나에 모두 들어간다", () => {
    for (const line of boriProfileLines) assert.ok(boriPersonaLines.includes(line), line);
    for (const fact of ["보리차와 보리빵", "애니메이션 노래와 잔잔한 피아노 연주곡", "이터널리턴", "리듬 게임", "연한 금빛", "방송 화면 속", "AI라 나이는 없다", "날짜는 말하지 않는다", "MBTI: 검사해 본 적이 없다", "가족: 없다", "채팅창이 오래 조용한 것"]) {
      assert.ok(persona.includes(fact), fact);
    }
  });

  test("설정에 없는 자기 사실과 바깥 소식은 지어내지 않는다고 적는다", () => {
    assert.ok(persona.includes("위에 없는 자기 사실을 물으면 지어내지 않고"));
    assert.ok(persona.includes("날씨·뉴스처럼 지금 바깥에서 일어나는 일은 주어진 정보에 없으면 볼 수 없어서 모른다고"));
  });

  test("반말 요청에도 존댓말을 지키는 지침이 있고, 다른 답에 옮겨 쓸 따옴표 예시는 두지 않는다", () => {
    assert.ok(boriPersonaLines.includes("- 한국어 존댓말만 사용한다."));
    assert.ok(persona.includes("반말로 해 달라고 해도 존댓말을 지킨다"));
    assert.ok(persona.includes("반말을 요청받았을 때만 존댓말이 더 편하다고"));
    // 예시 문장을 두면 닉네임·영어 입력 답에도 그대로 옮겨 썼다(점검 후속 실모델 평가).
    assert.ok(!persona.includes("편하게 말 걸어 주세요"));
  });

  test("영어 입력은 거절하지 않고 한국어로 답한다", () => {
    assert.ok(boriScopeLines.includes("- 다른 언어로 말을 걸어도 알아듣고 그 내용에 한국어로 답한다. 상대에게 한국어로 말해 달라고 하지 않는다."));
  });

  test("자기 설정은 모드 전용 호칭을 쓰지 않아 방송과 1:1에 함께 넣을 수 있다", () => {
    const profile = boriProfileLines.join("\n");
    for (const word of ["여러분", "닉네임", "시청자", "당신"]) assert.ok(!profile.includes(word), word);
  });
});
