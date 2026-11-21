# 이터널리턴 메타 대시보드 설계 (보리가 읽어 주는 메타 분석)

작성 2026-11-21. 브레인스토밍에서 사용자가 승인한 설계다.

## 0. 배경과 결정

- 치지직 OBS 방송 시스템(W1~W6)은 **전부 삭제**한다.
- 1:1 대화(친구 같은 채팅)도 **없앤다**. 보리는 대화 상대가 아니라 "오늘의 메타 분석"을 알려 주는 진행자다.
- 결과는 **대시보드 화면**으로 받는다. 알림·분석 글 파일은 만들지 않는다.
- 대시보드 옆에 **보리 Live2D**가 있고, 갱신 결과를 LLM이 수치만 근거로 쓴 대사 3~5줄로 **목소리로 읽는다**. 대화·기억은 없다.
- 데이터는 **앱을 켤 때 오래됐으면 자동 갱신 + 버튼**.
- **내 전적** 칸을 넣는다(설정에 게임 닉네임을 한 번 저장).
- TTS 업체는 지금처럼 고를 수 있게 둔다(Fish·ElevenLabs·OpenAI). 기본 목소리는 Fish "보리 목소리".
- 구조는 **A안**: `apps/companion`을 대시보드 앱으로 바꾸고, 스튜디오(`apps/admin`)는 "대시보드 / 설정" 두 탭으로 줄인다.

조사 근거: Orca 워커 3개 보고(ER API 확장, 방송 삭제 범위, 1:1 ER 연결), run_968a13ea1548.

## 1. 데이터

### 1.1 수집 (`packages/er`)

지금 받는 경기 상세(`/v1/games/{gameId}`, 1판 24행)에서 더 센다. **API 호출 수는 늘지 않는다.**

- 거르기: `matchingMode === 3`(랭크)이고 현재 시즌 경기만. 시즌 판정 필드는 응답에서 확인해 정한다(`seasonId` 또는 `versionSeason`). 표본에서 가장 많은 패치 버전(`versionMajor.versionMinor`)을 기준 정보에 저장한다.
- (캐릭터 `characterNum`, 무기 `bestWeapon`) 조합별로 센다.
  - 참가자 수, 순위 합, 1등 횟수
  - MMR 증감 합(`mmrGain`, 랭크 경기만 있음)과 그 표본 수
  - 킬(`playerKill`)·어시스트(`playerAssistant`)·데스(`playerDeaths`) 합
  - 플레이어 딜량(`damageToPlayer`) 합
  - 코어 특성(`traitFirstCore`) 빈도
  - 부위별 최종 장비(`equipment` 0~4) 빈도
- 캐릭터 단위 수치는 조합 수치를 합쳐서 낸다.
- 표본 정보를 바로잡는다. **경기 수**(`games`)와 **참가자 수**(`participants`)를 따로 둔다. 지금 "3,717판"은 참가자 수였다.
- 사전(`loadDictionary`)에 l10n의 `Item/Name/{code}`, `Trait/Name/{code}` 한국어 이름을 더한다. 같은 l10n 파일이라 호출이 늘지 않는다.
- 표본 기준: 조합 참가자 30명 미만은 `lowSample: true`. 화면에서는 흐리게 보이고, 보리 대사의 사실 목록에는 넣지 않는다.

### 1.2 전적 (`lookupPlayer` 확장)

이미 받는 응답에서 더 꺼낸다(추가 호출 0).

- `/v2/user/stats`: `mmr`, `rankPercent`, `averageKills`, `averageAssistants`, `top3` 비율
- `/v1/user/games/uid`: 최근 10판의 캐릭터·무기·순위·킬·MMR 증감
- 주캐릭터(판수 1위)가 현재 메타 조합 순위에서 몇 위인지는 서버가 메타와 맞춰 계산한다.
- 닉네임은 화면에만 보이고, 로그와 LLM 사실 목록에는 넣지 않는다.

### 1.3 저장 (`apps/server/src/er/`)

- `data/er-dictionary.json`: 사전 + 장비·특성 이름
- `data/er-meta.json`: 최신 집계(원래 개수 포함)와 기준 정보
- `data/er-history/<collectedAt>.json`: 갱신마다 하나씩, **최근 10개**만 남긴다. 비교 키는 캐릭터 `code` + 무기 `code`.
- `data/dashboard-settings.json`: 게임 닉네임. 원자적으로 쓴다(설정 파일 공통 방식 `config-file.ts`).
- 모든 쓰기는 지금처럼 원자적으로 한다. 갱신이 실패하면 지난 파일은 그대로 남는다.

### 1.4 비교

- 직전 갱신(history의 가장 최근 것)과 조합별로 비교한다. 변화량은 평균 순위·1등 비율·픽률·평균 MMR 증감이다.
- 시즌이나 기준 패치가 바뀌었으면 `patchChanged: true`. 비교는 하되 화면에 "패치 바뀜"을 표시한다.
- 직전 갱신이 없으면 변화량은 없다(`null`).

### 1.5 갱신 시점

- 대시보드가 열릴 때(`GET /api/dashboard`) 서버가 판단한다. 데이터가 없거나, `collectedAt`이 24시간 넘게 지났거나, 사전의 시즌이 현재 시즌이 아니면 **자동 갱신을 시작**한다. 하루에 한 번만 판정한다.
- 버튼: `POST /api/er/refresh`
- 표본: 랭커 100명 × 3판(최대 약 9분). 지금 쓰는 환경 변수 `BORI_ER_RANKERS`, `BORI_ER_GAMES_PER_RANKER`로 늘릴 수 있다.
- 갱신하는 동안 화면은 지난 데이터를 보여 주고 진행률을 표시한다.

## 2. 화면

### 2.1 대시보드 (`apps/companion` → 대시보드 앱, 서버 경로 `/companion/` 유지)

- 위 띠: 기준 정보(시즌·패치·경기 수·참가자 수·수집 시각), 데이터 상태 배지(최신 / 오래됨 / 없음 / 갱신 중), 갱신 버튼과 진행률
- 왼쪽: 보리 Live2D(지금의 `useBoriLive2D` 재사용), 지금 읽는 줄 자막, 다시 듣기 버튼
- 오른쪽 4구역
  1. **메타 TOP**: 캐릭터+무기 표. 픽률, 평균 순위, 1등 비율, 평균 MMR 증감, 지난번 대비 ▲▼. 열마다 정렬할 수 있다. 표본이 적은 조합은 흐리게.
  2. **오르고 내린 조합**: 변화량 상위·하위 5개씩
  3. **캐릭터 상세**: 표에서 고르면 무기별 비교, 코어 특성·부위별 장비 1~2위, 평균 킬·딜량
  4. **내 전적**: 닉네임이 없으면 설정 안내. 있으면 MMR·순위 백분위·평균 킬·최근 10판·주캐릭터의 메타 위치
- 지우는 1:1 화면 부품: `Composer`, `ConversationList`, `MessageList`, `MemoryDialog`, `ConfirmDialog`(대시보드에서 쓰지 않으면)
- 남기는 것: `live2d/*`, `preferences.ts`(음성 켜기), `api.ts`(새 API로 다시 씀), 스타일 기반

### 2.2 스튜디오 (`apps/admin`)

- 탭: **대시보드**(기본, `/companion/` iframe) / **설정**
- 설정 탭: 외부 LLM(업체·모델·키), 음성(업체 Fish·ElevenLabs·OpenAI, 키, 목소리), 게임 닉네임, 이터널리턴 데이터(상태·갱신·마지막 오류), API 사용량
- 지우는 것: 방송 운영 탭, 1:1 대화 탭, 방송 패널, 1:1 통계, 장기 기억 패널, 표정 테스트 패널
- Electron 쪽(`main.cjs`, `server-process.cjs`)은 그대로 둔다. `npm run studio` = `build:companion && build:admin && electron`

## 3. 보리가 읽어 주기 (`apps/server/src/narration/`)

1. **사실 목록**(정해진 규칙으로 만든다): 갱신이 끝나면 만든다.
   - 메타 TOP 3 조합, 크게 오른 조합 2개, 크게 내린 조합 1개, 새로 TOP 10에 든 조합, 내 주캐릭터의 메타 위치(닉네임이 있을 때), 패치가 바뀌었는지
   - 사실마다 `id`와 화면과 같은 반올림의 숫자 문자열을 둔다. 예: `{ id: "f3", text: "재키 쌍검 평균 순위 3.9위 → 3.4위 (참가자 412명)", numbers: ["3.9", "3.4", "412"] }`
2. **대사 생성**: `packages/llm` 어댑터의 구조화 출력(`overrideSchema`)으로 `{ lines: [{ text, emotion, factIds }] }`, 3~5줄을 받는다.
   - 시스템 지시: 보리 말투(존댓말), 사실 목록에 있는 것만 말하고, 수치 뒤에 '~같아요' 한마디를 붙여도 된다. 무기 특성·빌드 효과는 지어내지 않는다.
   - 감정은 `packages/live2d`의 감정 이름(`boriEmotionNames`) 중 하나를 고른다. (2026-11-21 정정: 처음에는 `packages/character`로 잘못 적었다)
3. **검사**: 줄마다 텍스트 안의 숫자(정규식 `\d+(\.\d+)?`)가 `factIds` 사실들의 `numbers`에 모두 있어야 한다. 아니면 그 줄을 버린다. 캐릭터 이름도 사전에 있는 이름만 허용한다. 남는 줄이 없거나 LLM이 실패·꺼짐이면 사실 목록에서 정해진 문장 3줄을 만든다.
4. **음성**: 지금의 `prepareAudio`(TTS 캐시)를 그대로 쓴다. 실패한 줄은 자막만 보여 준다.
5. **재생**: 대시보드는 새 대사가 생기면 한 번 자동으로 읽는다(음성 켜기 설정을 따른다). "다시 듣기"로 또 들을 수 있다. 줄마다 감정을 Live2D 표정에 보낸다(지금의 `reaction.ts` 연결).
6. 최신 대사는 `data/narration.json`에 원자적으로 저장해, 다시 켰을 때 갱신 없이도 마지막 분석을 보여 준다.
7. 사용량은 새 모드 `narration`으로 센다(LLM·TTS 모두). `UsageMode`에 더하고, 예전 `broadcast`·`companion` 줄은 읽기만 한다.

## 4. API (0단계에서 `packages/shared`에 타입으로 정한다)

```ts
type ErConnection = "ready" | "stale" | "missing" | "refreshing";

type ErComboStat = {
  characterCode: number; characterName: string;
  weaponCode: number; weaponName: string;     // 무기 모르면 0, ""
  participants: number; pickRate: number;     // 0~1, 전체 참가자 대비
  avgRank: number; top1Rate: number;
  avgMmrGain: number | null;                  // 표본 없으면 null
  avgKills: number; avgAssists: number; avgDeaths: number; avgDamage: number;
  topTraits: Array<{ code: number; name: string; rate: number }>;            // 최대 2
  topEquipment: Array<{ slot: number; items: Array<{ code: number; name: string; rate: number }> }>; // 부위별 최대 2
  lowSample: boolean;
  change: { avgRank: number; top1Rate: number; pickRate: number; avgMmrGain: number | null } | null; // 직전 갱신 대비
};

type ErMetaBasisV2 = {
  seasonId: number; seasonName: string; patch: string | null;  // "1.47" 등
  games: number; participants: number;
  rankers: number; gamesPerRanker: number;
  collectedAt: string; previousCollectedAt: string | null; patchChanged: boolean;
};

type ErPlayerSummary = {
  nickname: string;                 // 화면 표시용(대시보드는 본인 것만 보여 준다)
  seasonName: string; mmr: number | null; rankPercent: number | null;
  games: number; avgRank: number; top1Rate: number; avgKills: number | null; avgAssists: number | null;
  recent: Array<{ characterName: string; weaponName: string; rank: number; kills: number; mmrGain: number | null }>; // 최대 10, 최신 먼저
  mainCharacters: Array<{ name: string; games: number; avgRank: number; metaRank: number | null }>; // 최대 3
};

type NarrationLine = { text: string; emotion: string; audioId?: string };
type Narration = { id: string; createdAt: string; source: "llm" | "template"; lines: NarrationLine[] };

type DashboardState = {
  connection: ErConnection;
  refresh: { running: boolean; progress: number | null; lastError: string | null; autoStarted: boolean };
  basis: ErMetaBasisV2 | null;
  combos: ErComboStat[];            // 픽률 순
  player: { status: "unset" | "ready" | "not-found" | "error" | "loading"; summary: ErPlayerSummary | null };
  narration: Narration | null;
};
```

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `/api/dashboard` | `DashboardState`. 필요하면 자동 갱신을 시작한다(1.5) |
| POST | `/api/er/refresh` | 갱신 시작. `{ started: boolean }` |
| GET/PUT | `/api/dashboard/settings` | `{ nickname: string \| null }`. PUT하면 전적을 다시 조회한다 |
| POST | `/api/narration/replay` | 다시 듣기용. 최신 대사를 그대로 돌려준다(음성 없으면 다시 만든다) |
| GET | `/api/tts/:id` | 지금 그대로 |
| 기존 | `/api/llm`, `/api/tts`, `/api/usage`, `/api/health` | 남긴다 |

대시보드는 갱신 중에 2초마다 `/api/dashboard`를 폴링하고, 평소에는 30초마다 폴링한다.

## 5. 남기는 것 / 지우는 것

| 구역 | 남김 | 지움 |
|---|---|---|
| `apps/broadcast` | — | 전부 |
| `apps/server` | `http/*`, `config-file`, `load-env`, `secret-store`, `retention`, `usage/*`, `input-text`(쓰면), TTS·LLM 설정 라우트, 새 `er/`, 새 `narration/` | `obs/`, `chzzk/`, `show/`, `companion/`, `conversation/`, 방송·1:1 라우트, 큐 설정 검증 |
| `packages/er` | 전부(확장) | — |
| `packages/llm` | 어댑터(openai·anthropic), `tts`, `validate`, `retry`, `redact`, `usage` | 대화 프롬프트 조립, 요약(`summarize`), 방송·1:1 전용 타입 |
| `packages/character` | 프로필 말투, 감정·모션 표 | 대화 정책, 위기 답, 규칙 응답 |
| `packages/memory` | — | 전부 |
| `packages/live2d` | 전부 | — |
| `packages/shared` | ER·LLM·TTS·사용량·캐릭터 카탈로그 타입, 새 대시보드 타입 | 방송·대화·기억 타입 |
| `apps/admin` | 설정 탭(정리), 대시보드 탭 | 방송 운영 탭, 1:1 탭, 방송·기억·표정 패널 |
| `tools` | `test`(대시보드 흐름으로 다시 씀), `vite` | `obs`, `eval`(대화 평가) |
| `docs` | 기록 문서(decisions·progress·verification-log)는 남기고 전환 기록을 덧붙임 | `broadcast/`, `chzzk-integration-review.md`, `content/dialogue-scenarios.md` |

- 의존성: `obs-websocket-js`, `socket.io-client`, `socket.io`를 지우고 `npm install`로 `package-lock.json`을 다시 맞춘다.
- `/private-*` 정적 경로(Live2D 파일)의 뿌리를 `apps/broadcast/dist`에서 `apps/companion/dist`로 바꾼다. 방송 앱을 지우는 단계와 같은 커밋에서 한다(안 하면 Live2D가 안 뜬다).
- 기존 `data/` 파일(`memories.json`, 1:1 대화 기록)은 코드가 읽지 않게 되지만 **지우지 않는다**. 사용량 기록의 `broadcast`·`companion` 줄은 "이전 기록"으로 계속 읽는다.
- 문서: README와 `docs/index.html`(공개 포트폴리오)을 새 방향으로 다시 쓰고, `decisions.md`에 전환 ADR을 덧붙인다.

## 6. 오류 처리

| 상황 | 동작 |
|---|---|
| `ER_API_KEY` 없음 | 상태 `missing` + "키 없음" 안내, 갱신 버튼 비활성 |
| 갱신 중 실패 | 지난 파일 유지, `lastError` 표시. 자동 갱신은 그날 다시 시도하지 않는다 |
| 경기 하나·랭커 하나 실패 | 지금처럼 건너뛰고 계속 |
| LLM 키 없음·실패·회로 열림 | 정해진 문장 대사(`source: "template"`) |
| 대사 검사로 모든 줄이 버려짐 | 정해진 문장 대사 |
| TTS 실패 | 그 줄은 자막만 |
| 닉네임을 찾지 못함 | `player.status = "not-found"` |
| 전적 조회 실패 | `player.status = "error"`, 메타는 그대로 |

## 7. 검사

- 단위 검사
  - `packages/er`: 조합 집계, 시즌·모드 거르기, 경기 수/참가자 수, 표본 기준, 장비·특성 빈도(픽스처를 실제 필드 모양으로 늘린다)
  - 서버 `er/`: history 10개 유지, 비교·`patchChanged`, 자동 갱신 판정(24시간·시즌·하루 한 번), 설정 파일
  - `narration/`: 사실 목록, 숫자 검사(통과·버림), 정해진 문장 대체, LLM 실패
- 통합 검사(`tools/test`): 가짜 ER(`fake-er.mjs` 확장) + 가짜 OpenAI(`mock-openai.mjs`)로 서버를 띄워 "대시보드 열기 → 자동 갱신 → 대사 → 음성 id"까지
- `npm run typecheck`, `npm run test:unit`, `npm test`, CI 통과
- 실제 확인: `npm run studio`로 켜서 Live2D·표·대사 재생을 CDP 캡처로 본다

## 8. 작업 순서 (Orca 병렬)

- **0단계 (코디네이터 직접, 작은 PR)**: ER 코드를 `apps/server/src/show/`에서 `apps/server/src/er/`로 옮긴다(동작 변화 없음). `ErConnection` 타입을 분리하고, 4절 대시보드 타입을 `packages/shared`에 추가한다(아직 쓰지 않음). `waitFor` 테스트 헬퍼는 공용으로 옮긴다.
- **이후 워커 셋이 동시에 진행한다** (각자 브랜치·워크트리)
  1. **ER 집계 확장**: `packages/er`, 서버 `er/`(history·비교·자동 갱신·설정·`/api/dashboard` 데이터 부분)
  2. **삭제**: 방송·1:1·대화 엔진·기억·eval, admin 정리, 통합 검사 재작성, 의존성·lock, `/private-*` 경로, 문서
  3. **대시보드 화면 + 읽어 주기**: `apps/companion` 대시보드 UI(4절 타입에 맞춘 가짜 API로 개발), `apps/server/src/narration/` 모듈과 단위 검사
- **마무리 (코디네이터)**: 셋을 병합하고 `index.ts`에 `/api/dashboard`·`narration`을 연결한다. 통합 검사, 실제 화면 확인, README·공개 페이지 최종 정리.
- 병합 순서: 0 → 1·3(서로 다른 파일) → 2(서버 `index.ts` 크게 바뀜) → 마무리 연결. 워커 2가 `index.ts`를 줄이는 동안 다른 워커는 `index.ts`를 건드리지 않는다.
