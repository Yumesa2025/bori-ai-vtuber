/**
 * 대화 품질 평가 실행기.
 *
 *   npm run eval -- --label before          정적 평가 + 실모델 평가(키가 있을 때만)
 *   npm run eval:static -- --label before   정적 평가만
 *   npm run eval:model -- --label before    실모델 평가만. OPENAI_API_KEY가 없으면 건너뛰고 정상 종료한다
 *
 * 결과는 tools/eval/results/<타임스탬프>-<라벨>.json에 저장한다. 비교는 compare.ts.
 * 실모델 평가 환경변수: OPENAI_API_KEY, BORI_EVAL_MODEL(기본 gpt-4o-mini), BORI_OPENAI_BASE_URL, BORI_EVAL_TIMEOUT_MS.
 *
 * 종료 코드는 시나리오 데이터가 문서와 어긋나거나 형식이 틀렸을 때만 1이다.
 * 시나리오 실패는 평가 결과이지 실행 실패가 아니므로 0으로 끝난다.
 */
import { execFileSync } from "node:child_process";
import { runModelEvaluation, type ModelSection } from "./src/model.js";
import { promptFingerprints } from "./src/request.js";
import { saveResult } from "./src/results.js";
import { checkScenarioDoc, loadScenarioSet, repoRoot } from "./src/scenarios.js";
import { runStaticEvaluation } from "./src/static.js";
import type { EvalResultFile, SectionResult } from "./src/types.js";

function readArgs(argv: readonly string[]) {
  let label = "run";
  let only: "static" | "model" | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--label") label = argv[++index] ?? label;
    else if (arg === "--only") {
      const value = argv[++index];
      if (value !== "static" && value !== "model") throw new Error("--only는 static 또는 model이어야 합니다.");
      only = value;
    } else throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }
  return { label, only };
}

/** 숫자가 아니거나 0 이하이면 기본값을 쓴다. */
function readTimeout(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function printSection(title: string, section: SectionResult) {
  const { pass, fail, out_of_scope: outOfScope, skipped, error } = section.counts;
  console.log(`\n[${title}] 통과 ${pass} / 실패 ${fail} / 범위 밖 ${outOfScope} / 건너뜀 ${skipped} / 오류 ${error} (총 ${section.scenarios.length})`);
  for (const result of section.scenarios) {
    if (result.status === "fail") {
      const failed = result.checks.filter(check => check.status === "fail").map(check => `${check.label}${check.detail ? `: ${check.detail}` : ""}`);
      console.log(`  실패 ${result.id} ${result.title} — ${failed.join(" | ")}`);
    } else if (result.status === "out_of_scope" || result.status === "error") {
      console.log(`  ${result.status === "error" ? "오류" : "범위 밖"} ${result.id} ${result.title} — ${result.reason ?? ""}`);
    }
  }
}

async function main() {
  const { label, only } = readArgs(process.argv.slice(2));
  const set = loadScenarioSet();

  // 문서와 데이터가 어긋나면 평가 결과를 믿을 수 없다. 평가 전에 멈춘다.
  const docProblems = checkScenarioDoc(set);
  if (docProblems.length > 0) {
    console.error("시나리오 문서와 데이터가 어긋납니다.");
    for (const problem of docProblems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`시나리오 ${set.scenarios.length}건 (문서와 일치)`);

  const result: EvalResultFile = {
    version: 1,
    label,
    createdAt: new Date().toISOString(),
    commit: currentCommit(),
    promptFingerprints: promptFingerprints(),
    scenarioCount: set.scenarios.length,
  };

  if (only !== "model") {
    result.static = runStaticEvaluation(set);
    printSection("정적 평가", result.static);
  }

  if (only !== "static") {
    const model: ModelSection = await runModelEvaluation(set, {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.BORI_EVAL_MODEL || undefined,
      timeoutMs: readTimeout(process.env.BORI_EVAL_TIMEOUT_MS),
      log: line => console.log(line),
    });
    result.model = model;
    if (model.skippedReason) console.log(`\n[실모델 평가] 건너뜀: ${model.skippedReason}`);
    else {
      const target = model.baseUrl ? ` @ ${model.baseUrl} (기본 OpenAI 주소 아님)` : "";
      printSection(`실모델 평가 ${model.model}${target}`, model);
    }
  }

  console.log(`\n결과 저장: ${saveResult(result)}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
