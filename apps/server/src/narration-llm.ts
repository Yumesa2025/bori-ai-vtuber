/**
 * 보리 대사(narration/)가 받는 좁은 LLM 함수(NarrationLlm)를 @bori/llm 클라이언트의 complete<T>에 잇는다.
 * 꺼짐·키 없음·회로 열림·호출 실패는 클라이언트가 { ok: false }로 돌려주고, 사용량(모드 narration)도 클라이언트가 센다.
 * 여기서는 JSON 모양만 본다. 모양이 틀린 응답은 validation 실패라 회로 차단의 연속 실패에 들어간다.
 * 숫자·이름 검사는 narration/check.ts가 한다.
 */
import type { LlmSettings } from "@bori/shared";
import type { LlmOutcome, LlmParse, LlmRequest } from "@bori/llm";
import type { NarrationLlm } from "./narration/index.js";

/** createLlmClient().complete와 같은 모양. 검사에서 가짜로 바꿔 끼운다. */
export type CompleteFn = <T>(settings: LlmSettings, apiKey: string, request: LlmRequest, parse: LlmParse<T>) => Promise<LlmOutcome<T>>;

/** 응답이 { lines: [...] } 모양의 JSON인지. 줄마다의 칸은 narration/writer.ts가 다시 본다. */
export const parseNarrationJson: LlmParse<unknown> = raw => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "대사 응답이 JSON이 아닙니다." };
  }
  const lines = (value as { lines?: unknown } | null)?.lines;
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(lines)) {
    return { ok: false, reason: "대사 응답에 lines 배열이 없습니다." };
  }
  return { ok: true, value };
};

/**
 * 부를 때마다 지금 LLM 설정과 키를 읽는다. 스튜디오에서 키·모델을 바꾸면 다음 대사부터 새 값을 쓴다.
 * 기다림 상한은 LLM 설정(1:1 답용 짧은 값)이 아니라 narrator가 준 값(기본 20초)을 쓴다.
 */
export function narrationLlmFrom(complete: CompleteFn, current: () => { settings: LlmSettings; apiKey: string }): NarrationLlm {
  return async ({ systemPrompt, userPrompt, schema, timeoutMs, maxOutputTokens }) => {
    const { settings, apiKey } = current();
    const request: LlmRequest = {
      overrideSystemPrompt: systemPrompt,
      overrideUserPrompt: userPrompt,
      overrideSchema: schema,
      timeoutMs,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
    const outcome = await complete(settings, apiKey, request, parseNarrationJson);
    return outcome.ok ? { ok: true, raw: outcome.value } : { ok: false, reason: `${outcome.kind}: ${outcome.reason}` };
  };
}
