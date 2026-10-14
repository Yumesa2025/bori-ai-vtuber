import { readFileSync, renameSync } from "node:fs";
import { basename } from "node:path";
import type { ConversationMode } from "@bori/character";
import type { LlmTokenUsage } from "@bori/llm";
import { backupFile, isMissingFileError, writeFileAtomically } from "@bori/memory";
import type { UsageFeature, UsageMode } from "@bori/shared";

/** 파일 형식 버전. 형식을 바꾸면 올리고 읽을 때 옮기는 경로를 만든다. */
export const USAGE_FILE_VERSION = 1;
/** 오늘을 포함해 남기는 날 수. 그보다 오래된 날은 읽을 때와 쓸 때 버린다. */
export const USAGE_RETENTION_DAYS = 31;

const FEATURES: readonly UsageFeature[] = ["reply", "summary", "digest", "embedding", "tts"];
const MODES: readonly UsageMode[] = ["broadcast", "companion", "none"];

/** 하루 동안 기능·모드·모델 한 조합의 누계. 숫자와 모델 이름만 담는다. */
export type UsageCounter = {
  feature: UsageFeature;
  mode: UsageMode;
  model: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  callsWithoutTokens: number;
  characters: number;
};

/** 로컬 날짜(YYYY-MM-DD)별 누계. */
export type UsageDays = Record<string, UsageCounter[]>;

type UsageFile = { version: number; days: UsageDays };

/**
 * 업체를 한 번 부른 결과. 대화 내용·닉네임·소유자 ID를 넣을 자리가 없게 숫자와 이름만 받는다.
 * mode가 null이면 어느 모드의 호출인지 모르는 것이다(임베딩).
 */
export type UsageEvent = {
  feature: UsageFeature;
  mode: ConversationMode | null;
  model: string;
  ok: boolean;
  /** 업체 응답에 토큰 수가 있을 때만. */
  usage?: LlmTokenUsage;
  /** 음성 합성에 보낸 글자 수. */
  characters?: number;
};

export type UsageStoreOptions = {
  log?: (message: string) => void;
  /** 현재 시각(ms). 테스트에서 날짜를 고정할 때 바꾼다. */
  now?: () => number;
  /** 임시 파일을 제자리로 옮기는 함수. 테스트에서 쓰기 실패를 주입할 때 바꾼다. */
  rename?: (from: string, to: string) => void;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** 로컬 날짜 문자열. 업체 청구 기준(UTC)과 하루 경계가 다를 수 있다. */
export function localDateKey(time: number | Date): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** time이 속한 로컬 날짜에서 days일 전의 날짜. 일광 절약 시간이 있어도 달력 기준으로 센다. */
export function localDateKeyDaysBefore(time: number, days: number): string {
  const date = new Date(time);
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days));
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 파일에서 읽은 누계 한 줄을 검사한다. 모르는 기능·모드나 음수가 있으면 버린다. */
function parseCounter(value: unknown): UsageCounter | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (!FEATURES.includes(entry.feature as UsageFeature) || !MODES.includes(entry.mode as UsageMode)) return null;
  if (typeof entry.model !== "string" || entry.model.length === 0) return null;
  const counts = ["calls", "failures", "inputTokens", "outputTokens", "callsWithoutTokens", "characters"] as const;
  if (!counts.every(key => isCount(entry[key]))) return null;
  return {
    feature: entry.feature as UsageFeature,
    mode: entry.mode as UsageMode,
    model: entry.model,
    calls: entry.calls as number,
    failures: entry.failures as number,
    inputTokens: entry.inputTokens as number,
    outputTokens: entry.outputTokens as number,
    callsWithoutTokens: entry.callsWithoutTokens as number,
    characters: entry.characters as number,
  };
}

/**
 * API 사용량 저장소.
 * 대화 저장소와 같이 파일 하나를 통째로 읽고, 임시 파일에 쓴 뒤 rename으로 바꾼다.
 * 사용량은 보조 기록이라 쓰기에 실패해도 답변을 막지 않는다. 기록만 남기고 메모리의 누계는 유지한다.
 */
export function createUsageStore(filePath: string, options: UsageStoreOptions = {}) {
  const log = options.log ?? (message => console.log(`[bori-usage] ${message}`));
  const now = options.now ?? Date.now;
  const rename = options.rename ?? renameSync;

  let days: UsageDays = {};
  /** 파일에 써도 되는지. 있는데 읽지 못했거나 원본을 남기지 못했으면 false다. */
  let writable = true;

  /** 보관 기간 밖의 날을 지운다. 지운 것이 있으면 true. */
  function prune(): boolean {
    const oldest = localDateKeyDaysBefore(now(), USAGE_RETENTION_DAYS - 1);
    let removed = false;
    for (const key of Object.keys(days)) {
      if (key < oldest) { delete days[key]; removed = true; }
    }
    return removed;
  }

  /**
   * 읽을 수 없는 파일은 원본을 unreadable 백업으로 남기고 빈 상태로 시작한다. 다음 기록 때 새 형식으로 쓴다.
   * 있는데 읽지 못한 파일(잠김·권한)은 이번 실행 동안 덮어쓰지 않는다.
   */
  function load() {
    days = {};
    writable = true;
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return;
      writable = false;
      log(`사용량 파일을 읽지 못했습니다. 이번 실행에서는 사용량 파일에 쓰지 않습니다. (${(error as NodeJS.ErrnoException).code ?? "오류"})`);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<UsageFile>;
      if (parsed.version !== USAGE_FILE_VERSION || typeof parsed.days !== "object" || parsed.days === null) throw new Error("형식이 다릅니다.");
      days = {};
      for (const [key, counters] of Object.entries(parsed.days)) {
        if (!DATE_KEY.test(key) || !Array.isArray(counters)) continue;
        days[key] = counters.map(parseCounter).filter((entry): entry is UsageCounter => entry !== null);
      }
    } catch {
      days = {};
      try {
        log(`사용량 파일을 읽지 못해 빈 상태로 시작합니다. 원본: ${basename(backupFile(filePath, "unreadable", now()))}`);
      } catch (error) {
        writable = false;
        log(`사용량 파일을 읽지 못했고 원본도 남기지 못해 이번 실행에서는 사용량 파일에 쓰지 않습니다. (${(error as NodeJS.ErrnoException).code ?? "오류"})`);
      }
    }
    prune();
  }

  function save() {
    if (!writable) return;
    try {
      const file: UsageFile = { version: USAGE_FILE_VERSION, days };
      writeFileAtomically(filePath, JSON.stringify(file, null, 2), { rename });
    } catch (error) {
      log(`사용량을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 호출 한 번을 오늘 누계에 더하고 파일에 쓴다. */
  function record(event: UsageEvent) {
    const today = localDateKey(now());
    const mode: UsageMode = event.mode ?? "none";
    const counters = days[today] ?? (days[today] = []);
    let counter = counters.find(entry => entry.feature === event.feature && entry.mode === mode && entry.model === event.model);
    if (!counter) {
      counter = { feature: event.feature, mode, model: event.model, calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, callsWithoutTokens: 0, characters: 0 };
      counters.push(counter);
    }

    counter.calls += 1;
    if (!event.ok) {
      // 실패한 호출은 과금되지 않는 것으로 보고 토큰·글자를 세지 않는다.
      counter.failures += 1;
    } else if (event.characters !== undefined) {
      counter.characters += event.characters;
    } else if (event.usage) {
      counter.inputTokens += event.usage.inputTokens;
      counter.outputTokens += event.usage.outputTokens;
    } else {
      counter.callsWithoutTokens += 1;
    }

    prune();
    save();
  }

  return {
    load,
    record,
    /** 날짜별 누계의 복사본. 보고서를 만들 때 쓴다. */
    days(): UsageDays {
      return Object.fromEntries(Object.entries(days).map(([key, counters]) => [key, counters.map(entry => ({ ...entry }))]));
    },
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;
