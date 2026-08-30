import type { CharacterResponse } from "@bori/shared";
import type { LlmRequest, LlmValidation } from "./types.js";

/**
 * LLM 출력을 그대로 믿지 않고 단계별로 검증한다.
 * 계획서 10단계의 순서를 그대로 따른다.
 *
 *   JSON 형식 → 답변 길이 → 허용 범위 → 감정·행동 allowlist → 강도·지속 시간 범위
 *
 * 한 단계라도 걸리면 실패로 처리하고 보리는 무반응한다.
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

  // 답변 문장
  const reply = candidate.reply;
  if (typeof reply !== "string") return { ok: false, reason: "reply가 문자열이 아닙니다." };
  const trimmedReply = reply.trim();
  if (trimmedReply.length === 0) return { ok: false, reason: "reply가 비어 있습니다." };
  if (trimmedReply.length > request.maxReplyLength) {
    return { ok: false, reason: `reply가 ${request.maxReplyLength}자를 넘었습니다.` };
  }

  // 감정
  const emotion = candidate.emotion;
  if (typeof emotion !== "object" || emotion === null) return { ok: false, reason: "emotion이 객체가 아닙니다." };
  const emotionRecord = emotion as Record<string, unknown>;

  const primary = emotionRecord.primary;
  if (typeof primary !== "string") return { ok: false, reason: "emotion.primary가 문자열이 아닙니다." };
  if (!request.allowedEmotions.includes(primary)) {
    return { ok: false, reason: `허용되지 않은 감정입니다: ${primary}` };
  }

  const secondary = emotionRecord.secondary;
  if (secondary !== undefined && secondary !== null) {
    if (typeof secondary !== "string") return { ok: false, reason: "emotion.secondary가 문자열이 아닙니다." };
    if (!request.allowedEmotions.includes(secondary)) {
      return { ok: false, reason: `허용되지 않은 보조 감정입니다: ${secondary}` };
    }
  }

  const intensity = emotionRecord.intensity;
  if (typeof intensity !== "number" || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    return { ok: false, reason: "emotion.intensity는 0과 1 사이여야 합니다." };
  }

  const durationSeconds = emotionRecord.durationSeconds;
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    return { ok: false, reason: "emotion.durationSeconds는 1과 60 사이여야 합니다." };
  }

  // 행동
  const rawActions = candidate.actions ?? [];
  if (!Array.isArray(rawActions)) return { ok: false, reason: "actions가 배열이 아닙니다." };
  const actions: CharacterResponse["actions"] = [];
  for (const entry of rawActions) {
    if (typeof entry !== "object" || entry === null) return { ok: false, reason: "action이 객체가 아닙니다." };
    const action = entry as Record<string, unknown>;

    const name = action.name;
    if (typeof name !== "string") return { ok: false, reason: "action.name이 문자열이 아닙니다." };
    if (!request.allowedMotions.some(motion => motion.name === name)) {
      return { ok: false, reason: `허용되지 않은 모션입니다: ${name}` };
    }

    const layer = action.layer;
    if (layer !== "face" && layer !== "body" && layer !== "system") {
      return { ok: false, reason: `허용되지 않은 레이어입니다: ${String(layer)}` };
    }

    const priority = action.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 3) {
      return { ok: false, reason: "action.priority는 0과 3 사이 정수여야 합니다." };
    }

    actions.push({ name, layer, priority });
  }

  const response: CharacterResponse = {
    reply: trimmedReply,
    emotion: {
      primary,
      ...(typeof secondary === "string" ? { secondary } : {}),
      intensity,
      durationSeconds,
    },
    actions,
    source: "llm",
  };

  return { ok: true, response };
}
