/**
 * LLM이 사실 문장 뒤에 붙이는 감상 한마디(comment) 검사(Codex C2 1~3절).
 * 수치·이름이 든 문장은 서버가 정해진 문장으로 만든다. 감상에는 수치·이름·지표가 들어갈 수 없게 닫힌 규칙으로 본다.
 * 어기면 감상만 버리고 서버 문장은 남긴다. 규칙은 넓게(애매하면 버리는 쪽으로) 잡았다. 감상이 빠져도 사실은 그대로 전해진다.
 *
 * 검사 순서(처음 어긴 이유를 돌려준다):
 *  length → number(숫자 글자) → latin → quote → unit(%) → chars(허용 글자 밖) → sentence → ending
 *  → number(한글 수·서수 낱말) → metric(지표·단위 낱말) → name(사전 이름) → word(금지 낱말)
 *
 * Z1(2026-11-22): 실제 키 측정과 무해한 예문 탐색에서 찾은 과잉 판정만 좁혔다. 수로 읽힐 여지가 있는 곳은 그대로 버린다.
 *  - '하나'는 낱말 첫머리에서만 수로 본다("좋아하나 봐요"의 어미는 수가 아니다).
 *  - 붙여 쓴 '이번'은 이 + 번(수 + 단위)으로 보지 않는다. 띄어 쓴 "이 번"은 그대로 버린다.
 *  - '판도가/를/는/의/에'는 판 + 도(단위 + 조사)로 보지 않는다. "판도 많아요"·앞에 수가 붙은 "세 판도가"는 그대로 버린다.
 *  - 대신 붙여 쓴 '열한·열두·열세·열네' + 띄어쓰기·단위를 수로 본다("열한 판도는"이 판도 예외로 빠져나가지 않게).
 */
import { findDictionaryName, PARTICLE, WORD_END, WORD_START, type NameDictionary } from "./names.js";

export const MAX_COMMENT_LENGTH = 40;

export type CommentReason = "length" | "number" | "latin" | "quote" | "unit" | "chars" | "sentence" | "ending" | "metric" | "name" | "word";
export type CommentResult = { ok: true; text: string } | { ok: false; reason: CommentReason | "empty" };

/** 어디에 있든 수로 보는 한글 낱말 */
export const NUMBER_WORDS: readonly string[] = [
  "하나", "다섯", "여섯", "일곱", "여덟", "아홉", "스물", "스무", "서른", "마흔", "예순", "일흔", "여든", "아흔",
  "절반", "반절", "곱절", "갑절", "번째", "첫째", "둘째", "셋째", "넷째", "열째",
];

/** 어디에 있든 지표·단위로 보는 낱말 */
export const METRIC_WORDS: readonly string[] = [
  "퍼센트", "퍼센티지", "프로", "포인트", "픽률", "픽", "승률", "순위", "등수", "평균", "비율", "확률", "우승",
  "참가자", "판수", "표본", "상위", "하위", "티어", "랭크", "랭킹", "점수", "등급", "통계", "몇",
];

/** 지어내기 쉬운 게임 설명·평가·방송 말 */
export const BANNED_WORDS: readonly string[] = [
  "효과", "스킬", "빌드", "패치", "너프", "버프", "상향", "하향", "사기", "오피", "카운터", "조합",
  "캐릭터", "캐릭", "무기", "장비", "아이템", "특성", "시즌",
  "가장", "최고", "최강", "최악", "일등", "꼴등", "강하", "강해", "강한", "강력", "강캐", "약하", "약해", "약한", "약캐", "쎄", "쎈",
  "이유", "때문", "덕분", "대비",
  "여러분", "시청자", "채팅", "구독", "방송",
];

/** 수 뒤에 오는 셈 단위 */
const COUNTER = "(?:위|등|퍼센트|퍼|프로|판|명|배|점|개|번|분|초|가지|차례|단계|시즌|게임|경기|등급|티어)";
const SINO = "일이삼사오육칠팔구십백천만억영공";

/** 한글로 쓴 수·서수 */
const NUMBER_PATTERNS: readonly RegExp[] = [
  // 둘·셋·넷·쉰이 낱말로 홀로 설 때("둘러"는 아니다)
  new RegExp(`${WORD_START}(?:둘|셋|넷|쉰)${WORD_END}`),
  // 관형 수 + 띄어 쓴 낱말: 한 번, 세 배, 열 판
  new RegExp(`${WORD_START}(?:한|두|세|네|스무|열)\\s+[가-힣]`),
  // 관형 수 + 붙인 단위: 한번, 두배, 세명
  new RegExp(`${WORD_START}(?:한|두|세|네|열)${COUNTER}${WORD_END}`),
  // 붙여 쓴 열한·열두·열세·열네 + 띄어쓰기·단위: 열한 판, 열두명. "열세에 몰렸어요"(劣勢)는 남는다
  new RegExp(`${WORD_START}열(?:한|두|세|네)(?=\\s|${COUNTER})`),
  // 첫 번째, 첫째, 첫 판
  new RegExp(`${WORD_START}첫(?=\\s|번|째|$)`),
  // 자릿수(십·백·천·만·억)가 든 한자어 수: 구십구, 백, 오십. "천천히"·"만큼"·"만합니다"는 뒤가 조사·단위가 아니라 남는다
  new RegExp(`${WORD_START}[${SINO}]*[십백천만억][${SINO}]*(?=$|[^가-힣]|${PARTICLE}|${COUNTER})`),
  // 한자어 한두 자리 수 + 단위: 일 위, 이 위, 삼 점, 사위
  new RegExp(`${WORD_START}[일이삼사오육칠팔구영공]{1,3}\\s?${COUNTER}${WORD_END}`),
];

/** 낱말로 홀로 선 단위: "위로 올라왔어요", "판이 많아요" */
const STANDALONE_UNIT = new RegExp(`${WORD_START}(?:위|등|명|판|배|점|개|번|분|초|퍼)${WORD_END}`);

/** 낱말 첫머리에서만 수로 보는 낱말. 그 밖의 NUMBER_WORDS는 어디에 있든 수로 본다 */
const WORD_START_NUMBER_WORDS: ReadonlySet<string> = new Set(["하나"]);

const hasNumberWord = (text: string) => NUMBER_WORDS.some(word =>
  WORD_START_NUMBER_WORDS.has(word) ? new RegExp(`${WORD_START}${word}`).test(text) : text.includes(word));

/** 수 + 단위 꼴이지만 굳은 낱말: 붙여 쓴 '이번'. 한글 수 꼴(NUMBER_PATTERNS)을 보기 전에 공백으로 지운다 */
const NOT_NUMBER = new RegExp(`${WORD_START}이번`, "g");
/** 단위 + 조사 꼴이지만 굳은 낱말: '판도' + 격조사. 홀로 선 단위(STANDALONE_UNIT)를 보기 전에 공백으로 지운다 */
const NOT_UNIT = new RegExp(`${WORD_START}판도(?=가|를|는|의|에)`, "g");

/** 지운 자리를 같은 길이 공백으로 둔다. 앞뒤 낱말은 그대로 낱말 경계에서 다시 본다("이번 판이" → "   판이") */
const blank = (text: string, pattern: RegExp) => text.replace(pattern, match => " ".repeat(match.length));

const ALLOWED = /^[가-힣 ,.!?]+$/;
const QUOTES = /["'“”‘’`´«»「」『』()（）[\]{}<>《》〈〉【】]/;
const ENDING = /(?:요|니다|죠)[.!?]*$/;

export function checkComment(comment: string, names: NameDictionary): CommentResult {
  const text = comment.normalize("NFC").trim();
  const fail = (reason: CommentReason | "empty"): CommentResult => ({ ok: false, reason });
  if (text.length === 0) return fail("empty");
  if ([...text].length > MAX_COMMENT_LENGTH) return fail("length");
  if (/\p{N}/u.test(text)) return fail("number");
  if (/\p{Script=Latin}/u.test(text)) return fail("latin");
  if (QUOTES.test(text)) return fail("quote");
  if (/[%％‰]/.test(text)) return fail("unit");
  if (!ALLOWED.test(text)) return fail("chars");
  if (/[.!?]/.test(text.replace(/[.!?]+$/, ""))) return fail("sentence");
  if (!ENDING.test(text)) return fail("ending");
  // 낱말 목록은 원문에서 본다("이번째"의 '번째'). 지우기는 꼴(정규식) 판정에만 쓴다
  const numberText = blank(text, NOT_NUMBER);
  if (hasNumberWord(text) || NUMBER_PATTERNS.some(pattern => pattern.test(numberText))) return fail("number");
  if (METRIC_WORDS.some(word => text.includes(word)) || STANDALONE_UNIT.test(blank(numberText, NOT_UNIT))) return fail("metric");
  if (findDictionaryName(text, names) !== null) return fail("name");
  if (BANNED_WORDS.some(word => text.includes(word))) return fail("word");
  return { ok: true, text };
}
