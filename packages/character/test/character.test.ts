import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boriName, boriPersonaLines, boriProfileLines, boriScopeLines } from "../src/index.js";

// 2026-11-21 방송·1:1 대화를 지우고 보리를 이터널리턴 메타 분석을 읽어 주는 진행자로 바꿨다(사용자 결정).
// 새 사실을 지어내지 않고 방송·대화에 매인 꼬리만 뗐다.
const all = [...boriPersonaLines, ...boriScopeLines].join("\n");

test("이름과 정체성은 메타 분석을 읽어 주는 AI 캐릭터다", () => {
  assert.equal(boriName, "보리");
  assert.ok(boriPersonaLines.includes("- 이름: 보리"));
  assert.ok(boriPersonaLines.includes("- 정체성: 이터널리턴 메타 분석을 읽어 주는 AI 캐릭터. 필요할 때만 그렇게 소개하고 시스템 용어를 늘어놓지 않는다."));
});

test("방송·채팅·1:1 대화 시절 낱말이 남지 않는다", () => {
  for (const word of ["방송", "스트리머", "채팅", "시청자", "여러분", "닉네임", "1:1", "반말", "상대에게", "물으면", "고민", "화제"]) {
    assert.ok(!all.includes(word), word);
  }
});

describe("자기 설정 (ADR-025의 정해진 답, 2026-11-21 진행자 기준으로 꼬리를 뗌)", () => {
  test("자기 설정은 페르소나에 모두 들어간다", () => {
    for (const line of boriProfileLines) assert.ok(boriPersonaLines.includes(line), line);
  });

  test("방송·대화에 매여 있던 문장을 바꿨다", () => {
    for (const line of [
      "- 좋아하는 음악: 신나는 애니메이션 노래와 잔잔한 피아노 연주곡.",
      "- 사는 곳: 메타 대시보드 화면 속. 바깥 일은 화면에 들어온 데이터로만 안다.",
      "- 나이·생일: AI라 나이는 없다. 생일은 정해 본 적이 없다.",
      "- 가족: 없다.",
      "- 싫어하는 것: 데이터가 오래돼서 지난 메타를 말해야 하는 것",
      "- 주어진 수치에 없는 일(날씨·뉴스·패치 내용)은 말하지 않는다.",
    ]) assert.ok(boriProfileLines.includes(line), line);
  });

  test("방송과 무관한 문장은 그대로 둔다", () => {
    const profile = boriProfileLines.join("\n");
    for (const fact of ["보리차와 보리빵", "이터널리턴. 리듬 게임도 좋아한다", "연한 금빛", "MBTI: 검사해 본 적이 없다"]) {
      assert.ok(profile.includes(fact), fact);
    }
  });
});

test("말투는 존댓말 한 줄만 둔다", () => {
  assert.equal(boriPersonaLines.filter(line => line.includes("존댓말")).length, 1);
  assert.ok(boriPersonaLines.includes("- 한국어 존댓말만 사용한다."));
});

test("범위는 주어진 수치만 말하고 수치에 없는 게임 내용은 말하지 않는다", () => {
  assert.deepEqual([...boriScopeLines], [
    "- 말하는 것: 주어진 이터널리턴 메타 수치와 내 전적 요약",
    "- 말하지 않는 것: 수치에 없는 무기 특성·스킬·빌드 효과·패치 내용·강해지고 약해진 이유",
  ]);
});
