import { cosineSimilarity } from "./embedding.js";

/**
 * 새 기억이 이미 있는 기억과 같은 뜻인지 판정하는 규칙.
 * 잘못 합치면 서로 다른 사실 하나가 사라지고 되살릴 방법이 없다. 애매하면 합치지 않는 쪽을 고른다.
 * 누구의 기억끼리 비교할지(scope·소유자)는 저장소가 정한다. 여기서는 문장만 본다.
 */

/**
 * 임베딩 코사인 유사도가 이 값 이상이면 같은 뜻으로 본다.
 * 검색 임계값(minSimilarity 기본 0.3)은 "관련 있음"을 보는 값이라 병합에 쓰기에는 한참 낮다.
 * 어순·조사·높임만 다른 바꿔 쓰기를 겨냥해 높게 잡았다. 실제 기억 데이터로 재서 정한 값이 아니라
 * 보수적인 출발점이므로, 잘못 합치는 사례가 나오면 올린다.
 */
export const MERGE_SIMILARITY = 0.92;

/**
 * 한 문장이 다른 문장을 품을 때, 짧은 쪽이 긴 쪽 길이의 이 비율 이상이어야 같은 뜻으로 본다.
 * "피아노를 좋아해요"와 "피아노를 좋아해"는 합치고, "재즈 피아노를 좋아해"처럼 정보가 더 붙은 문장은 따로 둔다.
 */
export const CONTAINMENT_MIN_RATIO = 0.8;

/**
 * 뜻을 뒤집는 표현. 한쪽에만 있으면 유사도가 아무리 높아도 다른 사실이다.
 * "안경"처럼 부정이 아닌 낱말도 걸리지만, 그때는 합치지 않을 뿐이라 안전한 쪽으로 틀린다.
 */
const negationPattern = /(?:^|\s)(?:안|못)|않|없|아니|싫|별로|말고|그만/g;

/** 비교용 정규화. 대소문자·공백·문장부호를 지운다. */
const normalizeForCompare = (text: string) => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const negationKey = (text: string) => Array.from(text.matchAll(negationPattern), match => match[0].trim()).sort().join(",");
/** "고양이 2마리"와 "고양이 3마리"는 임베딩이 거의 같아도 다른 사실이다. */
const numberKey = (text: string) => (text.match(/\d+/g) ?? []).join(",");
/**
 * 영문 낱말. 게임·노래 제목 같은 고유명사가 영문이면 이것만 다른 문장("Minecraft를 좋아해"와 "Terraria를 좋아해")도
 * 임베딩이 가깝게 나올 수 있다. 한글 고유명사는 가려낼 수 없어 임계값에 맡긴다.
 */
const latinKey = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).sort().join(",");

/** 부정 표현·숫자·영문 낱말이 같은지. 다르면 어떤 규칙으로도 합치지 않는다. */
function sameGuards(a: string, b: string): boolean {
  return negationKey(a) === negationKey(b) && numberKey(a) === numberKey(b) && latinKey(a) === latinKey(b);
}

/** 문자열만으로 같은 뜻인지. 정규화해서 같거나, 길이가 거의 같고 한쪽이 다른 쪽을 품을 때다. */
export function isSameMemoryText(a: string, b: string): boolean {
  if (!sameGuards(a, b)) return false;

  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.includes(short) && short.length / long.length >= CONTAINMENT_MIN_RATIO;
}

/** 임베딩으로 같은 뜻인지. 부정·숫자·영문 낱말 검사는 임베딩이 놓치므로 여기서도 먼저 한다. */
export function isSameMemoryEmbedding(a: { text: string; embedding: readonly number[] }, b: { text: string; embedding: readonly number[] }): boolean {
  if (!sameGuards(a.text, b.text)) return false;
  return cosineSimilarity(a.embedding, b.embedding) >= MERGE_SIMILARITY;
}
