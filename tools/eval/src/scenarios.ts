import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conversationModes, type ConversationMode } from "@bori/character";
import type { MemoryAccess, MemoryScope } from "@bori/memory";

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
};

export type ScenarioSet = {
  version: number;
  source: string;
  commonForbiddenPatterns: ForbiddenPattern[];
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
