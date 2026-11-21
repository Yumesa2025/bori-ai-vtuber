/**
 * 감상 한마디 속 사전 이름 찾기(Codex C2 3절).
 * 예전에는 자유 문장에서 "캐릭터 + 조사"·"캐릭터 + 공백 + 무기" 꼴만 찾아서 "레온입니다"·"재키의 권총"이 빠져나갔다.
 * 이제 수치·이름 문장은 서버가 만들고, LLM 감상에는 사전 이름이 아예 들어갈 수 없다. 그래서 찾기를 넓게(어긋나면 버리는 쪽으로) 한다.
 * - 이름 목록은 사전(er-dictionary)의 캐릭터·무기·장비·특성 이름 전체다.
 * - 두 글자 이상 이름은 글 어디에 있든 찾는다. 띄어쓰기를 지운 글에서도 찾는다("리다이린").
 * - 여러 낱말 이름은 두 글자 이상 조각도 찾는다("돌격 소총"의 "돌격").
 * - 한 글자 이름(활·창)은 흔한 낱말 첫 글자와 겹치므로(활약) 낱말 경계(앞이 한글이 아니고 뒤가 끝·조사)에서만 찾는다.
 */

export type NameDictionary = { names: readonly string[] };

/** @bori/er ErDictionary에서 쓰는 부분만. 서버가 erData.dictionary()를 그대로 넘긴다. */
export type DictionaryLike = {
  characters: ReadonlyArray<{ name: string }>;
  weaponNames: Readonly<Record<number, string>>;
  itemNames?: Readonly<Record<number, string>>;
  traitNames?: Readonly<Record<number, string>>;
};

export function dictionaryNames(dictionary: DictionaryLike | null | undefined): NameDictionary | null {
  if (!dictionary) return null;
  const all = [
    ...dictionary.characters.map(character => character.name),
    ...Object.values(dictionary.weaponNames),
    ...Object.values(dictionary.itemNames ?? {}),
    ...Object.values(dictionary.traitNames ?? {}),
  ];
  return { names: [...new Set(all.map(name => name.trim()).filter(name => name.length > 0))] };
}

/**
 * 낱말 뒤에 붙어도 낱말이 끝난 것으로 보는 조사·어미(앞부분만 본다).
 * "나"는 "만나"처럼 흔한 낱말과 겹쳐 넣지 않는다.
 */
export const PARTICLE = "(?:이|가|은|는|을|를|의|도|만|에|로|으로|까지|부터|과|와|랑|보다|씩|쯤|째|권|예요|이에요|입니다|이죠|죠|이네요|네요|이요|요)";
/** 낱말이 여기서 끝난다: 글 끝, 한글이 아닌 글자, 또는 조사 */
export const WORD_END = `(?=$|[^가-힣]|${PARTICLE})`;
/** 낱말이 여기서 시작한다: 앞 글자가 한글이 아니다 */
export const WORD_START = "(?<![가-힣])";

const compact = (text: string) => text.replace(/\s+/g, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 글에 나온 사전 이름 하나(처음 찾은 것). 없으면 null */
export function findDictionaryName(text: string, dictionary: NameDictionary): string | null {
  const flat = compact(text);
  for (const name of dictionary.names) {
    const parts = name.split(/[^가-힣]+/).filter(part => part.length > 0);
    const joined = parts.join("");
    if (joined.length >= 2 && flat.includes(joined)) return name;
    if (parts.length >= 2 && parts.some(part => part.length >= 2 && text.includes(part))) return name;
    if (joined.length === 1 && new RegExp(`${WORD_START}${escape(joined)}${WORD_END}`).test(text)) return name;
  }
  return null;
}
