/**
 * 통합 검사 실행기.
 *
 * 가짜 API 서버와 보리 서버를 직접 띄우고 시나리오를 차례로 돌린 뒤 정리한다.
 * 실제 API 키도 비용도 필요 없고, 실제 data/도 건드리지 않는다.
 *
 *   npm run test
 *   npm run test -- security secrets   (시나리오 파일 이름으로 일부만)
 *
 * 포트를 바꾸려면 MOCK_PORT와 BORI_TEST_PORT를 준다.
 * 비정상 종료하면 종료 코드와 그때 돌던 시나리오를 남긴다. 그 줄도 없이 끝났다면
 * 이 프로세스가 밖에서 강제 종료된 것이다(Windows의 taskkill /F는 종료 코드 1을 남긴다).
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
import * as stability from "./stability.mjs";
import * as concurrency from "./concurrency.mjs";
import * as secrets from "./secrets.mjs";
import * as privacy from "./privacy.mjs";
import * as durability from "./durability.mjs";
import * as safety from "./safety.mjs";

const mockPort = Number(process.env.MOCK_PORT ?? 4390);
const boriPort = Number(process.env.BORI_TEST_PORT ?? 4391);
const mockUrl = `http://127.0.0.1:${mockPort}`;
const boriUrl = `http://127.0.0.1:${boriPort}`;

const allScenarios = { latency, behavior, isolation, security, companion, usage, stability, concurrency, secrets, privacy, durability, safety };
const only = process.argv.slice(2);
const unknown = only.filter(name => !Object.hasOwn(allScenarios, name));
if (unknown.length > 0) {
  console.error(`[run] 모르는 시나리오: ${unknown.join(", ")} (있는 것: ${Object.keys(allScenarios).join(", ")})`);
  process.exit(2);
}
const scenarios = Object.entries(allScenarios).filter(([key]) => only.length === 0 || only.includes(key)).map(([, scenario]) => scenario);
const startedAt = Date.now();
let allResults = [];

// 비정상 종료 때 어디서 멈췄는지 남긴다. 정상 종료(0)와 검사 실패(요약을 이미 찍음)는 조용히 둔다.
let stage = "가짜 API 서버 시작";
let summarized = false;
process.on("exit", code => {
  if (code !== 0 && !summarized) console.error(`\n[run] 종료 코드 ${code}로 끝났습니다. 마지막 단계: ${stage}`);
});
// Ctrl+C 등으로 멈추면 띄운 서버를 정리하고 끝낸다. 기본 동작은 exit 처리기 없이 바로 끝나 자식이 남는다.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signal, () => {
    console.error(`\n[run] ${signal} 신호를 받아 멈춥니다. 단계: ${stage}`);
    stopAll().finally(() => process.exit(code));
  });
}

console.log(`[run] mock ${mockPort} / bori ${boriPort}, Node ${process.version}, 시나리오 ${scenarios.length}개`);

const mockServer = startScript(join(toolsTestDir, "mock-openai.mjs"), { env: { MOCK_PORT: String(mockPort) }, label: "mock-openai" });

try {
  await waitForHttp(`${mockUrl}/__calls`, { describe: "가짜 API 서버" });
  const mock = createMockClient(mockUrl);

  for (const scenario of scenarios) {
    console.log(`\n── ${scenario.meta.name} ${"─".repeat(Math.max(0, 50 - scenario.meta.name.length))}`);
    stage = `${scenario.meta.name} 준비`;

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
      stage = `${scenario.meta.name} 실행`;
      await scenario.run({ bori: createBoriClient(boriUrl), mock, report, dataDir: data.path });
    } catch (error) {
      report.check(`${scenario.meta.name} 시나리오가 끝까지 돌았다`, false, error instanceof Error ? error.message : String(error));
      const output = boriServer.output();
      const { exitCode, signalCode } = boriServer.child;
      if (exitCode !== null || signalCode !== null) console.log(`\n[서버 종료] code=${exitCode} signal=${signalCode}`);
      if (output.trim()) console.log(`\n[서버 출력]\n${output}`);
    } finally {
      allResults = [...allResults, ...report.results];
      await boriServer.stop();
      await data.cleanup();
    }
  }
} finally {
  stage = "정리";
  await mockServer.stop();
  await stopAll();
}

const failed = allResults.filter(entry => !entry.pass);
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
summarized = true;
console.log(`\n총 ${allResults.length}건 중 ${allResults.length - failed.length}건 통과, ${failed.length}건 실패 (${seconds}초)`);

if (failed.length > 0) {
  for (const entry of failed) console.log(`  실패: ${entry.name}`);
  process.exit(1);
}
