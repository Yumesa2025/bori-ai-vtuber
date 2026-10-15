/**
 * 보리 스튜디오가 보리 서버를 자식 프로세스로 띄우고 끄는 규칙.
 * Electron 없이 단위 검사(test/server-process.test.ts)할 수 있게 main.cjs에서 떼어 둔다.
 *
 * - 이미 같은 포트에 보리 서버가 떠 있으면 그것을 쓰고, 끌 때도 건드리지 않는다.
 * - 루트 .env는 서버가 스스로 읽는다(apps/server/src/load-env.ts). 여기서는 읽지도 넘기지도 않는다.
 * - 서버 출력은 데이터 폴더의 로그 파일에만 쓴다. 서버는 키 값을 출력하지 않는다.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** 치지직 Redirect URL(http://localhost:4310/api/chzzk/callback)에 맞춘 기본 포트. */
const DEFAULT_SERVER_PORT = 4310;
/** 저장소 루트를 cwd로 두고 띄운다. tsx도 루트 node_modules에서 찾는다. */
const SERVER_ARGS = ["--import", "tsx", "apps/server/src/index.ts"];
/** 서버가 /api/health에 답할 때까지 기다리는 최대 시간. */
const START_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 1000;
/** 끌 때 자식이 끝나기를 기다리는 최대 시간. */
const STOP_TIMEOUT_MS = 5000;

const LOG_NAME = "studio-server.log";
const PREVIOUS_LOG_NAME = "studio-server.previous.log";

/** BORI_SERVER_PORT 값. 비었거나 포트가 아니면 기본 포트를 쓴다. 서버에도 이 값을 그대로 넘겨 둘이 어긋나지 않게 한다. */
function resolveServerPort(value) {
  if (!value) return DEFAULT_SERVER_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SERVER_PORT;
}

/** 이 포트에 보리 서버가 떠 있는지. 다른 프로그램이 포트를 쓰고 있으면 false다. */
async function findRunningServer(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (response.status !== 200) return false;
    const body = await response.json();
    return body?.service === "bori-server";
  } catch {
    return false;
  }
}

/** 서버 로그 경로. 실행할 때마다 지난 로그를 previous로 넘겨 지금 실행과 바로 전 실행 것만 남긴다(log-file.cjs와 같은 방식). */
function prepareServerLog(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, LOG_NAME);
  try {
    fs.renameSync(logPath, path.join(dataDir, PREVIOUS_LOG_NAME));
  } catch {
    // 처음 실행이라 넘길 로그가 없다.
  }
  return logPath;
}

/** 자식을 끄고 끝날 때까지 기다린다. 이미 끝났으면 바로 돌아온다. */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    // Windows에서는 바로 종료(TerminateProcess)된다. node를 직접 띄웠으므로 손자 프로세스는 없다.
    child.kill();
  });
}

/**
 * 서버를 띄우고 /api/health가 될 때까지 기다린다.
 * 포트는 env.BORI_SERVER_PORT다. 자식이 먼저 끝나거나 제한 시간을 넘기면 자식을 끄고 로그 경로를 담아 실패한다.
 * nodePath·args·timeoutMs는 검사가 가짜 서버를 띄울 때 바꾼다.
 */
async function startServer({ cwd, env, logPath, nodePath = process.env.npm_node_execPath || "node", args = SERVER_ARGS, timeoutMs = START_TIMEOUT_MS }) {
  const port = resolveServerPort(env.BORI_SERVER_PORT);
  const logFd = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn(nodePath, args, { cwd, env: { ...env, BORI_SERVER_PORT: String(port) }, stdio: ["ignore", logFd, logFd], windowsHide: true });
  } finally {
    // 자식이 자기 핸들을 따로 가지므로 여기 것은 바로 닫는다.
    fs.closeSync(logFd);
  }

  let exited = null;
  let spawnError = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  child.once("error", error => { spawnError = error; });
  const fail = async message => {
    await stopChild(child);
    const error = new Error(`${message} 서버 로그: ${logPath}`);
    error.child = child;
    throw error;
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) return fail(`서버를 실행하지 못했습니다(${spawnError.code ?? spawnError.message}).`);
    if (exited) return fail(`서버가 시작 중에 종료되었습니다(코드 ${exited.code ?? exited.signal}).`);
    if (await findRunningServer(port)) return { child, stop: () => stopChild(child) };
    await new Promise(resolve => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  return fail(`서버가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다.`);
}

/**
 * 이 포트에 보리 서버가 있으면 그것을 쓰고, 없으면 띄운다.
 * stop은 스튜디오가 띄운 서버만 끈다. 바깥 서버(터미널에서 띄운 dev 서버 등)는 그대로 둔다.
 */
async function ensureServer({ port, ...options }) {
  if (await findRunningServer(port)) return { external: true, stop: async () => {} };
  const started = await startServer({ ...options, env: { ...options.env, BORI_SERVER_PORT: String(port) } });
  return { external: false, child: started.child, stop: started.stop };
}

module.exports = { DEFAULT_SERVER_PORT, SERVER_ARGS, LOG_NAME, PREVIOUS_LOG_NAME, resolveServerPort, findRunningServer, prepareServerLog, startServer, ensureServer };
