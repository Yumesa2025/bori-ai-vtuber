/**
 * 보리 스튜디오 서버 자식 프로세스 단위 검사.
 * 이미 떠 있는 서버를 알아보는지, 띄운 서버가 준비될 때까지 기다리는지, 끌 때 자기가 띄운 것만 끄는지 본다.
 * 실제 보리 서버 대신 /api/health만 답하는 가짜 서버 스크립트를 띄운다. Electron은 띄우지 않는다.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const require = createRequire(import.meta.url);
type Started = { child: ChildProcess; stop: () => Promise<void> };
type StartOptions = { cwd: string; env: NodeJS.ProcessEnv; logPath: string; nodePath?: string; args?: string[]; timeoutMs?: number };
const { DEFAULT_SERVER_PORT, SERVER_ARGS, ensureServer, findRunningServer, prepareServerLog, resolveServerPort, startServer } = require("../electron/server-process.cjs") as {
  DEFAULT_SERVER_PORT: number;
  SERVER_ARGS: string[];
  ensureServer: (options: StartOptions & { port: number }) => Promise<{ external: boolean; stop: () => Promise<void> }>;
  findRunningServer: (port: number) => Promise<boolean>;
  prepareServerLog: (dataDir: string) => string;
  resolveServerPort: (value: string | undefined) => number;
  startServer: (options: StartOptions) => Promise<Started>;
};

/** BORI_SERVER_PORT로 /api/health만 답하는 가짜 서버. FAKE_MODE로 바로 끝나기·영원히 안 뜨기를 흉내 낸다. */
const FAKE_SERVER = `
import { createServer } from "node:http";
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "exit") { console.log("fake exit"); process.exit(3); }
if (mode === "hang") { console.log("fake hang"); setInterval(() => {}, 1000); }
else createServer((request, response) => {
  if (request.url === "/api/health") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, service: "bori-server" })); return; }
  response.writeHead(404); response.end();
}).listen(Number(process.env.BORI_SERVER_PORT), "127.0.0.1", () => console.log("fake listening"));
`;

let dir: string;
let script: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-studio-server-"));
  script = join(dir, "fake-server.mjs");
  writeFileSync(script, FAKE_SERVER);
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** 지금 비어 있는 포트. 잠깐 열었다 닫는다. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** 정해진 응답만 하는 바깥 서버. 스튜디오가 띄운 것이 아닌 서버를 흉내 낸다. */
async function externalServer(status: number, body: unknown): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

const closeServer = (server: Server) => new Promise(resolve => server.close(resolve));

function fakeOptions(port: number, mode: string, extra: Partial<StartOptions> = {}): StartOptions {
  return { cwd: dir, env: { ...process.env, BORI_SERVER_PORT: String(port), FAKE_MODE: mode }, logPath: join(dir, `server-${port}.log`), nodePath: process.execPath, args: [script], ...extra };
}

describe("서버 포트", () => {
  test("BORI_SERVER_PORT를 따르고, 비었거나 잘못되면 4310이다", () => {
    assert.equal(DEFAULT_SERVER_PORT, 4310);
    assert.equal(resolveServerPort(undefined), 4310);
    assert.equal(resolveServerPort(""), 4310);
    assert.equal(resolveServerPort("4850"), 4850);
    for (const value of ["abc", "0", "70000", "43.5", "-1"]) assert.equal(resolveServerPort(value), 4310, value);
  });

  test("보리 서버는 tsx로 저장소의 서버 진입점을 띄운다", () => {
    assert.deepEqual(SERVER_ARGS, ["--import", "tsx", "apps/server/src/index.ts"]);
  });
});

describe("findRunningServer", () => {
  test("/api/health가 200이고 보리 서버면 true", async () => {
    const { server, port } = await externalServer(200, { ok: true, service: "bori-server" });
    try { assert.equal(await findRunningServer(port), true); } finally { await closeServer(server); }
  });

  test("다른 응답·다른 서비스·빈 포트면 false", async () => {
    const notFound = await externalServer(404, { error: "Not found" });
    const other = await externalServer(200, { ok: true, service: "something-else" });
    try {
      assert.equal(await findRunningServer(notFound.port), false);
      assert.equal(await findRunningServer(other.port), false);
      assert.equal(await findRunningServer(await freePort()), false);
    } finally {
      await closeServer(notFound.server);
      await closeServer(other.server);
    }
  });
});

describe("startServer", () => {
  test("health가 될 때까지 기다리고, 출력은 로그 파일에 남기고, stop으로 끈다", async () => {
    const port = await freePort();
    const options = fakeOptions(port, "ok");
    const started = await startServer(options);
    assert.equal(await findRunningServer(port), true);
    await started.stop();
    assert.notEqual(started.child.exitCode ?? started.child.signalCode, null, "자식이 끝나야 한다");
    assert.equal(await findRunningServer(port), false);
    assert.match(readFileSync(options.logPath, "utf8"), /fake listening/);
  });

  test("자식이 먼저 끝나면 기다리지 않고 로그 경로와 함께 실패한다", async () => {
    const port = await freePort();
    const options = fakeOptions(port, "exit");
    const startedAt = Date.now();
    await assert.rejects(startServer(options), (error: Error) => error.message.includes(options.logPath) && error.message.includes("3"));
    assert.ok(Date.now() - startedAt < 5000, "제한 시간까지 기다리지 않는다");
  });

  test("제한 시간 안에 준비되지 않으면 자식을 끄고 실패한다", async () => {
    const port = await freePort();
    let child: ChildProcess | undefined;
    const options = fakeOptions(port, "hang", { timeoutMs: 600 });
    await assert.rejects(startServer({ ...options, env: { ...options.env } }).catch(error => { child = (error as { child?: ChildProcess }).child; throw error; }), /준비되지 않/);
    assert.ok(child, "실패에 띄운 자식을 싣는다");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.notEqual(child!.exitCode ?? child!.signalCode, null, "자식이 남지 않는다");
  });
});

describe("ensureServer", () => {
  test("이미 떠 있는 서버는 그대로 쓰고, 끌 때 건드리지 않는다", async () => {
    const { server, port } = await externalServer(200, { ok: true, service: "bori-server" });
    try {
      // 띄우려 하면 실패하도록 없는 파일을 준다. 바깥 서버를 쓰면 이 경로는 안 탄다.
      const result = await ensureServer({ ...fakeOptions(port, "ok", { args: [join(dir, "missing.mjs")] }), port });
      assert.equal(result.external, true);
      await result.stop();
      assert.equal(await findRunningServer(port), true, "바깥 서버는 살아 있다");
    } finally {
      await closeServer(server);
    }
  });

  test("떠 있는 서버가 없으면 띄우고, 끌 때 그 서버를 끈다", async () => {
    const port = await freePort();
    const result = await ensureServer({ ...fakeOptions(port, "ok"), port });
    assert.equal(result.external, false);
    assert.equal(await findRunningServer(port), true);
    await result.stop();
    assert.equal(await findRunningServer(port), false);
  });
});

describe("서버 로그 파일", () => {
  test("실행할 때마다 지난 로그를 previous로 넘긴다", () => {
    const dataDir = join(dir, "data");
    const first = prepareServerLog(dataDir);
    writeFileSync(first, "첫 실행\n");
    const second = prepareServerLog(dataDir);
    assert.equal(second, first);
    assert.equal(existsSync(second), false);
    assert.equal(readFileSync(join(dataDir, "studio-server.previous.log"), "utf8"), "첫 실행\n");
  });
});
