/**
 * 대사 숫자 토큰 검사. 숫자를 단위·부호와 함께 하나의 토큰으로 뽑고, 앞 낱말로 뜻을 짐작한다.
 * 대사 검사(check.ts)는 이 토큰을 사실의 토큰과 비교한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractTokens, normalizeForCheck } from "../src/narration/tokens.js";

const simple = (text: string) => extractTokens(text).map(token => `${token.value}${token.unit === "plain" ? "" : `|${token.unit}`}`);

describe("숫자 토큰", () => {
  test("단위를 붙여 뽑는다", () => {
    assert.deepEqual(simple("픽률 8.1%, 평균 순위 3.4위, 참가자 412명, 경기 300판, 변화 +1.2%p"), ["8.1|%", "3.4|rank", "412|명", "300|판", "+1.2|%p"]);
  });

  test("부호는 값의 일부이고, 낱말 사이 하이픈은 부호가 아니다", () => {
    assert.deepEqual(simple("-8.1%p 내려갔어요, MMR +12.3"), ["-8.1|%p", "+12.3"]);
    assert.deepEqual(simple("A-3 구역"), ["3"]);
  });

  test("쉼표 숫자는 한 토큰이고 값에서 쉼표를 뗀다", () => {
    assert.deepEqual(simple("참가자 7,200명"), ["7200|명"]);
    assert.deepEqual(simple("7,200"), ["7200"]);
  });

  test("전각 숫자·전각 퍼센트·유니코드 빼기 기호를 보통 꼴로 바꾼다", () => {
    assert.deepEqual(simple("３위, ５．７％, −0.5"), ["3|rank", "5.7|%", "-0.5"]);
  });

  test("'퍼센트'·'퍼센트포인트'는 %·%p로 본다", () => {
    assert.deepEqual(simple("8.1퍼센트, 1.2퍼센트포인트"), ["8.1|%", "1.2|%p"]);
  });

  test("'1등 비율'의 1은 숫자가 아니다. 다른 'N등'은 순위다", () => {
    assert.deepEqual(simple("1등 비율 14.0%"), ["14.0|%"]);
    assert.deepEqual(simple("1등률이 14.0%"), ["14.0|%"]);
    assert.deepEqual(simple("3등을 했어요"), ["3|rank"]);
  });

  test("TOP·상위 뒤 숫자는 순위, 패치 옆 숫자는 패치, 시즌 뒤 숫자는 시즌", () => {
    assert.deepEqual(simple("픽률 TOP 10, 톱 3, 상위 5"), ["10|rank", "3|rank", "5|rank"]);
    assert.deepEqual(simple("지금 패치 1.47, 13.1 패치"), ["1.47|patch", "13.1|patch"]);
    assert.deepEqual(simple("시즌 13 랭크"), ["13|season"]);
  });

  test("'배'는 배수 단위라 따로 뽑는다", () => {
    assert.deepEqual(simple("2배나 돼요"), ["2|배"]);
  });

  test("한글 수: 순서·한자어 순위·고유어 수+단위를 숫자 토큰으로 바꾼다", () => {
    assert.deepEqual(simple("첫 번째 조합"), ["1|rank"]);
    assert.deepEqual(simple("첫째로"), ["1|rank"]);
    assert.deepEqual(simple("세 번째로 많이"), ["3|rank"]);
    assert.deepEqual(simple("일 위예요"), ["1|rank"]);
    assert.deepEqual(simple("지금 일위"), ["1|rank"]);
    assert.deepEqual(simple("세 배나"), ["3|배"]);
    assert.deepEqual(simple("두 판"), ["2|판"]);
    assert.deepEqual(simple("열 명"), ["10|명"]);
  });

  test("'절반'은 지어낸 수량으로 늘 토큰이 된다", () => {
    assert.equal(extractTokens("절반이나 돼요").length, 1);
  });

  test("숫자가 아닌 흔한 낱말은 토큰이 아니다", () => {
    assert.deepEqual(simple("한 번 확인해 보세요. 이 위에 있어요. 사위, 반가워요, 이등변"), []);
  });

  test("뜻(hint)은 같은 마디 안 가까운 앞 낱말로 짐작한다", () => {
    const hints = (text: string) => extractTokens(text).map(token => token.hint ?? null);
    assert.deepEqual(hints("픽률 8.1%, 평균 순위 3.4위, 1등 비율 14.0% (참가자 412명)"), ["pickRate", "avgRank", "top1Rate", "participants"]);
    assert.deepEqual(hints("평균 순위는 3.9위에서 3.4위로"), ["avgRank", "avgRank"]);
    assert.deepEqual(hints("메타 조합 순위 2위"), ["meta"]);
    assert.deepEqual(hints("재키 쌍검이 3.4위예요"), [null]);
    // 마디가 끊기면 앞 낱말을 쓰지 않는다
    assert.deepEqual(hints("픽률이 높아요. 3.4위예요"), [null]);
  });

  test("정규화는 NFKC와 빼기 기호, '1등 비율'을 바꾼다", () => {
    assert.equal(normalizeForCheck("１등 비율 −１"), "우승비율 -1");
  });
});
