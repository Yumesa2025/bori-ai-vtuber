/**
 * `!전적` 명령 단위 검사.
 * 전적 진단 단계에서만 조회하고, 닉네임 없음·한 번에 하나·조회 실패·결과 없음·단계 이동·안내 문장 반복 제한을 본다.
 * 보리 대사에 넘기는 줄에는 닉네임(원래 것도 가린 것도)이 들어가지 않는다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardView, ErPlayerReport, ShowStage } from "@bori/shared";
import { createPlayerCommand, PLAYER_DIRECTIVE } from "../src/show/commands.js";

const report: ErPlayerReport = {
  maskedNickname: "보리팬**",
  seasonName: "시즌 9",
  games: 120,
  avgRank: 3.25,
  top1Rate: 0.15,
  recentRanks: [1, 4, 2],
  mainCharacters: [{ name: "재키", games: 40, avgRank: 2.9 }, { name: "아야", games: 20, avgRank: 4.1 }],
};

type Setup = { stage?: ShowStage; lookup?: (nickname: string) => Promise<ErPlayerReport | null>; available?: boolean; speak?: () => Promise<void> };

function setup(options: Setup = {}) {
  let stage: ShowStage = options.stage ?? "diagnosis";
  let epoch = 1;
  let clock = 0;
  const dashboards: DashboardView[] = [];
  const spoken: Array<{ directive: string; gameData: readonly string[] }> = [];
  const said: string[] = [];
  const lookups: string[] = [];
  const command = createPlayerCommand({
    stage: () => stage,
    epoch: () => epoch,
    available: () => options.available ?? true,
    lookup: async nickname => {
      lookups.push(nickname);
      return options.lookup ? options.lookup(nickname) : report;
    },
    setDashboard: (view, at) => { if (at === epoch) dashboards.push(view); },
    speak: async (directive, gameData) => {
      spoken.push({ directive, gameData });
      await options.speak?.();
    },
    say: async line => { said.push(line); },
    now: () => clock,
  });
  return {
    command, dashboards, spoken, said, lookups,
    moveStage(next: ShowStage) { stage = next; epoch += 1; },
    advance(ms: number) { clock += ms; },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("!전적", () => {
  test("명령이 아니면 false이고 아무것도 하지 않는다", () => {
    const { command, said, lookups } = setup();
    assert.equal(command.handle("전적 보여줘"), false);
    assert.equal(command.handle("!전적이 뭐예요?"), false);
    assert.deepEqual(said, []);
    assert.deepEqual(lookups, []);
  });

  test("진단 단계에서 조회해 대시보드를 ready로 바꾸고 전적을 분석해 말한다", async () => {
    const { command, dashboards, spoken, lookups } = setup();
    assert.equal(command.handle("!전적 보리팬클럽"), true);
    await command.idle();
    assert.deepEqual(lookups, ["보리팬클럽"]);
    assert.deepEqual(dashboards.map(view => view.kind === "player" ? view.status : view.kind), ["loading", "ready"]);
    assert.deepEqual(dashboards[1], { kind: "player", status: "ready", report });
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].directive, PLAYER_DIRECTIVE);
    const lines = spoken[0].gameData.join("\n");
    assert.match(lines, /평균 순위: 3\.3위|평균 순위: 3\.2위/);
    assert.match(lines, /1등 비율: 15\.0%/);
    assert.match(lines, /최근 순위\(최신부터\): 1, 4, 2/);
    assert.match(lines, /재키 40판/);
  });

  test("대사 줄에는 원래 닉네임도 가린 닉네임도 없다", async () => {
    const { command, spoken } = setup();
    command.handle("!전적 보리팬클럽");
    await command.idle();
    const lines = spoken[0].gameData.join("\n");
    assert.equal(lines.includes("보리팬"), false);
  });

  test("다른 단계에서는 조회하지 않고 진단 때 봐 준다고 안내한다", async () => {
    const { command, said, lookups } = setup({ stage: "qna" });
    assert.equal(command.handle("!전적 보리팬클럽"), true);
    await flush();
    assert.deepEqual(lookups, []);
    assert.deepEqual(said, ["전적 진단 때 봐 드릴게요!"]);
  });

  test("같은 안내는 잠시 동안 되풀이하지 않는다", async () => {
    const { command, said, advance } = setup({ stage: "qna" });
    command.handle("!전적 가");
    command.handle("!전적 나");
    await flush();
    assert.equal(said.length, 1);
    advance(16_000);
    command.handle("!전적 다");
    await flush();
    assert.equal(said.length, 2);
  });

  test("닉네임이 없으면 같이 적어 달라고 한다", async () => {
    const { command, said, lookups } = setup();
    assert.equal(command.handle("!전적"), true);
    await flush();
    assert.deepEqual(lookups, []);
    assert.match(said[0] ?? "", /닉네임/);
  });

  test("조회 중에 또 오면 하나만 보고 기다려 달라고 한다", async () => {
    let release!: (value: ErPlayerReport) => void;
    let held = false;
    // 첫 조회만 붙잡아 두고 그 뒤 조회는 바로 끝낸다.
    const { command, said, lookups } = setup({
      lookup: () => {
        if (held) return Promise.resolve(report);
        held = true;
        return new Promise(resolve => { release = resolve; });
      },
    });
    command.handle("!전적 첫째");
    command.handle("!전적 둘째");
    await flush();
    assert.deepEqual(lookups, ["첫째"]);
    assert.deepEqual(said, ["잠깐만요, 지금 보고 있어요!"]);
    release(report);
    await command.idle();
    // 끝나면 다음 조회를 받는다.
    command.handle("!전적 셋째");
    await command.idle();
    assert.deepEqual(lookups, ["첫째", "셋째"]);
  });

  test("결과가 없으면 not-found로 두고 찾지 못했다고 말한다", async () => {
    const { command, dashboards, said, spoken } = setup({ lookup: async () => null });
    command.handle("!전적 없는사람");
    await command.idle();
    assert.deepEqual(dashboards.at(-1), { kind: "player", status: "not-found", report: null });
    assert.match(said[0] ?? "", /찾지 못했어요/);
    assert.equal(spoken.length, 0);
  });

  test("조회가 실패하면 error로 두고 불러오지 못했다고 말한다", async () => {
    const { command, dashboards, said } = setup({ lookup: () => Promise.reject(new Error("API 실패")) });
    command.handle("!전적 보리팬클럽");
    await command.idle();
    assert.deepEqual(dashboards.at(-1), { kind: "player", status: "error", report: null });
    assert.match(said[0] ?? "", /불러오지 못했어요/);
  });

  test("ER 데이터를 쓸 수 없으면 조회하지 않고 error로 둔다", async () => {
    const { command, dashboards, said, lookups } = setup({ available: false });
    command.handle("!전적 보리팬클럽");
    await command.idle();
    assert.deepEqual(lookups, []);
    assert.deepEqual(dashboards.at(-1), { kind: "player", status: "error", report: null });
    assert.match(said[0] ?? "", /볼 수 없어요/);
  });

  test("조회 중에 단계를 옮기면 결과를 버리고 말하지 않는다", async () => {
    let release!: (value: ErPlayerReport) => void;
    const context = setup({ lookup: () => new Promise(resolve => { release = resolve; }) });
    context.command.handle("!전적 보리팬클럽");
    await flush();
    context.moveStage("ending");
    release(report);
    await context.command.idle();
    assert.equal(context.dashboards.some(view => view.kind === "player" && view.status === "ready"), false);
    assert.equal(context.spoken.length, 0);
  });

  test("분석 대사를 못 만들면 화면을 봐 달라는 고정 문장을 말한다", async () => {
    const { command, said } = setup({ speak: () => Promise.reject(new Error("LLM 실패")) });
    command.handle("!전적 보리팬클럽");
    await command.idle();
    assert.match(said[0] ?? "", /화면/);
  });
});
