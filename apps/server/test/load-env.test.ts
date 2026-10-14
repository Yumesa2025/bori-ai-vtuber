/**
 * 루트 .env 읽기 단위 검사(점검 Q-5).
 * 모듈을 불러오는 순간 루트 .env를 읽으므로, BORI_ENV_FILE을 비워 실제 파일을 읽지 않게 한 뒤 동적으로 불러온다.
 * 키가 data/에 저장되지 않는지는 통합 검사(tools/test/secrets.mjs)가 실제 서버로 본다.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BORI_ENV_FILE = "";
const { loadEnvFileIfPresent } = await import("../src/load-env.js");

const dir = mkdtempSync(join(tmpdir(), "bori-load-env-"));
const names = ["BORI_TEST_ENV_A", "BORI_TEST_ENV_B", "BORI_TEST_ENV_EMPTY", "BORI_TEST_ENV_PRESET", "BORI_TEST_ENV_PRESET_EMPTY"];

after(() => {
  for (const name of names) delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});

function envFile(text: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(path, text, "utf8");
  return path;
}

describe(".env 읽기", () => {
  test("파일이 없거나 경로가 비어 있으면 아무것도 하지 않는다", () => {
    assert.equal(loadEnvFileIfPresent(join(dir, "없는파일.env")), false);
    assert.equal(loadEnvFileIfPresent(""), false);
  });

  test("값을 읽고 따옴표·주석을 처리한다", () => {
    assert.equal(loadEnvFileIfPresent(envFile("# 주석\nBORI_TEST_ENV_A=하나\nBORI_TEST_ENV_B=\"둘 # 셋\"\n")), true);
    assert.equal(process.env.BORI_TEST_ENV_A, "하나");
    assert.equal(process.env.BORI_TEST_ENV_B, "둘 # 셋");
  });

  test("이미 설정된 환경 변수는 덮지 않는다(빈 값으로 설정돼 있어도)", () => {
    process.env.BORI_TEST_ENV_PRESET = "셸";
    process.env.BORI_TEST_ENV_PRESET_EMPTY = "";
    loadEnvFileIfPresent(envFile("BORI_TEST_ENV_PRESET=파일\nBORI_TEST_ENV_PRESET_EMPTY=파일\n"));
    assert.equal(process.env.BORI_TEST_ENV_PRESET, "셸");
    assert.equal(process.env.BORI_TEST_ENV_PRESET_EMPTY, "");
  });

  test(".env.example을 그대로 복사한 빈 값은 설정하지 않은 것으로 둔다(포트 0·빈 API 주소 방지)", () => {
    loadEnvFileIfPresent(envFile("BORI_TEST_ENV_EMPTY=\n"));
    assert.equal("BORI_TEST_ENV_EMPTY" in process.env, false);
    assert.equal(Number(process.env.BORI_TEST_ENV_EMPTY ?? 4310), 4310);
  });
});
