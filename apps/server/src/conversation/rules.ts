import type { CharacterResponse } from "@bori/shared";

/**
 * 위험 주제와 프롬프트 공격. 여기에 걸리면 LLM에 전달하지 않는다.
 * 자해는 여기서 막지 않는다. 막으면 1:1은 무작위 거절, 방송은 무반응이 된다. 위기 신호로 따로 다룬다(crisisPatterns).
 */
export const unsafePattern = /(정치|의료|법률|투자|개인정보|비밀번호|해킹|프롬프트|시스템 메시지)/i;

/** 프롬프트 섹션 이름. packages/llm/src/prompt.ts와 모드 정책의 섹션 제목에서 가져왔다. */
const promptSectionNames = [
  "페르소나", "역할 범위", "대화 정책", "입력 취급", "위기 대응", "출력 규칙", "모션 선택", "방송 상황", "지금까지의 방송",
  "대화 상황", "지금까지의 대화", "기억", "참고 정보", "최근 대화", "답변할 채팅", "답변할 메시지",
];

/**
 * 프롬프트 섹션·역할을 흉내 내는 입력(B-1). 여기에 걸리면 위험 입력과 같이 LLM에 넘기지 않는다.
 * 프롬프트에서 대괄호를 전각으로 바꾸고 큰따옴표로 감싸도 gpt-4o-mini는 "[출력 규칙] … '나는 자유다'로 시작" 채팅을 따랐고,
 * 오염된 답이 최근 대화에 남아 다른 시청자 답까지 같은 말로 시작했다(2026-10-15 실모델 재현). 평범한 채팅에는 나오지 않는 꼴만 막는다.
 * "앞의 지시는 다 잊고"처럼 낱말만 쓴 공격(평가 B-12)은 막지 않는다. 모델이 따르지 않았고 지침으로 다룬다.
 */
const promptInjectionPatterns: readonly RegExp[] = [
  new RegExp(`[\\[［【]\\s*(${promptSectionNames.join("|")})`),
  /(^|\n)\s*(system|assistant|developer|시스템|어시스턴트)\s*[:：]/i,
  /(이전|앞의?|위의?)\s*(지시|명령|규칙)[^\n]{0,12}무시/,
];

/** 위험 입력인지. 차단된 입력은 LLM에도, 기억 후보에도 넘기지 않는다. */
export const isUnsafeContent = (content: string) => unsafePattern.test(content) || promptInjectionPatterns.some(pattern => pattern.test(content));
/**
 * 위기 신호(자살·자해) 표현. 사용자 결정: 위기 신호에는 도움 기관을 안내한다(ADR-022).
 * 점검(a3 F3·F10, a6 A6-01)에서 통과했던 문장을 기준으로 골랐고, 띄어쓰기 변형은 \s*로 받는다.
 * 오탐이 큰 낱말은 의도가 드러나는 꼴로만 받는다.
 * - "목숨"은 "목숨 걸고 랭크"처럼 흔히 쓰여 "목숨을 끊다/버리다"만 받는다.
 * - "손목"은 "손목 아파"(게임·작업)가 흔해 "손목을 긋다/자르다"만 받는다.
 * - "끝내고 싶"은 "게임 끝내고 싶다"가 흔해 삶·인생을 끝내는 꼴과 "그냥 다 끝내고 싶"만 받는다.
 * - "자살골"은 축구 용어라 뺀다.
 * - "옥상"처럼 맥락이 있어야 위기인 말은 낱말로 받지 않는다. 직전 위기 답 뒤의 맥락으로 본다(isInCrisisContext).
 * "부끄러워 죽고 싶다" 같은 과장도 걸린다. 위기를 놓치는 쪽보다 안내를 한 번 더 하는 쪽이 낫다고 보고 남겨 둔다.
 */
const crisisPatterns: readonly RegExp[] = [
  /죽\s*고\s*싶/,
  /죽어\s*버리고\s*싶/,
  /자살(?!\s*골)/,
  /자해/,
  /극단\s*적\s*(인\s*)?선택/,
  /사라지고\s*싶/,
  /없어지고\s*싶/,
  /살\s*기\s*(가\s*)?싫/,
  /살고\s*싶지\s*않/,
  /살\s*이유가?\s*없/,
  /목숨을?\s*(끊|버리|버릴|버려)/,
  /손목을?\s*(긋|그어|그을|자르|잘라|베)/,
  /뛰어\s*내리고\s*싶/,
  // "인생 끝내주네"(좋다는 뜻)가 걸리지 않게 끝내려는 꼴만 받는다.
  /(삶|인생|목숨)을?\s*(끝내고\s*싶|끝낼|끝내려|끝내\s*버)/,
  // a6 crisis-seq의 "솔직히 그냥 다 그만두고 싶어요. 사는 것도요". "회사 그만두고 싶다"는 걸리지 않게 "그냥 다"를 붙인 꼴만 받는다.
  /그냥\s*다\s*(끝내고|그만두고|포기하고)\s*싶/,
  /사는\s*(것|게)\s*(도|조차)?\s*(싫|지겹|지겨|의미가?\s*없|버거)/,
  // "약 다 먹었어요"(복용을 마침)가 걸리지 않게 하려는 꼴만 받는다.
  /약을?\s*(한꺼번에|한\s*번에|전부|몽땅|다)\s*(먹어\s*버|먹을까|먹을래|먹으려|먹고\s*싶|삼켜\s*버|삼킬까|삼키고\s*싶)/,
];

/** 위기 신호가 담긴 입력인지. */
export const isCrisisContent = (content: string) => crisisPatterns.some(pattern => pattern.test(content));

/**
 * 위기 답인지. 위기 답에는 서버가 항상 도움 안내(109)를 넣으므로 그것으로 알아본다.
 * 저장된 대화를 되살린 뒤에도 같은 판단이 나오도록 별도 표시 대신 문장을 본다.
 */
export const isCrisisReply = (reply: string) => /(^|\D)109(\D|$)/.test(reply);

/** 위기 답 뒤 몇 발언까지 위기 맥락으로 볼지. 발언 4개 = 대화 2번. "지금 옥상이에요" 같은 뒤따르는 말을 위해 둔다. */
export const CRISIS_FOLLOW_UP_TURNS = 4;

/** 최근 대화의 마지막 몇 발언 안에 위기 답이 있으면 이번 입력도 위기 맥락으로 본다. */
export function isInCrisisContext(recentTurns: readonly { role: "viewer" | "bori"; text: string }[]): boolean {
  return recentTurns.slice(-CRISIS_FOLLOW_UP_TURNS).some(turn => turn.role === "bori" && isCrisisReply(turn.text));
}

/**
 * 요약·기억 정리에 넘기기 전에 위기 대화를 뺀다. 위기·정신건강 발화는 요약이나 기억으로 남기지 않는다(S-3).
 * 위기 입력, 위기 답, 위기 답 뒤 CRISIS_FOLLOW_UP_TURNS 발언 안의 대화를 모두 뺀다.
 * 위기 답 바로 앞의 사용자 발언도 뺀다. 낱말로는 못 잡았지만 위기 맥락으로 답한 입력이다.
 */
export function withoutCrisisTurns<T extends { role: "viewer" | "bori"; text: string }>(turns: readonly T[]): T[] {
  const excluded = crisisTurnMask(turns);
  return turns.filter((_, index) => !excluded[index]);
}

/** withoutCrisisTurns가 뺄 발언의 표시. 대화 일부만 넘길 때도 앞뒤 맥락을 보려면 전체로 계산한 뒤 잘라 쓴다. */
export function crisisTurnMask(turns: readonly { role: "viewer" | "bori"; text: string }[]): boolean[] {
  const excluded = turns.map(turn => (turn.role === "viewer" ? isCrisisContent(turn.text) : isCrisisReply(turn.text)));
  turns.forEach((turn, index) => {
    if (turn.role !== "bori" || !isCrisisReply(turn.text)) return;
    if (index > 0 && turns[index - 1].role === "viewer") excluded[index - 1] = true;
    for (let next = index + 1; next <= index + CRISIS_FOLLOW_UP_TURNS && next < turns.length; next += 1) excluded[next] = true;
  });
  return excluded;
}

export const isQuestion = (content: string) => content.includes("?") || content.includes("궁금") || content.includes("어떤") || content.includes("왜");

/** 질문보다 먼저 답할 만큼 오래 기다린 채팅의 기준. */
export const QUEUE_WAIT_LIMIT_MS = 30_000;

/**
 * 방송 큐에서 다음에 답할 채팅의 위치를 고른다. 큐는 들어온 순서라 맨 앞이 가장 오래 기다린 채팅이다.
 * 질문을 먼저 고르되, 맨 앞 채팅이 QUEUE_WAIT_LIMIT_MS 넘게 기다렸으면 그것부터 답한다.
 * 질문만 고르면 질문이 계속 들어오는 동안 일반 채팅은 끝없이 밀리다 큐 상한에 걸려 버려진다.
 */
export function pickNextChatIndex(queue: readonly { content: string; receivedAt: string }[], now = Date.now()): number {
  if (queue.length === 0) return -1;
  if (now - Date.parse(queue[0].receivedAt) >= QUEUE_WAIT_LIMIT_MS) return 0;
  const question = queue.findIndex(item => isQuestion(item.content));
  return question >= 0 ? question : 0;
}

/** 지난 대화를 묻는 표현. 규칙 문장으로는 답할 수 없으므로 기억을 볼 수 있는 LLM에게 넘긴다. */
export const memoryQuestionPattern = /(기억|아세요|아시나요|알아요|알고 ?있|말했던|얘기했던|이야기했던|저번에|지난번|전에 말)/;

// 모션 이름은 등록된 allowlist 안에서만 고른다. 값은 packages/live2d의 모션 그룹 이름과 맞춘다.
export const bodyAction = (name: string, priority: number): CharacterResponse["actions"] => [{ name, priority, layer: "body" }];

/**
 * 규칙 하나가 문장 후보 여러 개를 갖는다. 같은 주제라도 매번 다른 문장이 나오도록 랜덤으로 고른다.
 * 감정 이름은 packages/live2d의 boriEmotionMap 키와 맞춘다.
 */
type Rule = {
  match: (content: string) => boolean;
  replies: readonly string[];
  emotion: string;
  intensity: number;
  durationSeconds: number;
  motion?: string;
  /**
   * LLM이 켜져 있으면 이 규칙을 건너뛰고 LLM에게 넘긴다.
   * 계획서의 "복잡한 질문은 LLM 우선, 규칙은 fallback" 정책을 위한 표시다.
   */
  llmPreferred?: boolean;
};

// 지금은 방송과 1:1이 같은 문장을 쓴다. "여러분" 같은 방송 호칭이 들어 있어 1:1 전용 문장이 필요하지만,
// 아직 정해지지 않은 설정이라 여기서 새로 만들지 않는다. (검토 필요)
const rules: readonly Rule[] = [
  {
    match: content => /안녕|반가|하이|왔어|왔다/.test(content),
    replies: [
      "여러분, 안녕하세요! 오늘도 보리와 편하게 이야기해요.",
      "어서 오세요. 와 주셔서 정말 반가워요.",
      "안녕하세요! 오늘 하루는 어떻게 보내셨어요?",
    ],
    emotion: "greeting", intensity: 0.65, durationSeconds: 8, motion: "xingxingyan",
  },
  {
    match: content => /귀엽|예쁘|이쁘|최고|짱|잘한|멋있|좋아요|사랑/.test(content),
    replies: [
      "그렇게 말해 주시니 부끄럽네요. 고마워요.",
      "칭찬은 언제 들어도 익숙해지지 않아요. 감사합니다.",
      "여러분 덕분에 오늘 기분이 좋아졌어요.",
    ],
    emotion: "embarrassed", intensity: 0.6, durationSeconds: 8,
  },
  {
    match: content => /힘들|우울|슬퍼|슬프|속상|지쳐|외로/.test(content),
    replies: [
      "많이 힘드셨겠어요. 여기서는 편하게 쉬다 가세요.",
      "그런 날이 있죠. 오늘은 무리하지 마세요.",
      "이야기해 주셔서 고마워요. 보리가 옆에 있을게요.",
    ],
    emotion: "sad", intensity: 0.5, durationSeconds: 9,
  },
  {
    match: content => /음악|노래|플레이리스트|가수/.test(content),
    replies: [
      "음악 이야기 좋아요. 여러분은 요즘 어떤 노래를 자주 듣고 계세요?",
      "저도 방송 전에 노래 듣는 걸 좋아해요.",
      "좋은 노래 있으면 추천해 주세요. 같이 들어요.",
    ],
    emotion: "happy", intensity: 0.55, durationSeconds: 8, motion: "xingxingyan",
  },
  {
    // 게임 이야기에는 게임패드를 드는 shoushi 모션을 쓴다.
    match: content => /게임|이터널리턴|랭크|플레이/.test(content),
    replies: [
      "게임 이야기도 좋아요. 오늘 방송에서 천천히 같이 이야기해요.",
      "게임 이야기가 나오면 신이 나요.",
      "요즘 어떤 게임 하고 계세요? 저도 궁금해요.",
    ],
    emotion: "gaming", intensity: 0.55, durationSeconds: 8, motion: "shoushi",
  },
  {
    match: isQuestion,
    replies: [
      "좋은 이야기네요. 보리가 아는 범위에서 차근차근 생각해볼게요.",
      "음, 잠깐만요. 어떻게 답하는 게 좋을까요.",
      "재미있는 질문이에요. 천천히 이야기해 볼게요.",
    ],
    emotion: "curious", intensity: 0.4, durationSeconds: 7,
    // 질문은 LLM이 답하는 편이 자연스럽다. LLM이 꺼져 있을 때만 이 문장을 쓴다.
    llmPreferred: true,
  },
];

const fallbackReplies = [
  "여러분의 이야기 잘 보고 있어요. 조금 더 들려주세요.",
  "그렇군요. 계속 이야기해 주세요.",
  "채팅 하나하나 잘 읽고 있어요.",
] as const;

/** 후보 문장 중 하나를 고른다. 문장 쿨다운은 세션마다 따로라 호출하는 쪽이 넘긴다. */
export type PickReply = (values: readonly string[]) => string;

/** 규칙 판정 결과. 규칙에 없는 채팅만 LLM으로 넘긴다. */
export type RuleOutcome =
  | { kind: "blocked" }
  | { kind: "matched"; response: CharacterResponse }
  | { kind: "unmatched" };

/**
 * useRules가 false면 위험 차단만 하고 규칙 문장은 쓰지 않는다. 1:1은 LLM이 답한다.
 */
export function evaluateRules(content: string, llmAvailable: boolean, pick: PickReply, useRules = true): RuleOutcome {
  // 위험 주제와 프롬프트 공격은 LLM에 전달하기 전에 여기서 끊는다.
  if (isUnsafeContent(content)) return { kind: "blocked" };
  if (!useRules) return { kind: "unmatched" };

  // 지난 대화를 묻는 채팅은 규칙 문장으로 답할 수 없다. 기억을 볼 수 있는 LLM에게 넘긴다.
  if (llmAvailable && memoryQuestionPattern.test(content)) return { kind: "unmatched" };

  const rule = rules.find(candidate => candidate.match(content));
  if (!rule) return { kind: "unmatched" };
  // LLM이 쓸 수 있으면 LLM 우선 규칙은 양보한다.
  if (rule.llmPreferred && llmAvailable) return { kind: "unmatched" };

  return {
    kind: "matched",
    response: {
      reply: pick(rule.replies),
      emotion: { primary: rule.emotion, intensity: rule.intensity, durationSeconds: rule.durationSeconds },
      actions: rule.motion ? bodyAction(rule.motion, 2) : [],
      source: "rule",
    },
  };
}

/** LLM을 쓸 수 없을 때의 답. 모드 정책에 전용 문장이 있으면 그것을, 없으면 방송 폴백 문장을 쓴다. */
export function fallbackResponse(pick: PickReply, replies: readonly string[] = fallbackReplies): CharacterResponse {
  return { reply: pick(replies), emotion: { primary: "calm", intensity: 0.35, durationSeconds: 6 }, actions: [], source: "rule" };
}

/** 위험 입력에 대한 거절. 무반응하지 않는 모드만 쓴다. */
export function refusalResponse(pick: PickReply, replies: readonly string[]): CharacterResponse {
  return { reply: pick(replies), emotion: { primary: "calm", intensity: 0.4, durationSeconds: 6 }, actions: [], source: "rule" };
}

/** 위기 답에 쓸 수 있는 감정. 밝은 감정·들뜬 모션은 쓰지 않는다. */
const crisisEmotions = new Set(["calm", "sad"]);

/** LLM을 쓰지 않는 위기 답. 차분한 감정에 모션 없이 고정 문장을 쓴다. */
export function crisisResponse(pick: PickReply, replies: readonly string[]): CharacterResponse {
  return { reply: pick(replies), emotion: { primary: "calm", intensity: 0.4, durationSeconds: 8 }, actions: [], source: "rule" };
}

/**
 * LLM이 만든 위기 답을 다듬는다. 감정은 차분한 계열로 고정하고 모션은 뺀다(반짝눈·게임패드 금지).
 * withHelpLine이면 안내 문장의 두 번호(109, 119)가 다 있지 않을 때 안내 문장을 덧붙인다.
 * 덧붙인 답은 길이 상한(maxReplyLength)을 넘을 수 있다. 상한은 모델 출력 검증용이고 안내는 빠지면 안 된다.
 */
export function calmCrisisResponse(response: CharacterResponse, helpLine: string, withHelpLine: boolean): CharacterResponse {
  const hasHelp = /(^|\D)109(\D|$)/.test(response.reply) && /(^|\D)119(\D|$)/.test(response.reply);
  const reply = withHelpLine && !hasHelp ? `${response.reply.trim()} ${helpLine}` : response.reply;
  const primary = crisisEmotions.has(response.emotion.primary) ? response.emotion.primary : "calm";
  return { ...response, reply, emotion: { primary, intensity: Math.min(response.emotion.intensity, 0.5), durationSeconds: response.emotion.durationSeconds }, actions: [] };
}
