/**
 * 보리가 말할 사실 목록. 갱신이 끝난 집계에서 정해진 규칙으로 만든다(설계 3절 1).
 * LLM은 이 목록에 있는 수치·이름만 말할 수 있고, LLM을 쓸 수 없을 때는 사실마다 둔 정해진 문장(spoken)을 읽는다.
 * 숫자는 화면과 같은 반올림(format.ts)이다. 플레이어 닉네임은 어디에도 넣지 않는다.
 */
import type { ErComboStat, ErMetaBasisV2, ErPlayerSummary } from "@bori/shared";
import { formatCount, formatPercent, formatRank } from "./format.js";
import { extractTokens, type NumberMeaning, type NumberToken, type NumberUnit } from "./tokens.js";

export type NarrationInput = {
  basis: ErMetaBasisV2 | null;
  combos: readonly ErComboStat[];
  /** 닉네임이 없거나 조회하지 못했으면 null */
  player: ErPlayerSummary | null;
};

export type NarrationFactKind = "top" | "riser" | "faller" | "newTop" | "main" | "patch" | "basis";

export type NarrationFact = {
  /** f1, f2 … 만든 순서대로 */
  id: string;
  kind: NarrationFactKind;
  /** LLM에게 주는 사실 문장 */
  text: string;
  /** LLM을 쓸 수 없을 때 읽는 보리 말투 문장. text에 있는 숫자만 쓴다 */
  spoken: string;
  /**
   * text에 나온 숫자 토큰(값·단위·뜻). 대사 검사는 줄의 숫자 토큰마다 인용한 사실의 같은 단위·값 토큰을 찾는다.
   * 값·단위는 extractTokens(text)와 같다(narration-facts 검사가 고정한다).
   */
  tokens: NumberToken[];
  /** 이 사실에 나온 캐릭터·무기 이름 */
  names: string[];
  /** 이 사실의 캐릭터+무기 조합. "재키 권총"처럼 두 사실의 이름을 섞은 조합을 막는다 */
  pairs: Array<{ character: string; weapon: string }>;
};

const TOP_COUNT = 3;
const RISER_COUNT = 2;
const FALLER_COUNT = 1;
const NEW_TOP_LIMIT = 2;
const NEW_TOP_RANGE = 10;

/**
 * 이름 뒤 조사를 받침에 맞춘다. 예: withParticle("재키 쌍검", "는", "은") → "재키 쌍검은".
 * 한글이 아닌 글자로 끝나면 받침 없는 쪽을 쓴다.
 */
export function withParticle(name: string, withoutFinal: string, withFinal: string): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return `${name}${hasFinal ? withFinal : withoutFinal}`;
}

/** "재키 쌍검". 무기를 모르면 캐릭터 이름만. 화면 comboLabel과 같은 모양이다. */
export const comboLabel = (combo: Pick<ErComboStat, "characterName" | "weaponName">) =>
  combo.weaponName ? `${combo.characterName} ${combo.weaponName}` : combo.characterName;

const comboNames = (combo: ErComboStat) => [combo.characterName, combo.weaponName].filter(name => name.length > 0);
const comboPairs = (combo: ErComboStat) => (combo.weaponName ? [{ character: combo.characterName, weapon: combo.weaponName }] : []);
const token = (value: string, unit: NumberUnit, meaning: NumberMeaning): NumberToken => ({ value: value.replace(/,/g, ""), unit, meaning });

/** 직전 갱신의 평균 순위. change는 "이번 값 − 직전 값"이다(코디네이터 확인 2026-11-21). */
const previousRank = (combo: ErComboStat) => combo.avgRank - (combo.change?.avgRank ?? 0);

/** 화면에 보이는 반올림으로도 순위가 달라졌는지. 3.4위 → 3.4위 같은 움직임은 말하지 않는다. */
const visiblyMoved = (combo: ErComboStat) => formatRank(previousRank(combo)) !== formatRank(combo.avgRank);

/**
 * 평균 순위로 본 오르고 내린 조합. 표본 적은 조합과 직전 값이 없는 조합은 뺀다.
 * 순위는 작아질수록 좋으므로 change.avgRank가 음수면 오른 것이다. 같은 값이면 입력 순서(픽률 순)를 지킨다.
 * 화면 dashboard.ts의 selectMovers와 같은 규칙이다(narration-facts 검사가 비교한다).
 */
export function rankMovers(combos: readonly ErComboStat[], limit: number): { risers: ErComboStat[]; fallers: ErComboStat[] } {
  const moved = combos.filter(combo => !combo.lowSample && combo.change !== null && visiblyMoved(combo));
  const delta = (combo: ErComboStat) => combo.change?.avgRank ?? 0;
  return {
    risers: moved.filter(combo => delta(combo) < 0).sort((a, b) => delta(a) - delta(b)).slice(0, limit),
    fallers: moved.filter(combo => delta(combo) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, limit),
  };
}

/** 표본이 충분한 조합을 픽률 순으로 */
const byPickRate = (combos: readonly ErComboStat[]) => combos.filter(combo => !combo.lowSample).sort((a, b) => b.pickRate - a.pickRate);

/**
 * 새로 픽률 TOP 10에 든 조합. 직전 갱신에 없던 조합이거나, 직전 픽률(이번 − 변화)로 세운 순위가 10 밖이던 조합이다.
 * 직전 갱신에서 빠진 조합은 지금 목록에 없어 직전 순위를 정확히 셀 수 없다. 지금 있는 조합끼리 세운 근사값이다.
 */
function newTopCombos(ranked: readonly ErComboStat[]): ErComboStat[] {
  const previous = ranked.filter(combo => combo.change !== null)
    .map(combo => ({ combo, pickRate: combo.pickRate - (combo.change?.pickRate ?? 0) }))
    .sort((a, b) => b.pickRate - a.pickRate)
    .map(entry => entry.combo);
  return ranked.slice(0, NEW_TOP_RANGE)
    .filter(combo => combo.change === null || previous.indexOf(combo) >= NEW_TOP_RANGE)
    .slice(0, NEW_TOP_LIMIT);
}

type Draft = Omit<NarrationFact, "id">;

function topFact(combo: ErComboStat, place: number): Draft {
  const label = comboLabel(combo);
  const pick = formatPercent(combo.pickRate);
  const rank = formatRank(combo.avgRank);
  const top1 = formatPercent(combo.top1Rate);
  const participants = formatCount(combo.participants);
  const spoken = place === 1
    ? `지금 가장 많이 고른 조합은 ${withParticle(label, "예요", "이에요")}. 픽률 ${pick}, 평균 순위 ${rank}위예요.`
    : `${label}도 픽률 ${pick}로 많이 보이고, 평균 순위는 ${rank}위예요.`;
  return {
    kind: "top",
    // "메타 N위"라고 쓰면 LLM이 "가장 강한 조합"으로 바꿔 말할 여지가 있어 픽률 순위라고 밝힌다(점검 V2 15번).
    text: `픽률 ${place}위 ${label}: 픽률 ${pick}, 평균 순위 ${rank}위, 1등 비율 ${top1} (참가자 ${participants}명)`,
    spoken,
    tokens: [
      token(String(place), "rank", "pickRank"),
      token(pick.slice(0, -1), "%", "pickRate"),
      token(rank, "rank", "avgRank"),
      token(top1.slice(0, -1), "%", "top1Rate"),
      token(participants, "명", "participants"),
    ],
    names: comboNames(combo),
    pairs: comboPairs(combo),
  };
}

function moverFact(combo: ErComboStat, kind: "riser" | "faller"): Draft {
  const label = comboLabel(combo);
  const before = formatRank(previousRank(combo));
  const after = formatRank(combo.avgRank);
  const participants = formatCount(combo.participants);
  return {
    kind,
    text: `${label} 평균 순위 ${before}위 → ${after}위 (참가자 ${participants}명)`,
    spoken: `${withParticle(label, "는", "은")} 평균 순위가 ${before}위에서 ${after}위로 ${kind === "riser" ? "좋아졌어요" : "내려갔어요"}.`,
    tokens: [token(before, "rank", "avgRank"), token(after, "rank", "avgRank"), token(participants, "명", "participants")],
    names: comboNames(combo),
    pairs: comboPairs(combo),
  };
}

function newTopFact(combo: ErComboStat): Draft {
  const label = comboLabel(combo);
  const pick = formatPercent(combo.pickRate);
  return {
    kind: "newTop",
    text: `새로 픽률 TOP ${NEW_TOP_RANGE}에 든 조합: ${label} (픽률 ${pick})`,
    spoken: `${withParticle(label, "가", "이")} 새로 픽률 TOP ${NEW_TOP_RANGE}에 들어왔어요.`,
    tokens: [token(String(NEW_TOP_RANGE), "rank", "topRange"), token(pick.slice(0, -1), "%", "pickRate")],
    names: comboNames(combo),
    pairs: comboPairs(combo),
  };
}

/** 시즌 이름 속 숫자("시즌 13")의 토큰. 시즌 이름은 게임 표기라 토크나이저로 뽑고 뜻만 붙인다. */
const seasonTokens = (seasonName: string) => extractTokens(seasonName).map(found => ({ ...found, meaning: "season" as const }));

/**
 * 주캐릭터 사실. 판수가 0이거나 평균 순위가 수가 아니면 "0.0위"가 되므로 만들지 않는다(점검 V2 19번).
 * 전적이 이번 시즌이 아닐 수 있어(일반 대전) 전적의 시즌 이름을 그대로 쓴다.
 */
function mainFact(main: ErPlayerSummary["mainCharacters"][number], seasonName: string): Draft {
  const place = main.metaRank === null ? "메타 조합 순위에는 없음" : `메타 조합 순위 ${main.metaRank}위`;
  const games = formatCount(main.games);
  const rank = formatRank(main.avgRank);
  const spoken = main.metaRank === null
    ? `자주 하시는 ${withParticle(main.name, "는", "은")} 이번 집계의 메타 조합 순위에는 없어요.`
    : `자주 하시는 ${withParticle(main.name, "는", "은")} 지금 메타 조합 순위 ${main.metaRank}위예요.`;
  return {
    kind: "main",
    text: `내 주캐릭터 ${main.name}: ${seasonName}에서 ${games}판, 평균 순위 ${rank}위, ${place}`,
    spoken,
    tokens: [
      ...seasonTokens(seasonName),
      token(games, "판", "games"),
      token(rank, "rank", "avgRank"),
      ...(main.metaRank === null ? [] : [token(String(main.metaRank), "rank", "metaRank")]),
    ],
    names: [main.name],
    pairs: [],
  };
}

function patchFact(basis: ErMetaBasisV2): Draft {
  return {
    kind: "patch",
    text: `시즌이나 패치가 지난 갱신과 다름${basis.patch ? ` (지금 패치 ${basis.patch})` : ""}`,
    spoken: "시즌이나 패치가 바뀌어서, 지난번과 비교한 수치는 참고만 해 주세요.",
    tokens: basis.patch ? extractTokens(`패치 ${basis.patch}`).map(found => ({ ...found, meaning: "patch" as const })) : [],
    names: [],
    pairs: [],
  };
}

function basisFact(basis: ErMetaBasisV2): Draft {
  const games = formatCount(basis.games);
  const participants = formatCount(basis.participants);
  return {
    kind: "basis",
    text: `집계 기준: ${basis.seasonName} 랭크 경기 ${games}판, 참가자 ${participants}명`,
    spoken: `이번 분석은 ${basis.seasonName} 랭크 경기 ${games}판, 참가자 ${participants}명을 모은 거예요.`,
    tokens: [...seasonTokens(basis.seasonName), token(games, "판", "games"), token(participants, "명", "participants")],
    names: [],
    pairs: [],
  };
}

/** 집계에서 사실 목록을 만든다. 기준이나 조합이 없으면 빈 목록이다. */
export function buildFacts(input: NarrationInput): NarrationFact[] {
  const { basis, combos, player } = input;
  if (!basis || combos.length === 0) return [];

  const ranked = byPickRate(combos);
  const movers = rankMovers(combos, Math.max(RISER_COUNT, FALLER_COUNT));
  const drafts: Draft[] = [
    ...ranked.slice(0, TOP_COUNT).map((combo, index) => topFact(combo, index + 1)),
    ...movers.risers.slice(0, RISER_COUNT).map(combo => moverFact(combo, "riser")),
    ...movers.fallers.slice(0, FALLER_COUNT).map(combo => moverFact(combo, "faller")),
    ...(basis.previousCollectedAt ? newTopCombos(ranked).map(newTopFact) : []),
  ];
  const main = player?.mainCharacters[0];
  if (player && main && main.games > 0 && Number.isFinite(main.avgRank) && main.avgRank > 0) drafts.push(mainFact(main, player.seasonName));
  if (basis.patchChanged) drafts.push(patchFact(basis));
  drafts.push(basisFact(basis));

  return drafts.map((draft, index) => ({ id: `f${index + 1}`, ...draft }));
}
