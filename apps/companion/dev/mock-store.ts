/**
 * 개발·검증용 가짜 대시보드 API의 상태와 규칙. 빌드 산출물에는 들어가지 않는다.
 * 서버 없이 `npm --workspace apps/companion run dev:mock`으로 화면을 상태별로 확인하려고 둔다.
 *
 * 캐릭터·무기 이름은 게임의 공개 이름이고 수치는 지어낸 값이다. 특성·장비 이름은 "예시"로 표시한 가짜 이름이다.
 * 플레이어 닉네임도 가짜다.
 *
 * 상태(시나리오)는 `POST /__mock/scenario { "name": "refreshing" }`으로 바꾼다. 목록은 mockScenarios.
 */
import type { DashboardPlayerStatus, DashboardState, ErComboStat, ErMetaBasisV2, ErPlayerSummary, Narration } from "@bori/shared";

export type MockResult = { status: number; body: unknown };

export const mockScenarios = [
  "ready",
  "stale",
  "missing",
  "no-key",
  "refreshing",
  "error",
  "patch-changed",
  "first-collect",
  "player-unset",
  "player-loading",
  "player-not-found",
  "player-error",
] as const;
export type MockScenario = (typeof mockScenarios)[number];

export const MOCK_NICKNAME = "테스트유저";
/** 버튼으로 시작한 가짜 갱신이 끝나는 데 걸리는 시간 */
export const MOCK_REFRESH_MS = 10_000;
/** "refreshing" 시나리오에서 멈춰 보이는 진행률. 캡처가 늘 같은 화면이 되게 한다. */
const FROZEN_PROGRESS = 0.42;

type Seed = [characterCode: number, characterName: string, weaponCode: number, weaponName: string, participants: number, avgRank: number, top1Rate: number, mmr: number | null, change: [rank: number, top1: number, pick: number, mmr: number | null] | null];

/** 픽률은 참가자 수로 계산한다. 유키 쌍검·쇼우 단검은 표본이 적다(30명 미만). */
const SEEDS: Seed[] = [
  [1, "재키", 13, "쌍검", 412, 3.42, 0.14, 12.3, [-0.5, 0.021, 0.01, 3.1]],
  [2, "아야", 7, "권총", 380, 4.1, 0.1, 4.2, [0.6, -0.012, -0.004, -2.4]],
  [3, "현우", 9, "글러브", 350, 3.8, 0.12, 8.8, [-0.2, 0.008, 0.002, 1.2]],
  [4, "피오라", 15, "레이피어", 331, 3.95, 0.118, 7.5, [0.1, 0.003, 0.001, 0.4]],
  [5, "매그너스", 17, "망치", 318, 4.36, 0.092, 2.1, [0.35, -0.02, -0.003, -4]],
  [6, "나딘", 11, "활", 300, 4.5, 0.08, -1.2, null],
  [7, "하트", 20, "기타", 284, 4.4, 0.09, 3.3, [0.02, 0, 0, 0]],
  [8, "이솔", 6, "돌격 소총", 262, 3.66, 0.13, 10.4, [-0.42, 0.03, 0.006, 5.5]],
  [9, "리 다이린", 9, "글러브", 240, 4.21, 0.1, 1.9, [-0.12, 0.004, 0.001, 0.8]],
  [10, "혜진", 16, "암기", 222, 4.62, 0.075, -3.4, [0.48, -0.025, -0.005, -6.2]],
  [1, "재키", 2, "도끼", 205, 4.05, 0.11, 5.1, [-0.08, 0.002, 0, 0.2]],
  [11, "키아라", 15, "레이피어", 190, 3.99, 0.12, 6.6, [-0.3, 0.01, 0.004, 2.2]],
  [12, "시셀라", 18, "투척", 176, 4.77, 0.07, -5.1, [0.25, -0.01, -0.002, -1.1]],
  [13, "레녹스", 19, "채찍", 150, 4.31, 0.093, null, [0.05, 0, 0, null]],
  [14, "유키", 13, "쌍검", 21, 2.9, 0.24, 18.2, [-1.4, 0.1, 0.001, 9]],
  [15, "쇼우", 3, "단검", 9, 5.6, 0, -9, null],
];

const TOTAL_PARTICIPANTS = 7_200;

function seedCombo([characterCode, characterName, weaponCode, weaponName, participants, avgRank, top1Rate, mmr, change]: Seed): ErComboStat {
  return {
    characterCode,
    characterName,
    weaponCode,
    weaponName,
    participants,
    pickRate: participants / TOTAL_PARTICIPANTS,
    avgRank,
    top1Rate,
    avgMmrGain: mmr,
    avgKills: 2 + (characterCode % 4) * 0.7,
    avgAssists: 3 + (weaponCode % 3) * 0.9,
    avgDeaths: 2.4 + (characterCode % 3) * 0.3,
    avgDamage: 9_000 + characterCode * 830 + weaponCode * 110,
    topTraits: [
      { code: 7_000_000 + characterCode * 10, name: `예시 특성 ${characterCode}-1`, rate: 0.58 },
      { code: 7_000_001 + characterCode * 10, name: `예시 특성 ${characterCode}-2`, rate: 0.27 },
    ],
    topEquipment: ["무기", "옷", "머리", "팔", "다리"].map((part, slot) => ({
      slot,
      items: [
        { code: 100_000 + characterCode * 100 + slot * 2, name: `예시 ${part} ${characterCode}A`, rate: 0.46 },
        { code: 100_001 + characterCode * 100 + slot * 2, name: `예시 ${part} ${characterCode}B`, rate: 0.21 },
      ],
    })),
    lowSample: participants < 30,
    change: change && { avgRank: change[0], top1Rate: change[1], pickRate: change[2], avgMmrGain: change[3] },
  };
}

const baseCombos = () => SEEDS.map(seedCombo).sort((a, b) => b.pickRate - a.pickRate);

const HOUR = 3_600_000;

function basisAt(collectedAt: number, overrides: Partial<ErMetaBasisV2> = {}): ErMetaBasisV2 {
  return {
    seasonId: 31,
    seasonName: "시즌 13",
    patch: "1.47",
    games: 300,
    participants: TOTAL_PARTICIPANTS,
    rankers: 100,
    gamesPerRanker: 3,
    collectedAt: new Date(collectedAt).toISOString(),
    previousCollectedAt: new Date(collectedAt - 24 * HOUR).toISOString(),
    patchChanged: false,
    ...overrides,
  };
}

const PLAYER: ErPlayerSummary = {
  nickname: MOCK_NICKNAME,
  seasonName: "시즌 13",
  mmr: 4_321,
  rankPercent: 0.052,
  games: 64,
  avgRank: 4.18,
  top1Rate: 0.109,
  avgKills: 3.4,
  avgAssists: 2.8,
  recent: [
    { characterName: "재키", weaponName: "쌍검", rank: 1, kills: 7, mmrGain: 58 },
    { characterName: "재키", weaponName: "쌍검", rank: 4, kills: 3, mmrGain: 6 },
    { characterName: "아야", weaponName: "권총", rank: 7, kills: 1, mmrGain: -31 },
    { characterName: "재키", weaponName: "도끼", rank: 2, kills: 5, mmrGain: 34 },
    { characterName: "현우", weaponName: "글러브", rank: 3, kills: 4, mmrGain: 18 },
    { characterName: "재키", weaponName: "쌍검", rank: 5, kills: 2, mmrGain: -4 },
    { characterName: "아야", weaponName: "권총", rank: 2, kills: 6, mmrGain: 30 },
    { characterName: "재키", weaponName: "쌍검", rank: 6, kills: 2, mmrGain: -18 },
    { characterName: "현우", weaponName: "글러브", rank: 1, kills: 8, mmrGain: 61 },
    { characterName: "재키", weaponName: "쌍검", rank: 8, kills: 0, mmrGain: -40 },
  ],
  mainCharacters: [
    { name: "재키", games: 31, avgRank: 3.9, metaRank: 1 },
    { name: "아야", games: 14, avgRank: 4.6, metaRank: 2 },
    { name: "현우", games: 9, avgRank: 3.7, metaRank: 3 },
  ],
};

/** 보리 대사 예시. 실제 서버는 사실 목록에서 만들고 검사한다. */
function narrationFor(id: string, createdAt: number): Narration {
  return {
    id,
    createdAt: new Date(createdAt).toISOString(),
    source: "llm",
    lines: [
      { text: "오늘의 이터널리턴 메타 분석을 정리해 봤어요!", emotion: "greeting" },
      { text: "지금 가장 많이 고른 조합은 재키 쌍검이에요. 픽률 5.7%, 평균 순위 3.4위예요.", emotion: "gaming" },
      { text: "재키 쌍검은 평균 순위가 3.9위에서 3.4위로 좋아졌어요. 요즘 꽤 힘이 좋은 것 같아요.", emotion: "happy" },
      { text: "아야 권총은 3.5위에서 4.1위로 내려갔어요.", emotion: "sad" },
      { text: "자주 하시는 재키는 지금 메타 조합 순위 1위예요.", emotion: "excited" },
    ].map((line, index) => ({ ...line, audioId: `mock-audio-${id}-${index}` })),
  };
}

const PLAYER_STATUS: Partial<Record<MockScenario, DashboardPlayerStatus>> = {
  "player-unset": "unset",
  "player-loading": "loading",
  "player-not-found": "not-found",
  "player-error": "error",
  missing: "unset",
  "no-key": "unset",
};

export function createMockStore(initial: MockScenario = "ready", options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let scenario: MockScenario = initial;
  let state: DashboardState;
  let refreshStartedAt: number | null = null;
  let narrationSeq = 0;
  let nickname: string | null = MOCK_NICKNAME;

  const nextNarration = (at: number) => narrationFor(`mock-${(narrationSeq += 1)}`, at);

  function build(name: MockScenario): DashboardState {
    const at = now();
    const playerStatus = PLAYER_STATUS[name] ?? "ready";
    const player = { status: playerStatus, summary: playerStatus === "ready" ? PLAYER : null };
    const refresh = { available: true, running: false, progress: null, lastError: null, autoStarted: false };
    const ready: DashboardState = { connection: "ready", refresh, basis: basisAt(at - 2 * HOUR), combos: baseCombos(), player, narration: nextNarration(at - 2 * HOUR) };

    switch (name) {
      case "stale":
        return { ...ready, connection: "stale", basis: basisAt(at - 50 * HOUR) };
      case "missing":
        return { ...ready, connection: "missing", basis: null, combos: [], narration: null };
      case "no-key":
        return { ...ready, connection: "missing", refresh: { ...refresh, available: false }, basis: null, combos: [], narration: null };
      case "refreshing":
        return { ...ready, connection: "refreshing", refresh: { ...refresh, running: true, progress: FROZEN_PROGRESS, autoStarted: true }, basis: basisAt(at - 30 * HOUR) };
      case "error":
        return { ...ready, connection: "stale", refresh: { ...refresh, lastError: "이터널리턴 API가 응답하지 않았습니다. (가짜 오류)" }, basis: basisAt(at - 30 * HOUR) };
      case "patch-changed":
        return { ...ready, basis: basisAt(at - 2 * HOUR, { patch: "1.48", patchChanged: true }) };
      case "first-collect":
        return { ...ready, basis: basisAt(at - 2 * HOUR, { previousCollectedAt: null }), combos: baseCombos().map(entry => ({ ...entry, change: null })) };
      default:
        return ready;
    }
  }

  state = build(scenario);

  /** 버튼으로 시작한 갱신을 시각에 맞춰 진행시키고, 끝나면 새 데이터와 새 대사를 붙인다. */
  function advance() {
    if (refreshStartedAt === null) return;
    const progress = Math.min(1, (now() - refreshStartedAt) / MOCK_REFRESH_MS);
    if (progress < 1) {
      state = { ...state, connection: "refreshing", refresh: { ...state.refresh, running: true, progress, autoStarted: false } };
      return;
    }
    const at = now();
    const previous = state.basis?.collectedAt ?? null;
    refreshStartedAt = null;
    state = {
      ...state,
      connection: "ready",
      refresh: { ...state.refresh, running: false, progress: null, lastError: null },
      basis: { ...basisAt(at), previousCollectedAt: previous },
      combos: baseCombos(),
      narration: nextNarration(at),
    };
  }

  return {
    scenario: () => scenario,

    setScenario(body: unknown): MockResult {
      const name = (body as { name?: unknown } | null)?.name;
      if (!mockScenarios.includes(name as MockScenario)) return { status: 400, body: { error: "없는 시나리오입니다.", scenarios: mockScenarios } };
      scenario = name as MockScenario;
      refreshStartedAt = null;
      state = build(scenario);
      return { status: 200, body: { scenario } };
    },

    dashboard(): MockResult {
      advance();
      return { status: 200, body: state };
    },

    refresh(): MockResult {
      advance();
      if (!state.refresh.available) return { status: 200, body: { started: false } };
      if (state.refresh.running) return { status: 200, body: { started: false } };
      refreshStartedAt = now();
      advance();
      return { status: 200, body: { started: true } };
    },

    /** 다시 듣기: 최신 대사를 그대로, 음성 id는 새로 만들어 돌려준다(서버가 사라진 음성을 다시 만드는 흉내). */
    replay(): MockResult {
      const narration = state.narration;
      if (!narration) return { status: 404, body: { error: "아직 읽을 대사가 없습니다." } };
      const replayed: Narration = { ...narration, lines: narration.lines.map((line, index) => ({ ...line, audioId: `mock-audio-${narration.id}-r${index}` })) };
      state = { ...state, narration: replayed };
      return { status: 200, body: { narration: replayed } };
    },

    settings(): MockResult {
      return { status: 200, body: { nickname } };
    },

    saveSettings(body: unknown): MockResult {
      const value = (body as { nickname?: unknown } | null)?.nickname;
      if (value !== null && (typeof value !== "string" || value.trim().length === 0 || value.length > 40)) return { status: 400, body: { error: "닉네임은 1~40자입니다." } };
      nickname = value === null ? null : value.trim();
      state = { ...state, player: nickname ? { status: "ready", summary: { ...PLAYER, nickname } } : { status: "unset", summary: null } };
      return { status: 200, body: { nickname } };
    },

    hasAudio: (id: string) => id.startsWith("mock-audio-"),
  };
}

export type MockStore = ReturnType<typeof createMockStore>;

/** 소리 확인용 짧은 톤. 사람 목소리 대신 음절처럼 오르내리는 220Hz 사인파다. */
export function createToneWav(seconds = 1.6, sampleRate = 16000): Uint8Array {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeText(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); writeText(8, "WAVE");
  writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    // 음절처럼 들리도록 초당 5번 크기를 오르내린다.
    const envelope = Math.abs(Math.sin(Math.PI * 5 * t));
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * t) * envelope * 0.4 * 32767), true);
  }
  return new Uint8Array(buffer);
}
