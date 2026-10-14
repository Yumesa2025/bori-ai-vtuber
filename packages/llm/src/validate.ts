import type { CharacterResponse } from "@bori/shared";
import type { LlmRequest, LlmValidation } from "./types.js";

/** 허용 목록 밖 감정 대신 쓰는 값. 위기 답도 차분한 감정을 쓰므로 어느 쪽에도 어긋나지 않는다(ADR-024). */
export const DEFAULT_EMOTION = "calm";
const DEFAULT_INTENSITY = 0.4;
const DEFAULT_DURATION_SECONDS = 6;
/** 프롬프트가 고정한 모션 규칙. 화면은 body 레이어·우선순위 2 모션 하나만 받는다(a3 F13). */
const ACTION_LAYER = "body";
const ACTION_PRIORITY = 2;

/** 답 길이는 코드포인트로 센다. UTF-16으로 세면 이모지·일부 한자가 두 글자로 잡힌다(a3 F14). 1:1 입력 검사와 같은 단위다. */
export const replyLengthOf = (text: string) => Array.from(text).length;

// 그림 문자와 그 부속(이음 문자, 변형 선택자, 피부색, 국기 문자, 키캡).
const emojiPattern = /\p{Extended_Pictographic}|‍|️|⃣|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * 출력 규칙(이모지·마크다운 금지)을 어긴 기호를 지운다(a3 F12). 화면과 TTS가 기호를 그대로 보이거나 읽는다.
 * 내용 글자는 남기고 꾸밈만 뺀다: 링크는 글자만, 굵게·기울임·코드 표시와 줄머리 기호, 꺾쇠 태그는 지운다.
 * 한국어 답에서 *·_·# 같은 기호를 내용으로 쓰는 경우가 거의 없어 단순하게 지운다.
 */
export function stripDecorations(text: string): string {
  return text
    .replace(emojiPattern, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__|\*|~~|`+)/g, "")
    .replace(/^\s*(#{1,6}|>|[-+]|\d+\.)\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/**
 * LLM 출력을 그대로 믿지 않고 단계별로 검증한다.
 *
 *   JSON 형식 → 답변(기호 제거·길이) → 감정 → 강도·지속 시간 → 행동
 *
 * 답이 될 수 없는 것(JSON이 아님, 답 문장이 없거나 너무 김)만 실패다. 이때 보리는 폴백 문장으로 답한다.
 * 감정·모션처럼 곁가지 값 하나가 틀렸다고 정상 답을 버리지 않는다(a6 A6-02, a3 F7). 그 값만 기본값으로 바꾸고
 * 무엇을 바꿨는지 corrections에 남긴다. 보정은 호출 실패가 아니라 회로 차단기에 세지 않는다(ADR-024).
 */
export function validateLlmOutput(raw: string, request: LlmRequest): LlmValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSON 형식이 아닙니다." };
  }

  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "객체가 아닙니다." };
  const candidate = parsed as Record<string, unknown>;
  const corrections: string[] = [];

  // 답변 문장
  const rawReply = candidate.reply;
  if (typeof rawReply !== "string") return { ok: false, reason: "reply가 문자열이 아닙니다." };
  const reply = stripDecorations(rawReply);
  if (reply !== rawReply.trim()) corrections.push("이모지·마크다운 기호를 지웠습니다.");
  if (reply.length === 0) return { ok: false, reason: "reply가 비어 있습니다." };
  if (replyLengthOf(reply) > request.maxReplyLength) {
    return { ok: false, reason: `reply가 ${request.maxReplyLength}자를 넘었습니다.` };
  }

  // 감정. 대소문자만 다른 값("Happy")은 같은 감정으로 본다.
  const emotionRecord = typeof candidate.emotion === "object" && candidate.emotion !== null ? candidate.emotion as Record<string, unknown> : {};
  if (emotionRecord !== candidate.emotion) corrections.push("emotion이 객체가 아니라 기본 감정으로 바꿨습니다.");
  const allowedEmotion = (value: unknown) => {
    if (typeof value !== "string") return null;
    const lowered = value.trim().toLowerCase();
    return request.allowedEmotions.includes(lowered) ? lowered : null;
  };

  let primary = allowedEmotion(emotionRecord.primary);
  if (primary === null) {
    corrections.push(`허용되지 않은 감정(${String(emotionRecord.primary)})을 ${DEFAULT_EMOTION}으로 바꿨습니다.`);
    primary = DEFAULT_EMOTION;
  }

  const secondaryRaw = emotionRecord.secondary;
  const secondary = secondaryRaw === undefined || secondaryRaw === null ? null : allowedEmotion(secondaryRaw);
  if (secondaryRaw !== undefined && secondaryRaw !== null && secondary === null) corrections.push(`허용되지 않은 보조 감정(${String(secondaryRaw)})을 뺐습니다.`);

  const intensity = numberWithin(emotionRecord.intensity, 0, 1, DEFAULT_INTENSITY);
  if (intensity !== emotionRecord.intensity) corrections.push("emotion.intensity를 0과 1 사이로 맞췄습니다.");
  const durationSeconds = numberWithin(emotionRecord.durationSeconds, 1, 60, DEFAULT_DURATION_SECONDS);
  if (durationSeconds !== emotionRecord.durationSeconds) corrections.push("emotion.durationSeconds를 1과 60 사이로 맞췄습니다.");

  // 행동. 허용된 모션 하나만 body 레이어·우선순위 2로 둔다.
  const rawActions = Array.isArray(candidate.actions) ? candidate.actions : [];
  if (candidate.actions !== undefined && !Array.isArray(candidate.actions)) corrections.push("actions가 배열이 아니라 비웠습니다.");
  const names = rawActions.map(entry => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).name : undefined));
  const chosen = names.find((name): name is string => typeof name === "string" && request.allowedMotions.some(motion => motion.name === name));
  if (names.some(name => name !== chosen)) corrections.push(`허용되지 않거나 넘치는 모션을 뺐습니다: ${names.filter(name => name !== chosen).map(String).join(", ")}`);
  const fixedRule = rawActions.every(entry => typeof entry !== "object" || entry === null || ((entry as Record<string, unknown>).layer === ACTION_LAYER && (entry as Record<string, unknown>).priority === ACTION_PRIORITY));
  if (chosen && !fixedRule) corrections.push("모션 레이어·우선순위를 body·2로 맞췄습니다.");
  const actions: CharacterResponse["actions"] = chosen ? [{ name: chosen, layer: ACTION_LAYER, priority: ACTION_PRIORITY }] : [];

  const response: CharacterResponse = {
    reply,
    emotion: {
      primary,
      ...(secondary !== null ? { secondary } : {}),
      intensity,
      durationSeconds,
    },
    actions,
    source: "llm",
  };

  return { ok: true, response, corrections };
}

/** 숫자가 아니면 기본값, 범위 밖이면 가장 가까운 끝값. */
function numberWithin(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
