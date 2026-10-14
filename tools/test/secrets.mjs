/**
 * API 키 저장 검사.
 *
 * 환경변수로 넣은 키는 메모리에서만 쓰고 data/에 쓰지 않는지, 화면에서 넣은 키만 암호화해 저장하는지 본다.
 * 실행기가 띄운 서버에는 ElevenLabs 환경변수가 없으므로, 이 시나리오는 그 서버를 내리고 필요한 환경변수로 직접 띄운다.
 * 포트와 데이터 디렉터리는 실행기가 준 것을 그대로 쓴다.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningScript, startScript, waitForHttp } from "./harness.mjs";

export const meta = {
  name: "API 키 저장",
  timing: { llm: 300, tts: 200, embed: 100 },
};

const ENV_OPENAI_KEY = "env-openai-key-should-not-be-saved";
const ENV_ELEVENLABS_KEY = "env-elevenlabs-key-should-not-be-saved";
const SCREEN_OPENAI_KEY = "screen-openai-key-entered-in-admin";
const PLAIN_ELEVENLABS_KEY = "plain-elevenlabs-key-from-old-version";
const DOTENV_OPENAI_KEY = "dotenv-openai-key-should-not-be-saved";

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function patch(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

export async function run({ bori, mock, report, dataDir }) {
  const llmPath = join(dataDir, "llm-config.json");
  const ttsPath = join(dataDir, "tts-config.json");
  const raw = async path => (await readFile(path, "utf8").catch(() => ""));

  await runningScript("bori-server")?.stop();
  const server = startScript("apps/server/src/index.ts", {
    loadTypeScript: true,
    label: "bori-server-secrets",
    env: {
      BORI_SERVER_PORT: new URL(bori.baseUrl).port,
      BORI_DATA_DIR: dataDir,
      BORI_OPENAI_BASE_URL: `${mock.baseUrl}/v1`,
      OPENAI_API_KEY: ENV_OPENAI_KEY,
      ELEVENLABS_API_KEY: ENV_ELEVENLABS_KEY,
    },
  });
  const ready = () => waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버" });

  try {
    await ready();

    // ── 환경변수 키만 있을 때 ─────────────────────────────────
    {
      const before = await bori.llm();
      const changed = await patch(bori.baseUrl, "/api/llm", { maxReplyLength: 100 });
      const saved = await readJson(llmPath);
      const text = await raw(llmPath);
      report.check("환경변수 키로 동작한다", before.status.hasApiKey === true);
      report.check(
        "환경변수 키로 동작 중에 LLM 설정만 바꾸면 키를 파일에 쓰지 않는다",
        changed.status === 200 && saved?.settings?.maxReplyLength === 100 && saved.apiKey === undefined && !text.includes(ENV_OPENAI_KEY),
        `status=${changed.status} apiKey=${saved?.apiKey === undefined ? "없음" : "있음"}`,
      );
    }
    {
      const changed = await patch(bori.baseUrl, "/api/tts", { speed: 1.1 });
      const saved = await readJson(ttsPath);
      const text = await raw(ttsPath);
      report.check(
        "환경변수 키로 동작 중에 음성 설정만 바꾸면 ElevenLabs 키를 파일에 쓰지 않는다",
        changed.status === 200 && saved?.speed === 1.1 && saved.elevenLabsApiKey === undefined && !text.includes(ENV_ELEVENLABS_KEY),
        `status=${changed.status} elevenLabsApiKey=${saved?.elevenLabsApiKey === undefined ? "없음" : "있음"}`,
      );
      report.check("음성 설정 응답은 환경변수 키가 있다고 알린다", changed.body?.hasElevenLabsKey === true);
    }

    // ── 화면에서 넣은 키 ─────────────────────────────────────
    {
      const changed = await patch(bori.baseUrl, "/api/llm", { apiKey: SCREEN_OPENAI_KEY });
      const saved = await readJson(llmPath);
      const text = await raw(llmPath);
      report.check(
        "화면에서 넣은 키는 암호화해 저장한다",
        changed.status === 200 && typeof saved?.apiKey === "string" && saved.apiKey.startsWith("enc.v1:") && !text.includes(SCREEN_OPENAI_KEY) && !text.includes(ENV_OPENAI_KEY),
      );

      await server.restart();
      await ready();
      const afterRestart = await readJson(llmPath);
      const status = await bori.llm();
      report.check("재시작 뒤에도 저장된 키가 남고 그대로 쓴다", afterRestart?.apiKey === saved?.apiKey && status.status.hasApiKey === true);
    }
    {
      // 저장한 키를 지우면 환경변수 키로 돌아간다. 재시작했을 때와 같은 결과다.
      const cleared = await patch(bori.baseUrl, "/api/llm", { apiKey: "" });
      const saved = await readJson(llmPath);
      report.check(
        "화면에서 키를 지우면 파일에서 빠지고 환경변수 키로 돌아간다",
        cleared.status === 200 && saved?.apiKey === undefined && cleared.body?.status?.hasApiKey === true,
        `apiKey=${saved?.apiKey === undefined ? "없음" : "있음"} hasApiKey=${cleared.body?.status?.hasApiKey}`,
      );
    }

    // ── 이전 버전이 남긴 평문 키 ─────────────────────────────
    {
      await server.stop();
      const current = (await readJson(ttsPath)) ?? {};
      await writeFile(ttsPath, JSON.stringify({ ...current, elevenLabsApiKey: PLAIN_ELEVENLABS_KEY }, null, 2), "utf8");
      await server.restart();
      await ready();
      const saved = await readJson(ttsPath);
      const text = await raw(ttsPath);
      report.check(
        "평문으로 저장돼 있던 ElevenLabs 키는 시작할 때 암호문으로 바꾼다",
        typeof saved?.elevenLabsApiKey === "string" && saved.elevenLabsApiKey.startsWith("enc.v1:") && !text.includes(PLAIN_ELEVENLABS_KEY),
      );
    }
  } catch (error) {
    const output = server.output();
    if (output.trim()) console.log(`\n[서버 출력]\n${output}`);
    throw error;
  } finally {
    await server.stop();
  }

  await checkEnvFile({ bori, mock, report });
}

/** 폴더 안 모든 파일의 내용을 이어 붙인다. 키가 어느 파일에도 없는지 볼 때 쓴다. */
async function readAllFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(entries.filter(entry => entry.isFile()).map(entry => readFile(join(entry.parentPath, entry.name), "utf8")));
  return texts.join("\n");
}

/**
 * 루트 .env 읽기(load-env.ts). 실제 루트 .env 대신 BORI_ENV_FILE로 임시 파일을 가리킨다.
 * 이 서버에는 OPENAI_API_KEY 환경변수를 주지 않아서, 키가 있다면 .env에서 온 것이다.
 */
async function checkEnvFile({ bori, mock, report }) {
  const dir = await mkdtemp(join(tmpdir(), "bori-envfile-"));
  const envPath = join(dir, ".env");
  const dataDir = join(dir, "data");
  const server = startScript("apps/server/src/index.ts", {
    loadTypeScript: true,
    label: "bori-server-envfile",
    env: {
      BORI_SERVER_PORT: new URL(bori.baseUrl).port,
      BORI_DATA_DIR: dataDir,
      BORI_OPENAI_BASE_URL: `${mock.baseUrl}/v1`,
      BORI_ENV_FILE: envPath,
      // undefined면 자식 프로세스 환경에서 빠진다. 실행한 셸에 키가 있어도 섞이지 않는다.
      OPENAI_API_KEY: undefined,
      ELEVENLABS_API_KEY: undefined,
    },
  });
  const ready = () => waitForHttp(`${bori.baseUrl}/api/health`, { describe: "보리 서버(.env)" });

  try {
    await ready();
    const missing = await bori.llm();
    report.check(".env 파일이 없으면 조용히 넘어가고 키 없이 뜬다", missing.status.hasApiKey === false);

    // .env에 엉뚱한 포트도 넣는다. 서버가 원래 포트로 뜨면 이미 설정된 환경변수가 이긴 것이다.
    await server.stop();
    await writeFile(envPath, `OPENAI_API_KEY=${DOTENV_OPENAI_KEY}\nBORI_SERVER_PORT=1\n`, "utf8");
    await server.restart();
    await ready();
    const loaded = await bori.llm();
    report.check(".env의 키를 읽고, 이미 설정된 환경변수(포트)는 .env가 덮지 않는다", loaded.status.hasApiKey === true);

    const changed = await patch(bori.baseUrl, "/api/llm", { maxReplyLength: 90 });
    const stored = await readAllFiles(dataDir);
    report.check(
      ".env에서 읽은 키도 설정을 바꿀 때 data/에 쓰지 않는다",
      changed.status === 200 && stored.includes('"maxReplyLength": 90') && !stored.includes(DOTENV_OPENAI_KEY),
      `status=${changed.status}`,
    );
  } catch (error) {
    const output = server.output();
    if (output.trim()) console.log(`\n[서버 출력]\n${output}`);
    throw error;
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
