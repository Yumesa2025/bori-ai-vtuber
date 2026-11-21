/**
 * 보리 대사 숫자 토큰(점검 V2 1·2·4번).
 * 예전 검사는 숫자만(\d+(\.\d+)?) 뽑아 한 줄이 밝힌 사실들의 숫자 전부와 비교해서, 숫자 바꿔치기·단위 바꾸기·"1위" 지어내기가 통과했다.
 * 이제 숫자를 단위·부호와 함께 하나의 토큰으로 뽑고(예: "3.4위" → {3.4, rank}, "-8.1%p" → {-8.1, %p}),
 * 사실 쪽 토큰은 facts.ts가 뜻까지 붙여 만든다. 대사 쪽은 숫자 앞 낱말로 뜻(hint)을 짐작한다.
 * 한글로 쓴 수(세 번째·일 위·세 배)와 전각 숫자도 같은 토큰으로 바꿔 검사를 빠져나가지 못하게 한다.
 */

/** 숫자 단위. rank는 "위"·"등"·"번째"·"TOP N"을 함께 이르는 순위 단위다. 단위가 없으면 plain. */
export type NumberUnit = "%" | "%p" | "rank" | "명" | "판" | "배" | "patch" | "season" | "plain";

/** 사실 쪽 숫자의 뜻. facts.ts가 붙인다. */
export type NumberMeaning =
  | "pickRate" | "pickRank" | "topRange" | "avgRank" | "top1Rate" | "participants" | "games" | "metaRank" | "patch" | "season";

/** 대사 쪽에서 숫자 앞 낱말로 짐작한 뜻 */
export type NumberHint = "pickRate" | "avgRank" | "top1Rate" | "participants" | "meta";

export type NumberToken = { value: string; unit: NumberUnit; meaning?: NumberMeaning; hint?: NumberHint };

/** 짐작한 뜻이 허용하는 사실 쪽 뜻 */
export const HINT_MEANINGS: Record<NumberHint, readonly NumberMeaning[]> = {
  pickRate: ["pickRate", "pickRank", "topRange"],
  avgRank: ["avgRank"],
  top1Rate: ["top1Rate"],
  participants: ["participants"],
  meta: ["pickRank", "metaRank"],
};

/**
 * 비교 전에 글을 한 모양으로 맞춘다: 전각 → 반각(NFKC), 유니코드 빼기 기호 → "-",
 * "1등 비율"·"1등률"은 숫자가 아닌 낱말이라 "우승비율"로, "퍼센트(포인트)"는 기호로.
 */
export function normalizeForCheck(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[−–]/g, "-")
    .replace(/1\s?등\s?(?:비율|률)/g, "우승비율")
    .replace(/퍼센트\s?포인트/g, "%p")
    .replace(/퍼센트/g, "%");
}

const NATIVE: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const SINO: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 십: 10 };
/** 한자어 순위 뒤에 올 수 있는 말. "이 위에"처럼 자리를 뜻하는 "에"는 넣지 않는다. */
const RANK_TAIL = "(?=$|[^가-힣]|예요|이에요|입니다|이고|이며|이라|라는|를|은|는|이|가|로|으로|까지|도|의|권)";

/** 한글로 쓴 수를 아라비아 숫자로 바꾼다. 바꾼 숫자는 같은 토크나이저가 단위와 함께 뽑는다. */
function replaceKoreanNumbers(text: string): string {
  return text
    .replace(/(?<![가-힣])첫\s?(?:번째|째)/g, "1번째")
    .replace(/(?<![가-힣])(두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s?번째/g, (_, word: string) => `${NATIVE[word]}번째`)
    .replace(new RegExp(`(?<![가-힣])(일|삼|오|육|칠|팔|구|십)\\s?(위|등)${RANK_TAIL}`, "g"), (_, word: string, unit: string) => `${SINO[word]}${unit}`)
    // "이"·"사"는 붙여 쓰면 "이등변"·"사위" 같은 낱말이라 띄어 쓴 꼴만 본다.
    .replace(new RegExp(`(?<![가-힣])(이|사)\\s(위|등)${RANK_TAIL}`, "g"), (_, word: string, unit: string) => `${SINO[word]}${unit}`)
    .replace(/(?<![가-힣])(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s?(배|판|명)/g, (_, word: string, unit: string) => `${NATIVE[word]}${unit}`);
}

const NUMBER_PATTERN = /([+-]?)(\d{1,3}(?:,\d{3})+(?![\d.])|\d+(?:\.\d+)?)/g;
const SUFFIX_UNITS: Array<[RegExp, NumberUnit]> = [
  [/^\s?%p/, "%p"],
  [/^\s?%/, "%"],
  [/^\s?(?:번째|위|등)/, "rank"],
  [/^\s?명/, "명"],
  [/^\s?판/, "판"],
  [/^\s?배/, "배"],
  [/^\s?패치/, "patch"],
];
const PREFIX_UNITS: Array<[RegExp, NumberUnit]> = [
  [/(?:TOP|톱|상위)\s?$/i, "rank"],
  [/패치\s?$/, "patch"],
  [/시즌\s?$/, "season"],
];
const KEYWORDS: Array<[string, NumberHint]> = [
  ["픽률", "pickRate"],
  ["평균 순위", "avgRank"],
  ["평균순위", "avgRank"],
  ["평균", "avgRank"],
  ["우승비율", "top1Rate"],
  ["우승 비율", "top1Rate"],
  ["참가자", "participants"],
  ["메타", "meta"],
];
/** 앞 낱말과 숫자 사이 최대 글자 수 */
const HINT_WINDOW = 8;
/** 마디 끝: 쉼표·느낌표·물음표·줄바꿈, 숫자 사이가 아닌 마침표 */
const CLAUSE_BREAK = /[,!?;\n·]|\.(?!\d)/g;

function unitOf(before: string, after: string): NumberUnit {
  for (const [pattern, unit] of SUFFIX_UNITS) if (pattern.test(after)) return unit;
  for (const [pattern, unit] of PREFIX_UNITS) if (pattern.test(before)) return unit;
  return "plain";
}

/** 같은 마디 안 숫자 앞 가까운 낱말로 뜻을 짐작한다. 없으면 undefined. */
function keywordHint(clause: string): { hint: NumberHint; distance: number } | undefined {
  let best: { hint: NumberHint; distance: number } | undefined;
  for (const [word, hint] of KEYWORDS) {
    const at = clause.lastIndexOf(word);
    if (at < 0) continue;
    const distance = clause.length - (at + word.length);
    if (distance <= HINT_WINDOW && (!best || distance < best.distance)) best = { hint, distance };
  }
  return best;
}

function clauseStart(text: string, index: number): number {
  let start = 0;
  for (const match of text.slice(0, index).matchAll(CLAUSE_BREAK)) start = (match.index ?? 0) + 1;
  return start;
}

/** 글 속 숫자 토큰을 나온 순서대로 뽑는다. */
export function extractTokens(source: string): NumberToken[] {
  const text = replaceKoreanNumbers(normalizeForCheck(source));
  const found: Array<{ index: number; end: number; clause: number; token: NumberToken }> = [];

  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const index = match.index ?? 0;
    const [whole, rawSign, digits] = match;
    const previous = text[index - 1] ?? "";
    // 하이픈 앞이 글자·숫자면("A-3") 부호가 아니다.
    const sign = rawSign && !/[0-9A-Za-z가-힣]/.test(previous) ? rawSign : "";
    const start = index + (rawSign.length - sign.length);
    const end = index + whole.length;
    const before = text.slice(0, start);
    const unit = unitOf(before, text.slice(end));
    const clause = clauseStart(text, start);
    const token: NumberToken = { value: `${sign}${digits.replace(/,/g, "")}`, unit };

    const fromKeyword = keywordHint(text.slice(clause, start));
    const last = found.at(-1);
    if (fromKeyword) token.hint = fromKeyword.hint;
    // "평균 순위는 3.9위에서 3.4위로"처럼 같은 단위가 이어지면 앞 숫자의 뜻을 잇는다.
    else if (last?.token.hint && last.clause === clause && last.token.unit === unit && start - last.end <= HINT_WINDOW) token.hint = last.token.hint;

    found.push({ index: start, end, clause, token });
  }

  for (const match of text.matchAll(/절반/g)) {
    found.push({ index: match.index ?? 0, end: (match.index ?? 0) + 2, clause: 0, token: { value: "절반", unit: "배" } });
  }

  return found.sort((a, b) => a.index - b.index).map(entry => entry.token);
}
