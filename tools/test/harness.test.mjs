import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForHttp, createBoriClient } from "./harness.mjs";

async function fake(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const bounded = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("외부 제한 초과")), 1000);
  timer.unref();
})]);
test("다른 instance의 서버에는 PATCH를 보내지 않는다", async t => {
  let patches = 0;
  const url = await fake(t, (req, res) => {
    if (req.method === "PATCH") patches++;
    res.end(JSON.stringify({ ok: true, instanceId: "other" }));
  });
  await assert.rejects(async () => {
    await waitForHttp(url, { instanceId: "ours", timeoutMs: 150 });
    await createBoriClient(url).patchLlm({ enabled: false });
  }, /instance|소유/);
  assert.equal(patches, 0);
});
for (const body of [false, true]) {
  test(`readiness 시간 상한: ${body ? "본문" : "헤더"} 무응답`, async t => {
    const url = await fake(t, (_, res) => { if (body) { res.writeHead(200); res.write('{'); } });
    await assert.rejects(bounded(waitForHttp(url, { timeoutMs: 150, intervalMs: 10 })), /150ms/);
  });
  test(`공용 클라이언트 시간 상한: ${body ? "본문" : "헤더"} 무응답`, async t => {
    const url = await fake(t, (_, res) => { if (body) { res.writeHead(200); res.write('{'); } });
    await assert.rejects(bounded(createBoriClient(url).dashboard({ timeoutMs: 150 })), /timeout|aborted/i);
  });
}
import { spawn } from "node:child_process";
import { projectRoot } from "./harness.mjs";
test("점유 포트에서 실행기는 즉시 실패하고 PATCH 0건", async t => {
  let patches = 0;
  const url = await fake(t, (req, res) => {
    if (req.method === "PATCH") patches++;
    res.end(JSON.stringify({ ok: true }));
  });
  const child = spawn(process.execPath, ["tools/test/run.mjs", "secrets"], {
    cwd: projectRoot, env: { ...process.env, BORI_TEST_PORT: new URL(url).port }, stdio: "ignore",
  });
  t.after(() => child.kill());
  const code = await bounded(new Promise(resolve => child.once("exit", resolve)));
  assert.notEqual(code, 0);
  assert.equal(patches, 0);
});
