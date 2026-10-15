import { findCharacter, type ErDictionary } from "@bori/er";
import type { DashboardView, ErCharacterStat, ErMetaBasis, ShowStage } from "@bori/shared";
import type { StageContext } from "./stages.js";

/**
 * 보리 프롬프트의 [게임 데이터] 줄을 만든다. 서버가 가진 집계 수치만 넣고, 시청자가 쓴 글은 넣지 않는다.
 * 수치는 화면 카드와 같은 반올림(소수 한 자리)을 써서 보리가 말하는 값과 화면 값이 같게 한다.
 * 보리가 수치를 읽기만 하지 않고 자기 생각을 말할 수 있게, 집계 전체에서 몇 번째인지도 함께 넣는다(근거 없는 평가를 막는다).
 */

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const rank = (value: number) => `${value.toFixed(1)}위`;

/** "기준: 시즌 9 최근 상위 랭커 7,200판". 설명 끝의 "기준"은 머리말과 겹쳐 뺀다. */
export const basisLine = (basis: ErMetaBasis) => `기준: ${basis.seasonName} ${basis.description.replace(/\s*기준$/, "")}`;

/** "재키 (랭커 픽률 8.1%, 평균 순위 3.4위, 1등 비율 12.0%)" */
const statSummary = (stat: ErCharacterStat) => `${stat.name} (랭커 픽률 ${percent(stat.pickRate)}, 평균 순위 ${rank(stat.avgRank)}, 1등 비율 ${percent(stat.top1Rate)})`;

const NO_META_LINE = "이터널리턴 메타 데이터가 아직 없다.";

/** 전체 판도를 물을 때 붙이는 많이 고른 순 캐릭터 수. 브리핑 TOP 5와 같다. */
const META_COUNT = 5;

/** 단계에 들어갈 때 대사에 붙이는 데이터. 대사 지시가 쓰는 값만 담는다. */
export function stageGameData(stage: ShowStage, ctx: StageContext): string[] {
  switch (stage) {
    case "opening":
      return ctx.basis ? [basisLine(ctx.basis)] : [NO_META_LINE];
    case "briefing":
      if (ctx.top5.length === 0 || !ctx.basis) return [NO_META_LINE];
      return [...ctx.top5.map((stat, index) => `${index + 1}위: ${statSummary(stat)}`), basisLine(ctx.basis)];
    default:
      return [];
  }
}

/**
 * TOP 5가 왜 상위인지 설명할 때 붙이는 데이터. 캐릭터마다 수치와, 집계 전체에서 많이 고른·평균 순위·1등 비율 순서를 넣는다.
 * 순서를 주면 "많이 고르지만 성적은 중간" 같은 판단을 수치로 할 수 있다(근거 없는 이유를 지어내지 않게).
 */
export function top5ReasonLines(ctx: StageContext): string[] {
  if (ctx.top5.length === 0 || !ctx.basis) return [NO_META_LINE];
  const all = ctx.stats.length > 0 ? ctx.stats : ctx.top5;
  const order = (sorted: readonly ErCharacterStat[], stat: ErCharacterStat) => sorted.findIndex(entry => entry.code === stat.code) + 1;
  const byRank = [...all].sort((a, b) => a.avgRank - b.avgRank);
  const byTop1 = [...all].sort((a, b) => b.top1Rate - a.top1Rate);
  return [
    ...ctx.top5.map((stat, index) => `${index + 1}위 ${statSummary(stat)} — 집계 캐릭터 ${all.length}명 중 많이 고른 순서 ${order(all, stat)}번째, 평균 순위가 좋은 순서 ${order(byRank, stat)}번째, 1등 비율이 높은 순서 ${order(byTop1, stat)}번째`),
    basisLine(ctx.basis),
  ];
}

/** 마무리 인사(전적 진단을 떠날 때)에 붙이는 데이터. 오늘 이야기한 캐릭터만 넣는다. */
export function outroGameData(ctx: StageContext): string[] {
  return [ctx.mentioned.length > 0 ? `오늘 이야기한 캐릭터: ${ctx.mentioned.join(", ")}` : "오늘은 캐릭터 질문이 없었다."];
}

/**
 * 캐릭터 하나의 수치 줄. 주 무기는 넣지 않는다. 실모델이 "쌍검이라 빠르다"처럼 데이터에 없는 무기 특성을 지어냈다(무기는 대시보드 카드에만 보인다).
 * stats(많이 고른 순)가 있으면 그 안에서 몇 번째인지 붙인다. "많이 고르지만 성적은 중간" 같은 생각의 근거가 된다.
 */
export function characterLines(stat: ErCharacterStat, basis: ErMetaBasis | null, stats: readonly ErCharacterStat[] = []): string[] {
  const pickOrder = stats.findIndex(entry => entry.code === stat.code) + 1;
  const rankOrder = [...stats].sort((a, b) => a.avgRank - b.avgRank).findIndex(entry => entry.code === stat.code) + 1;
  return [
    `캐릭터: ${stat.name}`,
    `랭커 픽률: ${percent(stat.pickRate)}`,
    `평균 순위: ${rank(stat.avgRank)}`,
    `1등 비율: ${percent(stat.top1Rate)}`,
    ...(pickOrder > 0
      ? [`많이 고른 순서: 집계 캐릭터 ${stats.length}명 중 ${pickOrder}번째`, `평균 순위가 좋은 순서: 집계 캐릭터 ${stats.length}명 중 ${rankOrder}번째`]
      : []),
    ...(basis ? [basisLine(basis)] : []),
  ];
}

export type CharacterView = Extract<DashboardView, { kind: "character" }>;
/** stats는 많이 고른 순이다(er-data의 top5가 앞 다섯을 자른다). */
export type GameDataContext = { dictionary: ErDictionary | null; stats: readonly ErCharacterStat[]; basis: ErMetaBasis | null };

/** 캐릭터를 못 찾았을 때 캐릭터 질문으로 볼 말. "세"는 "세상"과 겹쳐 물음 꼴만 본다. */
const CHARACTER_QUESTION = /어때|좋아|추천|쎄|센가|세\?|세냐|세요\?|강해/;
/** 특정 캐릭터 없이 전체 판도를 묻는 말. "1티어 뭐야", "메타 어때", "추천해 줘", "뭐가 제일 쎄". */
/**
 * "1등 비율 제일 높은 애 누구야?"처럼 기록을 기준으로 가장 좋은 캐릭터를 묻는 말. 게임 기록 낱말과 최상급·누구가 함께 있을 때만 본다
 * ("제일 좋아하는 노래"처럼 게임과 상관없는 최상급은 빼려고). 2026-10-15 리허설에서 이 질문을 메타 질문으로 보지 않아 데이터 없이 답했다.
 */
const RECORD_WORD = /1등|순위|픽률|승률|캐릭|티어/;
const SUPERLATIVE = /제일|가장|누구|누가/;
/** 전체 판도를 묻는 말인지. 메타·티어 질문 또는 기록 낱말 + 최상급. */
export const isMetaQuestion = (content: string) => META_QUESTION.test(content) || (RECORD_WORD.test(content) && SUPERLATIVE.test(content));
/** 가장 좋은 캐릭터를 고를 때 보는 범위(많이 고른 상위). 판수가 적은 캐릭터의 치우친 비율을 빼려고 둔다. */
const LEADER_POOL = 15;

export const META_QUESTION = /티어|메타|추천|사기\s*캐|(뭐가|누가)\s*(제일\s*)?(좋|쎄|세|강)/;
/** 대시보드 카드에 보일 질문 글 길이(글자). */
const QUERY_MAX_LENGTH = 40;

/**
 * 채팅에서 캐릭터를 찾아 [게임 데이터] 줄과 대시보드 캐릭터 카드를 만든다.
 * - 찾으면 집계 수치 줄과 카드. 표본에 없는 캐릭터는 없다고 적는다(수치를 지어내지 않게).
 * - 캐릭터 없이 1티어·메타를 물으면 많이 고른 순 상위 수치 줄. 카드는 바꾸지 않는다(view null).
 * - 못 찾았는데 캐릭터 질문처럼 보이고 비슷한 이름이 있으면 그 이름을 담은 카드.
 * - 나머지와 사전이 없을 때는 null.
 */
export function buildGameData(chatContent: string, ctx: GameDataContext): { lines: string[]; view: CharacterView | null } | null {
  if (!ctx.dictionary) return null;
  const { match, suggestions } = findCharacter(chatContent, ctx.dictionary);
  const query = Array.from(chatContent.trim()).slice(0, QUERY_MAX_LENGTH).join("");

  if (match) {
    const stat = ctx.stats.find(entry => entry.code === match.code) ?? null;
    const lines = stat
      ? characterLines(stat, ctx.basis, ctx.stats)
      : [`캐릭터: ${match.name}`, `이번 집계 표본에 ${match.name} 경기가 없다.`, ...(ctx.basis ? [basisLine(ctx.basis)] : [])];
    return { lines, view: { kind: "character", query, stat, suggestions: [], basis: ctx.basis } };
  }

  if (isMetaQuestion(chatContent)) {
    if (ctx.stats.length === 0 || !ctx.basis) return { lines: [NO_META_LINE], view: null };
    const pool = ctx.stats.slice(0, LEADER_POOL);
    const bestTop1 = [...pool].sort((a, b) => b.top1Rate - a.top1Rate)[0];
    const bestRank = [...pool].sort((a, b) => a.avgRank - b.avgRank)[0];
    return {
      lines: [
        ...ctx.stats.slice(0, META_COUNT).map((stat, index) => `많이 고른 순 ${index + 1}위: ${statSummary(stat)}`),
        `많이 고른 상위 ${pool.length}명 중 1등 비율이 가장 높은 캐릭터: ${statSummary(bestTop1)}`,
        `많이 고른 상위 ${pool.length}명 중 평균 순위가 가장 좋은 캐릭터: ${statSummary(bestRank)}`,
        basisLine(ctx.basis),
      ],
      view: null,
    };
  }

  if (!CHARACTER_QUESTION.test(chatContent) || suggestions.length === 0) return null;
  return {
    lines: ["채팅에서 말한 캐릭터를 데이터에서 찾지 못했다.", `비슷한 이름: ${suggestions.join(", ")}`],
    view: { kind: "character", query, stat: null, suggestions, basis: ctx.basis },
  };
}
