/**
 * 서버가 내주는 빌드 화면 경로 표 검사.
 * 방송 화면(apps/broadcast)을 지운 뒤에도 Live2D 비공개 자산이 대시보드 빌드에서 나오는지 본다(위험 R1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { staticRoutesFor } from "../src/http/static-routes.js";

const root = resolve(tmpdir(), "bori-static-routes-root");
const routes = staticRoutesFor(root);
const companionDist = resolve(root, "apps/companion/dist");

test("Live2D 비공개 자산(/private-*)은 대시보드 빌드에서 접두사를 남긴 채 내준다", () => {
  for (const prefix of ["/private-model/", "/private-core/", "/private-framework/"]) {
    const route = routes.find(entry => entry.prefix === prefix);
    assert.ok(route, prefix);
    assert.equal(route.root, companionDist, prefix);
    assert.equal(route.build, "npm run build:companion", prefix);
    assert.ok(!route.stripPrefix, prefix);
  }
});

test("대시보드와 스튜디오 화면을 내주고 방송 화면(/obs/)은 없다", () => {
  assert.deepEqual(routes.map(entry => entry.prefix).sort(), ["/companion/", "/private-core/", "/private-framework/", "/private-model/", "/studio/"]);
  assert.deepEqual(routes.find(entry => entry.prefix === "/companion/"), { prefix: "/companion/", root: companionDist, build: "npm run build:companion", stripPrefix: true });
  assert.deepEqual(routes.find(entry => entry.prefix === "/studio/"), { prefix: "/studio/", root: resolve(root, "apps/admin/dist"), build: "npm run build:admin", stripPrefix: true });
});
