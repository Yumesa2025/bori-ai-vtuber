import type { CharacterResponse } from "@bori/shared";

/** 위험 주제와 프롬프트 공격. 여기에 걸리면 LLM에 전달하지 않는다. */
export const unsafePattern = /(정치|의료|법률|투자|개인정보|비밀번호|해킹|자해|프롬프트|시스템 메시지)/i;
/** 위험 입력인지. 차단된 입력은 LLM에도, 기억 후보에도 넘기지 않는다. */
export const isUnsafeContent = (content: string) => unsafePattern.test(content);
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
