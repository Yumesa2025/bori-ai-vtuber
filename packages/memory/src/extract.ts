import { isAnonymousViewer } from "./access.js";
import type { MemoryCandidate } from "./types.js";

/** 저장하면 안 되는 내용. 계획서 12장의 제외 대상이다. */
const excludePattern = /(정치|의료|법률|투자|주식|개인정보|비밀번호|전화번호|주소|계좌|주민등록)/;

/**
 * 낱말 목록만으로는 "010-1234-5678", "test@example.com"처럼 값만 적은 문장을 못 막았다(a2 M-08).
 * 저장 직전에 값의 꼴과 건강·정신건강 표현을 함께 본다(S-3). 위기·정신건강 발화는 기억으로 남기지 않는다(ADR-022).
 */
const sensitivePatterns: readonly RegExp[] = [
  // 휴대전화·일반 전화번호
  /01[016-9][-\s.]?\d{3,4}[-\s.]?\d{4}/,
  /0\d{1,2}-\d{3,4}-\d{4}/,
  // 이메일과 연락처 낱말
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/,
  /연락처|이메일|메일\s*주소|카톡\s*아이디/,
  // 주민등록번호 꼴
  /\d{6}\s*-\s*[1-4]\d{6}/,
  // 연도가 붙은 생년월일. "생일은 3월 5일"처럼 연도 없는 생일은 남긴다.
  /생년월일|(19|20)?\d{2}\s*년생|(19|20)\d{2}\s*[년.\/-]\s*\d{1,2}\s*[월.\/-]\s*\d{1,2}\s*일?\s*(생|에\s*태어|태어)/,
  // 병·진단·치료
  /진단|처방|복용|정신과|병원|입원|수술|우울증|공황|조울|양극성|불안\s*장애|ADHD|조현|치매|항우울|약을?\s*먹/,
  // 위기·정신건강 표현
  /자살|자해|죽\s*고\s*싶|사라지고\s*싶|살\s*기\s*(가\s*)?싫|극단\s*적\s*(인\s*)?선택|우울/,
];

/** 저장하면 안 되는 내용인지. 계획서 12장의 제외 낱말과 값의 꼴·건강 표현을 함께 본다. */
const isSensitiveText = (text: string) => excludePattern.test(text) || sensitivePatterns.some(pattern => pattern.test(text));
/**
 * 인사·감탄 낱말과 문장부호. 이것들을 다 지웠을 때 남는 것이 없으면 단순 인사·일회성 반응이다.
 * 예전에는 "안녕"으로 시작하기만 해도 버려서 "안녕 보리! 나는 피아노 연주곡을 좋아해"처럼
 * 인사 뒤에 취향을 말한 문장까지 기억되지 않았다. 메시지 전체가 인사·감탄일 때만 버린다.
 */
const trivialTokenPattern = /안녕하세요|안녕하십니까|안녕|하이|반가워요|반가워|반갑습니다|어서와요|어서와|잘가요|잘가|바이|굿|좋아요|감사합니다|감사해요|감사|고마워요|고마워|ㅋ+|ㅎ+|ㅠ+|ㅜ+|[\s!?.,~^]+/g;

/** 단순 인사와 일회성 반응은 장기 기억으로 남기지 않는다. */
const isTrivialText = (text: string) => text.replace(trivialTokenPattern, "").length === 0;

/**
 * 시청자의 취향·경험이 드러나는 표현.
 * 점검(a4 A4-01, a6 A6-06)에서 "리듬 게임에 완전 빠졌어", "요즘은 마라탕이 더 좋아요", "좋아하지 않아"처럼
 * 입말로 한 취향이 저장되지 않았다. 방송과 1:1이 같은 패턴을 쓴다.
 */
const preferencePattern = /(좋아해|좋아합니다|좋아하거든|좋아하는\s*편|[을를이가]\s*(더\s*)?(좋아요|좋더라)|더\s*좋|싫어해|싫어합니다|싫어요|좋아하지\s*않|안\s*좋아해|별로\s*(안|예요|야|에요)|즐겨|자주\s*(듣|하|해|봐|보|가)|최애|덕질|취미|빠졌|빠져\s*있|꽂혔|꽂혀|하고\s*있어|다니고\s*있어|배우고\s*있어|하는\s*중|요즘(은|엔)?\s.+(해요|해|하고|배워|들어|봐요|다녀|읽어|먹어))/;
/** 시청자의 상황이나 경험. 정정("A가 아니라 B")과 바뀐 사실(그만뒀다·끊었다)도 여기서 잡는다. */
const experiencePattern = /(퇴근|출근|시험|졸업|이사|아팠|아파|생일|여행|취직|입사|합격|바빴|힘들었|아니라|잘못\s*말|그만뒀|그만두|끊었|바꿨|바뀌었)/;

/**
 * 묻는 말. "제 강아지 이름 기억나요?", "내 취미 뭐였더라"는 사실을 말한 것이 아니다(점검 M-3).
 * 저장하면 다음 같은 질문에 질문 원문이 맨 위로 올라와 다른 기억을 밀어냈고, 떠보기 질문이 거짓 기억이 됐다.
 */
const questionPattern = /[?？]|였더라|었더라|았더라|했더라|(나요|까요|던가요|었나요|았나요|했나요)\s*$/;
/**
 * 기억을 떠보는 말. "제 고양이 이름 기억나요", "제가 뭐라고 했었죠"처럼 보리가 기억하는지 묻는다.
 * LLM 정리도 이런 질문에서 "상대는 고양이를 키운다"를, 기억을 되짚은 보리의 답에서 "제주도 여행 계획이 있다"를 만들었다(F3 실모델 재현).
 */
const memoryProbePattern = /기억\s*(나|하시|하세|하지|해\s*줘|해요|하니|하냐)|뭐였|뭐더라|뭐라고\s*했|어디였|언제였|누구였|했었죠|했었나|했던\s*거/;

/** 기억을 떠보는 말인지. 1:1 LLM 정리에 넘기기 전에 이런 질문과 그 답을 뺄 때 쓴다. */
export const isMemoryProbe = (text: string) => memoryProbePattern.test(text);

/**
 * 다른 사람에 관한 말. "친구가 고양이를 좋아해", "엄마가 아팠어"는 말한 사람의 사실이 아니다(점검 M-3).
 * 보리나 상대(너)를 주어로 한 말도 말한 사람의 사실이 아니다. "친구랑 여행 가요"처럼 함께한 일은 남긴다.
 */
const otherPersonPattern = /(친구|엄마|아빠|어머니|아버지|부모님|동생|언니|오빠|누나|형|남친|여친|남자\s*친구|여자\s*친구|애인|남편|아내|와이프|선배|후배|동료|팀장|사장님|선생님|할머니|할아버지|이모|고모|삼촌|사촌|아들|딸)(가|이|는|은|도|께서)\s|(^|\s)(너는|넌|네가|니가|너도|보리는|보리가|보리도|보리님은|보리님이|보리님도)(\s|$)/;

/**
 * 상대적인 날짜·때. 저장한 뒤 며칠 지나면 뜻이 바뀐다("다음 주 토요일"이 지난 일이 된다, 점검 M-7).
 * 이런 말이 든 기억에는 들은 날을 함께 남긴다.
 */
const relativeTimePattern = /(오늘|내일|모레|어제|그제|그저께|이번\s*주|다음\s*주|담주|지난\s*주|저번\s*주|이번\s*달|다음\s*달|지난\s*달|저번\s*달|올해|내년|작년|이번\s*주말|다음\s*주말|며칠\s*(뒤|후|전)|곧|이따)/;

/** 상대적인 날짜·때가 든 문장인지. 들은 날을 붙여 저장할지 정할 때 쓴다. */
export const hasRelativeTime = (text: string) => relativeTimePattern.test(text);

export type ConversationTurn = { role: "viewer" | "bori"; text: string; viewerId?: string };

/**
 * 발언 하나가 장기 기억 후보인지 규칙으로 판정한다. 후보가 아니면 null이다.
 * 방송과 1:1이 같은 기준을 쓰고, 공개 범위와 소유자는 호출하는 쪽이 정한다.
 */
function classifyMemoryText(raw: string): { text: string; importance: number } | null {
  const text = raw.trim();
  if (text.length < 6) return null;
  if (isSensitiveText(text)) return null;
  if (isTrivialText(text)) return null;
  if (questionPattern.test(text) || memoryProbePattern.test(text) || otherPersonPattern.test(text)) return null;

  const isPreference = preferencePattern.test(text);
  const isExperience = experiencePattern.test(text);
  if (!isPreference && !isExperience) return null;

  // 취향은 반복해서 확인되는 편이라 조금 더 높게 잡는다.
  return { text, importance: isPreference ? 0.6 : 0.45 };
}

/**
 * 방송 대화에서 장기 기억 후보를 규칙으로 추린다.
 * 후보는 말한 시청자 소유의 방송 기억이 된다.
 * 익명 발언은 누구의 것인지 알 수 없으므로 후보로 만들지 않는다.
 */
export function extractMemoryCandidates(turns: readonly ConversationTurn[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  for (const turn of turns) {
    if (turn.role !== "viewer") continue;
    if (isAnonymousViewer(turn.viewerId)) continue;

    const classified = classifyMemoryText(turn.text);
    if (!classified) continue;

    candidates.push({
      text: classified.text,
      kind: "viewer",
      scope: "broadcast",
      ownerId: turn.viewerId,
      importance: classified.importance,
      // 규칙으로만 뽑은 단계라 확신은 중간이다. LLM 요약을 거치면 올라간다.
      confidence: 0.5,
    });
  }

  return candidates;
}

/**
 * 규칙으로 뽑은 1:1 기억 문장. 사용자가 한 말을 그대로 두되 누가 한 말인지 붙인다.
 * 예전에는 "나는 ○○ 노래를 즐겨 들어"가 그대로 [기억]에 들어가 보리 자신의 기억으로 읽힐 수 있었다(점검 M-14).
 * 상대적인 날짜가 들어 있으면 들은 날을 함께 적는다(점검 M-7).
 */
export function privateRuleMemoryText(text: string, heardOn?: string): string {
  return heardOn && hasRelativeTime(text) ? `상대가 ${heardOn}에 한 말: "${text}"` : `상대가 한 말: "${text}"`;
}

/**
 * 1:1 대화의 사용자 메시지에서 개인 기억 후보를 추린다.
 * 후보는 그 사용자 소유의 private 기억이 되고, 방송 기억으로는 만들지 않는다.
 * 소유자를 모르면 누구의 기억인지 알 수 없으므로 후보를 만들지 않는다.
 * heardOn은 들은 날("10월 15일")이다. 상대적인 날짜가 든 문장에만 붙는다.
 */
export function extractPrivateMemoryCandidates(texts: readonly string[], ownerId: string, options: { heardOn?: string } = {}): MemoryCandidate[] {
  if (ownerId.trim().length === 0 || isAnonymousViewer(ownerId)) return [];

  return texts.flatMap(text => {
    const classified = classifyMemoryText(text);
    if (!classified) return [];
    // kind는 사람에 관한 기억이라는 뜻으로 viewer를 그대로 쓴다. 누구의 것인지는 scope와 ownerId가 정한다.
    return [{ text: privateRuleMemoryText(classified.text, options.heardOn), kind: "viewer" as const, scope: "private" as const, ownerId, importance: classified.importance, confidence: 0.5 }];
  });
}

/** 위험하거나 개인정보가 섞인 요약은 저장 직전에 한 번 더 막는다. */
export function isStorableMemory(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return !isSensitiveText(trimmed);
}
