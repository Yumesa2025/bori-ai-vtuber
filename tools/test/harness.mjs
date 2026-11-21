/**
 * 통합 검사 공용 유틸.
 *
 * 실제 보리 서버를 가짜 API에 붙여 띄우고, HTTP로 조작하면서 결과를 확인한다.
 * 단위 테스트가 아니라 서버 하나를 실제로 띄워 라우트를 두드려 보는 쪽에 가깝다.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const toolsTestDir = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(toolsTestDir, "../..");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── 결과 보고 ────────────────────────────────────────────────

export function createReporter() {
  const results = [];

  return {
    results,
    check(name, pass, detail = "") {
      results.push({ name, pass });
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
      return pass;
    },
    note(text) {
      console.log(`        · ${text}`);
    },
    failed: () => results.filter(entry => !entry.pass),
  };
}

// ── 프로세스 ─────────────────────────────────────────────────

/** 살아 있는 자식 프로세스. 검사가 중간에 죽어도 정리되도록 모아 둔다. */
const children = new Set();

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

/** label을 붙여 띄운 스크립트. 시나리오가 서버를 다시 띄워야 할 때 찾는다. */
const scripts = new Map();

/**
 * 스크립트를 새 Node 프로세스로 띄운다.
 * TypeScript는 tsx 로더로 읽는다. npx를 거치지 않으므로 자식이 하나만 생기고 종료가 확실하다.
 */
export function startScript(scriptPath, { env = {}, label = "", loadTypeScript = false } = {}) {
  if (env.BORI_SERVER_PORT) env = { ...env, BORI_TEST_INSTANCE_ID: randomUUID() };
  let spawnError = null;
  const args = loadTypeScript ? ["--import", "tsx", scriptPath] : [scriptPath];
  const lines = [];
  const collect = chunk => { lines.push(String(chunk)); };

  let child;
  function spawnChild() {
    child = spawn(process.execPath, args, {
      cwd: projectRoot,
      // 서버는 루트 .env를 읽는다. 검사가 실제 키·연동 설정을 읽지 않도록 기본으로 끄고, 필요한 시나리오만 env로 켠다.
      env: { ...process.env, BORI_ENV_FILE: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawnError = null;
    child.once("error", error => { spawnError = error; });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    track(child);
  }
  spawnChild();

  const handle = {
    get child() { return child; },
    label,
    env,
    get error() { return spawnError; },
    output: () => lines.join(""),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const current = child;
      current.kill();
      // 종료를 기다린다. 안 끝나면 강제로 끊는다.
      await Promise.race([
        new Promise(resolve => current.once("exit", resolve)),
        sleep(3000).then(() => current.kill("SIGKILL")),
      ]);
    },
    /** 같은 인자와 환경으로 다시 띄운다. 재시작 뒤에도 파일에 남은 상태를 확인할 때 쓴다. */
    async restart() {
      await handle.stop();
      spawnChild();
    },
  };
  if (label) {
    scripts.delete(label);
    scripts.set(label, handle);
  }
  return handle;
}

/** label로 띄운 스크립트를 찾는다. 같은 label이 여럿이면 마지막에 띄운 것이다. */
export const runningScript = label => scripts.get(label);

/** 프로세스가 남지 않도록 마지막에 반드시 부른다. */
export async function stopAll() {
  await Promise.all([...children].map(async child => {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      sleep(2000).then(() => child.kill("SIGKILL")),
    ]);
  }));
}

process.on("exit", () => { for (const child of children) child.kill(); });

/** 서버가 응답할 때까지 기다린다. 정해진 시간 안에 못 뜨면 실패로 본다. */
export async function availablePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return selected;
}

export async function waitForHttp(url, { timeoutMs = 25_000, intervalMs = 150, describe = url, instanceId, server } = {}) {
  // 재시작 시나리오에도 소유권 검사를 적용한다.
  if (!server && new URL(url).pathname === "/api/health") {
    server = [...scripts.values()].reverse().find(candidate => candidate.env.BORI_SERVER_PORT === new URL(url).port);
  }
  instanceId ??= server?.env.BORI_TEST_INSTANCE_ID;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (server && (server.error || server.child.exitCode !== null || server.child.signalCode !== null)) throw new Error(`${describe} 자식 서버 종료 또는 실행 실패`);
    let response, text;
    const stopped = new AbortController();
    const abort = () => stopped.abort();
    const child = server?.child;
    child?.once("exit", abort);
    child?.once("error", abort);
    try {
      response = await fetch(url, { signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
      text = await response.text();
    } catch {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      continue;
    } finally {
      child?.removeListener("exit", abort);
      child?.removeListener("error", abort);
    }
    if (response.ok) {
      if (instanceId && JSON.parse(text).instanceId !== instanceId) throw new Error(`${describe} instance 소유권 불일치`);
      if (server && (server.error || server.child.exitCode !== null || server.child.signalCode !== null)) throw new Error(`${describe} 자식 서버 종료`);
      return Date.now() - startedAt;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${describe}이(가) ${timeoutMs}ms 안에 뜨지 않았습니다.`);
}

// ── 임시 데이터 디렉터리 ─────────────────────────────────────

/**
 * 고정 자료를 임시 디렉터리로 복사해 돌려준다.
 * 서버가 설정과 사용량을 파일에 쓰므로, 검사마다 새 디렉터리를 써야 결과가 반복 가능하다.
 * 실제 data/는 어떤 경우에도 건드리지 않는다.
 */
export async function prepareDataDir(fixtures = ["llm-config.json", "tts-config.json"]) {
  const dir = await mkdtemp(join(tmpdir(), "bori-test-"));
  for (const name of fixtures) {
    await cp(join(toolsTestDir, "fixtures", name), join(dir, name));
  }
  return {
    path: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ── 가짜 API 조작 ────────────────────────────────────────────

export function createMockClient(baseUrl) {
  const call = async path => (await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(25_000) })).json();

  return {
    baseUrl,
    calls: () => call("/__calls"),
    reset: () => call("/__reset"),
    fail: on => call(`/__fail?on=${on ? 1 : 0}`),
    setTiming: ({ llm, tts, embed }) => call(`/__timing?llm=${llm}&tts=${tts}&embed=${embed}`),
    /** 지정 횟수만큼 실패를 주입한다. mode는 500·delay·badjson, match가 있으면 그 문자열이 든 요청만. */
    inject: ({ target, mode, count = 1, ms = 0, match = "" }) => call(`/__inject?target=${target}&mode=${mode}&count=${count}&ms=${ms}&match=${encodeURIComponent(match)}`),
    clearInjections: () => call("/__inject?clear=1"),
    /** LLM 호출만 고른다. */
    async llmCalls() {
      const all = await call("/__calls");
      return all.filter(entry => entry.kind === "llm" || entry.kind === "llm-failed");
    },
  };
}

// ── 보리 서버 조작 ───────────────────────────────────────────

export function createBoriClient(baseUrl) {
  const send = async (path, init, { timeoutMs = 25_000 } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    return { status: response.status, body: await response.json().catch(error => {
      if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
      return null;
    }) };
  };
  const withJson = (method, path, payload) => send(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return {
    baseUrl,
    get: path => send(path),
    llm: async () => (await send("/api/llm")).body,
    patchLlm: next => withJson("PATCH", "/api/llm", next),
    tts: async () => (await send("/api/tts")).body,
    dashboard: async options => (await send("/api/dashboard", undefined, options)).body,
    /** PUT /api/dashboard/settings. 전적 조회가 끝나야 답한다. */
    putSettings: payload => withJson("PUT", "/api/dashboard/settings", payload),
    post: path => send(path, { method: "POST" }),
  };
}
