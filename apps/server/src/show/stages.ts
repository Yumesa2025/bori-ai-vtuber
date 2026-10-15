import type { DashboardView, ErCharacterStat, ErMetaBasis, ObsSceneName, ShowStage } from "@bori/shared";

/** 단계 대시보드를 만들 때 쓰는 값. 진행기가 단계에 들어갈 때마다 새로 모은다. */
export type StageContext = {
  basis: ErMetaBasis | null;
  top5: ErCharacterStat[];
  /** 이번 방송에서 대시보드에 띄운 캐릭터 이름. 엔딩 요약에 쓴다. */
  mentioned: string[];
};

export type StageConfig = {
  scene: ObsSceneName;
  dashboard: (ctx: StageContext) => DashboardView;
  /** 단계에 들어갈 때 보리에게 주는 지시. 비어 있으면 말하지 않는다. */
  directive: string;
  /** LLM으로 대사를 못 만들었을 때 그대로 말하는 문장. */
  fallbackLines: string[];
};

/** 방송 진행 단계. 순서는 showStages(@bori/shared)를 따른다. */
export const stageConfig: Record<ShowStage, StageConfig> = {
  idle: { scene: "보리-대기", dashboard: ctx => ({ kind: "season", basis: ctx.basis }), directive: "", fallbackLines: [] },
  opening: {
    scene: "보리-메인",
    dashboard: ctx => ({ kind: "season", basis: ctx.basis }),
    directive: "방송을 시작하는 인사를 한다. 오늘은 이터널리턴 랭커 데이터로 메타를 살펴보고, 채팅으로 캐릭터 질문을 받고, 마지막에 전적을 봐 준다고 소개한다. 2문장.",
    fallbackLines: ["안녕하세요, 보리예요! 오늘은 이터널리턴 랭커 데이터로 요즘 메타를 같이 살펴봐요."],
  },
  briefing: {
    scene: "보리-메인",
    dashboard: ctx => ({ kind: "top5", items: ctx.top5, revealed: 0, basis: ctx.basis }),
    directive: "[게임 데이터]의 TOP 5를 1위부터 짧게 소개하고, 눈에 띄는 점(1위의 픽률, 평균 순위가 특히 좋은 캐릭터 등)에 대한 보리의 생각을 한마디 붙인다. 수치는 주어진 것만 쓴다. 3~4문장.",
    fallbackLines: ["이번 랭커 데이터 TOP 5를 볼게요! 화면을 같이 봐 주세요."],
  },
  qna: {
    scene: "보리-메인",
    dashboard: ctx => ({ kind: "season", basis: ctx.basis }),
    directive: "이제 채팅으로 궁금한 캐릭터나 요즘 메타를 물어봐 달라고 한다. 예: '재키 어때?', '요즘 1티어 뭐야?'. 1~2문장.",
    fallbackLines: ["궁금한 캐릭터를 채팅으로 물어봐 주세요! 예를 들면 '재키 어때?'처럼요."],
  },
  diagnosis: {
    scene: "보리-전적",
    dashboard: () => ({ kind: "player", status: "waiting", report: null }),
    directive: "채팅에 '!전적 닉네임'을 치면 최근 전적을 봐 준다고 안내한다. 1~2문장.",
    fallbackLines: ["이제 전적 진단 시간이에요! 채팅에 '!전적 닉네임'을 적어 주세요."],
  },
  // 대기·엔딩 장면에서는 보리가 말하지 않는다(사용자 결정 2026-10-15). 마무리 인사는 엔딩 화면 글로만 보인다.
  ending: { scene: "보리-엔딩", dashboard: ctx => ({ kind: "summary", characters: ctx.mentioned }), directive: "", fallbackLines: [] },
};
