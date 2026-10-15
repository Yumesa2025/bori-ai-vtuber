/**
 * 통합 검사 공용 유틸.
 *
 * 실제 보리 서버를 가짜 API에 붙여 띄우고, HTTP로 조작하면서 결과를 확인한다.
 * 단위 테스트가 아니라 방송 한 판을 짧게 돌려 보는 쪽에 가깝다.
 */
import { spawn } from "node:child_process";
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
  const args = loadTypeScript ? ["--import", "tsx", scriptPath] : [scriptPath];
  const lines = [];
  const collect = chunk => { lines.push(String(chunk)); };

  let child;
  function spawnChild() {
    child = spawn(process.execPath, args, {
      cwd: projectRoot,
      // 서버는 루트 .env를 읽는다. 검사가 실제 키·연동 설정을 읽지 않도록 기본으로 끄고, 필요한 시나리오만 env로 켠다.
      // 코너 자동 진행은 끈다. 검사가 단계를 직접 넘기고, 오래 걸리는 검사 중에 코너가 바뀌면 안 된다.
      env: { ...process.env, BORI_ENV_FILE: "", BORI_SHOW_AUTO_ADVANCE: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    track(child);
  }
  spawnChild();

  const handle = {
    get child() { return child; },
    label,
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
  if (label) scripts.set(label, handle);
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
export async function waitForHttp(url, { timeoutMs = 25_000, intervalMs = 150, describe = url } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return Date.now() - startedAt;
    } catch {
      // 아직 안 떴다. 다시 시도한다.
    }
    await sleep(intervalMs);
  }
  throw new Error(`${describe}이(가) ${timeoutMs}ms 안에 뜨지 않았습니다.`);
}

// ── 임시 데이터 디렉터리 ─────────────────────────────────────

/**
 * 고정 자료를 임시 디렉터리로 복사해 돌려준다.
 * 서버가 기억과 설정을 파일에 쓰므로, 검사마다 새 디렉터리를 써야 결과가 반복 가능하다.
 * 실제 data/는 어떤 경우에도 건드리지 않는다.
 */
export async function prepareDataDir(fixtures = ["llm-config.json", "tts-config.json", "macros.json", "memories.json"]) {
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
  const call = async path => (await fetch(`${baseUrl}${path}`)).json();

  return {
    baseUrl,
    calls: () => call("/__calls"),
    reset: () => call("/__reset"),
    fail: on => call(`/__fail?on=${on ? 1 : 0}`),
    setTiming: ({ llm, tts, embed }) => call(`/__timing?llm=${llm}&tts=${tts}&embed=${embed}`),
    /** 지정 횟수만큼 실패를 주입한다. mode는 500·delay·badjson, match가 있으면 그 문자열이 든 요청만. */
    inject: ({ target, mode, count = 1, ms = 0, match = "" }) => call(`/__inject?target=${target}&mode=${mode}&count=${count}&ms=${ms}&match=${encodeURIComponent(match)}`),
    clearInjections: () => call("/__inject?clear=1"),
    /** 방송 종료 요약 응답을 정한다. 인자 없이 부르면 기본값으로 되돌린다. */
    setBroadcastSummary: summary => call(`/__summary${summary ? `?json=${encodeURIComponent(JSON.stringify(summary))}` : ""}`),
    /** 답변 생성 호출만 고른다. 누적 요약 호출이 섞이므로 그냥 마지막을 보면 안 된다. */
    async answerCalls() {
      const all = await call("/__calls");
      return all.filter(entry => (entry.kind === "llm" || entry.kind === "llm-failed") && entry.user.includes("[답변할 채팅]"));
    },
    async summaryCalls() {
      const all = await call("/__calls");
      return all.filter(entry => entry.kind === "llm" && entry.system.includes("진행 중인 방송의 흐름"));
    },
    /** 1:1 누적 요약 호출. 방송 요약과 지시문이 다르다. */
    async companionSummaryCalls() {
      const all = await call("/__calls");
      return all.filter(entry => entry.kind === "llm" && entry.system.includes("1:1 대화의 흐름"));
    },
    /** 1:1 개인 기억 정리 호출. */
    async digestCalls() {
      const all = await call("/__calls");
      return all.filter(entry => entry.kind === "llm" && entry.system.includes("오래 기억할 내용"));
    },
  };
}

// ── 보리 서버 조작 ───────────────────────────────────────────

export function createBoriClient(baseUrl) {
  const send = async (path, init) => {
    const response = await fetch(`${baseUrl}${path}`, init);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const withJson = (method, path, payload) => send(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const client = {
    baseUrl,
    get: path => send(path),
    state: async () => (await send("/api/state")).body,
    llm: async () => (await send("/api/llm")).body,
    patchSettings: next => withJson("PATCH", "/api/settings", next),
    patchLlm: next => withJson("PATCH", "/api/llm", next),
    /** 닉네임을 주면 서버가 그 시청자의 내부 ID(local:닉네임)로 받는다. 없으면 익명 채팅이다. */
    chat: (content, nickname) => withJson("POST", "/api/chat", { content, ...(nickname ? { nickname } : {}) }),
    memory: async () => (await send("/api/memory")).body,
    startSession: () => send("/api/session/start", { method: "POST" }),
    endSession: () => send("/api/session/end", { method: "POST" }),
    reloadMacros: () => send("/api/macros/reload", { method: "POST" }),

    /** 답변이 화면 상태에 올라올 때까지 기다리고 걸린 시간을 함께 돌려준다. */
    async waitForReply(timeoutMs = 25_000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const state = await client.state();
        if (state?.currentResponse) {
          return { ms: Date.now() - startedAt, response: state.currentResponse, audioId: state.currentAudioId };
        }
        await sleep(25);
      }
      return { ms: -1, response: null, audioId: undefined };
    },

    /** 말풍선이 내려갈 때까지 기다린다. 다음 측정이 이전 답변에 걸리지 않게 한다. */
    async waitForIdle(timeoutMs = 25_000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const state = await client.state();
        if (!state?.currentResponse) return true;
        await sleep(40);
      }
      return false;
    },

    /** 채팅 한 건을 보내고 답변이 나온 뒤 말풍선이 내려갈 때까지 기다린다. */
    async askAndSettle(content) {
      await client.chat(content);
      const result = await client.waitForReply();
      await client.waitForIdle();
      return result;
    },
  };

  return client;
}

/** 검사에서 공통으로 쓰는 큐 설정. 시나리오가 필요한 값만 덮어쓴다. */
export const baseQueueSettings = {
  responseDelayMinSeconds: 1,
  responseDelayMaxSeconds: 1,
  maxQueueSize: 100,
  visibleChatLimit: 8,
  duplicateWindowMinutes: 1,
  sameReplyCooldownMinutes: 0,
  monologueEnabled: false,
  monologueMinSeconds: 30,
  monologueMaxSeconds: 60,
};
