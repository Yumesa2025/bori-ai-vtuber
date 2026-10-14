/**
 * 새 기억이 이미 있는 기억과 같은 뜻인지 판정하는 규칙.
 * 잘못 합치면 서로 다른 사실 하나가 사라지고 되살릴 방법이 없다. 애매하면 합치지 않는 쪽을 고른다.
 * 누구의 기억끼리 비교할지(scope·소유자)는 저장소가 정한다. 여기서는 문장만 본다.
 *
 * 임베딩 유사도로는 합치지 않는다(ADR-023). 실임베딩(text-embedding-3-small) 46쌍을 재 보니
 * 같은 뜻(중앙 0.873)과 다른 뜻(중앙 0.866)이 거의 겹쳐, 0.92에서 "콩이/콩떡이", "스물다섯/스물여섯",
 * "좋아한다/좋아했었다", "즐겨 본다/꺼린다"가 합쳐졌다(점검 M-1). 0.96으로 올려도 다른 뜻이 넘었다.
 * 그래서 문장이 사실상 같을 때(끝의 어미만 다를 때)만 합치고, 비슷하지만 다른 기억은 둘 다 남긴다.
 * 뜻이 같은 바꿔 쓰기를 하나로 모으는 일은 LLM 정리가 "대체할 기억"을 지정하는 쪽이 맡는다.
 */

/**
 * 뜻을 뒤집는 표현. 한쪽에만 있으면 어떤 규칙으로도 합치지 않는다.
 * "안경"처럼 부정이 아닌 낱말도 걸리지만, 그때는 합치지 않을 뿐이라 안전한 쪽으로 틀린다.
 */
const negationPattern = /(?:^|\s)(?:안|못)|않|없|아니|싫|별로|말고|그만|꺼리|끊/g;

/**
 * 끝에서 이것만 다르면 같은 문장으로 본다. 높임·문장 끝맺음만 다른 경우다("좋아해"/"좋아해요", "좋아한다"/"좋아함").
 * 과거형(했다·었다)은 넣지 않는다. "좋아한다"와 "좋아했었다"는 다른 사실이다.
 */
const sameEndingTails: ReadonlySet<string> = new Set([
  "", "요", "다", "함", "음", "임", "해", "해요", "한다", "합니다", "하다",
  "이다", "이에요", "예요", "에요", "입니다", "야", "이야", "어", "어요", "아", "아요", "죠", "지", "네", "네요",
]);

/** 끝맺음을 빼고도 이만큼은 같아야 한다. 아주 짧은 문장끼리 우연히 겹치는 것을 막는다. */
const MIN_COMMON_PREFIX = 4;

/** 비교용 정규화. 대소문자·공백·문장부호를 지운다. */
export const normalizeForCompare = (text: string) => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const negationKey = (text: string) => Array.from(text.normalize("NFC").matchAll(negationPattern), match => match[0].trim()).sort().join(",");

/** 한글 수사 뒤에 단위가 붙은 것. "두 마리"와 "세 마리", "스물다섯 살"과 "스물여섯 살"은 다른 사실이다. */
const koreanNumberPattern = /(?:한|하나|두|둘|세|셋|석|네|넷|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰|예순|일흔|여든|아흔)+\s*(?:살|마리|시간|번|개|명|달|주|해|권|잔|대|층|분|사람|곳|년|일|시)/g;
/** "고양이 2마리"와 "고양이 3마리"처럼 숫자만 다른 문장은 다른 사실이다. 한글 수사도 같이 본다. */
const numberKey = (text: string) => [...(text.match(/\d+/g) ?? []), ...Array.from(text.normalize("NFC").matchAll(koreanNumberPattern), match => match[0].replace(/\s+/g, ""))].join(",");
/**
 * 영문 낱말. 게임·노래 제목 같은 고유명사가 영문이면 이것만 다른 문장("Minecraft를 좋아해"와 "Terraria를 좋아해")이 있다.
 */
const latinKey = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).sort().join(",");

/**
 * 과거를 나타내는 글자 수. 받침 ㅆ이 든 음절(했·었·았·갔·봤…)로 센다. "있"은 진행·존재라 뺀다.
 * "좋아한다"와 "좋아했었다", "배우고 있다"와 "배웠었다"를 가른다.
 */
function tenseKey(text: string): number {
  let count = 0;
  for (const char of text.normalize("NFC")) {
    const code = char.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) continue;
    // 받침 번호 20이 ㅆ이다.
    if (code % 28 === 20 && char !== "있") count += 1;
  }
  return count;
}

/** 부정 표현·숫자·영문 낱말·시제가 같은지. 다르면 어떤 규칙으로도 합치지 않는다. */
function sameGuards(a: string, b: string): boolean {
  return negationKey(a) === negationKey(b) && numberKey(a) === numberKey(b) && latinKey(a) === latinKey(b) && tenseKey(a) === tenseKey(b);
}

/**
 * 문자열만으로 같은 뜻인지. 정규화해서 같거나, 앞부분이 같고 끝의 어미만 다를 때다.
 * "피아노를 좋아해요"/"피아노를 좋아해"는 합치고, "강아지 이름은 콩이다"/"콩떡이다",
 * "재즈 피아노를 좋아해"/"피아노를 좋아해"처럼 가운데가 다르면 따로 둔다.
 */
export function isSameMemoryText(a: string, b: string): boolean {
  if (!sameGuards(a, b)) return false;

  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;

  const xs = Array.from(x);
  const ys = Array.from(y);
  let common = 0;
  while (common < xs.length && common < ys.length && xs[common] === ys[common]) common += 1;
  if (common < MIN_COMMON_PREFIX) return false;
  return sameEndingTails.has(xs.slice(common).join("")) && sameEndingTails.has(ys.slice(common).join(""));
}

/** 두 글자씩 끊은 조각. 공백·문장부호는 지운 뒤에 자른다. */
function bigrams(text: string): Map<string, number> {
  const chars = Array.from(normalizeForCompare(text));
  const grams = new Map<string, number>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const gram = chars[index] + chars[index + 1];
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/**
 * 임베딩이 없는 기억을 검색할 때 쓰는 문자열 유사도(0~1). 두 글자 조각의 겹침(Dice 계수)이다.
 * 임베딩만큼 뜻을 보지는 못하지만, "강아지 이름"을 물었을 때 강아지 이야기를 찾는 정도는 된다(점검 M-8).
 */
export function textSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  const total = [...x.values(), ...y.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  let shared = 0;
  for (const [gram, count] of x) shared += Math.min(count, y.get(gram) ?? 0);
  return (2 * shared) / total;
}
