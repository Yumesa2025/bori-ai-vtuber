/**
 * 캐릭터 사전 단위 검사. 언어 데이터·게임 데이터 가짜 응답으로 사전을 만든다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDictionary } from "../src/dictionary.js";
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

test("장비·특성 한국어 이름과 현재 시즌 끝 시각을 담는다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  assert.equal(dict.itemNames?.[117406], "저지먼트");
  assert.equal(dict.itemNames?.[202529], "화령장");
  assert.equal(dict.traitNames?.[7000601], "아드레날린");
  // 숫자가 아닌 변형 키(202529_D)는 넣지 않는다
  assert.equal(Object.keys(dict.itemNames ?? {}).some((key) => !/^\d+$/.test(key)), false);
  // "2026-11-12 09:00:00"은 한국 시간으로 읽는다
  assert.equal(dict.seasonEnd, "2026-11-12T00:00:00.000Z");
});

test("시즌 끝 시각을 읽지 못하면 null", async () => {
  const routes = { ...dictionaryRoutes(), "/v2/data/Season": { code: 200, message: "Success", data: [{ seasonID: 41, seasonName: "Season21", isCurrent: 1 }] } };
  const dict = await loadDictionary(fakeClient(routes));
  assert.equal(dict.seasonEnd, null);
});
