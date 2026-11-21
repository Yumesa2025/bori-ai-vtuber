/**
 * 감상 한마디(comment) 검사. 수치·이름 문장은 서버가 만들고, LLM이 붙이는 감상에는 수치·이름이 들어갈 수 없다.
 * 규칙은 닫힌 목록이라 어기면 감상만 버린다(Codex C2 1~3절).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BANNED_WORDS, checkComment, MAX_COMMENT_LENGTH, METRIC_WORDS, NUMBER_WORDS } from "../src/narration/comment.js";
import { dictionaryNames, findDictionaryName } from "../src/narration/names.js";
import { fixtureNames } from "./narration-fixtures.js";

const reasonOf = (comment: string) => {
  const result = checkComment(comment, fixtureNames);
  return result.ok ? "ok" : result.reason;
};

describe("감상 한마디 검사", () => {
  test("짧은 존댓말 감상은 통과하고 앞뒤 공백만 정리한다", () => {
    for (const comment of ["꽤 안정적으로 보여요.", "흐름이 재미있네요!", "앞으로가 기대돼요", "천천히 올라오고 있어요.", "분위기가 좋아 보여요.", "활약이 기대돼요.", "한결 편해 보여요.", "정말 그렇죠?", "눈여겨볼 만합니다."]) {
      assert.deepEqual(checkComment(`  ${comment} `, fixtureNames), { ok: true, text: comment }, comment);
    }
  });

  test("빈 감상은 감상 없음이다", () => {
    assert.deepEqual(checkComment("   ", fixtureNames), { ok: false, reason: "empty" });
  });

  test(`${MAX_COMMENT_LENGTH}자를 넘으면 버린다(코드포인트)`, () => {
    assert.equal(reasonOf(`${"가".repeat(MAX_COMMENT_LENGTH - 1)}요`), "ok");
    assert.equal(reasonOf(`${"가".repeat(MAX_COMMENT_LENGTH)}요`), "length");
  });

  test("아라비아·전각 숫자는 버린다", () => {
    assert.equal(reasonOf("3위까지 올라왔어요."), "number");
    assert.equal(reasonOf("３위예요."), "number");
  });

  test("라틴 문자(반각·전각), 따옴표·괄호, 퍼센트 기호는 버린다", () => {
    assert.equal(reasonOf("OP 같아요."), "latin");
    assert.equal(reasonOf("ＯＰ 같아요."), "latin");
    assert.equal(reasonOf("\"좋아요\"라고 해요."), "quote");
    assert.equal(reasonOf("좋아요(아마)."), "quote");
    assert.equal(reasonOf("「좋아요」"), "quote");
    assert.equal(reasonOf("반이 넘는 %예요."), "unit");
  });

  test("허용 글자(한글 음절·공백·쉼표·마침표·느낌표·물음표) 밖은 버린다", () => {
    for (const comment of ["좋아요 😊", "좋아요~", "ㅋㅋ 좋아요", "좋아요​", "좋아요…", "좋아요:"]) assert.equal(reasonOf(comment), "chars", comment);
  });

  test("문장은 하나만", () => {
    assert.equal(reasonOf("좋아요. 정말 좋아요."), "sentence");
    assert.equal(reasonOf("와! 좋아요"), "sentence");
    assert.equal(reasonOf("좋아요!!"), "ok");
  });

  test("존댓말 어미로 끝나야 한다", () => {
    for (const comment of ["좋다.", "좋아 보여", "대박이야!", "괜찮음"]) assert.equal(reasonOf(comment), "ending", comment);
  });

  test("한글 수·서수 낱말은 버린다", () => {
    for (const comment of [
      "구십구 퍼센트예요.", "백 퍼센트 좋아요.", "이십 위로 떨어졌어요.", "삼 점 사 위예요.", "일 위예요.", "이 위예요.",
      "세 배나 돼요.", "두 판 중 한 판은 이겨요.", "첫 번째로 많이 골라요.", "두 번째예요.", "첫째로 보여요.", "절반이에요.",
      "하나만 기억해요.", "다섯 명이 골랐어요.", "열 번 중에 아홉 번이에요.", "스무 판 넘게 했어요.", "한 번 더 볼게요.", "오십 판이에요.",
      "십오 퍼에요.", "천 명이 넘어요.", "만 명이 골랐어요.", "둘이 비슷해요.", "곱절이에요.", "사위예요.",
    ]) {
      assert.notEqual(reasonOf(comment), "ok", comment);
    }
    assert.equal(reasonOf("구십구 퍼센트예요."), "number");
    assert.equal(reasonOf("첫 번째로 많이 골라요."), "number");
  });

  test("지표 이름과 홀로 선 단위 낱말은 버린다", () => {
    for (const comment of ["픽률이 높아요.", "우승 비율이 좋아요.", "순위가 올랐어요.", "평균보다 좋아요.", "참가자가 많아요.", "위로 올라왔어요.", "판이 많아요.", "명이 넘어요.", "몇 판 안 돼요."]) {
      assert.equal(reasonOf(comment), "metric", comment);
    }
  });

  test("사전 이름은 조사·띄어쓰기와 상관없이 버린다", () => {
    for (const comment of ["레온입니다.", "재키의 기세가 좋아요.", "리다이린도 보여요.", "리 다이린도 보여요.", "다이린이 보여요.", "활이 좋아요.", "청룡도가 좋아요.", "흡혈마가 좋아요."]) {
      assert.equal(reasonOf(comment), "name", comment);
    }
    // 한 글자 이름은 낱말 경계에서만 찾는다
    assert.equal(reasonOf("활약이 기대돼요."), "ok");
  });

  test("금지 낱말은 버린다", () => {
    for (const comment of ["스킬이 좋아요.", "빌드가 좋아요.", "패치로 바뀌었어요.", "너프됐어요.", "버프 받았어요.", "상향됐어요.", "사기예요.", "카운터예요.", "조합이 좋아요.", "가장 강한 캐릭터예요.", "약해졌어요.", "강해졌어요.", "때문이에요.", "여러분 반가워요."]) {
      assert.equal(reasonOf(comment), "word", comment);
    }
  });

  test("Z1: 낱말 속 '하나'·붙여 쓴 '이번'·'판도'는 수·단위로 보지 않는다", () => {
    for (const comment of [
      "다들 좋아하나 봐요.", "궁금하나 봐요.", "이번에도 자주 보이네요.", "이번 집계에서도 눈에 띄어요.", "이번엔 꾸준하네요.",
      "판도가 흥미로워요.", "메타 판도를 바꾸고 있네요.", "판도는 늘 바뀌네요.",
    ]) {
      assert.equal(reasonOf(comment), "ok", comment);
    }
  });

  test("Z1: 좁힌 곳 바로 옆의 수·단위는 그대로 버린다", () => {
    for (const comment of [
      "하나만 기억해요.", "단 하나예요.", "하나같이 좋아요.", "이 번 더 봐요.", "일 번이에요.", "이번 판이 많아요.",
      "판도 많아요.", "판이 바뀌었네요.", "판에서 이겨요.", "한 점이에요.", "만 점이에요.", "백 점이에요.", "점이 높아요.", "이 점이 좋아요.",
      "삼 점 사 위예요.", "위로 올라왔어요.", "인기 만점이에요.",
      // 관형형 뒤 '점'(꾸준한 점)은 좁히지 않았다. "열한 점"처럼 수와 구별할 수 없다
      "꾸준한 점이 좋아요.", "열한 점이 좋아요.", "열한 판도는 많아요.", "세 판도가 많아요.", "이번째예요.",
    ]) {
      assert.notEqual(reasonOf(comment), "ok", comment);
    }
  });

  test("목록을 고정한다", () => {
    for (const word of ["효과", "스킬", "빌드", "패치", "너프", "버프", "상향", "하향", "사기", "카운터", "조합", "캐릭터", "무기", "장비", "특성", "가장", "강하", "약하", "때문", "여러분"]) {
      assert.ok(BANNED_WORDS.includes(word), word);
    }
    for (const word of ["퍼센트", "픽률", "승률", "순위", "평균", "비율", "우승", "참가자", "판수"]) assert.ok(METRIC_WORDS.includes(word), word);
    for (const word of ["하나", "다섯", "아홉", "절반", "번째", "첫째"]) assert.ok(NUMBER_WORDS.includes(word), word);
  });
});

describe("사전 이름", () => {
  test("사전의 캐릭터·무기·장비·특성 이름을 모은다", () => {
    const names = dictionaryNames({
      characters: [{ name: "재키" }, { name: " " }],
      weaponNames: { 13: "쌍검", 7: "권총" },
      itemNames: { 1: "청룡도" },
      traitNames: { 2: "흡혈마" },
    });
    assert.deepEqual(names, { names: ["재키", "권총", "쌍검", "청룡도", "흡혈마"] });
    assert.deepEqual(dictionaryNames({ characters: [], weaponNames: {} }), { names: [] });
    assert.equal(dictionaryNames(null), null);
  });

  test("글 속 이름: 두 글자 이상은 어디서나, 한 글자는 낱말 경계, 여러 낱말 이름은 조각도", () => {
    assert.equal(findDictionaryName("레온입니다", fixtureNames), "레온");
    assert.equal(findDictionaryName("리다이린", fixtureNames), "리 다이린");
    assert.equal(findDictionaryName("돌격이 좋아요", fixtureNames), "돌격 소총");
    assert.equal(findDictionaryName("활 좋아요", fixtureNames), "활");
    assert.equal(findDictionaryName("활약", fixtureNames), null);
    assert.equal(findDictionaryName("좋아 보여요", fixtureNames), null);
  });
});
