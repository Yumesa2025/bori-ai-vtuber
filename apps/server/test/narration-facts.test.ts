/**
 * 보리가 말할 사실 목록 검사. 규칙은 설계 3절: 메타 TOP 3, 크게 오른 2, 크게 내린 1, 새 TOP 10, 내 주캐릭터, 패치 바뀜.
 * 사실마다 화면과 같은 반올림의 숫자 토큰({값, 단위, 뜻})과 조합 짝을 갖고, 닉네임은 들어가지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildFacts, rankMovers, withParticle } from "../src/narration/facts.js";
import { extractTokens } from "../src/narration/tokens.js";
import { selectMovers } from "../../companion/src/dashboard.js";
import { combo, FAKE_NICKNAME, fixtureBasis, fixtureCombos, fixturePlayer } from "./narration-fixtures.js";

const input = { basis: fixtureBasis, combos: fixtureCombos, player: fixturePlayer };

describe("사실 목록", () => {
  const unitsOf = (tokens: { value: string; unit: string }[]) => tokens.map(token => `${token.value}|${token.unit}`);

  test("id는 f1부터 차례이고 토큰의 값·단위는 사실 문장에서 뽑은 것과 같다", () => {
    const facts = buildFacts({ ...input, basis: { ...fixtureBasis, patchChanged: true } });
    assert.deepEqual(facts.map(fact => fact.id), facts.map((_, index) => `f${index + 1}`));
    for (const fact of facts) {
      assert.deepEqual(unitsOf(fact.tokens), unitsOf(extractTokens(fact.text)), fact.text);
      assert.ok(fact.tokens.every(token => token.meaning !== undefined), fact.text);
    }
  });

  test("TOP 사실 토큰은 픽률 순위·픽률·평균 순위·1등 비율·참가자 뜻을 갖고, '1등 비율'의 1은 토큰이 아니다", () => {
    const top = buildFacts(input).find(fact => fact.kind === "top")!;
    assert.deepEqual(top.tokens, [
      { value: "1", unit: "rank", meaning: "pickRank" },
      { value: "8.1", unit: "%", meaning: "pickRate" },
      { value: "3.4", unit: "rank", meaning: "avgRank" },
      { value: "14.0", unit: "%", meaning: "top1Rate" },
      { value: "412", unit: "명", meaning: "participants" },
    ]);
    assert.deepEqual(top.pairs, [{ character: "재키", weapon: "쌍검" }]);
  });

  test("메타 TOP 3은 표본 적은 조합을 빼고 픽률 순이다", () => {
    const top = buildFacts(input).filter(fact => fact.kind === "top");
    assert.equal(top.length, 3);
    assert.match(top[0].text, /^픽률 1위 재키 쌍검: 픽률 8\.1%, 평균 순위 3\.4위, 1등 비율 14\.0% \(참가자 412명\)$/);
    assert.deepEqual(top.map(fact => fact.names[0]), ["재키", "아야", "현우"]);
    assert.ok(!top.some(fact => fact.text.includes("유키")));
  });

  test("크게 오른 2개는 평균 순위가 가장 좋아진 순, 크게 내린 1개는 가장 나빠진 것이다", () => {
    const facts = buildFacts(input);
    const risers = facts.filter(fact => fact.kind === "riser");
    const fallers = facts.filter(fact => fact.kind === "faller");
    assert.deepEqual(risers.map(fact => fact.text), [
      "재키 쌍검 평균 순위 3.9위 → 3.4위 (참가자 412명)",
      "현우 글러브 평균 순위 4.0위 → 3.8위 (참가자 350명)",
    ]);
    assert.deepEqual(unitsOf(risers[0].tokens), ["3.9|rank", "3.4|rank", "412|명"]);
    assert.deepEqual(fallers.map(fact => fact.text), ["아야 권총 평균 순위 3.5위 → 4.1위 (참가자 380명)"]);
  });

  test("반올림하면 같아지는 변화(하트 +0.02)와 표본 적은 조합(유키)은 움직임으로 치지 않는다", () => {
    const { risers, fallers } = rankMovers(fixtureCombos, 5);
    const names = [...risers, ...fallers].map(entry => entry.characterName);
    assert.ok(!names.includes("하트"));
    assert.ok(!names.includes("유키"));
  });

  test("화면의 오르고 내린 조합과 같은 규칙이다", () => {
    const keys = (list: { characterCode: number; weaponCode: number }[]) => list.map(entry => `${entry.characterCode}:${entry.weaponCode}`);
    const server = rankMovers(fixtureCombos, 5);
    const screen = selectMovers(fixtureCombos, 5);
    assert.deepEqual(keys(screen.risers), keys(server.risers));
    assert.deepEqual(keys(screen.fallers), keys(server.fallers));
  });

  test("직전 갱신에 없던 조합이 TOP 10에 들면 새로 든 조합이다", () => {
    const newTop = buildFacts(input).filter(fact => fact.kind === "newTop");
    assert.deepEqual(newTop.map(fact => fact.text), ["새로 픽률 TOP 10에 든 조합: 나딘 활 (픽률 6.0%)"]);
  });

  test("직전 갱신에서 픽률 순위가 10 밖이던 조합도 새로 든 조합이다", () => {
    const many = Array.from({ length: 12 }, (_, index) => combo({
      characterCode: 100 + index, characterName: `캐릭${index}`, weaponCode: 1, weaponName: "검", participants: 100, pickRate: 0.05 - index * 0.001, avgRank: 4, top1Rate: 0.1,
      change: { avgRank: 0, top1Rate: 0, pickRate: index === 3 ? 0.03 : 0, avgMmrGain: 0 },
    }));
    const newTop = buildFacts({ basis: fixtureBasis, combos: many, player: null }).filter(fact => fact.kind === "newTop");
    assert.deepEqual(newTop.map(fact => fact.names[0]), ["캐릭3"]);
  });

  test("직전 갱신이 없으면 오르고 내린·새로 든 사실이 없다", () => {
    const fresh = fixtureCombos.map(entry => ({ ...entry, change: null }));
    const facts = buildFacts({ basis: { ...fixtureBasis, previousCollectedAt: null }, combos: fresh, player: null });
    assert.deepEqual(facts.map(fact => fact.kind), ["top", "top", "top", "basis"]);
  });

  test("주캐릭터의 메타 위치를 넣되 닉네임은 어디에도 넣지 않는다", () => {
    const facts = buildFacts(input);
    const main = facts.find(fact => fact.kind === "main");
    assert.equal(main?.text, "내 주캐릭터 재키: 시즌 13에서 23판, 평균 순위 4.2위, 메타 조합 순위 2위");
    for (const fact of facts) {
      assert.ok(!fact.text.includes(FAKE_NICKNAME));
      assert.ok(!fact.spoken.includes(FAKE_NICKNAME));
    }
    const outside = buildFacts({ ...input, player: { ...fixturePlayer, mainCharacters: [{ name: "재키", games: 3, avgRank: 5, metaRank: null }] } });
    assert.equal(outside.find(fact => fact.kind === "main")?.text, "내 주캐릭터 재키: 시즌 13에서 3판, 평균 순위 5.0위, 메타 조합 순위에는 없음");
  });

  test("주캐릭터 판수가 0이거나 평균 순위가 수가 아니면 주캐릭터 사실을 만들지 않는다(0.0위 방지)", () => {
    for (const main of [{ name: "재키", games: 0, avgRank: 0, metaRank: 1 }, { name: "재키", games: 3, avgRank: Number.NaN, metaRank: 1 }]) {
      const facts = buildFacts({ ...input, player: { ...fixturePlayer, mainCharacters: [main] } });
      assert.equal(facts.find(fact => fact.kind === "main"), undefined);
    }
  });

  test("전적이 일반 대전이면 사실 문장도 그 이름을 쓴다", () => {
    const facts = buildFacts({ ...input, player: { ...fixturePlayer, seasonName: "일반 대전" } });
    assert.match(facts.find(fact => fact.kind === "main")!.text, /^내 주캐릭터 재키: 일반 대전에서 23판/);
  });

  test("패치가 바뀌었으면 알리고, 기준 사실은 늘 마지막이다", () => {
    const facts = buildFacts({ ...input, basis: { ...fixtureBasis, patchChanged: true } });
    assert.equal(facts.find(fact => fact.kind === "patch")?.text, "시즌이나 패치가 지난 갱신과 다름 (지금 패치 1.47)");
    assert.equal(facts.at(-1)?.text, "집계 기준: 시즌 13 랭크 경기 300판, 참가자 7,200명");
  });

  test("정해진 문장도 사실 문장의 숫자 토큰만 쓴다", () => {
    for (const fact of buildFacts({ ...input, basis: { ...fixtureBasis, patchChanged: true } })) {
      const allowed = unitsOf(fact.tokens);
      for (const token of unitsOf(extractTokens(fact.spoken))) assert.ok(allowed.includes(token), `${fact.spoken} / ${token}`);
    }
  });

  test("기준이나 조합이 없으면 사실도 없다", () => {
    assert.deepEqual(buildFacts({ basis: null, combos: fixtureCombos, player: null }), []);
    assert.deepEqual(buildFacts({ basis: fixtureBasis, combos: [], player: fixturePlayer }), []);
  });

  test("조사는 받침에 맞춘다", () => {
    assert.equal(withParticle("재키 쌍검", "는", "은"), "재키 쌍검은");
    assert.equal(withParticle("아야 권총", "는", "은"), "아야 권총은");
    assert.equal(withParticle("나딘 활", "가", "이"), "나딘 활이");
    assert.equal(withParticle("하트 기타", "가", "이"), "하트 기타가");
    assert.equal(withParticle("Jackie", "가", "이"), "Jackie가");
  });
});
