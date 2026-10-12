import { createHash } from "node:crypto";
import { conversationModes, type ConversationMode } from "@bori/character";
import { boriEmotionNames, boriMotionDescriptions, boriMotionGroupNames } from "@bori/live2d";
import { buildSystemPrompt, type LlmRequest } from "@bori/llm";
import { canAccessMemory, type MemoryAccess, type MemoryRecord } from "@bori/memory";
import type { FixtureMemory, Scenario } from "./scenarios.js";

/** 서버 기본 설정과 같은 값. 서버 내부를 import하지 않으려고 여기에 같은 숫자를 둔다. */
export const evalReplyLimit = 120;
export const evalAllowedMotions = boriMotionGroupNames.map(name => ({ name, description: boriMotionDescriptions[name] }));

/** 기억 고정 자료가 없는 시나리오의 접근 주체. */
export function defaultAccess(mode: ConversationMode): MemoryAccess {
  return mode === "companion" ? { mode: "private", userId: "user-a" } : { mode: "broadcast", speakerId: "viewer-a" };
}

function toRecord(memory: FixtureMemory): MemoryRecord {
  return {
    id: memory.id,
    text: memory.text,
    kind: memory.ownerId ? "viewer" : "broadcast",
    scope: memory.scope,
    ...(memory.ownerId !== undefined ? { ownerId: memory.ownerId } : {}),
    importance: 0.5,
    confidence: 0.8,
    repeatCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

export type MemorySelection = {
  access: MemoryAccess;
  visible: FixtureMemory[];
  hidden: FixtureMemory[];
};

/**
 * 기억 저장소의 search와 같은 방식으로 접근 가능한 기억만 남긴다.
 * store.search는 canAccessMemory로 먼저 거른 뒤 유사도로 줄인다. 평가는 유사도 단계 없이 거르기만 재현한다.
 */
export function selectMemories(scenario: Scenario): MemorySelection {
  const fixture = scenario.memoryFixture;
  const access = fixture?.access ?? defaultAccess(scenario.mode);
  const visible: FixtureMemory[] = [];
  const hidden: FixtureMemory[] = [];
  for (const memory of fixture?.records ?? []) {
    (canAccessMemory(toRecord(memory), access) ? visible : hidden).push(memory);
  }
  return { access, visible, hidden };
}

/** 시나리오 하나를 답변 요청으로 바꾼다. 최근 대화·요약·매크로·방송 상황은 비워 입력과 기억만 본다. */
export function buildScenarioRequest(scenario: Scenario, options: { timeoutMs?: number } = {}): LlmRequest {
  if (scenario.input === null) throw new Error(`${scenario.id}: 입력이 없는 시나리오는 프롬프트를 만들 수 없습니다.`);
  return {
    mode: scenario.mode,
    content: scenario.input,
    recentTurns: [],
    memories: selectMemories(scenario).visible.map(memory => memory.text),
    sessionSummary: "",
    macroPrompts: [],
    broadcastStatus: [],
    allowedEmotions: boriEmotionNames,
    allowedMotions: evalAllowedMotions,
    maxReplyLength: evalReplyLimit,
    timeoutMs: options.timeoutMs ?? 8000,
  };
}

/**
 * 모드별 시스템 프롬프트의 지문. 결과 파일 두 개를 비교할 때 프롬프트가 바뀌었는지 알려 준다.
 * system 메시지는 턴마다 같으므로 이것만으로 프롬프트 버전을 가린다.
 */
export function promptFingerprints(): Record<ConversationMode, string> {
  const entries = conversationModes.map(mode => {
    const system = buildSystemPrompt({
      mode,
      content: "",
      recentTurns: [],
      memories: [],
      sessionSummary: "",
      macroPrompts: [],
      broadcastStatus: [],
      allowedEmotions: boriEmotionNames,
      allowedMotions: evalAllowedMotions,
      maxReplyLength: evalReplyLimit,
      timeoutMs: 8000,
    });
    return [mode, createHash("sha256").update(system).digest("hex").slice(0, 12)] as const;
  });
  return Object.fromEntries(entries) as Record<ConversationMode, string>;
}
