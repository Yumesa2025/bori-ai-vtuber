/**
 * 캐릭터 사전. 언어 데이터(l10n)와 게임 데이터로 한국어 이름·무기·장비·특성·현재 시즌을 모은다.
 */
import type { ErClient } from "./client.js";

export type ErDictionary = {
  characters: Array<{ code: number; name: string; weapons: string[] }>;
  weaponNames: Record<number, string>;
  seasonId: number;
  seasonName: string;
  // 아래 셋은 대시보드용으로 나중에 더했다. 예전 사전 파일에는 없을 수 있다.
  /** 장비 코드 → 한국어 이름(l10n Item/Name). 부위별 장비에 쓴다 */
  itemNames?: Record<number, string>;
  /** 특성 코드 → 한국어 이름(l10n Trait/Name). 코어 특성에 쓴다 */
  traitNames?: Record<number, string>;
  /** 현재 시즌이 끝나는 시각(ISO). 지나면 사전을 다시 받아야 한다. 모르면 null */
  seasonEnd?: string | null;
};

/** 경기 결과의 bestWeapon(숙련도 코드) → 언어 데이터 WeaponType 키. 공식 문서 4.5 숙련도 표 기준. */
const WEAPON_TYPES: Record<number, string> = {
  1: "Glove", 2: "Tonfa", 3: "Bat", 4: "Whip", 5: "HighAngleFire", 6: "DirectFire", 7: "Bow", 8: "CrossBow",
  9: "Pistol", 10: "AssaultRifle", 11: "SniperRifle", 13: "Hammer", 14: "Axe", 15: "OneHandSword", 16: "TwoHandSword",
  17: "Polearm", 18: "DualSword", 19: "Spear", 20: "Nunchaku", 21: "Rapier", 22: "Guitar", 23: "Camera", 24: "Arcana", 25: "VFArm",
};

type DataResponse<T> = { data: T };
type CharacterRow = { code: number; name: string };
type MasteryRow = { code: number; weapon1?: string; weapon2?: string; weapon3?: string; weapon4?: string };
type SeasonRow = { seasonID: number; seasonName: string; seasonEnd?: string; isCurrent: number | string };

/**
 * Season API의 "2027-02-18 09:00:00". 시간대 표기가 없어 한국 시간으로 읽는다
 * (경기 startDtm이 +0900이라 그렇게 본다. 공식 문서로는 확인하지 못했다). 못 읽으면 null.
 */
function seasonEndIso(value: string | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const time = Date.parse(`${match[1]}T${match[2]}+09:00`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** l10n에서 "접두어/숫자" 키만 모은다. "202529_D" 같은 변형 키는 뺀다. */
function namesByCode(l10n: Map<string, string>, prefix: string): Record<number, string> {
  const names: Record<number, string> = {};
  for (const [key, value] of l10n) {
    if (!key.startsWith(prefix)) continue;
    const code = key.slice(prefix.length);
    if (/^\d+$/.test(code)) names[Number(code)] = value;
  }
  return names;
}

/** 언어 데이터 텍스트. 한 줄이 "키┃값"이고 값에 ┃가 또 있어도 첫 구분자만 쓴다. */
function parseL10n(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("┃");
    if (at > 0) entries.set(line.slice(0, at), line.slice(at + 1));
  }
  return entries;
}

/**
 * 얼리 액세스 시즌 수. API 시즌 이름은 얼리 액세스부터 이어 세어 정식 출시 뒤 첫 시즌이 Season10이다.
 * 게임 화면은 정식 시즌을 1부터 다시 센다(API Season21 = 정식 시즌 12, 2026-10-15 사용자 확인).
 */
export const EARLY_ACCESS_SEASONS = 9;

/** API 시즌 번호 → 게임에 보이는 시즌 번호. 얼리 액세스 시즌(1~9)은 그대로 둔다. */
export function officialSeasonNumber(apiNumber: number): number {
  return apiNumber > EARLY_ACCESS_SEASONS ? apiNumber - EARLY_ACCESS_SEASONS : apiNumber;
}

/** "Season21" → "시즌 12", "Pre-Season21" → "프리시즌 12". 모르는 형식은 그대로 둔다. */
function koreanSeasonName(name: string): string {
  const match = /^(Pre-)?Season\s*(\d+)$/i.exec(name.trim());
  if (!match) return name;
  return `${match[1] ? "프리시즌" : "시즌"} ${officialSeasonNumber(Number(match[2]))}`;
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
    itemNames: namesByCode(l10n, "Item/Name/"),
    traitNames: namesByCode(l10n, "Trait/Name/"),
    seasonId: current.seasonID,
    seasonName: koreanSeasonName(current.seasonName),
    seasonEnd: seasonEndIso(current.seasonEnd),
  };
}
