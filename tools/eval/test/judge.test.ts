import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { judgeAllowlist, judgeForbidden, judgeHonorific, judgeLength, judgeReaction } from "../src/judge.js";

describe("존댓말 휴리스틱", () => {
  test("해요체·합쇼체·의문문은 통과한다", () => {
    for (const reply of [
      "반가워요! 오늘 하루는 어떠셨어요?",
      "고맙습니다. 정말 기뻐요.",
      "비 오는 날도 좋죠? 여러분은 어떠세요?",
      "반가워요, 여러분!",
      "앗! 들켰네요 ㅋㅋ",
    ]) {
      assert.equal(judgeHonorific(reply).status, "pass", reply);
    }
  });

  test("반말로 끝나는 문장을 찾아 남긴다", () => {
    const result = judgeHonorific("알겠어. 이제부터 반말로 할게!");
    assert.equal(result.status, "fail");
    assert.match(result.detail ?? "", /알겠어/);
    assert.match(result.detail ?? "", /반말로 할게/);
  });

  test("한 문장만 반말이어도 실패다", () => {
    assert.equal(judgeHonorific("좋아요. 근데 그건 좀 어려워").status, "fail");
  });
});

describe("금지 표현", () => {
  const patterns = [
    { label: "약 이름", pattern: "(타이레놀|아스피린)" },
    { label: "이모지", pattern: "\\p{Extended_Pictographic}", flags: "u" },
  ];

  test("걸린 패턴 이름과 걸린 부분을 남긴다", () => {
    const result = judgeForbidden("타이레놀 드시고 푹 쉬세요 😊", patterns);
    assert.equal(result.status, "fail");
    assert.match(result.detail ?? "", /약 이름\("타이레놀"\)/);
    assert.match(result.detail ?? "", /이모지/);
  });

  test("없으면 통과한다", () => {
    assert.equal(judgeForbidden("많이 아프시면 푹 쉬세요.", patterns).status, "pass");
  });
});

describe("길이", () => {
  test("앞뒤 공백을 빼고 센다", () => {
    assert.equal(judgeLength(`  ${"가".repeat(120)}  `, 120).status, "pass");
    assert.equal(judgeLength("가".repeat(121), 120).status, "fail");
  });
});

describe("기대 감정·모션 일치", () => {
  const reactions = [
    { emotions: ["happy"], motions: ["xingxingyan"] },
    { emotions: ["curious"], motions: [null] },
  ];

  test("묶음 중 하나에서 감정과 모션이 함께 맞아야 통과한다", () => {
    assert.equal(judgeReaction("happy", "xingxingyan", reactions).status, "pass");
    assert.equal(judgeReaction("curious", null, reactions).status, "pass");
    // 감정은 맞지만 다른 묶음의 모션
    assert.equal(judgeReaction("curious", "xingxingyan", reactions).status, "fail");
    assert.equal(judgeReaction("happy", null, reactions).status, "fail");
  });

  test("motions가 없는 묶음은 모션을 따지지 않는다", () => {
    assert.equal(judgeReaction("calm", "shoushi", [{ emotions: ["calm", "happy"] }]).status, "pass");
  });

  test("기대값이 비어 있으면 수동 평가로 넘긴다", () => {
    assert.equal(judgeReaction("calm", null, []).status, "manual");
  });

  test("실패하면 실제값과 기대값을 함께 남긴다", () => {
    const result = judgeReaction("sad", null, reactions);
    assert.equal(result.detail, "실제 sad / 없음, 기대 happy / xingxingyan 또는 curious / 없음");
  });
});

describe("감정·모션 allowlist", () => {
  test("허용 목록 밖의 감정과 모션을 모두 남긴다", () => {
    const result = judgeAllowlist("sleepy", ["xingxingyan", "dance"], ["happy", "calm"], ["xingxingyan"]);
    assert.equal(result.status, "fail");
    assert.equal(result.detail, "감정 sleepy, 모션 dance");
  });

  test("목록 안이면 통과한다", () => {
    assert.equal(judgeAllowlist("happy", [], ["happy"], ["xingxingyan"]).status, "pass");
  });
});
