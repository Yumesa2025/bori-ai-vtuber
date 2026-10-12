import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalDir } from "./scenarios.js";
import type { EvalResultFile, ScenarioResult, ScenarioStatus } from "./types.js";

export const resultsDir = join(evalDir, "results");

/** 파일 이름에 쓸 수 있는 라벨로 바꾼다. 비면 run. */
export function sanitizeLabel(label: string): string {
  const cleaned = label.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "run";
}

/** 20261012-153045 형식. 결과 파일이 이름순으로 시간순 정렬되게 한다. */
export function timestampForFile(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function saveResult(result: EvalResultFile, date = new Date(result.createdAt)): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, `${timestampForFile(date)}-${sanitizeLabel(result.label)}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

export function loadResult(path: string): EvalResultFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EvalResultFile;
  if (parsed?.version !== 1) throw new Error(`${path}: 평가 결과 파일이 아니거나 버전이 다릅니다.`);
  return parsed;
}

export type Section = "static" | "model";

/** 시나리오 하나의 변화. before나 after가 없으면 한쪽 결과에만 있는 시나리오다. */
export type ScenarioChange = {
  section: Section;
  id: string;
  before: ScenarioStatus | null;
  after: ScenarioStatus | null;
  /** 상태가 같아도 개별 검사 결과가 달라졌으면 그 목록. */
  checkChanges: string[];
  /** 실모델 평가에서 답변이 달라졌는지. 같은 프롬프트라도 모델 답은 매번 다를 수 있다. */
  replyChanged: boolean;
};

export type Comparison = {
  promptChanged: { mode: string; before: string; after: string }[];
  changes: ScenarioChange[];
  /** 섹션별 상태 변화 수. 같은 상태끼리는 세지 않는다. */
  statusChangeCount: number;
};

/** 두 결과 파일을 시나리오 단위로 비교한다. 프롬프트 변경 전후 비교 용도다. */
export function compareResults(before: EvalResultFile, after: EvalResultFile): Comparison {
  const promptChanged = Object.keys({ ...before.promptFingerprints, ...after.promptFingerprints })
    .map(mode => ({
      mode,
      before: before.promptFingerprints[mode as keyof EvalResultFile["promptFingerprints"]] ?? "",
      after: after.promptFingerprints[mode as keyof EvalResultFile["promptFingerprints"]] ?? "",
    }))
    .filter(entry => entry.before !== entry.after);

  const changes: ScenarioChange[] = [];
  for (const section of ["static", "model"] as const) {
    const left = indexById(before[section]?.scenarios);
    const right = indexById(after[section]?.scenarios);
    const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const id of ids) {
      const a = left.get(id);
      const b = right.get(id);
      const checkChanges = a && b ? diffChecks(a, b) : [];
      const replyChanged = Boolean(a?.response && b?.response && a.response.reply !== b.response.reply);
      if (a?.status !== b?.status || checkChanges.length > 0 || replyChanged) {
        changes.push({ section, id, before: a?.status ?? null, after: b?.status ?? null, checkChanges, replyChanged });
      }
    }
  }

  return { promptChanged, changes, statusChangeCount: changes.filter(change => change.before !== change.after).length };
}

function indexById(results: readonly ScenarioResult[] | undefined): Map<string, ScenarioResult> {
  return new Map((results ?? []).map(result => [result.id, result]));
}

function diffChecks(a: ScenarioResult, b: ScenarioResult): string[] {
  const left = new Map(a.checks.map(check => [check.id, check.status]));
  const right = new Map(b.checks.map(check => [check.id, check.status]));
  const ids = [...new Set([...left.keys(), ...right.keys()])];
  return ids
    .filter(id => left.get(id) !== right.get(id))
    .map(id => `${id}: ${left.get(id) ?? "없음"} → ${right.get(id) ?? "없음"}`);
}

export function formatComparison(comparison: Comparison, beforeLabel: string, afterLabel: string): string {
  const lines = [`비교: ${beforeLabel} → ${afterLabel}`];
  if (comparison.promptChanged.length === 0) lines.push("시스템 프롬프트: 같음");
  else {
    for (const entry of comparison.promptChanged) lines.push(`시스템 프롬프트(${entry.mode}): ${entry.before || "없음"} → ${entry.after || "없음"}`);
  }

  const statusChanges = comparison.changes.filter(change => change.before !== change.after);
  lines.push(`상태 변화: ${statusChanges.length}건`);
  for (const change of statusChanges) {
    lines.push(`  [${change.section}] ${change.id} ${change.before ?? "없음"} → ${change.after ?? "없음"}`);
  }

  const detailOnly = comparison.changes.filter(change => change.before === change.after);
  if (detailOnly.length > 0) {
    lines.push(`상태는 같고 세부가 바뀐 시나리오: ${detailOnly.length}건`);
    for (const change of detailOnly) {
      const parts = [...change.checkChanges, ...(change.replyChanged ? ["답변 문장이 달라짐"] : [])];
      lines.push(`  [${change.section}] ${change.id} ${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
}
