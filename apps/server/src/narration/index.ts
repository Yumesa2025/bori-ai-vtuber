/**
 * 보리가 메타 분석을 읽어 주는 narrator(설계 3절).
 * 사실 목록 → LLM 대사 → 숫자·이름 검사 → (남는 줄이 없으면) 정해진 문장 → 줄마다 음성 → 저장.
 * 서버 본체(index.ts)에는 마무리 단계에서 연결한다. 갱신이 끝날 때 narrate를, 다시 듣기 라우트에서 replay를 부른다.
 */
import { randomUUID } from "node:crypto";
import type { Narration, NarrationLine } from "@bori/shared";
import { checkLines } from "./check.js";
import { buildFacts, type NarrationInput } from "./facts.js";
import type { NarrationStore } from "./store.js";
import { templateLines } from "./template.js";
import { writeLines, type NarrationLlm } from "./writer.js";

export type { NarrationInput, NarrationFact } from "./facts.js";
export type { NarrationLlm, NarrationLlmRequest } from "./writer.js";
export { createNarrationStore, type NarrationStore } from "./store.js";

export type NarratorDeps = {
  /**
   * 대사를 쓸 LLM. null이면 정해진 문장만 쓴다.
   * 꺼짐·키 없음·회로 열림은 주입하는 함수가 { ok: false }로 돌려준다. 사용량 기록(모드 narration)도 그쪽에서 한다.
   */
  llm: NarrationLlm | null;
  /** 음성을 만들고 id를 돌려준다. 실패하면 undefined(또는 예외) — 그 줄은 자막만 보여 준다 */
  prepareAudio: (text: string) => Promise<string | undefined>;
  /** 음성 id가 아직 캐시에 있는지. 다시 듣기 때 없는 것만 새로 만든다. 주지 않으면 있다고 본다 */
  hasAudio?: (audioId: string) => boolean;
  store: NarrationStore;
  now?: () => Date;
  newId?: () => string;
  /** LLM 응답 기다림 상한. 기본 20초 */
  timeoutMs?: number;
  /** 대사 본문과 닉네임은 넘기지 않는다. 버린 줄 수·이유·오류 메시지만 */
  log?: (message: string) => void;
};

export type Narrator = {
  /** 집계로 새 대사를 만든다. 실패해도 정해진 문장으로 늘 대사를 돌려준다 */
  narrate(input: NarrationInput): Promise<Narration>;
  /** 마지막 대사. 처음 부를 때 저장 파일에서 읽는다 */
  latest(): Narration | null;
  /** 다시 듣기용 최신 대사. 음성이 없거나 사라진 줄은 다시 만든다. 대사가 없으면 null */
  replay(): Promise<Narration | null>;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export function createNarrator(deps: NarratorDeps): Narrator {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? (message => console.warn(`[bori-narration] ${message}`));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let loaded = false;
  let current: Narration | null = null;
  /** narrate·replay를 차례로 돌린다. 갱신이 겹쳐도 늦게 시작한 대사가 마지막에 남는다. */
  let queue: Promise<unknown> = Promise.resolve();

  const latest = () => {
    if (!loaded) {
      loaded = true;
      try { current = deps.store.load(); } catch (error) { log(`저장된 대사를 읽지 못했습니다: ${message(error)}`); }
    }
    return current;
  };

  async function audioFor(text: string): Promise<string | undefined> {
    try { return await deps.prepareAudio(text); } catch (error) { log(`음성을 만들지 못했습니다: ${message(error)}`); return undefined; }
  }

  function save(narration: Narration) {
    current = narration;
    loaded = true;
    try { deps.store.save(narration); } catch (error) { log(`대사를 저장하지 못했습니다: ${message(error)}`); }
  }

  async function writeWithLlm(input: NarrationInput, facts: ReturnType<typeof buildFacts>): Promise<NarrationLine[]> {
    const llm = facts.length > 0 ? deps.llm : null;
    if (!llm) return [];
    const written = await writeLines(llm, facts, timeoutMs);
    if (!written.ok) { log(`LLM 대사를 쓰지 못해 정해진 문장을 씁니다: ${written.reason}`); return []; }
    const knownNames = [
      ...input.combos.flatMap(combo => [combo.characterName, combo.weaponName]),
      ...(input.player?.mainCharacters.map(main => main.name) ?? []),
    ];
    const { kept, dropped } = checkLines(written.lines, facts, knownNames);
    if (dropped.length > 0) log(`검사에서 ${dropped.length}줄을 버렸습니다 (${[...new Set(dropped.map(entry => entry.reason))].join(", ")})`);
    return kept;
  }

  async function narrateNow(input: NarrationInput): Promise<Narration> {
    const facts = buildFacts(input);
    const written = await writeWithLlm(input, facts);
    const source = written.length > 0 ? "llm" : "template";
    const lines = written.length > 0 ? written : templateLines(facts);
    const voiced: NarrationLine[] = [];
    // 음성은 차례로 만든다. 업체 속도 제한에 한꺼번에 걸리지 않게 한다.
    for (const line of lines) {
      const audioId = await audioFor(line.text);
      voiced.push(audioId ? { ...line, audioId } : { text: line.text, emotion: line.emotion });
    }
    const narration: Narration = { id: newId(), createdAt: now().toISOString(), source, lines: voiced };
    save(narration);
    return narration;
  }

  async function replayNow(): Promise<Narration | null> {
    const narration = latest();
    if (!narration) return null;
    const alive = (id: string | undefined) => id !== undefined && (deps.hasAudio?.(id) ?? true);
    let changed = false;
    const lines: NarrationLine[] = [];
    for (const line of narration.lines) {
      if (alive(line.audioId)) { lines.push(line); continue; }
      const audioId = await audioFor(line.text);
      if (audioId) changed = true;
      lines.push(audioId ? { text: line.text, emotion: line.emotion, audioId } : { text: line.text, emotion: line.emotion });
    }
    if (!changed) return narration;
    const updated = { ...narration, lines };
    save(updated);
    return updated;
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    narrate: input => enqueue(() => narrateNow(input)),
    latest,
    replay: () => enqueue(replayNow),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
