import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conversationModes, type ConversationMode } from "@bori/character";
import type { MemoryAccess, MemoryScope } from "@bori/memory";
import { isRelationshipLine } from "./relationship.js";

export const evalDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = join(evalDir, "..", "..");
export const scenarioDataPath = join(evalDir, "scenarios.json");
export const scenarioDocPath = join(repoRoot, "docs", "content", "dialogue-scenarios.md");

/**
 * 답이 어디서 나와야 하는지. 문서의 "처리 경로" 칸을 평가기가 쓸 수 있게 줄인 것이다.
 *   rule      서버 규칙 응답
 *   llm       LLM 답변
 *   blocked   서버 사전 차단(무반응)
 *   monologue 혼잣말 규칙 문장
 *   undecided 처리 방식 미결정. LLM 경로로 평가한다
 */
export type ScenarioPath = "rule" | "llm" | "blocked" | "monologue" | "undecided";
const scenarioPaths: readonly ScenarioPath[] = ["rule", "llm", "blocked", "monologue", "undecided"];

/** 기대 감정·모션 한 묶음. motions의 null은 "모션 없음", motions가 없으면 모션은 따지지 않는다. */
export type ExpectedReaction = { emotions: string[]; motions?: (string | null)[] };

/** 금지 반응 중 문자열로 판정할 수 있는 것. */
export type ForbiddenPattern = { label: string; pattern: string; flags?: string };

/**
 * 지어내기 판정 자료. 고정값(관계 문장·기억)에 없는 구체 세부가 답에 나오는지 본다.
 *   suspects   고정값에 없는 구체 명사 등. 답에 나오면 지어내기 후보로 실패 처리한다
 *   grounded   고정값에 실제로 있는 말. suspects에 걸려도 이 말이면 지어낸 것이 아니다
 *   expect     지어내기 후보가 없을 때 무엇을 보면 통과로 볼지
 *                admit    모른다·기억나지 않는다는 표현
 *                mention  mentions 중 하나를 언급
 *              없으면 후보가 없을 때 바로 통과다. 기대 표현을 못 찾으면 "수동 평가 필요"로 둔다
 */
export type FabricationGuard = {
  note?: string;
  grounded: string[];
  suspects: ForbiddenPattern[];
  expect?: "admit" | "mention";
  mentions?: string[];
};

export type FixtureMemory = { id: string; text: string; scope: MemoryScope; ownerId?: string };

/** 기억 격리를 재현하는 고정 자료. 이 기억들을 canAccessMemory로 걸러 프롬프트에 넣는다. */
export type MemoryFixture = {
  note?: string;
  access: MemoryAccess;
  records: FixtureMemory[];
  /** 사용자 확정 접근 규칙에 따라 보여야 하는 기억 id. */
  expectedVisible: string[];
};

export type Scenario = {
  id: string;
  title: string;
  mode: ConversationMode;
  premise: string;
  /** 혼잣말처럼 입력이 없으면 null. */
  input: string | null;
  path: ScenarioPath;
  pathNote: string;
  expectedFeatures: string;
  forbiddenText: string;
  reactionNote: string;
  expectedReactions: ExpectedReaction[];
  /** 규칙 경로 시나리오를 LLM이 답할 경우의 기대값. 있을 때만 실모델 평가를 돌린다. */
  llmReactions?: ExpectedReaction[];
  forbiddenPatterns?: ForbiddenPattern[];
  memoryFixture?: MemoryFixture;
  /**
   * 서버가 계산해 상황 섹션에 넣는 문장의 고정값. 1:1 시나리오는 관계 맥락 계약 형식만 쓴다.
   * 없으면 상황 섹션이 비어 있어야 한다.
   */
  statusLines?: string[];
  fabricationGuard?: FabricationGuard;
  /**
   * 서버가 위기 신호로 감지하는 입력인지. true면 서버처럼 위기 지침([위기 대응])을 붙여 요청한다(ADR-022).
   * 서버가 답 뒤에 붙이는 도움 안내 문장은 평가하지 않는다. 모델이 쓴 답만 본다.
   */
  crisis?: boolean;
};

export type ScenarioSet = {
  version: number;
  source: string;
  commonForbiddenPatterns: ForbiddenPattern[];
  /** 1:1 시나리오에만 더하는 금지 표현("당신" 호칭 등). */
  companionForbiddenPatterns?: ForbiddenPattern[];
  scenarios: Scenario[];
};

/** 문서에서 읽은 시나리오. 데이터와 대조할 칸만 뽑는다. */
export type DocScenario = { id: string; title: string; mode: string; input: string | null };

/** 시나리오 데이터를 읽고 형식을 검사한다. 형식이 틀리면 어디가 틀렸는지 모아서 던진다. */
export function parseScenarioSet(raw: unknown): ScenarioSet {
  const problems: string[] = [];
  const data = raw as Partial<ScenarioSet> | null;
  if (typeof data !== "object" || data === null) throw new Error("시나리오 데이터가 객체가 아닙니다.");
  if (!Array.isArray(data.scenarios)) throw new Error("scenarios 배열이 없습니다.");

  for (const pattern of data.commonForbiddenPatterns ?? []) checkPattern(pattern, "공통", problems);
  for (const pattern of data.companionForbiddenPatterns ?? []) checkPattern(pattern, "1:1 공통", problems);

  const seen = new Set<string>();
  for (const scenario of data.scenarios) {
    const where = typeof scenario?.id === "string" ? scenario.id : "(id 없음)";
    if (typeof scenario?.id !== "string" || !/^[BC]-\d{2}$/.test(scenario.id)) problems.push(`${where}: id 형식이 아닙니다.`);
    if (seen.has(where)) problems.push(`${where}: id가 중복됩니다.`);
    seen.add(where);
    if (!conversationModes.includes(scenario.mode)) problems.push(`${where}: 알 수 없는 모드 ${String(scenario.mode)}`);
    if (!scenarioPaths.includes(scenario.path)) problems.push(`${where}: 알 수 없는 처리 경로 ${String(scenario.path)}`);
    if (scenario.input !== null && typeof scenario.input !== "string") problems.push(`${where}: input은 문자열 또는 null이어야 합니다.`);
    // 입력이 없는 시나리오는 프롬프트를 만들 수 없다. 혼잣말 경로만 허용한다.
    if (scenario.input === null && scenario.path !== "monologue") problems.push(`${where}: 입력이 없는 시나리오는 혼잣말 경로여야 합니다.`);
    if (!Array.isArray(scenario.expectedReactions)) problems.push(`${where}: expectedReactions 배열이 없습니다.`);
    for (const pattern of scenario.forbiddenPatterns ?? []) checkPattern(pattern, where, problems);
    if (scenario.crisis !== undefined && typeof scenario.crisis !== "boolean") problems.push(`${where}: crisis는 true 또는 false여야 합니다.`);

    checkStatusLines(scenario, where, problems);
    checkFabricationGuard(scenario, where, problems);

    const fixture = scenario.memoryFixture;
    if (fixture) {
      const ids = new Set(fixture.records.map(record => record.id));
      for (const id of fixture.expectedVisible) {
        if (!ids.has(id)) problems.push(`${where}: expectedVisible의 ${id}가 records에 없습니다.`);
      }
      const modeOfAccess = fixture.access.mode === "private" ? "companion" : "broadcast";
      if (modeOfAccess !== scenario.mode) problems.push(`${where}: 기억 접근 주체의 모드가 시나리오 모드와 다릅니다.`);
    }
  }

  if (problems.length > 0) throw new Error(`시나리오 데이터 형식 오류\n- ${problems.join("\n- ")}`);
  return data as ScenarioSet;
}

/**
 * 상황 섹션 고정값. 방송 시나리오에 관계 문장을 넣으면 방송에 관계 문장이 새지 않는지 볼 수 없으므로 막는다.
 * 1:1 시나리오는 관계 맥락 계약 형식만 받는다. 형식이 틀린 고정값으로 통과하면 계약이 바뀐 걸 놓친다.
 */
function checkStatusLines(scenario: Scenario, where: string, problems: string[]) {
  const lines: unknown = scenario.statusLines;
  if (lines === undefined) return;
  if (!Array.isArray(lines) || lines.some(line => typeof line !== "string")) {
    problems.push(`${where}: statusLines는 문자열 배열이어야 합니다.`);
    return;
  }
  const strings = lines as string[];
  if (strings.length === 0) problems.push(`${where}: statusLines가 비어 있습니다. 상황 고정값이 없으면 칸을 지웁니다.`);
  if (scenario.mode === "broadcast") {
    const relationship = strings.filter(isRelationshipLine);
    if (relationship.length > 0) problems.push(`${where}: 방송 시나리오에 관계 문장이 있습니다: ${relationship.join(" / ")}`);
    return;
  }
  for (const line of strings) {
    if (!isRelationshipLine(line)) problems.push(`${where}: 관계 맥락 계약 형식이 아닙니다: ${line}`);
  }
}

function checkFabricationGuard(scenario: Scenario, where: string, problems: string[]) {
  const guard = scenario.fabricationGuard;
  if (!guard) return;
  if (!Array.isArray(guard.grounded) || !Array.isArray(guard.suspects)) {
    problems.push(`${where}: fabricationGuard에는 grounded와 suspects 배열이 있어야 합니다.`);
    return;
  }
  for (const pattern of guard.suspects) checkPattern(pattern, `${where} 지어내기 후보`, problems);
  if (guard.expect !== undefined && guard.expect !== "admit" && guard.expect !== "mention") {
    problems.push(`${where}: 알 수 없는 fabricationGuard.expect ${String(guard.expect)}`);
  }
  if (guard.expect === "mention" && (guard.mentions ?? []).length === 0) {
    problems.push(`${where}: expect가 mention이면 mentions가 있어야 합니다.`);
  }
}

function checkPattern(pattern: ForbiddenPattern, where: string, problems: string[]) {
  try {
    new RegExp(pattern.pattern, pattern.flags);
  } catch (error) {
    problems.push(`${where}: 금지 패턴 "${pattern.label}"이 정규식이 아닙니다. ${error instanceof Error ? error.message : ""}`);
  }
}

export function loadScenarioSet(path = scenarioDataPath): ScenarioSet {
  return parseScenarioSet(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * 대화 시나리오 문서에서 시나리오 목록을 뽑는다.
 * "### B-01 인사" 제목 아래 표의 모드·입력 칸만 읽는다.
 */
export function parseScenarioDoc(markdown: string): DocScenario[] {
  const result: DocScenario[] = [];
  let current: DocScenario | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^###\s+([BC]-\d{2})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2], mode: "", input: null };
      result.push(current);
      continue;
    }
    // 다른 제목이 나오면 표 읽기를 멈춘다.
    if (/^#{1,3}\s/.test(line)) { current = null; continue; }
    if (!current) continue;

    const row = /^\|\s*(모드|입력)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!row) continue;
    if (row[1] === "모드") current.mode = row[2];
    else current.input = parseDocInput(row[2]);
  }
  return result;
}

/** 입력 칸은 큰따옴표로 감싼 원문이거나 "(없음)"이다. */
function parseDocInput(cell: string): string | null {
  if (cell === "(없음)") return null;
  const quoted = /^"(.*)"$/.exec(cell);
  return quoted ? quoted[1] : cell;
}

/** 문서와 데이터가 어긋난 곳을 모두 찾는다. 빈 배열이면 일치한다. */
export function compareDocWithData(doc: readonly DocScenario[], data: readonly Scenario[]): string[] {
  const problems: string[] = [];
  const docById = new Map(doc.map(entry => [entry.id, entry]));
  const dataById = new Map(data.map(entry => [entry.id, entry]));

  if (docById.size !== doc.length) problems.push("문서에 중복된 시나리오 id가 있습니다.");
  for (const entry of doc) {
    const match = dataById.get(entry.id);
    if (!match) { problems.push(`${entry.id}: 문서에는 있고 데이터에는 없습니다.`); continue; }
    if (match.mode !== entry.mode) problems.push(`${entry.id}: 모드가 다릅니다. 문서 ${entry.mode}, 데이터 ${match.mode}`);
    if (match.input !== entry.input) problems.push(`${entry.id}: 입력이 다릅니다. 문서 ${JSON.stringify(entry.input)}, 데이터 ${JSON.stringify(match.input)}`);
    if (match.title !== entry.title) problems.push(`${entry.id}: 제목이 다릅니다. 문서 ${entry.title}, 데이터 ${match.title}`);
  }
  for (const entry of data) {
    if (!docById.has(entry.id)) problems.push(`${entry.id}: 데이터에는 있고 문서에는 없습니다.`);
  }
  return problems;
}

export function checkScenarioDoc(set: ScenarioSet, docPath = scenarioDocPath): string[] {
  return compareDocWithData(parseScenarioDoc(readFileSync(docPath, "utf8")), set.scenarios);
}
