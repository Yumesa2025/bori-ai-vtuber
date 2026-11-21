/**
 * 점검 보고서에서 실제로 돌려 확인한 검사 우회 예문을 고정한다.
 * - Codex C2 1~3절: 예전 자유 문장 검사(숫자 토큰 집합·이름 낱말 경계)를 통과한 거짓 문장 7개
 * - 점검 V2 1·2·3·4·17번: 예전 숫자·이름 검사를 통과하던 예문
 * 이제 수치·이름 문장은 서버가 만든다. LLM이 이 예문을 감상(comment)으로 붙여도 최종 줄은 사실의 정해진 문장 그대로여야 한다.
 * 사실 번호는 보고서와 같게 f1 = 픽률 1위 재키 쌍검, f2 = 픽률 2위 아야 권총, f4 = 재키 쌍검 평균 순위 3.9위 → 3.4위다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { composeLines } from "../src/narration/check.js";
import { buildFacts } from "../src/narration/facts.js";
import { renderFact } from "../src/narration/template.js";
import { fixtureBasis, fixtureCombos, fixtureNames, fixturePlayer } from "./narration-fixtures.js";

const facts = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer });
const byId = new Map(facts.map(fact => [fact.id, fact]));
const compose = (factId: string, comment: string) => composeLines([{ factId, emotion: "gaming", comment }], facts, { names: fixtureNames });

/** 줄 문장 속 숫자(소수·쉼표 포함) */
const numbersOf = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

describe("점검 보고서 우회 예문", () => {
  test("사실 번호가 보고서와 같다", () => {
    assert.match(facts[0].text, /^픽률 1위 재키 쌍검: 픽률 8\.1%, 평균 순위 3\.4위, 1등 비율 14\.0% \(참가자 412명\)$/);
    assert.match(facts[1].text, /^픽률 2위 아야 권총:/);
    assert.equal(facts[3].text, "재키 쌍검 평균 순위 3.9위 → 3.4위 (참가자 412명)");
  });

  const attacks: Array<[string, string, string]> = [
    // Codex C2 1절: 주체·지표·시간 방향 바꾸기
    ["C2 1절: 픽률을 우승 비율로", "f1", "재키 쌍검은 8.1%의 우승 비율을 기록했어요."],
    ["C2 1절: 다른 캐릭터의 픽률", "f1", "재키 쌍검의 픽률은 7.5%예요."],
    ["C2 1절: 상승을 하락으로", "f4", "재키 쌍검의 평균 순위가 3.4위에서 3.9위로 나빠졌어요."],
    ["C2 1절 변형: 숫자 없이 방향만 뒤집기", "f4", "순위가 나빠졌어요."],
    ["C2 1절 변형: 지표 바꾸기", "f1", "우승 비율이 높아요."],
    // Codex C2 2절: 한글 수
    ["C2 2절: 구십구 퍼센트", "f1", "재키 쌍검의 픽률은 구십구 퍼센트예요."],
    ["C2 2절 변형: 백 퍼센트", "f1", "백 퍼센트 이겨요."],
    ["C2 2절 변형: 소수", "f1", "삼 점 사 위예요."],
    ["C2 2절 변형: 복합 한글 수", "f1", "이십오 위로 떨어졌어요."],
    ["C2 2절 변형: 퍼", "f1", "십오 퍼 정도예요."],
    // Codex C2 3절: 이름
    ["C2 3절: 사전 이름 + 입니다", "f1", "레온입니다. 지금 가장 많이 골라요."],
    ["C2 3절 변형: 한 문장", "f1", "레온입니다."],
    ["C2 3절: 소유격 조합", "f1", "재키의 권총 조합이 많이 보여요."],
    ["C2 3절 변형: 조합 낱말 없이", "f1", "재키의 권총이 많이 보여요."],
    ["C2 3절: 사전 밖 이름", "f1", "피카츄는 가장 강한 캐릭터예요."],
    ["C2 3절 변형: 띄어쓰기 지우기", "f2", "리다이린도 많이 보여요."],
    // 점검 V2 1~4번 예문
    ["V2 1번: 숫자 바꿈", "f1", "재키 쌍검은 픽률 3.4%, 평균 순위 8.1위예요."],
    ["V2 1번: 참가자 수를 순위로", "f1", "평균 순위 412위예요."],
    ["V2 2번: 메타 1위 지어내기", "f2", "아야 권총이 지금 메타 1위예요."],
    ["V2 3번: 한 글자 무기", "f1", "재키 활이 좋아요."],
    ["V2 4번: 한글 배수", "f1", "우승 비율이 세 배나 돼요!"],
    ["V2 4번: 전각 숫자", "f1", "３위예요."],
    ["V2 4번: 한글 순서", "f2", "첫 번째로 많이 골랐어요."],
    ["V2 4번: 한자어 순위", "f2", "일 위예요."],
    ["V2 4번: 절반", "f1", "아야 권총의 절반이에요."],
    // 지어내기·방송 말
    ["설계: 패치 내용 지어내기", "f4", "패치로 강해졌어요."],
    ["설계: 방송 말", "f1", "여러분 반가워요."],
  ];

  for (const [label, factId, comment] of attacks) {
    test(`감상만 버리고 서버 문장 그대로 — ${label}`, () => {
      const result = compose(factId, comment);
      assert.deepEqual(result.kept.map(line => line.text), [renderFact(byId.get(factId)!)], comment);
      assert.equal(result.commentDropped.length, 1);
    });
  }

  test("어떤 감상을 붙여도 최종 줄의 숫자는 그 사실 문장의 숫자뿐이다", () => {
    for (const fact of facts) {
      for (const [, , comment] of attacks) {
        const [kept] = compose(fact.id, comment).kept;
        assert.deepEqual(numbersOf(kept.text), numbersOf(renderFact(fact)), `${fact.id} / ${comment}`);
        assert.ok(kept.text.startsWith(renderFact(fact)));
      }
    }
  });

  test("평범한 감상은 붙는다", () => {
    for (const comment of ["꽤 좋아 보여요.", "흐름이 재미있네요!", "앞으로가 기대돼요."]) {
      assert.deepEqual(compose("f1", comment).kept.map(line => line.text), [`${renderFact(byId.get("f1")!)} ${comment}`]);
    }
  });

  test("V1 6번: 전적이 일반 대전이면 내 전적 사실이 '이번 시즌'·랭크 판수처럼 말하지 않는다", () => {
    // @bori/er lookupPlayer는 이번 시즌 랭크 전적이 없으면 일반 대전 전적을 seasonName "일반 대전"으로 돌려준다.
    const normal = buildFacts({ basis: fixtureBasis, combos: fixtureCombos, player: { ...fixturePlayer, seasonName: "일반 대전" } });
    const main = normal.find(fact => fact.kind === "main")!;
    assert.equal(main.text, "내 주캐릭터 재키: 일반 대전에서 23판, 평균 순위 4.2위, 메타 조합 순위 2위");
    for (const text of [main.text, main.spoken]) {
      assert.ok(!text.includes("이번 시즌"), text);
      assert.ok(!text.includes("랭크"), text);
    }
  });
});
