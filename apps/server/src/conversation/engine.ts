import { conversationPolicies, type ConversationMode, type ConversationPolicy } from "@bori/character";
import { boriEmotionNames, boriMotionDescriptions, boriMotionGroupNames } from "@bori/live2d";
import { buildSystemPrompt, createAdapter, summarizeSessionProgress, type createLlmClient, type LlmRequest } from "@bori/llm";
import { isAnonymousViewer, type EmbeddingProvider, type MemoryAccess, type MemorySettings, type MemoryStore } from "@bori/memory";
import type { CharacterResponse, LlmSettings, MacroPrompt } from "@bori/shared";
import { activateMacros, clearMacros, tickMacros } from "./macros.js";
import { evaluateRules, fallbackResponse, refusalResponse } from "./rules.js";
import { createSessionState, pickReply, pushTurn, restoreTurns, type ConversationSession, type SessionTurn } from "./session.js";

export type LlmClient = Pick<ReturnType<typeof createLlmClient>, "isCircuitOpen" | "respond">;

/**
 * 엔진이 바깥에서 받는 것. 설정은 관리자 화면에서 바뀌므로 값 대신 getter로 받아 매번 최신 값을 읽는다.
 * 기억 저장소는 검색만 받는다. 엔진 밖에서는 기억을 검색하지 않는다.
 */
export type ConversationEngineDeps = {
  /**
   * 모드별 LLM 클라이언트. 회로 차단기와 통계가 클라이언트 안에 있으므로 모드마다 다른 인스턴스를 준다.
   * 같은 인스턴스를 주면 1:1 연속 실패가 방송 회로를 연다.
   */
  llmFor: (mode: ConversationMode) => LlmClient;
  llmSettings: () => LlmSettings;
  apiKey: () => string;
  memoryStore: Pick<MemoryStore, "search">;
  memorySettings: () => MemorySettings;
  embedding: () => EmbeddingProvider | null;
  /** 파일에서 읽은 매크로 정의. 켜져 있는 상태는 세션이 따로 갖는다. */
  macros: () => readonly MacroPrompt[];
  /** 같은 규칙 문장을 다시 쓰기까지 기다리는 시간(분). */
  replyCooldownMinutes: () => number;
  /** 모드 정책. 지정하지 않으면 @bori/character의 정책을 쓴다. */
  policies?: Record<ConversationMode, ConversationPolicy>;
  /** 누적 요약용 어댑터 생성기. 테스트에서 가짜 어댑터로 바꾼다. */
  createAdapter?: typeof createAdapter;
};

/** 말한 사람. ownerId가 null이면 누구인지 모르는 발언이라 소유 기억을 읽지 않는다. */
export type Speaker = { ownerId: string | null };

export type RespondInput = {
  content: string;
  speaker: Speaker;
  /** 모델이 스스로 셀 수 없는 상황 문장. 방송은 경과 시간·답변 수를 넘기고, 없으면 비운다. */
  statusLines?: readonly string[];
};

export type RespondFailure = { kind: "disabled" | "circuit" | "call" | "validation"; reason: string };

/**
 * blocked: 위험 입력이라 LLM에 넘기지 않았다. 방송은 무반응하고, 거절 문장이 있는 모드는 refusal로 답한다.
 * reply: 내보낼 답변. 폴백 문장을 쓴 경우 failure에 이유가 남는다.
 * 규칙 응답을 쓰는 모드(방송)는 LLM이 꺼져 있어도 규칙으로 정상 진행하므로, 그때의 폴백은 실패로 알리지 않는다.
 */
export type RespondResult =
  | { kind: "blocked"; refusal?: CharacterResponse }
  | { kind: "reply"; response: CharacterResponse; failure?: RespondFailure };

const allowedMotions = boriMotionGroupNames.map(name => ({ name, description: boriMotionDescriptions[name] }));

/**
 * 모드와 화자로 기억 접근 범위를 정한다.
 * 방송은 소유자 없는 기억과 말한 시청자 본인의 기억만, 1:1은 그 사용자 본인의 기억만 꺼낸다.
 * 화자를 모르면 방송은 소유 기억 없이 찾고, 1:1은 아예 찾지 않는다(null).
 */
export function memoryAccessFor(mode: ConversationMode, speaker: Speaker): MemoryAccess | null {
  const ownerId = speaker.ownerId !== null && !isAnonymousViewer(speaker.ownerId) ? speaker.ownerId : null;
  if (mode === "broadcast") return ownerId ? { mode: "broadcast", speakerId: ownerId } : { mode: "broadcast" };
  return ownerId ? { mode: "private", userId: ownerId } : null;
}

export function createConversationEngine(deps: ConversationEngineDeps) {
  const policies = deps.policies ?? conversationPolicies;
  const makeAdapter = deps.createAdapter ?? createAdapter;

  /** onSummary를 주면 누적 요약이 갱신될 때마다 부른다. 1:1은 대화 레코드에 요약을 저장한다. */
  function createSession(mode: ConversationMode, options: { onSummary?: (summary: string) => void } = {}): ConversationSession {
    const policy = policies[mode];
    // 모드를 모르면 다른 모드 정책으로 대신하지 않는다. 방송 규칙이 1:1 대화로 새거나 그 반대가 된다.
    if (!policy) throw new Error(`알 수 없는 대화 모드입니다: ${String(mode)}`);
    const session = createSessionState(policy);
    if (options.onSummary) session.onSummary = options.onSummary;
    return session;
  }

  const pick = (session: ConversationSession, values: readonly string[]) => pickReply(session, values, deps.replyCooldownMinutes());

  function buildRequest(mode: ConversationMode, settings: LlmSettings, context: Pick<LlmRequest, "content" | "recentTurns" | "memories" | "sessionSummary" | "macroPrompts" | "broadcastStatus">): LlmRequest {
    return {
      mode,
      ...context,
      allowedEmotions: boriEmotionNames,
      allowedMotions,
      maxReplyLength: settings.maxReplyLength,
      timeoutMs: settings.timeoutMs,
    };
  }

  /** 관련 기억을 찾는다. 검색이 실패해도 답변은 계속 만든다. */
  async function searchMemories(session: ConversationSession, input: RespondInput): Promise<string[]> {
    const memorySettings = deps.memorySettings();
    if (!memorySettings.enabled) return [];

    const access = memoryAccessFor(session.mode, input.speaker);
    if (!access) return [];

    try {
      const hits = await deps.memoryStore.search(input.content, memorySettings, deps.embedding(), access);
      return hits.map(hit => hit.record.text);
    } catch (error) {
      console.error("[bori-server] 기억 검색 실패:", error);
      return [];
    }
  }

  /** 모드 정책의 폴백 문장. 정책에 없으면 방송 폴백 문장을 쓴다. */
  function fallbackFor(session: ConversationSession): CharacterResponse {
    const replies = session.policy.fallbackReplies;
    const pickForSession = (values: readonly string[]) => pick(session, values);
    return replies && replies.length > 0 ? fallbackResponse(pickForSession, replies) : fallbackResponse(pickForSession);
  }

  /** LLM을 부르기 전에 쓸 수 없다고 판단한 이유. */
  function unavailableFailure(settings: LlmSettings, llm: LlmClient): RespondFailure {
    if (!settings.enabled) return { kind: "disabled", reason: "LLM이 꺼져 있습니다." };
    if (deps.apiKey().trim().length === 0) return { kind: "disabled", reason: "API 키가 없습니다." };
    if (llm.isCircuitOpen()) return { kind: "circuit", reason: "연속 실패로 LLM 호출을 잠시 멈췄습니다." };
    return { kind: "disabled", reason: "LLM을 쓸 수 없습니다." };
  }

  /**
   * 규칙 우선, 규칙에 없으면 LLM, LLM이 실패하면 폴백 문장 순서로 답을 만든다.
   * 규칙을 쓰지 않는 모드(1:1)는 위험 차단만 거치고 바로 LLM으로 간다.
   * 위험 입력은 blocked를 돌려준다. 실패를 어디에 알릴지는 호출하는 쪽이 정한다.
   */
  async function respond(session: ConversationSession, input: RespondInput): Promise<RespondResult> {
    const llm = deps.llmFor(session.mode);
    const policy = session.policy;
    const pickForSession = (values: readonly string[]) => pick(session, values);
    // 키가 없거나 회로가 열려 있으면 LLM을 쓸 수 없으므로 규칙이 그대로 답한다.
    const startSettings = deps.llmSettings();
    const llmAvailable = startSettings.enabled && deps.apiKey().trim().length > 0 && !llm.isCircuitOpen();

    const outcome = evaluateRules(input.content, llmAvailable, pickForSession, policy.ruleReplies);
    if (outcome.kind === "blocked") {
      return policy.refusalReplies.length > 0 ? { kind: "blocked", refusal: refusalResponse(pickForSession, policy.refusalReplies) } : { kind: "blocked" };
    }
    if (outcome.kind === "matched") return { kind: "reply", response: outcome.response };

    if (!llmAvailable) {
      // 규칙 문장이 없는 모드는 폴백 문장이 유일한 답이라 왜 LLM을 못 썼는지 함께 돌려준다.
      return policy.ruleReplies
        ? { kind: "reply", response: fallbackFor(session) }
        : { kind: "reply", response: fallbackFor(session), failure: unavailableFailure(startSettings, llm) };
    }

    // 키워드 매크로는 왕복이 없으므로 기억 검색보다 먼저 켠다.
    if (startSettings.macroEnabled) activateMacros(session, input.content, deps.macros());

    const memories = await searchMemories(session, input);

    // 기억을 찾는 사이 설정이 바뀌었을 수 있으므로 호출 직전 값을 쓴다.
    const settings = deps.llmSettings();
    const result = await llm.respond(settings, deps.apiKey(), buildRequest(session.mode, settings, {
      content: input.content,
      recentTurns: [...session.recentTurns],
      memories,
      sessionSummary: session.summary,
      macroPrompts: session.activeMacros.map(entry => entry.macro.prompt),
      broadcastStatus: input.statusLines ?? [],
    }));

    if (result.ok) return { kind: "reply", response: result.response };

    console.error(`[bori-server] LLM 실패(${result.kind}): ${result.reason}`);
    return { kind: "reply", response: fallbackFor(session), failure: { kind: result.kind, reason: result.reason } };
  }

  /** 발언을 기록한다. 창 밖으로 밀려나는 대화는 누적 요약이 대신 붙든다. */
  function record(session: ConversationSession, turn: SessionTurn) {
    pushTurn(session, turn);
    maybeUpdateRollingSummary(session);
  }

  /**
   * 누적 요약을 갱신한다.
   * 최근 대화는 RECENT_TURN_LIMIT턴만 남으므로 그보다 앞선 이야기는 이 요약에만 남는다.
   * 매 턴이 아니라 rollingSummaryTurns 턴마다 한 번 접어 비용과 지연을 낮춘다.
   * 답변 경로를 막지 않으며, 늦게 도착하면 그다음 답변부터 반영된다.
   *
   * 결과는 호출할 때의 세션 객체에 쓴다. 방송을 다시 시작하면 방송 쪽이 세션을 새로 만들므로
   * 늦게 도착한 요약은 버려진 옛 세션에 써질 뿐 새 세션에는 닿지 않는다.
   */
  function maybeUpdateRollingSummary(session: ConversationSession) {
    const settings = deps.llmSettings();
    const apiKey = deps.apiKey();
    if (!settings.rollingSummaryEnabled || !settings.enabled) return;
    if (apiKey.trim().length === 0) return;
    // 답변용 호출이 연달아 실패하는 중이라면 요약도 시도하지 않는다.
    if (deps.llmFor(session.mode).isCircuitOpen()) return;
    if (session.summaryInFlight) return;

    const pending = session.sessionTurns.slice(session.summarizedTurnCount);
    if (pending.length < settings.rollingSummaryTurns) return;

    const adapter = makeAdapter(settings.provider, { apiKey, model: settings.model });
    if (!adapter) return;

    session.summaryInFlight = true;
    const consumed = session.summarizedTurnCount + pending.length;

    // 모드별 지시문을 쓴다. 1:1 대화를 방송 기준("시청자", "방송")으로 요약하지 않는다.
    void summarizeSessionProgress(adapter, session.summary, pending, { timeoutMs: Math.max(settings.timeoutMs, 15_000), mode: session.mode })
      .then(updated => {
        if (!updated) return;
        session.summary = updated;
        // 실패했을 때는 개수를 올리지 않는다. 접지 못한 대화가 다음 시도에 다시 넘어간다.
        session.summarizedTurnCount = consumed;
        console.log(`[bori-server] 누적 요약 갱신 (${consumed}턴까지)`);
        // 저장이 실패해도 세션의 요약은 그대로 쓴다. 재시작 뒤에만 이 요약이 빠진다.
        try {
          session.onSummary?.(updated);
        } catch (error) {
          console.error("[bori-server] 누적 요약 저장 실패:", error);
        }
      })
      .catch(error => { console.error("[bori-server] 누적 요약 실패:", error); })
      .finally(() => { session.summaryInFlight = false; });
  }

  /**
   * 매 턴 그대로 들어가는 시스템 프롬프트의 크기.
   * 이 부분은 검색되지 않고 항상 전달되므로, 얼마나 큰지 눈에 보여야 관리할 수 있다.
   */
  function systemPromptChars(mode: ConversationMode): number {
    return buildSystemPrompt(buildRequest(mode, deps.llmSettings(), {
      content: "",
      recentTurns: [],
      memories: [],
      sessionSummary: "",
      macroPrompts: [],
      broadcastStatus: [],
    })).length;
  }

  return {
    createSession,
    respond,
    record,
    /** 저장된 대화와 누적 요약으로 새 세션을 채운다. 누적 요약 호출은 하지 않는다. */
    restore: restoreTurns,
    /** 답변이 실제로 나갔을 때 부른다. 그 시점은 모드가 정한다. */
    tickMacros,
    clearMacros,
    /** 세션의 문장 쿨다운을 지키며 후보 중 하나를 고른다. 방송 혼잣말도 같은 기록을 쓴다. */
    pickReply: pick,
    systemPromptChars,
  };
}

export type ConversationEngine = ReturnType<typeof createConversationEngine>;
