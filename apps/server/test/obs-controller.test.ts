/**
 * OBS 제어기 단위 검사.
 * 연결·인증, 장면 바꾸기, 틀린 비밀번호, 없는 장면, 끊긴 뒤 재연결, stop 뒤 재연결하지 않는지를 본다.
 * 실제 OBS 대신 가짜 OBS WebSocket v5 서버(포트 4842)와 실제 obs-websocket-js를 쓴다.
 */
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createObsController, type ObsController } from "../src/obs/controller.js";
import { sleep, waitFor } from "./chzzk-fake.js";

const PORT = 4842;
const url = `ws://127.0.0.1:${PORT}`;
const PASSWORD = "fake-obs-password";

type FakeObs = {
  requests: Array<{ requestType: string; sceneName?: string }>;
  currentScene(): string;
  authFailures(): number;
  connectedSockets(): number;
  removeScene(name: string): void;
  dropSockets(): void;
  close(): Promise<void>;
};
const fakeModuleUrl = new URL("../../../tools/test/fixtures/fake-obs.mjs", import.meta.url).href;
const { startFakeObs } = (await import(fakeModuleUrl)) as { startFakeObs(options: { port: number; password?: string; scenes?: string[] }): Promise<FakeObs> };

let fake: FakeObs;
let controller: ObsController | undefined;

before(async () => {
  fake = await startFakeObs({ port: PORT, password: PASSWORD });
});

after(async () => {
  await fake.close();
});

afterEach(async () => {
  await controller?.stop();
  controller = undefined;
});

const open = (password = PASSWORD) => {
  controller = createObsController({ url, password, reconnectDelayMs: 50 });
  controller.connect();
  return controller;
};

describe("OBS 제어기", () => {
  test("연결하면 connected이고 지금 장면을 안다", async () => {
    const obs = open();
    await waitFor(() => obs.status().state === "connected", "연결");
    assert.equal(obs.status().currentScene, fake.currentScene());
    assert.equal(obs.status().lastError, null);
  });

  test("setScene은 OBS 장면을 바꾼다", async () => {
    const obs = open();
    await waitFor(() => obs.status().state === "connected", "연결");
    await obs.setScene("보리-메인");
    assert.equal(fake.currentScene(), "보리-메인");
    assert.equal(obs.status().currentScene, "보리-메인");
  });

  test("비밀번호가 틀리면 error와 메시지를 남기고 다시 시도하지 않는다", async () => {
    const failuresBefore = fake.authFailures();
    const obs = open("틀린-비밀번호");
    await waitFor(() => obs.status().state === "error", "인증 실패");
    assert.match(obs.status().lastError ?? "", /비밀번호/);
    await sleep(300);
    assert.equal(fake.authFailures() - failuresBefore, 1);
    assert.equal(obs.status().state, "error");
  });

  test("없는 장면이면 오류를 기록하고 throw하지 않는다", async () => {
    fake.removeScene("보리-엔딩");
    const obs = open();
    await waitFor(() => obs.status().state === "connected", "연결");
    await obs.setScene("보리-엔딩");
    assert.equal(obs.status().state, "connected");
    assert.match(obs.status().lastError ?? "", /보리-엔딩/);
    // 다음 전환이 성공하면 오류를 지운다.
    await obs.setScene("보리-대기");
    assert.equal(obs.status().lastError, null);
  });

  test("연결되지 않았을 때 setScene은 throw하지 않는다", async () => {
    const obs = createObsController({ url, password: PASSWORD, reconnectDelayMs: 50 });
    controller = obs;
    await obs.setScene("보리-메인");
    assert.equal(obs.status().state, "off");
  });

  test("끊기면 정한 간격 뒤 다시 연결한다", async () => {
    const obs = open();
    await waitFor(() => obs.status().state === "connected", "연결");
    fake.dropSockets();
    await waitFor(() => obs.status().state !== "connected", "끊김 감지");
    await waitFor(() => obs.status().state === "connected", "재연결");
    await obs.setScene("보리-전적");
    assert.equal(fake.currentScene(), "보리-전적");
  });

  test("stop 뒤에는 다시 연결하지 않는다", async () => {
    const obs = open();
    await waitFor(() => obs.status().state === "connected", "연결");
    await obs.stop();
    assert.equal(obs.status().state, "off");
    await sleep(200);
    assert.equal(fake.connectedSockets(), 0);
  });

  test("OBS가 꺼져 있다 켜지면 연결한다", async () => {
    await fake.close();
    const obs = open();
    await waitFor(() => obs.status().state === "error", "연결 실패");
    assert.match(obs.status().lastError ?? "", /연결/);
    fake = await startFakeObs({ port: PORT, password: PASSWORD });
    await waitFor(() => obs.status().state === "connected", "켜진 뒤 연결");
  });
});
