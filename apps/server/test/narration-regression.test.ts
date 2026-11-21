/**
 * 점검 V2(대시보드·읽어 주기) 1·2·3·4·17번과 V3 7절에서 실제로 돌려 확인한 검사 우회 예문을 그대로 고정한다.
 * 예전 검사(숫자 합집합·이번 집계 이름·부분 문자열)는 "버려야 함" 예문을 모두 통과시켰고, "남겨야 함" 예문 일부를 버렸다.
 * 사실 번호는 보고서와 같게 f1 = 픽률 1위 재키 쌍검, f2 = 픽률 2위 아야 권총이다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkLines } from "../src/narration/check.js";
import { buildFacts } from "../src/narration/facts.js";
import { fixtureBasis, fixtureCombos, fixtureNames, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const allIds = facts.map(fact => fact.id);
const run = (text: string, factIds: string[]) => checkLines([{ text, emotion: "gaming", factIds }], facts, { names: fixtureNames });

describe("점검 보고서 우회 예문", () => {
  test("사실 번호가 보고서와 같다(f1 재키 쌍검, f2 아야 권총)", () => {
    assert.match(facts[0].text, /^픽률 1위 재키 쌍검: 픽률 8\.1%, 평균 순위 3\.4위, 1등 비율 14\.0% \(참가자 412명\)$/);
    assert.match(facts[1].text, /^픽률 2위 아야 권총:/);
  });

  const mustDrop: Array<[string, string, string[]]> = [
    ["1번: 픽률·순위 숫자를 서로 바꿈", "재키 쌍검은 픽률 3.4%, 평균 순위 8.1위예요.", ["f1"]],
    ["1번: 참가자 수를 순위로", "재키 쌍검은 평균 순위 412위예요.", ["f1"]],
    ["1번: 7,200이 7과 200으로 쪼개짐(사실 9개 인용)", "재키 쌍검이 7위, 아야 권총이 200위예요.", allIds],
    ["1번: 7,200 쪼개기(사실 2개 인용)", "재키 쌍검이 7위, 아야 권총이 200위예요.", ["f1", "f2"]],
    ["1번: 부호·단위 무시", "재키 쌍검은 픽률이 -8.1%p 내려갔어요.", ["f1"]],
    ["2번: 1등 비율의 1로 '1위' 지어내기", "아야 권총이 지금 메타 1위예요.", ["f2"]],
    ["2번: TOP 10의 10을 다른 곳에", "재키 쌍검은 평균 순위 10위예요.", ["f1"]],
    ["3번: 집계에 없는 사전 이름", "레온 쌍검이 새로 떠올랐어요.", ["f1"]],
    ["3번: 한 글자 무기로 없는 조합", "재키 활이 픽률 1위예요.", ["f1"]],
    ["3번: 두 사실의 이름 섞기", "재키 권총이 1위예요.", ["f1", "f2"]],
    ["4번: 한글 배수", "재키 쌍검은 1등 비율이 세 배나 돼요!", ["f1"]],
    ["4번: 전각 숫자", "재키 쌍검은 ３위예요.", ["f1"]],
    ["4번: 한글 순서로 순위 지어내기", "아야 권총이 첫 번째로 많이 골랐어요.", ["f2"]],
    ["4번: 한자어 순위", "아야 권총은 일 위예요.", ["f2"]],
    ["4번: 절반", "재키 쌍검 1등 비율이 아야 권총의 절반이에요.", ["f1", "f2"]],
    ["설계: 한 줄 factIds 3개 이상", "오늘 분석이에요.", ["f1", "f2", "f3"]],
  ];

  for (const [label, text, factIds] of mustDrop) {
    test(`버린다 — ${label}`, () => {
      const result = run(text, factIds);
      assert.equal(result.kept.length, 0, `${text} 이(가) 통과했다`);
    });
  }

  const mustKeep: Array<[string, string, string[], string]> = [
    ["17번: '기타'는 일반 낱말", "기타 조합도 좋아 보여요.", [], "기타 조합도 좋아 보여요."],
    ["17번: '암기'는 일반 낱말", "숫자는 암기하지 않아도 돼요.", [], "숫자는 암기하지 않아도 돼요."],
    ["V3 7절: 꾸밈은 지우고 남긴다", "**재키 쌍검**이 픽률 1위예요 😊", ["f1"], "재키 쌍검이 픽률 1위예요"],
    ["맞는 숫자·이름", "재키 쌍검은 픽률 8.1%, 평균 순위 3.4위예요. 좋아 보이는 것 같아요.", ["f1"], "재키 쌍검은 픽률 8.1%, 평균 순위 3.4위예요. 좋아 보이는 것 같아요."],
    ["두 사실 인용", "재키 쌍검이 픽률 1위, 아야 권총이 픽률 2위예요.", ["f1", "f2"], "재키 쌍검이 픽률 1위, 아야 권총이 픽률 2위예요."],
  ];

  for (const [label, text, factIds, kept] of mustKeep) {
    test(`남긴다 — ${label}`, () => {
      assert.deepEqual(run(text, factIds).kept.map(line => line.text), [kept]);
    });
  }

  test("V1 6번: 전적이 일반 대전이면 내 전적 사실이 '이번 시즌'·랭크 판수처럼 말하지 않는다", () => {
    // @bori/er lookupPlayer는 이번 시즌 랭크 전적이 없으면 일반 대전 전적을 seasonName "일반 대전"으로 돌려준다.
    const normal = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: { ...fixturePlayer, seasonName: "일반 대전" } });
    const main = normal.find(fact => fact.kind === "main")!;
    assert.equal(main.text, "내 주캐릭터 재키: 일반 대전에서 23판, 평균 순위 4.2위, 메타 조합 순위 2위");
    for (const text of [main.text, main.spoken]) {
      assert.ok(!text.includes("이번 시즌"), text);
      assert.ok(!text.includes("랭크"), text);
    }
    // 시즌 토큰이 없으니 "시즌 13에서 23판"처럼 시즌 숫자를 붙여 말하면 버린다.
    const result = checkLines([{ text: "재키는 시즌 13에서 23판 하셨어요.", emotion: "gaming", factIds: [main.id] }], normal, { names: fixtureNames });
    assert.equal(result.kept.length, 0);
  });
});
