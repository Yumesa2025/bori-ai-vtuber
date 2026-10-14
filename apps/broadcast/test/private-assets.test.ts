/**
 * 비공개 자산이 없을 때의 빌드 안내 단위 검사(점검 Q-1).
 * 예전에는 번들을 다 만든 뒤 `ENOENT realpath` 스택으로 끝나 무엇을 놓아야 하는지 알 수 없었다.
 * 임시 폴더를 저장소 루트처럼 써서 실제 자산 폴더는 건드리지 않는다.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingAssetsMessage, missingPrivateFolders, privateAssets } from "../../../tools/vite/private-assets";

const sdk = "private-assets/cubism-sdk/CubismSdkForWeb-5-r.5";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bori-private-assets-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const relativeNames = (paths: string[]) => paths.map(path => path.slice(root.length + 1).split("\\").join("/")).sort();

describe("비공개 자산 확인", () => {
  test("아무것도 없으면 모델 폴더와 SDK 폴더만 적는다(하위 폴더는 줄인다)", () => {
    assert.deepEqual(relativeNames(missingPrivateFolders(root)), ["maolili", sdk]);
  });

  test("SDK가 일부만 있으면 빠진 하위 폴더를 적는다", () => {
    mkdirSync(join(root, "maolili"));
    mkdirSync(join(root, sdk, "Core"), { recursive: true });
    assert.deepEqual(relativeNames(missingPrivateFolders(root)), [`${sdk}/Framework/Shaders/WebGL`, `${sdk}/Framework/src`, `${sdk}/Samples/TypeScript/Demo/src`]);
  });

  test("다 있으면 빈 목록이다", () => {
    for (const folder of ["maolili", `${sdk}/Core`, `${sdk}/Framework/src`, `${sdk}/Framework/Shaders/WebGL`, `${sdk}/Samples/TypeScript/Demo/src`]) {
      mkdirSync(join(root, folder), { recursive: true });
    }
    assert.deepEqual(missingPrivateFolders(root), []);
  });

  test("안내는 없는 폴더와 README 위치, 자산 없이 되는 빌드를 알려 준다", () => {
    const message = missingAssetsMessage(root, missingPrivateFolders(root));
    assert.match(message, /- maolili/);
    assert.match(message, /실행 전 반드시 알아둘 것/);
    assert.match(message, /build:admin/);
    assert.doesNotMatch(message, /ENOENT/);
  });
});

describe("빌드 플러그인", () => {
  test("빌드할 때 자산이 없으면 번들 전에 스택 없는 안내로 멈춘다", () => {
    const plugin = privateAssets({ projectRoot: root, outDir: join(root, "dist") });
    plugin.configResolved({ command: "build" });
    assert.throws(() => plugin.buildStart(), (error: Error) => error.message.includes("비공개 자산이 없어") && error.stack === "");
  });

  test("dev 서버에서는 멈추지 않는다(없는 파일은 요청마다 404)", () => {
    const plugin = privateAssets({ projectRoot: root, outDir: join(root, "dist") });
    plugin.configResolved({ command: "serve" });
    assert.doesNotThrow(() => plugin.buildStart());
  });

  test("자산이 없으면 closeBundle이 ENOENT로 안내를 덮지 않는다", async () => {
    const plugin = privateAssets({ projectRoot: root, outDir: join(root, "dist") });
    await assert.doesNotReject(plugin.closeBundle());
  });
});
