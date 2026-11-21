# 이터널리턴 메타 대시보드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 방송·1:1 대화를 걷어내고, 보리 Live2D가 이터널리턴 메타 분석을 읽어 주는 대시보드로 바꾼다.

**Architecture:** 설계 문서 `docs/superpowers/specs/2026-11-21-er-meta-dashboard-design.md`를 따른다. 0단계에서 ER 코드를 중립 위치로 옮기고 대시보드 형식(타입)을 먼저 정한다. 그 뒤 서로 다른 파일을 건드리는 세 작업(T1 ER 집계 확장, T2 삭제, T3 대시보드·읽어 주기)을 Orca 워커가 각자 브랜치에서 병렬로 진행한다. 마지막에 코디네이터가 서버에 연결한다.

**Tech Stack:** Node 22, TypeScript, npm workspaces, React 19 + Vite 6, Electron, node:test(`node --import tsx --test`), 이터널리턴 Open API, OpenAI/Anthropic 구조화 출력, Fish·ElevenLabs·OpenAI TTS.

---

## 계획 구성

이 설계는 독립된 하위 작업 세 개라서 계획을 나눈다.

- 이 문서: 0단계 상세 단계, 세 작업의 범위·경계·완료 기준, 병합 순서, 마무리 단계
- 각 작업의 세부 TDD 계획: 그 작업을 맡은 워커가 자기 워크트리에서 `superpowers:writing-plans`로 `docs/superpowers/plans/2026-11-21-t<N>-<이름>.md`에 쓰고 실행한다.

공통 규칙(모든 작업):

- 주석·커밋 메시지는 한국어. 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- `maolili/`, `private-assets/`, `_local/`, `data/`는 커밋하지 않는다. `git add -f` 금지
- 테스트는 실제 `data/`에 쓰지 않는다(임시 폴더)
- 각 작업 끝에 `npm run typecheck`, `npm run test:unit`이 통과해야 한다. `npm test`(통합)는 T2 끝부터 통과해야 한다
- main 병합은 사용자 승인 뒤 코디네이터가 한다. 워커는 브랜치를 push하고 PR을 연다

## 파일 경계

| 작업 | 만들거나 고치는 곳 | 건드리지 않는 곳 |
|---|---|---|
| 0단계 | `apps/server/src/er/er-data.ts`(이동), `apps/server/test/wait.ts`, `packages/shared/src/index.ts`(타입 추가) | 그 밖 |
| T1 ER 집계 | `packages/er/**`, `apps/server/src/er/**`, `apps/server/test/er-*.test.ts`, `tools/test/fixtures/fake-er.mjs` | `apps/server/src/index.ts`, `apps/companion`, `apps/admin` |
| T2 삭제 | 방송·1:1·대화·기억 코드 전부, `apps/server/src/index.ts`, `apps/admin`, `tools/test`(fake-er 제외), `tools/eval`, `tools/obs`, 루트·서버 `package.json`, `package-lock.json`, `packages/{llm,character,memory,shared}`의 삭제 부분, 문서 | `packages/er`, `apps/server/src/er/**`, `apps/server/src/narration/**`, `apps/companion/src` |
| T3 대시보드 | `apps/companion/src/**`, `apps/companion/dev/**`, `apps/server/src/narration/**`, `apps/server/test/narration-*.test.ts` | `apps/server/src/index.ts`, `packages/er`, `apps/server/src/er/**` |
| 마무리 | `apps/server/src/index.ts`(연결), 통합 검사, README·`docs/index.html` 최종 | — |

`packages/shared`의 대시보드 타입은 0단계에서 정한다. 바꿔야 하면 코디네이터에게 묻는다(워커끼리 따로 바꾸지 않는다).

---

## 0단계: ER 코드 이동과 대시보드 형식 (코디네이터 직접)

### Task 0.1: 기다림 도우미를 공용 파일로

**Files:**
- Create: `apps/server/test/wait.ts`
- Modify: `apps/server/test/chzzk-fake.ts` (도우미를 다시 내보내기만)
- Modify: `apps/server/test/er-data.test.ts:13`

- [ ] **Step 1: `apps/server/test/wait.ts` 만들기**

```ts
/**
 * 검사가 같이 쓰는 기다림 도우미. 파일 이름이 *.test.ts가 아니라 검사로 직접 돌지 않는다.
 */

/** 조건이 참이 될 때까지 기다린다. 시간이 지나면 실패한다. */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`기다리다 시간이 지났습니다: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

- [ ] **Step 2: `chzzk-fake.ts`의 두 함수를 지우고 다시 내보내기**

`waitFor`와 `sleep` 정의(파일 끝 부분)를 지우고 이 한 줄로 바꾼다.

```ts
export { sleep, waitFor } from "./wait.js";
```

- [ ] **Step 3: `er-data.test.ts`가 공용 파일을 쓰게**

```ts
import { waitFor } from "./wait.js";
```

- [ ] **Step 4: 검사**

Run: `npm run test:unit`
Expected: 843개 통과, 실패 0

### Task 0.2: `er-data.ts`를 `er/`로 옮기고 연결 상태 타입 분리

**Files:**
- Move: `apps/server/src/show/er-data.ts` → `apps/server/src/er/er-data.ts`
- Modify: `apps/server/src/index.ts:30`, `apps/server/test/er-data.test.ts:11`
- Modify: `packages/shared/src/index.ts` (`ErConnection` 추가, `ShowConnections.er`가 그것을 씀)

- [ ] **Step 1: 파일 이동**

Run: `git mv apps/server/src/show/er-data.ts apps/server/src/er/er-data.ts`

- [ ] **Step 2: 상대 import 고치기** — 옮긴 파일의 `../config-file.js`는 같은 깊이라 그대로다. `index.ts:30`을 `import { createErData } from "./er/er-data.js";`로, `er-data.test.ts:11`을 `import { createErData } from "../src/er/er-data.js";`로 바꾼다.

- [ ] **Step 3: `ErConnection` 타입** — `packages/shared/src/index.ts`의 `ErPlayerReport` 다음에 추가하고, `ShowConnections`의 `er`가 이것을 쓰게 한다.

```ts
/** 이터널리턴 데이터 상태. 화면 배지와 자동 갱신 판단에 쓴다. */
export type ErConnection = "ready" | "stale" | "missing" | "refreshing";
```

```ts
export type ShowConnections = {
  chzzk: "off" | "connecting" | "connected" | "error";
  obs: "off" | "connecting" | "connected" | "error";
  er: ErConnection;
};
```

`apps/server/src/er/er-data.ts`의 import에서 `ShowConnections`를 `ErConnection`으로 바꾸고, `connection(): ErConnection`으로 고친다.

- [ ] **Step 4: 검사**

Run: `npm run typecheck && npm run test:unit`
Expected: 둘 다 통과

### Task 0.3: 대시보드 형식(타입) 추가

**Files:**
- Modify: `packages/shared/src/index.ts` (파일 끝에 추가)

- [ ] **Step 1: 설계 문서 4절의 타입을 그대로 추가**

```ts
// ── 이터널리턴 메타 대시보드 (2026-11-21 설계) ──

/** 캐릭터+무기 조합 하나의 집계. 비율은 0~1, 순위는 1이 1등. */
export type ErComboStat = {
  characterCode: number;
  characterName: string;
  /** 무기를 모르면 0과 "" */
  weaponCode: number;
  weaponName: string;
  participants: number;
  /** 전체 참가자 대비 */
  pickRate: number;
  avgRank: number;
  top1Rate: number;
  /** 랭크 MMR 증감 표본이 없으면 null */
  avgMmrGain: number | null;
  avgKills: number;
  avgAssists: number;
  avgDeaths: number;
  avgDamage: number;
  /** 많이 고른 코어 특성, 최대 2 */
  topTraits: Array<{ code: number; name: string; rate: number }>;
  /** 부위(0~4)별 많이 쓴 최종 장비, 부위마다 최대 2 */
  topEquipment: Array<{ slot: number; items: Array<{ code: number; name: string; rate: number }> }>;
  /** 참가자 30명 미만 */
  lowSample: boolean;
  /** 직전 갱신 대비 변화량. 직전 갱신이 없거나 그때 없던 조합이면 null */
  change: { avgRank: number; top1Rate: number; pickRate: number; avgMmrGain: number | null } | null;
};

/** 대시보드 집계의 기준. 화면과 보리 대사에 그대로 밝힌다. */
export type ErMetaBasisV2 = {
  seasonId: number;
  /** 게임 표기, 예: "시즌 13" */
  seasonName: string;
  /** 표본에서 가장 많은 패치, 예: "1.47". 모르면 null */
  patch: string | null;
  /** 집계한 경기 수 */
  games: number;
  /** 집계한 참가자 수(경기 수 × 참가자) */
  participants: number;
  rankers: number;
  gamesPerRanker: number;
  collectedAt: string;
  previousCollectedAt: string | null;
  /** 직전 갱신과 시즌이나 패치가 다르다 */
  patchChanged: boolean;
};

/** 대시보드 "내 전적" 칸. 닉네임은 본인 화면에만 보이고 로그·LLM에는 넣지 않는다. */
export type ErPlayerSummary = {
  nickname: string;
  seasonName: string;
  mmr: number | null;
  /** 0~1, 작을수록 상위 */
  rankPercent: number | null;
  games: number;
  avgRank: number;
  top1Rate: number;
  avgKills: number | null;
  avgAssists: number | null;
  /** 최근 경기, 최신 먼저, 최대 10 */
  recent: Array<{ characterName: string; weaponName: string; rank: number; kills: number; mmrGain: number | null }>;
  /** 많이 한 캐릭터, 최대 3. metaRank는 현재 메타 조합 순위(픽률 순)에서 그 캐릭터 최고 조합의 순위 */
  mainCharacters: Array<{ name: string; games: number; avgRank: number; metaRank: number | null }>;
};

/** 보리가 읽는 대사 한 줄. emotion은 packages/live2d의 감정 이름(boriEmotionNames). */
export type NarrationLine = { text: string; emotion: string; audioId?: string };

export type Narration = {
  id: string;
  createdAt: string;
  /** LLM이 썼는지, 정해진 문장인지 */
  source: "llm" | "template";
  lines: NarrationLine[];
};

export type DashboardPlayerStatus = "unset" | "loading" | "ready" | "not-found" | "error";

/** GET /api/dashboard 응답 */
export type DashboardState = {
  connection: ErConnection;
  refresh: { running: boolean; progress: number | null; lastError: string | null; autoStarted: boolean };
  basis: ErMetaBasisV2 | null;
  /** 픽률 순 */
  combos: ErComboStat[];
  player: { status: DashboardPlayerStatus; summary: ErPlayerSummary | null };
  narration: Narration | null;
};

/** GET/PUT /api/dashboard/settings */
export type DashboardSettings = { nickname: string | null };
```

- [ ] **Step 2: 검사**

Run: `npm run typecheck && npm run test:unit`
Expected: 둘 다 통과(아직 쓰는 곳 없음)

- [ ] **Step 3: 커밋**

```bash
git add apps/server/src/er apps/server/src/show apps/server/src/index.ts apps/server/test/wait.ts apps/server/test/chzzk-fake.ts apps/server/test/er-data.test.ts packages/shared/src/index.ts
git commit -m "구조: ER 데이터 모듈을 er/로 옮기고 대시보드 형식을 정한다"
```

- [ ] **Step 4: push 후 0단계 PR, 사용자 승인으로 main 병합.** 세 작업 브랜치는 병합된 main(또는 이 브랜치)에서 만든다.

---

## T1: ER 집계 확장 (워커)

**범위:** 설계 1절 전부와 4절의 데이터 부분.

- `packages/er`
  - `collectMeta`가 (캐릭터, 무기) 조합별로 센다. 원래 개수를 돌려주고, 비율 계산은 서버가 한다.
  - 랭크·현재 시즌만 거른다. 시즌 판정 필드는 실제 응답 픽스처로 확인한다.
  - 기준 패치와 경기 수·참가자 수를 따로 낸다.
  - 사전에 장비·특성 한국어 이름을 더한다.
  - `lookupPlayer`를 확장해 `ErPlayerSummary`에 필요한 값을 돌려준다.
  - 픽스처를 실제 필드 모양으로 늘린다(닉네임·uid는 가짜 값).
- `apps/server/src/er/`
  - `er-data.ts`가 새 집계를 저장한다.
  - 새 파일: `history.ts`(최근 10개 보존·직전 비교·`patchChanged`), `auto-refresh.ts`(24시간·시즌·하루 한 번 판정), `dashboard-settings.ts`(닉네임 파일), `dashboard-state.ts`(`DashboardState` 중 `connection`·`refresh`·`basis`·`combos`·`player`를 만드는 순수 함수와 전적 조회 상태)
  - 이 모듈들은 `index.ts`에 연결하지 않는다. 연결은 마무리 단계에서 한다.
  - 내보낼 인터페이스: `createErData(...)`, `createDashboardData({ erData, settingsFile, now })` → `{ state(): Omit<DashboardState,"narration">, maybeAutoRefresh(): boolean, refresh(): boolean, settings(), setSettings(s): Promise<void>, onRefreshed(cb) }`. 세부는 워커가 계획에서 정하고, `DashboardState` 형식은 바꾸지 않는다.
- 예전 형식 `data/er-meta.json`(stats만 있음)을 읽으면 `combos`가 빈 것으로 본다(`missing`). 다음 갱신 때 새 형식으로 쓴다.
- `tools/test/fixtures/fake-er.mjs`가 확장된 필드를 내주게 고친다(마무리 통합 검사용).

**완료 기준:** 단위 검사(집계·거르기·표본 기준·장비/특성 빈도·history 10개·비교·자동 갱신 판정·설정 파일·전적 요약), `npm run typecheck`, `npm run test:unit` 통과. 실제 키로 짧게 수집해 볼 때는 `BORI_DATA_DIR`를 임시 폴더로 하고, 랭커 수와 경기 수를 작게 잡는다(예: 랭커 3명, 1판). 결과 조합 수와 걸린 시간을 보고한다.

## T2: 방송·1:1·대화·기억 삭제 (워커)

**범위:** 설계 5절. 방송 삭제 조사 보고서 9절의 순서를 따르되, 이번에는 1:1 대화와 대화 엔진·기억도 지운다.

순서(단계마다 typecheck·test:unit 통과, 커밋):
1. 스튜디오(`apps/admin`)를 "대시보드 / 설정" 두 탭으로 줄인다.
   - 대시보드 탭은 지금의 1:1 iframe(`/companion/`)을 그대로 쓰고, 기본 탭으로 둔다.
   - 설정 탭에 남기는 것: LLM, TTS(Fish·ElevenLabs·OpenAI), 사용량, 이터널리턴 데이터(상태·갱신·오류). ER 패널은 OperateTab에서 옮긴다.
   - 게임 닉네임 입력칸은 `PUT /api/dashboard/settings`를 부르게 만든다. 서버 라우트는 마무리 단계에서 생기므로, 그 전에는 실패 메시지가 보여도 된다.
2. 통합 검사(`tools/test`)를 방송·1:1 경로에서 떼어 낸다.
   - 남기는 것: 보안·비밀·내구성·사용량처럼 대화와 무관한 검사. 남은 검사는 `/api/health`·`/api/llm`·`/api/tts` 같은 남는 라우트로 바꾼다.
   - 지우는 것: 대화 검사(behavior, latency, isolation, companion, concurrency, safety 등)와 방송 검사. `fake-er.mjs`는 T1 소유라 건드리지 않는다.
3. 서버에서 방송·1:1·대화 엔진을 지운다.
   - 대상: `obs/`, `chzzk/`, `show/`, `companion/`, `conversation/`, 방송·1:1 라우트, 큐 설정, `/api/diagnostics`, `/api/live2d/test`
   - `/private-*` 정적 경로를 `apps/companion/dist`로 바꾼다. 이걸 빠뜨리면 Live2D가 안 뜬다.
   - `/api/llm` 상태는 남은 LLM 클라이언트 하나만 보여 준다.
   - `/api/er/refresh`·`/api/er/status`, TTS·LLM·사용량 라우트는 남긴다. `er/`는 T1 소유라 건드리지 않는다.
   - `apps/broadcast`, `tools/obs`를 지운다.
4. `packages/memory`를 지우고, `packages/llm`·`packages/character`·`packages/shared`에서 대화 전용 부분을 지운다.
   - `packages/llm` 남김: 어댑터, 구조화 출력 경로(`overrideSchema`), TTS, 검사, 재시도, 가림, 사용량
   - `packages/character` 남김: 프로필 말투, 감정·모션 표
   - `UsageMode`에 `"narration"`을 더하고, 예전 `broadcast`·`companion` 줄은 읽기만 한다
   - `tools/eval`을 지운다
5. 의존성(`obs-websocket-js`, `socket.io-client`, `socket.io`)과 스크립트를 정리하고, `npm install`로 lock을 맞춘다.
   - CI(`.github/workflows/ci.yml`)에서 `eval` 줄을 지운다.
   - `npm test`가 통과해야 한다.
6. 문서
   - 지움: `docs/broadcast/`, `docs/chzzk-integration-review.md`, `docs/content/dialogue-scenarios.md`
   - 다시 씀: README, `docs/index.html`, operations, architecture
   - 덧붙임: `decisions.md`에 전환 ADR, `progress.md`에 전환 기록(`verification-log`는 그대로 둔다)

**주의:**
- `apps/companion/src`는 T3 소유다. 1:1 화면 코드를 지우지 말고 T3에게 맡긴다. 서버에서 `/api/conversations` 라우트가 사라져 1:1 화면이 깨지는 것은 괜찮다.
- 기존 `data/` 파일을 지우는 코드는 넣지 않는다.

**완료 기준:**
- `npm run typecheck`, `npm run test:unit`, `npm test`, `npm run build` 통과
- `npm run studio`로 켜서 대시보드 탭에서 Live2D 파일(`/private-core/live2dcubismcore.js`)이 200으로 오는지 확인
- 지운 줄 수를 보고

## T3: 대시보드 화면과 읽어 주기 (워커)

**범위:** 설계 2.1절, 3절.

- `apps/companion`을 대시보드로 바꾼다.
  - 채팅 부품을 지운다.
  - 새 부품(파일 하나에 하나의 역할): `Header`(기준·배지·갱신), `MetaTable`(정렬·▲▼·표본 적음), `Movers`, `CharacterDetail`, `PlayerCard`, `Narrator`(Live2D·자막·다시 듣기, 기존 `useBoriLive2D`·`reaction.ts` 재사용)
  - `api.ts`를 `DashboardState` 기준으로 다시 쓴다.
  - 갱신 중에는 2초, 평소에는 30초마다 폴링한다.
  - 새 `narration.id`가 오면 한 번 자동으로 읽는다(음성 켜기 설정을 따른다).
- 가짜 API(`apps/companion/dev/mock-api`)를 `DashboardState` 예시로 바꾼다. 서버 없이 `npm run dev:companion`으로 화면을 볼 수 있어야 한다.
- `apps/server/src/narration/` 새 모듈
  - `facts.ts`: `combos`·`basis`·`player`에서 사실 목록을 정해진 규칙으로 만든다. 설계 3절의 규칙과 반올림을 따른다.
  - `writer.ts`: LLM 구조화 출력으로 대사를 쓴다. 어댑터는 주입받는다.
  - `check.ts`: 숫자·캐릭터 이름 검사
  - `template.ts`: 정해진 문장
  - `store.ts`: `data/narration.json`을 원자적으로 쓴다
  - `index.ts`: `createNarrator({ llm, prepareAudio, store, now })` → `{ narrate(input): Promise<Narration>, latest(): Narration | null, replay(): Promise<Narration | null> }`
  - `index.ts`(서버 본체)에는 연결하지 않는다.
- 감정 이름은 `packages/live2d`의 감정 표(`boriEmotionNames`)에서 고른다. (2026-11-21 정정: 처음에는 `packages/character`로 잘못 적었다)
- LLM 어댑터는 `packages/llm`의 `LlmAdapter`와 `overrideSchema` 경로를 쓴다. 이 경로는 T2가 남긴다. 혹시 대화 전용 필드가 필수로 묶여 있으면, 얇은 호출 함수를 narration 안에 두고 코디네이터에게 알린다.

**완료 기준:**
- narration 단위 검사: 사실 목록, 숫자 검사 통과·버림, 정해진 문장 대체, LLM 실패, 저장
- companion typecheck와 화면 빌드 통과
- 가짜 API로 띄운 화면 캡처 2장: 데이터 있음 / 갱신 중
- `npm run typecheck`, `npm run test:unit` 통과

---

## 병합 순서

1. 0단계 → main
2. T1, T3 (파일이 겹치지 않음) → 각자 PR, 사용자 승인 후 병합
3. T2 → main 최신으로 rebase한 뒤 PR. T1·T3과 겹치는 곳은 `packages/shared`(T2는 지우기만 함)와 `packages/llm`이다.
4. 마무리

## 마무리 (코디네이터)

### Task F.1: 서버 연결

**Files:** `apps/server/src/index.ts`, `apps/server/test/dashboard-routes.test.ts`(새로)

- `createDashboardData`(T1)와 `createNarrator`(T3)를 만들고, `onRefreshed`에서 `narrate`를 부른다.
- 라우트: `GET /api/dashboard`(자동 갱신 판정 포함), `POST /api/er/refresh`, `GET/PUT /api/dashboard/settings`, `POST /api/narration/replay`
- 사용량 모드 `narration`

### Task F.2: 통합 검사

**Files:** `tools/test/dashboard.mjs`(새로), `tools/test/run.mjs`

가짜 ER과 가짜 OpenAI로 서버를 띄우고 다음을 확인한다.
- `GET /api/dashboard` → 자동 갱신 시작 → 끝나면 `combos`가 있음 → `narration.lines`가 있음 → 각 `audioId`가 `/api/tts/:id`로 200
- 닉네임을 PUT하면 `player.status`가 `ready`가 됨

### Task F.3: 실제 확인과 문서

- `npm run studio`를 실제 키로 켜고, CDP로 대시보드를 캡처해 사용자에게 보여 준다.
- README와 `docs/index.html`의 최종 문장을 다듬고, 설계 문서와 다른 점은 `decisions.md`에 적는다.
