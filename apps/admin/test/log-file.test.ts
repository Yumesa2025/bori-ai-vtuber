/**
 * 관리자 렌더러 로그 회전 단위 검사.
 * 실행할 때마다 지난 로그를 previous로 넘기고, 남는 로그가 두 개를 넘지 않는지 본다.
 * 파일은 임시 디렉터리에 만든다. Electron은 띄우지 않는다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { prepareRendererLog, LOG_NAME, PREVIOUS_LOG_NAME } = require("../electron/log-file.cjs") as {
  prepareRendererLog: (dataDir: string) => string;
  LOG_NAME: string;
  PREVIOUS_LOG_NAME: string;
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bori-admin-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("렌더러 로그", () => {
  test("처음 실행이면 previous 없이 새 로그 경로를 돌려준다", () => {
    const logPath = prepareRendererLog(join(dir, "data"));
    assert.equal(logPath, join(dir, "data", LOG_NAME));
    assert.equal(existsSync(join(dir, "data", PREVIOUS_LOG_NAME)), false);
  });

  test("실행할 때마다 지난 로그를 previous로 넘기고 그 전 것은 버린다", () => {
    appendFileSync(prepareRendererLog(dir), "첫 실행\n");
    appendFileSync(prepareRendererLog(dir), "둘째 실행\n");
    const logPath = prepareRendererLog(dir);
    appendFileSync(logPath, "셋째 실행\n");

    assert.deepEqual(readdirSync(dir).sort(), [LOG_NAME, PREVIOUS_LOG_NAME].sort());
    assert.equal(readFileSync(logPath, "utf8"), "셋째 실행\n");
    assert.equal(readFileSync(join(dir, PREVIOUS_LOG_NAME), "utf8"), "둘째 실행\n");
  });
});
