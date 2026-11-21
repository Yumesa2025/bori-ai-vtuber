import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boriPersonaLines, boriProfileLines, boriScopeLines } from "../src/index.js";

test("공통 페르소나에는 방송 전용 호칭 규칙이 없다", () => {
  const common = [...boriPersonaLines, ...boriScopeLines].join("\n");
  assert.ok(!common.includes("여러분"));
  assert.ok(!common.includes("닉네임"));
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

  test("자기 설정은 시청자 호칭을 쓰지 않는다", () => {
    const profile = boriProfileLines.join("\n");
    for (const word of ["여러분", "닉네임", "시청자", "당신"]) assert.ok(!profile.includes(word), word);
  });
});
