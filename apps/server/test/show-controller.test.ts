/**
 * 방송 진행기(상태 머신) 단위 검사.
 * 단계 순서·되돌리기·처음으로, 단계에 들어갈 때 OBS 장면과 보리 대사, 대사 실패 때 고정 문장,
 * 빠른 두 번 누르기 잠금, TOP 5 차례 공개를 가짜 OBS·가짜 발화로 본다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ErCharacterStat, ErMetaBasis, ObsSceneName } from "@bori/shared";
import { createShowController, type ShowControllerDeps } from "../src/show/controller.js";
import { stageConfig } from "../src/show/stages.js";

const basis: ErMetaBasis = { seasonName: "시즌 9", sampleGames: 7200, collectedAt: "2026-10-15T00:00:00.000Z", description: "최근 상위 랭커 7,200판 기준" };
const stat = (name: string, picks: number): ErCharacterStat => ({ code: picks, name, picks, pickRate: picks / 1000, avgRank: 3.4, top1Rate: 0.12, mainWeapon: "쌍검" });
const top = [stat("재키", 81), stat("아야", 70), stat("현우", 60), stat("유키", 50), stat("피오라", 40), stat("니키", 30)];

type Spoken = { directive: string; gameData: readonly string[] };

function setup(overrides: Partial<ShowControllerDeps> = {}) {
  const scenes: ObsSceneName[] = [];
  const spoken: Spoken[] = [];
  const said: string[] = [];
  const deps: ShowControllerDeps = {
    obs: { async setScene(name) { scenes.push(name); } },
    async speak(directive, gameData) { spoken.push({ directive, gameData }); },
    async say(line) { said.push(line); },
    er: { basis: () => basis, top5: () => top.slice(0, 5) },
    revealIntervalMs: 5,
    ...overrides,
  };
  return { controller: createShowController(deps), scenes, spoken, said };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("단계 이동", () => {
  test("next는 idle부터 ending까지 차례로 가고 ending에서는 그대로다", async () => {
    const { controller, scenes } = setup();
    const visited = [controller.view().stage];
    for (let i = 0; i < 6; i += 1) {
      await controller.next();
      visited.push(controller.view().stage);
    }
    assert.deepEqual(visited, ["idle", "opening", "briefing", "qna", "diagnosis", "ending", "ending"]);
    assert.deepEqual(scenes, ["보리-메인", "보리-메인", "보리-메인", "보리-전적", "보리-엔딩"]);
  });

  test("단계에 들어가면 그 단계의 지시로 말한다", async () => {
    const { controller, spoken } = setup();
    await controller.next();
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].directive, stageConfig.opening.directive);
  });

  test("briefing 대사에는 TOP 5 수치와 기준이 게임 데이터로 들어간다", async () => {
    const { controller, spoken } = setup();
    await controller.next();
    await controller.next();
    const lines = spoken[1].gameData.join("\n");
    assert.match(lines, /1위: 재키/);
    assert.match(lines, /5위: 피오라/);
    assert.doesNotMatch(lines, /니키/);
    assert.match(lines, /기준: 시즌 9 최근 상위 랭커 7,200판/);
  });

  test("prev는 한 단계 뒤로 가고 말하지 않는다", async () => {
    const { controller, spoken, scenes } = setup();
    await controller.next();
    await controller.next();
    await controller.next();
    const spokenBefore = spoken.length;
    await controller.prev();
    assert.equal(controller.view().stage, "briefing");
    assert.equal(spoken.length, spokenBefore);
    assert.equal(scenes.at(-1), "보리-메인");
    assert.equal(controller.view().dashboard.kind, "top5");
  });

  test("idle에서 prev는 그대로다", async () => {
    const { controller, scenes } = setup();
    await controller.prev();
    assert.equal(controller.view().stage, "idle");
    assert.equal(scenes.length, 0);
  });

  test("reset은 idle과 대기 장면으로 돌아가고 말하지 않는다", async () => {
    const { controller, spoken, scenes } = setup();
    await controller.next();
    await controller.next();
    await controller.reset();
    assert.equal(controller.view().stage, "idle");
    assert.equal(controller.view().scene, "보리-대기");
    assert.equal(scenes.at(-1), "보리-대기");
    assert.equal(spoken.length, 2);
  });

  test("단계마다 대시보드가 바뀐다", async () => {
    const { controller } = setup();
    assert.equal(controller.view().dashboard.kind, "season");
    await controller.next();
    await controller.next();
    const briefing = controller.view().dashboard;
    assert.ok(briefing.kind === "top5");
    assert.deepEqual(briefing.items, top.slice(0, 5));
    assert.deepEqual(briefing.basis, basis);
    await controller.next();
    await controller.next();
    assert.deepEqual(controller.view().dashboard, { kind: "player", status: "waiting", report: null });
  });

  test("엔딩 대시보드와 대사에는 이번 방송에서 띄운 캐릭터가 들어간다", async () => {
    const { controller, spoken } = setup();
    await controller.next();
    controller.showCharacter({ kind: "character", query: "재키 어때?", stat: top[0], suggestions: [], basis });
    controller.showCharacter({ kind: "character", query: "재키 또", stat: top[0], suggestions: [], basis });
    controller.showCharacter({ kind: "character", query: "아야는?", stat: top[1], suggestions: [], basis });
    for (let i = 0; i < 4; i += 1) await controller.next();
    assert.deepEqual(controller.view().dashboard, { kind: "summary", characters: ["재키", "아야"] });
    assert.match(spoken.at(-1)!.gameData.join("\n"), /재키, 아야/);
  });

  test("reset하면 띄운 캐릭터 기록도 지운다", async () => {
    const { controller } = setup();
    await controller.next();
    controller.showCharacter({ kind: "character", query: "재키", stat: top[0], suggestions: [], basis });
    await controller.reset();
    for (let i = 0; i < 5; i += 1) await controller.next();
    assert.deepEqual(controller.view().dashboard, { kind: "summary", characters: [] });
  });
});

describe("실패와 잠금", () => {
  test("OBS 장면 전환이 실패해도 단계는 진행하고 말한다", async () => {
    const { controller, spoken } = setup({ obs: { setScene: () => Promise.reject(new Error("OBS 꺼짐")) } });
    await controller.next();
    assert.equal(controller.view().stage, "opening");
    assert.equal(spoken.length, 1);
  });

  test("대사를 못 만들면 단계의 고정 문장을 말한다", async () => {
    const { controller, said } = setup({ speak: () => Promise.reject(new Error("LLM 실패")) });
    await controller.next();
    assert.deepEqual(said, stageConfig.opening.fallbackLines.slice(0, 1));
  });

  test("진행 중에 next를 또 누르면 한 번만 진행한다", async () => {
    let release!: () => void;
    const { controller, spoken } = setup({
      speak: (directive, gameData) => {
        spoken.push({ directive, gameData });
        return new Promise<void>(resolve => { release = resolve; });
      },
    });
    const first = controller.next();
    await sleep(5);
    const second = controller.next();
    await second;
    assert.equal(controller.view().stage, "opening");
    release();
    await first;
    assert.equal(controller.view().stage, "opening");
    assert.equal(spoken.length, 1);
    // 잠금이 풀린 뒤에는 다시 진행한다.
    const third = controller.next();
    await sleep(5);
    assert.equal(controller.view().stage, "briefing");
    release();
    await third;
  });

  test("말하는 중에 reset하면 이전 단계 대사는 지금 것이 아니다", async () => {
    let release!: () => void;
    let current: (() => boolean) | undefined;
    const said: string[] = [];
    const { controller } = setup({
      speak: (_directive, _gameData, isCurrent) => {
        current = isCurrent;
        return new Promise<void>((_, reject) => { release = () => reject(new Error("늦은 실패")); });
      },
      say: async line => { said.push(line); },
    });
    const pending = controller.next();
    await sleep(5);
    assert.equal(current?.(), true);
    await controller.reset();
    assert.equal(current?.(), false);
    release();
    await pending;
    // 지난 단계 대사가 실패해도 고정 문장을 말하지 않는다.
    assert.deepEqual(said, []);
    assert.equal(controller.view().stage, "idle");
  });
});

describe("TOP 5 공개", () => {
  test("briefing 대사가 나간 뒤 revealed가 1부터 5까지 오른다", async () => {
    const { controller } = setup();
    await controller.next();
    await controller.next();
    const revealed = () => (controller.view().dashboard as { revealed: number }).revealed;
    assert.equal(revealed(), 0);
    await sleep(250);
    assert.equal(revealed(), 5);
  });

  test("공개 중에 단계를 옮기면 공개를 멈춘다", async () => {
    const { controller } = setup({ revealIntervalMs: 20 });
    await controller.next();
    await controller.next();
    await controller.next();
    await sleep(80);
    assert.equal(controller.view().dashboard.kind, "season");
  });
});
