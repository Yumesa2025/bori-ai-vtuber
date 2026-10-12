/**
 * 비공개 자산 Vite 설정(tools/vite/private-assets.ts) 단위 검사.
 * dev 미들웨어가 비공개 폴더 밖(형제 폴더 포함)과 include 밖 파일을 내주지 않는지,
 * 빌드 복사 결과는 그대로인지 본다. 실제 구매 모델·SDK 대신 임시 디렉터리에 가짜 파일을 만든다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { privateAssets } from "../../../tools/vite/private-assets";

const SDK = "private-assets/cubism-sdk/CubismSdkForWeb-5-r.5";

let root: string;

function put(path: string, content = "x") {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bori-private-assets-"));
  put("maolili/maolili.model3.json", "model");
  put("maolili/textures/texture_00.png", "png");
  // 이름이 maolili로 시작하는 형제 폴더. 접두사 비교로는 빠져나갈 수 있었다.
  put("maolili-x/secret.json", "secret");
  put(`${SDK}/Core/live2dcubismcore.js`, "core");
  put(`${SDK}/Core/LICENSE.md`, "license");
  put(`${SDK}/Core/live2dcubismcore.js.map`, "map");
  put(`${SDK}/Core/README.md`, "readme");
  put(`${SDK}/CoreExtra/secret.js`, "secret");
  put(`${SDK}/Framework/Shaders/WebGL/vertshadersrc.vert`, "vert");
  put(`${SDK}/Framework/Shaders/WebGLx/secret.vert`, "secret");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Handler = (request: { url: string }, response: FakeResponse, next: () => void) => void | Promise<void>;
type FakeResponse = { statusCode: number; headers: Record<string, string>; body: string; setHeader(name: string, value: string): void; end(data?: Buffer): void };

/** dev 서버에 붙는 미들웨어를 꺼낸다. */
function middleware(): Handler {
  let handler: Handler | undefined;
  privateAssets({ projectRoot: root, outDir: join(root, "dist") }).configureServer({ middlewares: { use: fn => { handler = fn as Handler; } } });
  if (!handler) throw new Error("미들웨어가 등록되지 않았습니다.");
  return handler;
}

/** 요청 하나를 보내고 상태 코드와 본문을 돌려준다. 미들웨어가 넘기면 status는 "next"다. */
async function get(url: string): Promise<{ status: number | "next"; body: string }> {
  const handler = middleware();
  let passed = false;
  const response: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(data) { this.body = data ? data.toString("utf8") : ""; },
  };
  await handler({ url }, response, () => { passed = true; });
  return passed ? { status: "next", body: "" } : { status: response.statusCode, body: response.body };
}

describe("dev 미들웨어 경로 검사", () => {
  test("비공개 폴더 안의 파일은 내준다", async () => {
    assert.deepEqual(await get("/private-model/maolili/maolili.model3.json"), { status: 200, body: "model" });
    assert.deepEqual(await get("/private-model/maolili/textures/texture_00.png?v=1"), { status: 200, body: "png" });
    assert.deepEqual(await get("/private-framework/Shaders/WebGL/vertshadersrc.vert"), { status: 200, body: "vert" });
  });

  test("맡지 않는 URL은 다음 미들웨어로 넘긴다", async () => {
    assert.equal((await get("/src/main.tsx")).status, "next");
  });

  test("이름이 같은 접두사로 시작하는 형제 폴더로 빠져나가지 못한다", async () => {
    for (const url of [
      "/private-model/maolili/../maolili-x/secret.json",
      "/private-core/../CoreExtra/secret.js",
      "/private-framework/Shaders/WebGL/../WebGLx/secret.vert",
    ]) {
      const result = await get(url);
      assert.equal(result.status, 403, url);
      assert.notEqual(result.body, "secret", url);
    }
  });

  test("상위 폴더로 빠져나가지 못한다", async () => {
    assert.equal((await get("/private-model/maolili/../../package.json")).status, 403);
    assert.equal((await get("/private-model/maolili/..")).status, 403);
  });

  test("dev에서도 Core는 include 목록(스크립트·라이선스)만 내준다", async () => {
    assert.deepEqual(await get("/private-core/live2dcubismcore.js"), { status: 200, body: "core" });
    assert.deepEqual(await get("/private-core/LICENSE.md"), { status: 200, body: "license" });
    assert.equal((await get("/private-core/live2dcubismcore.js.map")).status, 403);
    assert.equal((await get("/private-core/README.md")).status, 403);
  });

  test("없는 파일은 404다", async () => {
    assert.equal((await get("/private-model/maolili/missing.json")).status, 404);
  });
});

describe("빌드 복사", () => {
  test("모델·셰이더 폴더는 통째로, Core는 include만 복사한다", async () => {
    const outDir = join(root, "dist");
    await privateAssets({ projectRoot: root, outDir }).closeBundle();
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [relative(outDir, join(dir, entry.name)).split("\\").join("/")]);
    assert.deepEqual(files(outDir).sort(), [
      "private-core/LICENSE.md",
      "private-core/live2dcubismcore.js",
      "private-framework/Shaders/WebGL/vertshadersrc.vert",
      "private-model/maolili/maolili.model3.json",
      "private-model/maolili/textures/texture_00.png",
    ]);
  });
});
