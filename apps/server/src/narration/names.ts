/**
 * 대사 속 캐릭터·무기 이름 찾기(점검 V2 3·17번).
 * 예전에는 이번 집계 조합의 이름만 알고 부분 문자열(includes)로 찾아서,
 * 집계에 없는 "레온"은 못 막고 "기타 조합"·"암기"처럼 흔한 낱말은 이름으로 잘못 잡았다.
 * - 이름 목록은 사전(er-dictionary)의 전체 캐릭터·무기 이름이다.
 * - 캐릭터 이름은 한글 낱말 경계(앞은 글자가 아니고, 뒤는 글자가 아니거나 조사)일 때만 찾는다.
 * - 무기 이름은 혼자 쓰이면 일반 낱말과 겹치므로(활·기타·암기) "캐릭터 + 공백 + 무기" 꼴만 조합으로 본다.
 */

export type NameDictionary = { characters: readonly string[]; weapons: readonly string[] };

/** @bori/er ErDictionary에서 쓰는 부분만. 서버가 erData.dictionary()를 그대로 넘긴다. */
export type DictionaryLike = { characters: ReadonlyArray<{ name: string }>; weaponNames: Readonly<Record<number, string>> };

export function dictionaryNames(dictionary: DictionaryLike | null | undefined): NameDictionary | null {
  if (!dictionary) return null;
  const unique = (names: string[]) => [...new Set(names.map(name => name.trim()).filter(name => name.length > 0))];
  return {
    characters: unique(dictionary.characters.map(character => character.name)),
    weapons: unique(Object.values(dictionary.weaponNames)).sort(),
  };
}

/** 이름 뒤에 붙어도 되는 조사(두 개까지 이어 붙일 수 있다) */
const PARTICLE = "(?:이|가|은|는|을|를|의|도|만|와|과|로|으로|에|에서|에게|이에요|예요|이요|요|랑|이랑|나|이나|까지|부터|보다|처럼|하고|이고|이며|이라|라|는요|은요|도요|만큼|같이)";
const TAIL = new RegExp(`^${PARTICLE}{0,2}(?![가-힣])`);
const isWordChar = (char: string | undefined) => char !== undefined && /[가-힣A-Za-z0-9]/.test(char);

type Span = { name: string; start: number; end: number };

/** 낱말 경계에 맞는 이름 위치. 긴 이름부터 찾고 겹치는 짧은 이름은 버린다. */
function findSpans(text: string, names: readonly string[], tail: (rest: string) => boolean): Span[] {
  const spans: Span[] = [];
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const end = at + name.length;
      if (isWordChar(text[at - 1]) || !tail(text.slice(end))) continue;
      if (spans.some(span => at < span.end && end > span.start)) continue;
      spans.push({ name, start: at, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

const characterSpans = (text: string, names: NameDictionary) => findSpans(text, names.characters, rest => TAIL.test(rest));

/** 글에 나온 캐릭터 이름(나온 순서, 겹치면 한 번씩) */
export function findCharacterNames(text: string, names: NameDictionary): string[] {
  return [...new Set(characterSpans(text, names).map(span => span.name))];
}

/** "캐릭터 무기" 꼴로 나온 조합 */
export function findPairs(text: string, names: NameDictionary): Array<{ character: string; weapon: string }> {
  const weapons = [...names.weapons].sort((a, b) => b.length - a.length);
  const pairs: Array<{ character: string; weapon: string }> = [];
  for (const span of characterSpans(text, names)) {
    const rest = text.slice(span.end);
    if (!rest.startsWith(" ")) continue;
    const after = rest.slice(1);
    const weapon = weapons.find(name => after.startsWith(name) && TAIL.test(after.slice(name.length)));
    if (weapon) pairs.push({ character: span.name, weapon });
  }
  return pairs;
}
