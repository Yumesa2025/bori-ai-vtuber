/**
 * 평가 결과 파일 두 개를 시나리오별로 비교한다. 프롬프트 변경 전후를 보는 용도다.
 *
 *   npm run eval:compare -- <이전 결과.json> <이후 결과.json>
 *
 * 상태 변화(통과 → 실패 등), 상태는 같지만 개별 검사가 바뀐 것, 실모델 답변 문장 변화를 보여 준다.
 * 시스템 프롬프트 지문이 다르면 프롬프트가 바뀌었다고 먼저 알린다.
 */
import { basename } from "node:path";
import { compareResults, formatComparison, loadResult } from "./src/results.js";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("사용법: npm run eval:compare -- <이전 결과.json> <이후 결과.json>");
  process.exitCode = 1;
} else {
  try {
    const comparison = compareResults(loadResult(beforePath), loadResult(afterPath));
    console.log(formatComparison(comparison, basename(beforePath), basename(afterPath)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
