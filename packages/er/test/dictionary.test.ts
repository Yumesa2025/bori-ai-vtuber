/**
 * 캐릭터 사전 단위 검사. 언어 데이터·게임 데이터 가짜 응답으로 사전을 만들고 채팅 속 이름을 찾는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findCharacter, loadDictionary } from "../src/dictionary.js";
import { dictionaryRoutes, fakeClient, L10N_URL } from "./fake-client.js";

test("한국어 이름·무기·현재 시즌으로 사전을 만든다", async () => {
  const client = fakeClient(dictionaryRoutes());
  const dict = await loadDictionary(client);

  assert.equal(dict.seasonId, 41);
  assert.equal(dict.seasonName, "시즌 12");
  assert.deepEqual(dict.characters.find((c) => c.code === 1), { code: 1, name: "재키", weapons: ["단검", "양손검", "도끼", "쌍검"] });
  // None 무기는 빠진다
  assert.deepEqual(dict.characters.find((c) => c.code === 2)?.weapons, ["권총", "돌격 소총", "저격총"]);
  assert.equal(dict.characters.find((c) => c.code === 10)?.name, "리 다이린");
  // 언어 데이터에 없는 새 캐릭터는 영문 이름, 숙련도 행이 없으면 무기 없음
  assert.deepEqual(dict.characters.find((c) => c.code === 99), { code: 99, name: "NewOne", weapons: [] });
  // bestWeapon 숙련도 코드 → 한국어 무기 이름
  assert.equal(dict.weaponNames[15], "단검");
  assert.equal(dict.weaponNames[1], "글러브");
  assert.equal(dict.weaponNames[10], "돌격 소총");
  assert.ok(client.calls.includes(L10N_URL));
});

test("언어 데이터 주소는 l10nPath 표기도 받는다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes("l10nPath")));
  assert.equal(dict.characters.find((c) => c.code === 1)?.name, "재키");
});

test("언어 데이터 주소가 없으면 실패한다", async () => {
  const routes = { ...dictionaryRoutes(), "/v1/l10n/Korean": { code: 200, message: "Success", data: {} } };
  await assert.rejects(loadDictionary(fakeClient(routes)), /언어 데이터/);
});

test("현재 시즌이 없으면 실패한다", async () => {
  const routes = { ...dictionaryRoutes(), "/v2/data/Season": { code: 200, message: "Success", data: [{ seasonID: 40, seasonName: "Season20", isCurrent: 0 }] } };
  await assert.rejects(loadDictionary(fakeClient(routes)), /현재 시즌/);
});

test("채팅 문장 속 캐릭터 이름을 찾는다(공백·대소문자 무시)", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  assert.equal(findCharacter("재키 요즘 어때?", dict).match?.name, "재키");
  assert.equal(findCharacter("재 키", dict).match?.name, "재키");
  assert.equal(findCharacter("리다이린 티어 알려줘", dict).match?.name, "리 다이린");
  assert.deepEqual(findCharacter("재키 요즘 어때?", dict).suggestions, []);
});

test("여러 이름이 있으면 먼저 나온 이름을 고른다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  assert.equal(findCharacter("재키랑 피오라 중에 뭐가 좋아", dict).match?.name, "재키");
  assert.equal(findCharacter("피오라랑 재키 중에 뭐가 좋아", dict).match?.name, "피오라");
});

test("별칭 표로도 찾는다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  assert.equal(findCharacter("JACKIE 어때", dict).match?.name, "재키");
});

test("한 글자 이름은 낱말로 쓰였을 때만 찾는다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  assert.equal(findCharacter("얀 어때?", dict).match?.name, "얀");
  assert.equal(findCharacter("얀은 요즘 어때", dict).match?.name, "얀");
  assert.equal(findCharacter("하얀 눈이 온다", dict).match, null);
});

test("못 찾으면 비슷한 이름을 최대 3개 제안한다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  const result = findCharacter("잭키", dict);
  assert.equal(result.match, null);
  assert.ok(result.suggestions.includes("재키"));
  assert.ok(result.suggestions.length <= 3);
  // 거리가 같으면 자모가 더 비슷한 이름이 앞이다(잭키: 재키 > 니키·유키)
  assert.deepEqual(result.suggestions, ["재키", "니키", "유키"]);
  // 조사가 붙어도 앞부분으로 비교한다
  assert.ok(findCharacter("피오나는 어때?", dict).suggestions.includes("피오라"));
  // 전혀 다른 말에는 제안이 없다
  assert.deepEqual(findCharacter("오늘 날씨 좋다", dict), { match: null, suggestions: [] });
});
