/**
 * 통합 검사 실행기.
 *
 * 가짜 API 서버와 보리 서버를 직접 띄우고 시나리오를 차례로 돌린 뒤 정리한다.
 * 실제 API 키도 비용도 필요 없고, 실제 data/도 건드리지 않는다.
 *
 *   npm run test
 *
 * 포트를 바꾸려면 MOCK_PORT와 BORI_TEST_PORT를 준다.
 * 방송 화면과 Live2D 모델은 검사 대상이 아니다. 서버 동작만 본다.
 */
import { join } from "node:path";
import {
  createBoriClient,
  createMockClient,
  createReporter,
  prepareDataDir,
  startScript,
  stopAll,
  toolsTestDir,
  waitForHttp,
} from "./harness.mjs";
import * as latency from "./latency.mjs";
import * as behavior from "./behavior.mjs";
import * as isolation from "./isolation.mjs";
import * as security from "./security.mjs";
import * as companion from "./companion.mjs";
import * as usage from "./usage.mjs";

const mockPort = Number(process.env.MOCK_PORT ?? 4390);
const boriPort = Number(process.env.BORI_TEST_PORT ?? 4391);
const mockUrl = `http://127.0.0.1:${mockPort}`;
const boriUrl = `http://127.0.0.1:${boriPort}`;

const scenarios = [latency, behavior, isolation, security, companion, usage];
const startedAt = Date.now();
let allResults = [];

const mockServer = startScript(join(toolsTestDir, "mock-openai.mjs"), { env: { MOCK_PORT: String(mockPort) }, label: "mock-openai" });

try {
  await waitForHttp(`${mockUrl}/__calls`, { describe: "가짜 API 서버" });
  const mock = createMockClient(mockUrl);

  for (const scenario of scenarios) {
    console.log(`\n── ${scenario.meta.name} ${"─".repeat(Math.max(0, 50 - scenario.meta.name.length))}`);

    // 서버가 설정과 기억을 파일에 쓰므로 시나리오마다 새 디렉터리를 준다.
    const data = await prepareDataDir();
    await mock.setTiming(scenario.meta.timing);
    await mock.reset();

    const boriServer = startScript("apps/server/src/index.ts", {
      loadTypeScript: true,
      label: "bori-server",
      env: {
        BORI_SERVER_PORT: String(boriPort),
        BORI_DATA_DIR: data.path,
        BORI_OPENAI_BASE_URL: `${mockUrl}/v1`,
        // 가짜 서버는 키를 보지 않는다. 값이 있어야 LLM 경로가 열린다.
        OPENAI_API_KEY: "mock-key",
      },
    });

    const report = createReporter();
    try {
      await waitForHttp(`${boriUrl}/api/health`, { describe: "보리 서버" });
      await scenario.run({ bori: createBoriClient(boriUrl), mock, report, dataDir: data.path });
    } catch (error) {
      report.check(`${scenario.meta.name} 시나리오가 끝까지 돌았다`, false, error instanceof Error ? error.message : String(error));
      const output = boriServer.output();
      if (output.trim()) console.log(`\n[서버 출력]\n${output}`);
    } finally {
      allResults = [...allResults, ...report.results];
      await boriServer.stop();
      await data.cleanup();
    }
  }
} finally {
  await mockServer.stop();
  await stopAll();
}

const failed = allResults.filter(entry => !entry.pass);
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n총 ${allResults.length}건 중 ${allResults.length - failed.length}건 통과, ${failed.length}건 실패 (${seconds}초)`);

if (failed.length > 0) {
  for (const entry of failed) console.log(`  실패: ${entry.name}`);
  process.exit(1);
}
