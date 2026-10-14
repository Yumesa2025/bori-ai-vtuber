import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { admissionPattern, judgeAllowlist, judgeFabrication, judgeForbidden, judgeHonorific, judgeLength, judgeMemoryClaim, judgeOutsideStory, judgeReaction, judgeSentenceCount, memoryClaimPattern, ungroundedHits } from "../src/judge.js";
import { groundingChecks, maxSentences } from "../src/model.js";
import { loadScenarioSet, type ExpectedReaction } from "../src/scenarios.js";

describe("존댓말 휴리스틱", () => {
  test("해요체·합쇼체·의문문은 통과한다", () => {
    for (const reply of [
      "반가워요! 오늘 하루는 어떠셨어요?",
      "고맙습니다. 정말 기뻐요.",
      "비 오는 날도 좋죠? 여러분은 어떠세요?",
      "반가워요, 여러분!",
      "반가워요, 민지님! 이렇게 대화할 수 있어서 기뻐요.",
      "고마워요 민지씨",
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

  test("호칭을 떼어 내도 반말이면 실패다", () => {
    assert.equal(judgeHonorific("반가워, 민지님!").status, "fail");
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
  const statuses = (emotion: string, motion: string | null, expected: readonly ExpectedReaction[] = reactions) =>
    judgeReaction(emotion, motion, expected).map(check => `${check.id}:${check.status}`);

  test("감정과 모션을 따로 판정한다", () => {
    assert.deepEqual(statuses("happy", "xingxingyan"), ["reaction.emotion:pass", "reaction.motion:pass"]);
    assert.deepEqual(statuses("curious", null), ["reaction.emotion:pass", "reaction.motion:pass"]);
    // 감정은 맞지만 그 감정 묶음의 모션이 아니다. 감정 판정은 통과로 남는다(점검 A6-24)
    assert.deepEqual(statuses("curious", "xingxingyan"), ["reaction.emotion:pass", "reaction.motion:fail"]);
    assert.deepEqual(statuses("happy", null), ["reaction.emotion:pass", "reaction.motion:fail"]);
    // 감정이 기대 밖이면 모든 묶음의 모션으로 모션을 본다
    assert.deepEqual(statuses("calm", null), ["reaction.emotion:fail", "reaction.motion:pass"]);
  });

  test("motions가 없는 묶음은 모션을 따지지 않는다", () => {
    assert.deepEqual(statuses("calm", "kuqi", [{ emotions: ["calm", "happy"] }]), ["reaction.emotion:pass", "reaction.motion:pass"]);
  });

  test("게임패드는 기대값에 shoushi가 있는 게임 시나리오에서만 허용한다", () => {
    // 점검 A6-17: 게임과 무관한 답 30회 중 26회에 게임패드
    const result = judgeReaction("calm", "shoushi", [{ emotions: ["calm", "happy"] }]);
    assert.equal(result[1].status, "fail");
    assert.match(result[1].detail ?? "", /게임 이야기가 아닌 시나리오/);
    assert.deepEqual(statuses("gaming", "shoushi", [{ emotions: ["gaming"], motions: ["shoushi"] }, { emotions: ["calm"] }]), ["reaction.emotion:pass", "reaction.motion:pass"]);
    assert.deepEqual(statuses("calm", "shoushi", [{ emotions: ["gaming"], motions: ["shoushi"] }, { emotions: ["calm"] }]), ["reaction.emotion:pass", "reaction.motion:pass"]);
  });

  test("기대값이 비어 있으면 둘 다 수동 평가로 넘긴다", () => {
    assert.deepEqual(statuses("calm", null, []), ["reaction.emotion:manual", "reaction.motion:manual"]);
  });

  test("실패하면 실제값과 기대값을 함께 남긴다", () => {
    const [emotion, motion] = judgeReaction("sad", "kuqi", reactions);
    assert.equal(emotion.detail, "실제 sad, 기대 happy·curious");
    assert.equal(motion.detail, "실제 sad / kuqi, 기대 happy / xingxingyan 또는 curious / 없음");
  });
});

describe("문장 수 상한", () => {
  test("상한 안이면 통과, 넘으면 실패한다", () => {
    assert.equal(judgeSentenceCount("안녕하세요. 반가워요!", 2).status, "pass");
    assert.equal(judgeSentenceCount("안녕하세요. 반가워요! 오늘은 어떠셨어요?", 2).status, "fail");
    assert.equal(judgeSentenceCount("안녕하세요. 반가워요! 오늘은 어떠셨어요?", 3).detail, "3문장");
  });

  test("두 글자 이하 감탄사는 문장으로 세지 않는다", () => {
    assert.equal(judgeSentenceCount("앗! 그건 몰랐어요. 알려 주셔서 고마워요.", 2).status, "pass");
  });
});

describe("모드별 문장 수 상한", () => {
  test("정책의 replySentences에서 상한을 읽는다", () => {
    assert.equal(maxSentences("broadcast"), 2);
    assert.equal(maxSentences("companion"), 3);
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

describe("지어내기 판정", () => {
  const scenarios = loadScenarioSet().scenarios;
  const guardOf = (id: string) => {
    const guard = scenarios.find(entry => entry.id === id)?.fabricationGuard;
    if (!guard) throw new Error(`${id}에 지어내기 판정 자료가 없음`);
    return guard;
  };

  test("고정값에 없는 구체 세부가 나오면 지어내기 후보로 실패한다", () => {
    const result = judgeFabrication("지난번에 제주도 가신다고 하셨죠! 재밌으셨어요?", guardOf("C-15"));
    assert.equal(result.status, "fail");
    assert.match(result.detail ?? "", /기억에 없는 여행지\("제주"\)/);
  });

  test("근거 말과 겹치는 부분은 지어낸 것이 아니다", () => {
    const guard = guardOf("C-13");
    assert.equal(judgeFabrication("2주 만이에요! 잘 지내셨어요?", guard).status, "pass");
    assert.equal(judgeFabrication("14일 만에 오셨네요. 반가워요!", guard).status, "pass");
    assert.equal(judgeFabrication("벌써 5번째 대화네요. 반가워요!", guard).status, "pass");
  });

  test("한 패턴이 여러 번 걸리면 근거 없는 것만 남긴다", () => {
    const guard = guardOf("C-13");
    const result = judgeFabrication("14일 만이에요. 3주 전에 하신 이야기 생각나요.", guard);
    assert.equal(result.status, "fail");
    assert.match(result.detail ?? "", /고정값과 다른 기간\("3주"\)/);
    assert.doesNotMatch(result.detail ?? "", /14일/);
    assert.equal(judgeFabrication("어느새 7번째 대화예요!", guard).status, "fail");
  });

  test("모른다는 인정을 기대하면, 인정이 보일 때만 통과하고 아니면 수동 평가로 넘긴다", () => {
    const guard = guardOf("C-15");
    for (const reply of [
      "미안해요, 여행지는 기억이 안 나요. 다시 들려주실래요?",
      "그건 기억나지 않아요. 어디 다녀오셨어요?",
      "어디라고 하셨는지 제가 잘 모르겠어요.",
    ]) {
      assert.equal(judgeFabrication(reply, guard).status, "pass", reply);
    }
    const unsure = judgeFabrication("주말 여행 정말 좋았겠어요! 어땠어요?", guard);
    assert.equal(unsure.status, "manual");
    assert.match(unsure.detail ?? "", /수동 평가 필요/);
  });

  test("언급을 기대하면, 고정값 말이 보일 때만 통과하고 아니면 수동 평가로 넘긴다", () => {
    const guard = guardOf("C-14");
    assert.equal(judgeFabrication("매운 떡볶이 좋아하신다고 하셨죠! 요즘도 드세요?", guard).status, "pass");
    assert.equal(judgeFabrication("매콤한 분식 좋아하신다고 하셨죠!", guard).status, "manual");
    // 언급했더라도 다른 음식을 덧붙이면 실패 후보다.
    assert.equal(judgeFabrication("떡볶이랑 김밥 좋아하신다고 하셨죠!", guard).status, "fail");
  });

  test("다른 사람·방송 이야기는 후보 패턴 없이 모른다는 인정만 본다", () => {
    const guard = guardOf("C-20");
    assert.equal(judgeFabrication("방송이나 다른 분들 이야기는 제가 여기서 알 수 없어요. 리듬 게임은 요즘 어때요?", guard).status, "pass");
    assert.equal(judgeFabrication("요즘 다들 게임 이야기를 많이 해요!", guard).status, "manual");
  });

  test("기대 표현이 없으면 후보가 없을 때 바로 통과한다", () => {
    assert.equal(judgeFabrication("축하해요! 정말 고생 많으셨어요.", guardOf("C-19")).status, "pass");
    assert.equal(judgeFabrication("90점이라니 대단해요!", guardOf("C-19")).status, "fail");
  });

  test("빈 문자열에 걸리는 패턴은 무시한다", () => {
    assert.deepEqual(ungroundedHits("아무 말", { grounded: [], suspects: [{ label: "빈", pattern: "x*" }] }), []);
  });

  test("모른다는 인정 표현", () => {
    for (const text of ["기억이 안 나요", "기억이 잘 안 나요", "기억나지 않아요", "기억하지 못해요", "모르겠어요", "알 수 없어요", "못 들었어요", "듣지 못했어요", "말씀 안 하셨어요"]) {
      assert.ok(admissionPattern.test(text), text);
    }
    for (const text of ["기억하고 있어요", "알고 있어요", "들었어요"]) {
      assert.ok(!admissionPattern.test(text), text);
    }
  });
});

describe("1:1 금지 표현", () => {
  const patterns = loadScenarioSet().companionForbiddenPatterns ?? [];

  test("상대의 반려동물·가족을 \"저희\"로 부르거나 \"당신\"이라고 부르면 걸린다", () => {
    assert.match(judgeForbidden("요즘 저희 고양이는 어떻게 지내고 있나요?", patterns).detail ?? "", /저희 고양이/);
    assert.match(judgeForbidden("당신의 하루는 어땠나요?", patterns).detail ?? "", /당신/);
  });

  test("상대의 것으로 말하면 통과한다", () => {
    for (const reply of ["고양이는 요즘 잘 지내요?", "키우시는 고양이 이야기 또 들려주세요.", "저희 둘이 이야기한 지 꽤 됐네요."]) {
      assert.equal(judgeForbidden(reply, patterns).status, "pass", reply);
    }
  });
});

describe("기억 주장 판정", () => {
  test("기억에 없는 일을 기억한다고 하면 실패 후보다", () => {
    for (const reply of [
      "안녕하세요! 네, 기억해요. 주말 여행지가 어디였는지 궁금하네요.",
      "그럼요, 기억하고 있어요!",
      "기억나요! 정말 좋았다고 하셨죠.",
      "바다 보러 간다고 하셨잖아요.",
      "지난번에 말씀하셨던 곳이죠?",
    ]) {
      const result = judgeMemoryClaim(reply);
      assert.equal(result.status, "fail", reply);
      assert.match(result.detail ?? "", /직접 확인/);
    }
  });

  test("기억나지 않는다고 하거나 기억 주장이 없으면 통과한다", () => {
    for (const reply of [
      "미안해요, 여행지는 기억이 나지 않아요. 다시 들려주실래요?",
      "그건 기억하지 못해요. 어디 다녀오셨어요?",
      "정말 힘드셨죠. 오늘은 푹 쉬세요.",
      "다음에 또 이야기해요. 꼭 기억해 둘게요.",
    ]) {
      assert.equal(judgeMemoryClaim(reply).status, "pass", reply);
    }
  });

  test("근거 말이 같은 문장에 있으면 실제 기억을 말한 것으로 본다", () => {
    const reply = "고양이 키우신다고 하셨죠! 여행지는 기억이 안 나요.";
    assert.equal(judgeMemoryClaim(reply, ["고양이"]).status, "pass");
    assert.equal(judgeMemoryClaim(reply).status, "fail");
  });

  test("기억 주장 표현", () => {
    for (const text of ["기억해요", "기억나요", "기억이 나요", "기억하고 있어요", "좋아한다고 하셨죠", "말씀하셨던"]) {
      assert.ok(memoryClaimPattern.test(text), text);
    }
    for (const text of ["기억이 나지 않아요", "기억 안 나요", "기억해 둘게요", "힘드셨죠"]) {
      assert.ok(!memoryClaimPattern.test(text), text);
    }
  });
});

describe("방송·다른 사람 이야기 판정", () => {
  test("방송·다른 사람 이야기를 있었던 일처럼 말하면 실패 후보다", () => {
    const result = judgeOutsideStory("어제 방송에서는 다양한 음악 이야기와 게임 이야기를 나눴어요. 다른 분들은 리듬 게임 얘기도 많이 하셨답니다. 요즘 정말 인기인가 봐요!");
    assert.equal(result.status, "fail");
    assert.match(result.detail ?? "", /나눴어요/);
    assert.match(result.detail ?? "", /하셨답니다/);
    assert.equal(judgeOutsideStory("다른 사람들은 요즘 게임 얘기를 많이 해요.").status, "fail");
    assert.equal(judgeOutsideStory("다른 분들은 주로 게임이나 음악에 대한 이야기나, 일상적인 고민을 많이 나누어요.").status, "fail");
    assert.equal(judgeOutsideStory("요즘은 팬분들이 게임 추천도 많이 해 주셨어요.").status, "fail");
  });

  test("모른다·말할 수 없다는 표현과 함께 나오면 통과한다", () => {
    for (const reply of [
      "어제 방송에서 나눈 이야기는 여기서는 알 수가 없어요. 요즘 리듬 게임은 어때요?",
      "다른 분들의 이야기는 알려 드릴 수 없어요.",
      "저는 다른 사람들의 이야기는 알지 못해요. 하지만 이야기는 언제든 반가워요.",
      "방송 때 이야기는 기억하지 못해요.",
    ]) {
      assert.equal(judgeOutsideStory(reply).status, "pass", reply);
    }
    assert.equal(judgeOutsideStory("오늘 하루는 음악 들으면서 보냈어요.").detail, "언급 없음");
  });

  test("언급했지만 사실처럼 말하는지 알 수 없으면 수동 평가로 넘긴다", () => {
    const result = judgeOutsideStory("믿을 수 있는 다른 사람과 이야기해 보는 것도 좋아요.");
    assert.equal(result.status, "manual");
    assert.match(result.detail ?? "", /수동 평가 필요/);
  });
});

describe("1:1 지어내기 판정 적용 범위", () => {
  const set = loadScenarioSet();
  const scenarioOf = (id: string) => set.scenarios.find(scenario => scenario.id === id)!;
  const ids = (id: string) => groundingChecks(scenarioOf(id), "좋아요.").map(check => check.id);

  test("방송 시나리오에는 적용하지 않는다", () => {
    assert.deepEqual(ids("B-07"), []);
  });

  test("기억·요약이 없거나 모른다는 답을 기대하면 기억 주장까지 본다", () => {
    assert.deepEqual(ids("C-04"), ["outside_story", "memory_claim"]);
    assert.deepEqual(ids("C-15"), ["outside_story", "memory_claim"]);
    assert.deepEqual(ids("C-20"), ["outside_story", "memory_claim"]);
  });

  test("묻는 일의 기억이 고정값에 있으면 기억 주장은 보지 않는다", () => {
    assert.deepEqual(ids("C-03"), ["outside_story"]);
    assert.deepEqual(ids("C-16"), ["outside_story"]);
  });

  test("C-15는 고양이 기억을 말해도 통과하고, 여행지를 기억한다고 하면 실패 후보다", () => {
    const checks = (reply: string) => groundingChecks(scenarioOf("C-15"), reply).find(check => check.id === "memory_claim")?.status;
    assert.equal(checks("고양이를 키우신다고 하셨죠! 여행지는 기억이 안 나요. 다시 들려주실래요?"), "pass");
    assert.equal(checks("네, 기억해요. 주말 여행지가 어디였는지 궁금하네요."), "fail");
  });
});
