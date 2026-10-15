import type { DashboardView, ErCharacterStat, ErMetaBasis, ObsSceneName, ShowStage } from "@bori/shared";

/** 단계 대시보드를 만들 때 쓰는 값. 진행기가 단계에 들어갈 때마다 새로 모은다. */
export type StageContext = {
  basis: ErMetaBasis | null;
  top5: ErCharacterStat[];
  /** 집계한 캐릭터 전체(많이 고른 순). TOP 5가 전체에서 몇 번째인지 볼 때 쓴다. */
  stats: ErCharacterStat[];
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
  /**
   * 이 단계에서 다음 단계로 넘어가기 직전에 하는 말. 말을 다 마친 뒤에 넘어간다.
   * 엔딩은 말하지 않으므로 마무리 인사를 전적 진단을 떠날 때 한다(2026-10-15 사용자 결정).
   */
  outro?: { directive: string; fallbackLines: string[] };
  /** TOP 5가 다 열린 뒤 하는 말(브리핑). 왜 TOP 5인지 데이터로 풀어 본다(2026-10-15 사용자 요청). */
  afterReveal?: { directive: string; fallbackLines: string[] };
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
    // 4분 시연 구성(2026-10-15): 먼저 TOP 5를 짧게 소개하고, 표가 다 열린 뒤(afterReveal) 왜 TOP 5인지 데이터로 풀어 본다.
    directive: "랭커들이 많이 고른 TOP 5를 공개한다고 하며 1위부터 이름만 짧게 소개한다. 수치는 아직 말하지 않는다. 2문장.",
    afterReveal: {
      directive: "TOP 5에 왜 들었는지 [게임 데이터]로 풀어 본다. 많이 골라진 정도와 성적(평균 순위·1등 비율이 집계 전체에서 몇 번째인지)을 비교해, 눈에 띄는 두세 명을 '많이 고르고 성적도 좋아서', '많이 고르지만 성적은 중간이라 손에 익은 캐릭터 같다'처럼 보리의 생각으로 설명한다. 패치·스킬 같은 데이터에 없는 이유는 말하지 않는다. 수치는 주어진 것만 쓴다. 3~4문장.",
      fallbackLines: ["TOP 5를 보면 많이 고르는 캐릭터와 성적이 좋은 캐릭터가 꼭 같지는 않아요. 화면의 평균 순위와 1등 비율도 같이 봐 주세요!"],
    },
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
    outro: {
      // 4분 시연 구성: 마무리 인사는 약 8초. 밝게 웃으며 작별한다.
      directive: "오늘 방송을 마무리한다. 기억에 남는 것을 짧게 한마디 하고, 함께해 줘서 고맙다고 밝게 웃으며 인사하고 다음 방송에서 또 만나자고 한다. 2문장. 감정은 happy.",
      fallbackLines: ["오늘 같이 메타도 보고 전적도 봐서 정말 즐거웠어요. 함께해 주셔서 고마워요, 다음 방송에서 또 만나요!"],
    },
  },
  // 대기·엔딩 장면에서는 보리가 말하지 않는다(사용자 결정 2026-10-15). 마무리 인사는 엔딩 화면 글로만 보인다.
  ending: { scene: "보리-엔딩", dashboard: ctx => ({ kind: "summary", characters: ctx.mentioned }), directive: "", fallbackLines: [] },
};
