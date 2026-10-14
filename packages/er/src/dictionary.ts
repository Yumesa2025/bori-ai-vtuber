/**
 * 캐릭터 사전. 언어 데이터(l10n)와 게임 데이터로 한국어 이름·무기·현재 시즌을 모으고,
 * 채팅 문장에서 캐릭터 이름을 찾는다.
 */
import { characterAliases } from "./aliases.js";
import type { ErClient } from "./client.js";

export type ErDictionary = { characters: Array<{ code: number; name: string; weapons: string[] }>; weaponNames: Record<number, string>; seasonId: number; seasonName: string };
type ErCharacter = ErDictionary["characters"][number];

/** 경기 결과의 bestWeapon(숙련도 코드) → 언어 데이터 WeaponType 키. 공식 문서 4.5 숙련도 표 기준. */
const WEAPON_TYPES: Record<number, string> = {
  1: "Glove", 2: "Tonfa", 3: "Bat", 4: "Whip", 5: "HighAngleFire", 6: "DirectFire", 7: "Bow", 8: "CrossBow",
  9: "Pistol", 10: "AssaultRifle", 11: "SniperRifle", 13: "Hammer", 14: "Axe", 15: "OneHandSword", 16: "TwoHandSword",
  17: "Polearm", 18: "DualSword", 19: "Spear", 20: "Nunchaku", 21: "Rapier", 22: "Guitar", 23: "Camera", 24: "Arcana", 25: "VFArm",
};

type DataResponse<T> = { data: T };
type CharacterRow = { code: number; name: string };
type MasteryRow = { code: number; weapon1?: string; weapon2?: string; weapon3?: string; weapon4?: string };
type SeasonRow = { seasonID: number; seasonName: string; isCurrent: number | string };

/** 언어 데이터 텍스트. 한 줄이 "키┃값"이고 값에 ┃가 또 있어도 첫 구분자만 쓴다. */
function parseL10n(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("┃");
    if (at > 0) entries.set(line.slice(0, at), line.slice(at + 1));
  }
  return entries;
}

/** "Season21" → "시즌 21". 모르는 형식은 그대로 둔다. */
function koreanSeasonName(name: string): string {
  const match = /^(Pre-)?Season\s*(\d+)$/i.exec(name.trim());
  if (!match) return name;
  return `${match[1] ? "프리시즌" : "시즌"} ${match[2]}`;
}

export async function loadDictionary(client: ErClient): Promise<ErDictionary> {
  // 공식 문서에 l10Path·l10nPath 두 표기가 섞여 있어 둘 다 받는다
  const info = await client.get<DataResponse<{ l10Path?: string; l10nPath?: string }>>("/v1/l10n/Korean");
  const l10nUrl = info.data?.l10Path ?? info.data?.l10nPath;
  if (!l10nUrl) throw new Error("언어 데이터 주소가 응답에 없습니다");
  const l10n = parseL10n(await client.get<string>(l10nUrl));

  const characters = await client.get<DataResponse<CharacterRow[]>>("/v2/data/Character");
  const masteries = await client.get<DataResponse<MasteryRow[]>>("/v2/data/CharacterMastery");
  const seasons = await client.get<DataResponse<SeasonRow[]>>("/v2/data/Season");

  const current = seasons.data.find((season) => Number(season.isCurrent) === 1);
  if (!current) throw new Error("현재 시즌을 찾지 못했습니다");

  const weaponName = (type: string) => l10n.get(`WeaponType/${type}`) ?? type;
  const weaponNames: Record<number, string> = {};
  for (const [code, type] of Object.entries(WEAPON_TYPES)) weaponNames[Number(code)] = weaponName(type);

  const masteryByCode = new Map(masteries.data.map((row) => [row.code, row]));
  return {
    characters: characters.data.map((row) => {
      const mastery = masteryByCode.get(row.code);
      const types = mastery ? [mastery.weapon1, mastery.weapon2, mastery.weapon3, mastery.weapon4] : [];
      return {
        code: row.code,
        name: l10n.get(`Character/Name/${row.code}`) ?? row.name,
        weapons: types.filter((type): type is string => !!type && type !== "None").map(weaponName),
      };
    }),
    weaponNames,
    seasonId: current.seasonID,
    seasonName: koreanSeasonName(current.seasonName),
  };
}

const normalize = (text: string) => text.normalize("NFC").toLowerCase().replace(/\s+/g, "");
/** 낱말 비교용. 문장부호를 뺀다. */
const bare = (text: string) => normalize(text).replace(/[^\p{L}\p{N}]/gu, "");

/** 코드포인트 단위 편집 거리. */
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= y.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[y.length]!;
}

/** 한글 음절을 초성·중성·종성으로 나눈다. 거리가 같은 제안을 고를 때 쓴다(잭키는 니키보다 재키에 가깝다). */
function jamo(text: string): string {
  return Array.from(text, (char) => {
    const index = char.codePointAt(0)! - 0xac00;
    if (index < 0 || index > 11171) return char;
    const tail = index % 28;
    return String.fromCharCode(0x1100 + Math.floor(index / 588), 0x1161 + Math.floor((index % 588) / 28)) + (tail ? String.fromCharCode(0x11a7 + tail) : "");
  }).join("");
}

/** 제안으로 인정할 최대 편집 거리. 한 글자 이름은 비슷한 말이 너무 많아 제안하지 않는다. */
const maxSuggestDistance = (length: number) => (length <= 1 ? 0 : length <= 4 ? 1 : 2);

/** 채팅에서 캐릭터 이름을 찾는다. 공백·대소문자 무시, 별칭 표 포함. 못 찾으면 비슷한 이름 최대 3개. */
export function findCharacter(text: string, dict: ErDictionary): { match: ErDictionary["characters"][number] | null; suggestions: string[] } {
  const byName = new Map(dict.characters.map((character) => [character.name, character]));
  const keys: Array<{ key: string; character: ErCharacter }> = dict.characters.map((character) => ({ key: normalize(character.name), character }));
  for (const [alias, name] of Object.entries(characterAliases)) {
    const character = byName.get(name);
    if (character) keys.push({ key: normalize(alias), character });
  }

  // 낱말과 그 낱말이 공백을 뺀 문장에서 시작하는 위치
  const words: Array<{ word: string; at: number }> = [];
  let offset = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    words.push({ word: bare(raw), at: offset });
    offset += normalize(raw).length;
  }

  const joined = normalize(text);
  let best: { at: number; length: number; character: ErCharacter } | null = null;
  for (const { key, character } of keys) {
    if (key.length === 0) continue;
    let at = -1;
    if (Array.from(key).length >= 2) {
      at = joined.indexOf(key);
    } else {
      // 한 글자 이름은 "얀", "얀은"처럼 낱말 앞에 올 때만 인정한다("하얀"은 아니다)
      at = words.find(({ word }) => word.startsWith(key) && Array.from(word).length <= 2)?.at ?? -1;
    }
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && key.length > best.length)) best = { at, length: key.length, character };
  }
  if (best) return { match: best.character, suggestions: [] };

  const candidates = [...words.map(({ word }) => word), bare(text)].filter(Boolean);
  const scored: Array<{ name: string; distance: number; jamoDistance: number }> = [];
  for (const character of dict.characters) {
    const name = bare(character.name);
    const length = Array.from(name).length;
    const limit = maxSuggestDistance(length);
    if (limit === 0) continue;
    let distance = Infinity;
    let jamoDistance = Infinity;
    for (const candidate of candidates) {
      // 조사가 붙은 낱말("피오나는")은 이름 길이만큼 앞부분으로도 비교한다
      for (const word of [candidate, Array.from(candidate).slice(0, length).join("")]) {
        distance = Math.min(distance, editDistance(word, name));
        jamoDistance = Math.min(jamoDistance, editDistance(jamo(word), jamo(name)));
      }
    }
    if (distance <= limit) scored.push({ name: character.name, distance, jamoDistance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.jamoDistance - b.jamoDistance || a.name.localeCompare(b.name, "ko"));
  return { match: null, suggestions: scored.slice(0, 3).map(({ name }) => name) };
}
