# T3 대시보드 화면과 보리 읽어 주기 — 세부 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/companion`을 이터널리턴 메타 대시보드로 바꾸고, 갱신 결과를 보리가 3~5줄로 읽어 주는 `apps/server/src/narration/` 모듈을 만든다(서버 본체에는 연결하지 않는다).

**Architecture:** 총괄 계획(`2026-11-21-er-meta-dashboard.md`)의 T3 절과 설계 문서 2.1·3절을 따른다. 화면은 `DashboardState`(packages/shared, type import만)를 30초(갱신 중 2초)마다 받아 그린다. 숫자 모양은 `apps/companion/src/format.ts` 한 곳이 정하고, 서버 `narration/format.ts`가 같은 규칙인지 서버 검사가 두 함수를 같은 입력으로 돌려 고정한다. narration은 사실 목록 → LLM 대사(주입 함수) → 숫자·이름 검사 → (없으면) 정해진 문장 → 음성 준비 → 원자적 저장 순서다.

**Tech Stack:** React 19 + Vite 6, node:test(`node --import tsx --test`), TypeScript strict, Playwright(MCP)로 화면 캡처.

---

## 공통 규칙(이 작업)

- 고치는 곳: `apps/companion/src/**`, `apps/companion/dev/**`, `apps/companion/test/**`(코디네이터 승인), `apps/companion/index.html`(제목만, 승인), `apps/server/src/narration/**`, `apps/server/test/narration-*.test.ts`, 이 계획 문서.
- 건드리지 않는 곳: `apps/server/src/index.ts`, `packages/**`, `apps/server/src/er/**`, 루트·companion `package.json`, `vite.config.ts`.
- narration은 `@bori/llm`·`@bori/memory`를 import하지 않는다(코디네이터 공지: T2가 LlmRequest를 줄이고 memory를 지운다). LLM은 narration 안에 정의한 `NarrationLlm` 함수 타입으로 주입받는다. 파일 쓰기는 `../config-file.js`의 `createConfigFile`만 쓴다.
- 감정 이름은 `@bori/live2d`의 `boriEmotionNames`·`boriEmotionDescriptions`(코디네이터 확인).
- 닉네임은 사실 목록·LLM 입력·로그에 넣지 않는다. 픽스처는 가짜 이름(예: 닉네임 "테스트유저").
- 커밋 메시지 한국어, 끝에 빈 줄 + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 파일을 지정해 add.

## 정한 규칙(설계에 없던 세부)

| 항목 | 규칙 |
|---|---|
| 비율 | `formatPercent(0.1234)` → `"12.3%"`. `Math.round(rate*1000)/10`을 `toFixed(1)` |
| 순위 | `formatRank(3.94)` → `"3.9"`(화면은 뒤에 `위`) |
| 비율 변화 | `formatPointChange(0.012)` → `"+1.2%p"`, 0이면 `"0.0%p"` |
| 순위 변화 | `formatRankChange(-0.5)` → `"-0.5"` |
| MMR | `formatMmr(12.34)` → `"+12.3"`, 음수 `"-3.0"`, null → `"—"` |
| 개수 | `formatCount(7200)` → `"7,200"`(직접 쉼표, 로캘 무관) |
| 킬·딜 | `formatDecimal(4.25)` → `"4.3"`, 딜량은 `formatCount(Math.round(x))` |
| 변화량 부호 | `change.x = 이번 값 − 직전 값`(코디네이터 확인). 순위는 작아지면 좋아짐(▲) |
| 키 없음 | `refresh.available === false`(통합 브랜치 a157d4f에서 더한 필드)면 "키 없음" 배지와 갱신 버튼 비활성 |
| 오르고 내린 조합 | 표본 적음·`change` 없음 제외. 평균 순위 변화로 정렬(좋아진 순 5, 나빠진 순 5). 0은 제외 |
| 메타 TOP | 표본 적지 않은 조합 중 픽률 순 |
| 새 TOP 10 | 이번 TOP 10(표본 적음 제외) 중 `change === null`인 것(직전 갱신이 있을 때만) 또는 직전 픽률(=이번−변화)로 세운 순위가 10 밖인 것 |
| 숫자 검사 | 대사 줄의 `\d+(\.\d+)?` 전부가 그 줄 `factIds` 사실의 `numbers`에 있어야 한다. 사실의 `numbers`는 사실 문장에서 같은 정규식으로 뽑는다(쉼표 숫자 `7,200`은 `7`·`200`으로 양쪽이 같게 갈린다) |
| 이름 검사 | 입력 조합의 캐릭터·무기 이름 중 줄에 나온 것은 그 줄 `factIds` 사실의 `names`에 있어야 한다 |
| 감정 | `boriEmotionNames` 밖이면 `calm`으로 바꾼다 |
| 줄 | 앞뒤 공백 정리, 빈 줄·120자 넘는 줄 버림, 최대 5줄 |
| 정해진 문장 | 사실마다 둔 `spoken`(보리 말투 문장)을 우선순위대로 최대 3줄 |
| 자동 읽기 | 받은 `narration.id`가 이 브라우저에서 마지막으로 읽은 id(localStorage)와 다르면 한 번 읽는다. 음성 꺼짐이면 자막+입 모양만 |

## 파일 구조

### 서버 `apps/server/src/narration/`
- `format.ts` — 화면과 같은 숫자 모양 함수(companion `format.ts`와 같은 규칙)
- `facts.ts` — `buildFacts(input): NarrationFact[]`, `rankMovers(combos)`
- `check.ts` — `extractNumbers`, `checkLines(raw, facts, knownNames)`
- `template.ts` — `templateLines(facts)`
- `writer.ts` — `NarrationLlm` 타입, `NARRATION_SYSTEM_PROMPT`, `narrationSchema`, `writeLines(llm, facts, timeoutMs)`
- `store.ts` — `createNarrationStore(filePath)` (`load`, `save`)
- `index.ts` — `createNarrator(deps)`

### 화면 `apps/companion/src/`
- `format.ts` — 숫자·시각 모양
- `dashboard.ts` — 정렬·추세·움직인 조합·배지 문구·폴링 간격 같은 순수 규칙
- `narration-player.ts` — 줄 차례 재생(DOM 없이 검사)
- `api.ts` — `DashboardState` 클라이언트(다시 씀)
- `useDashboard.ts` — 폴링 훅
- `preferences.ts` — 음성 켜기 + 마지막으로 읽은 대사 id
- `components/Header.tsx`, `MetaTable.tsx`, `Movers.tsx`, `CharacterDetail.tsx`, `PlayerCard.tsx`, `Narrator.tsx`
- `App.tsx`, `styles.css` — 1920×1080 배치
- 지움: `components/Composer.tsx`, `ConversationList.tsx`, `MessageList.tsx`, `MemoryDialog.tsx`, `ConfirmDialog.tsx`, `ui.ts`(쓰는 함수만 옮김)
- `live2d/useBoriLive2D.ts` — 말이 끝날 때까지 기다리는 `speakLine` 추가, `react`가 감정 이름만 받아도 되게

### 가짜 API `apps/companion/dev/`
- `mock-store.ts` — 상태별 `DashboardState` 예시(ready·stale·missing·no-key·refreshing·error·patch-changed·empty), 갱신 흉내, 다시 듣기, 톤 wav
- `mock-api.ts` — `/api/dashboard`, `/api/er/refresh`, `/api/narration/replay`, `/api/dashboard/settings`, `/api/tts/:id`, `POST /__mock/scenario`, `POST /__mock/down`

### 검사
- `apps/server/test/narration-format.test.ts`, `narration-facts.test.ts`, `narration-check.test.ts`, `narration-template.test.ts`, `narration-writer.test.ts`, `narration-store.test.ts`, `narration-narrator.test.ts`
- `apps/companion/test/format.test.ts`, `dashboard.test.ts`, `narration-player.test.ts`, `companion.test.ts`(api·reaction·mock 계약으로 다시 씀), `ui.test.ts`(남는 model-status·preferences로 줄임)

---

### Task 1: 화면 숫자 모양 `apps/companion/src/format.ts`

**Files:** Create `apps/companion/src/format.ts`, Test `apps/companion/test/format.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatCount, formatDecimal, formatMmr, formatPercent, formatPointChange, formatRank, formatRankChange } from "../src/format";

describe("숫자 모양", () => {
  test("비율은 % 소수 한 자리", () => {
    assert.equal(formatPercent(0.1234), "12.3%");
    assert.equal(formatPercent(0.00049), "0.0%");
    assert.equal(formatPercent(0.0125), "1.3%");
    assert.equal(formatPercent(1), "100.0%");
  });
  test("순위는 소수 한 자리", () => {
    assert.equal(formatRank(3.94), "3.9");
    assert.equal(formatRank(4.05), "4.1");
  });
  test("변화량은 부호를 붙인다", () => {
    assert.equal(formatPointChange(0.012), "+1.2%p");
    assert.equal(formatPointChange(-0.0049), "-0.5%p");
    assert.equal(formatPointChange(0), "0.0%p");
    assert.equal(formatRankChange(-0.46), "-0.5");
    assert.equal(formatRankChange(0.3), "+0.3");
  });
  test("MMR·개수·소수", () => {
    assert.equal(formatMmr(12.34), "+12.3");
    assert.equal(formatMmr(-3), "-3.0");
    assert.equal(formatMmr(null), "—");
    assert.equal(formatCount(7200), "7,200");
    assert.equal(formatCount(1234567), "1,234,567");
    assert.equal(formatCount(12), "12");
    assert.equal(formatDecimal(4.25), "4.3");
  });
});
```

- [ ] **Step 2:** `node --import tsx --test apps/companion/test/format.test.ts` → 모듈 없음으로 실패
- [ ] **Step 3: 구현** — 한 자리 반올림 `round1 = x => Math.round(x * 10) / 10`. 부동소수 오차(0.0125*1000=12.499…)를 피하려 `Math.round(Number((x*10).toPrecision(12)))/10`처럼 12자리로 먼저 정리한다. `-0`은 `0`으로. 부호 함수 `signed(text, value)`는 0 초과에만 `+`.
- [ ] **Step 4:** 같은 명령 → 통과
- [ ] **Step 5:** 커밋 `기능: 대시보드 숫자 모양을 한 곳에서 정한다`

### Task 2: 서버 숫자 모양 `narration/format.ts` + 같은 규칙 고정

**Files:** Create `apps/server/src/narration/format.ts`, Test `apps/server/test/narration-format.test.ts`

- [ ] **Step 1: 실패하는 검사** — 같은 입력 표(0~1 사이 비율 2,001개, 순위 1~8 사이 0.005 간격, MMR −50~50, 개수)를 companion `../../companion/src/format.ts`와 narration `../src/narration/format.ts`에 넣어 결과가 모두 같은지 본다.

```ts
import * as screen from "../../companion/src/format.js";
import * as narration from "../src/narration/format.js";
for (let i = 0; i <= 2000; i += 1) assert.equal(narration.formatPercent(i / 2000), screen.formatPercent(i / 2000));
```

- [ ] **Step 2:** `node --import tsx --test apps/server/test/narration-format.test.ts` → 실패
- [ ] **Step 3:** companion과 같은 구현(주석으로 "화면 format.ts와 같은 규칙, 검사가 고정")
- [ ] **Step 4:** 통과. 서버 typecheck(`npm run typecheck:server`)가 companion 파일을 끌어와도 통과하는지 확인
- [ ] **Step 5:** 커밋 `기능: 보리 대사 숫자 모양을 화면과 같게 맞춘다`

### Task 3: 사실 목록 `narration/facts.ts`

**Files:** Create `apps/server/src/narration/facts.ts`, Test `apps/server/test/narration-facts.test.ts`

타입:

```ts
export type NarrationInput = { basis: ErMetaBasisV2 | null; combos: readonly ErComboStat[]; player: ErPlayerSummary | null };
export type NarrationFact = {
  id: string;                 // f1, f2 … 순서대로
  kind: "basis" | "top" | "riser" | "faller" | "newTop" | "main" | "patch";
  text: string;               // LLM에게 주는 사실 문장
  spoken: string;             // 정해진 문장(보리 말투)
  numbers: string[];          // text에서 \d+(\.\d+)? 로 뽑은 것
  names: string[];            // 이 사실에 나온 캐릭터·무기 이름
};
```

규칙(순서 = id 순서 = 정해진 문장 우선순위):
1. `top` — 메타 TOP 3(표본 적음 제외, 픽률 순): `"메타 1위 재키 쌍검: 픽률 8.1%, 평균 순위 3.4위, 1등 비율 14.0% (참가자 412명)"`
2. `riser` 2개 / `faller` 1개 — `rankMovers` 결과: `"재키 쌍검 평균 순위 3.9위 → 3.4위 (참가자 412명)"`. 직전 값 = 이번 − 변화.
3. `newTop` — 새로 TOP 10에 든 조합(최대 2): `"새로 픽률 TOP 10에 든 조합: 아야 권총 (픽률 5.1%)"`
4. `main` — 플레이어 요약이 있고 주캐릭터 1위가 있을 때: `"내 주캐릭터 재키: 최근 시즌 23판, 평균 순위 4.2위, 메타 조합 순위 2위"`(metaRank null이면 "메타 순위 밖"). **닉네임은 넣지 않는다.**
5. `patch` — `basis.patchChanged`일 때: `"시즌이나 패치가 지난번 갱신과 달라짐 (지금 패치 1.47)"`
6. `basis` — 기준(항상, basis 있을 때): `"집계 기준: 시즌 13 랭크, 경기 300판, 참가자 7,200명"`

정해진 문장 우선순위는 top1 → riser1 → patch → main → top2 → basis 순으로 고른다(Task 5).

- [ ] **Step 1: 실패하는 검사** — 픽스처 `combos`(가짜 캐릭터 6개, 그중 하나 lowSample, 변화량 섞음)로:
  - TOP 3에 표본 적은 조합이 없다, id가 f1부터 차례다
  - riser는 평균 순위 변화가 가장 음수인 2개, faller는 가장 양수인 1개, 화살표 문장의 직전 값이 맞다
  - 사실의 `numbers`가 `text`의 숫자와 같다(예: `["3.9","3.4","412"]`)
  - 플레이어 닉네임 "테스트유저"가 어느 사실의 text·spoken에도 없다
  - basis 없음·combos 비었음이면 빈 배열
  - patchChanged면 patch 사실이 있다
  - 직전 갱신이 없으면(previousCollectedAt null, change 모두 null) riser·faller·newTop이 없다
- [ ] **Step 2:** 실패 확인
- [ ] **Step 3:** 구현. `rankMovers(combos, limit)` → `{ risers, fallers }`(표본 적음·change null·변화 0 제외)
- [ ] **Step 4:** 통과
- [ ] **Step 5:** 커밋 `기능: 메타 집계에서 보리가 말할 사실 목록을 정해진 규칙으로 만든다`

### Task 4: 숫자·이름 검사 `narration/check.ts`

**Files:** Create `apps/server/src/narration/check.ts`, Test `apps/server/test/narration-check.test.ts`

```ts
export type RawLine = { text: string; emotion: string; factIds: string[] };
export const NUMBER_PATTERN = /\d+(\.\d+)?/g;
export function extractNumbers(text: string): string[];
export function checkLines(lines: readonly RawLine[], facts: readonly NarrationFact[], knownNames: readonly string[]): { kept: NarrationLine[]; dropped: { text: string; reason: string }[] };
```

- [ ] **Step 1: 실패하는 검사**
  - 사실 숫자만 쓴 줄은 통과, 없는 숫자(예: "3.5위")가 있으면 버림, 다른 사실 id의 숫자는 버림, 없는 factId는 무시(숫자가 있으면 결국 버림)
  - 숫자 없는 인사 줄은 factIds가 비어도 통과
  - 이름 검사: 알려진 이름 "아야"가 나왔는데 그 줄 사실의 names에 없으면 버림
  - 모르는 감정은 calm, 빈 줄·120자 초과 버림, 5줄까지만
- [ ] **Step 2~4:** 실패 확인 → 구현 → 통과
- [ ] **Step 5:** 커밋 `기능: 보리 대사의 숫자와 캐릭터 이름을 사실 목록과 맞춰 본다`

### Task 5: 정해진 문장 `narration/template.ts`

**Files:** Create `apps/server/src/narration/template.ts`, Test `apps/server/test/narration-template.test.ts`

- `templateLines(facts): NarrationLine[]` — 우선순위(top f1, riser 첫째, patch, main, top 둘째, basis)에서 있는 것 최대 3줄, `spoken`과 감정(top·riser·main은 gaming, patch는 curious, basis는 calm). 사실이 없으면 `[{ text: "아직 정리할 메타 데이터가 없어요. 데이터를 갱신하면 읽어 드릴게요.", emotion: "calm" }]`.
- [ ] **Step 1:** 검사 — 3줄, 줄마다 숫자가 사실 numbers 안(즉 checkLines를 통과), 빈 사실은 안내 한 줄
- [ ] **Step 2~4**
- [ ] **Step 5:** 커밋 `기능: LLM을 못 쓸 때 읽을 정해진 대사를 만든다`

### Task 6: 대사 쓰기 `narration/writer.ts`

**Files:** Create `apps/server/src/narration/writer.ts`, Test `apps/server/test/narration-writer.test.ts`

```ts
/** 코디네이터가 마무리 단계에서 packages/llm 어댑터에 연결한다. raw는 문자열(JSON) 또는 이미 푼 객체. */
export type NarrationLlmRequest = { systemPrompt: string; userPrompt: string; schema: object; timeoutMs: number; maxOutputTokens?: number };
export type NarrationLlm = (request: NarrationLlmRequest) => Promise<{ ok: true; raw: unknown } | { ok: false; reason: string }>;
export const NARRATION_SYSTEM_PROMPT: string;   // 아래 지시
export function narrationSchema(): object;       // { lines: [{ text, emotion(enum), factIds }] }
export function narrationUserPrompt(facts): string; // "[사실 목록]\nf1: …"
export async function writeLines(llm, facts, timeoutMs): Promise<{ ok: true; lines: RawLine[] } | { ok: false; reason: string }>;
```

시스템 지시 문장(보리 프로필과 맞춤: 한국어 존댓말, 감정 표현이 풍부하고 귀엽다, 좋아하는 게임 이터널리턴):
- 너는 이터널리턴 메타 분석을 읽어 주는 보리다. 감정 표현이 풍부하고 귀엽지만 수치는 정확히 말한다.
- 한국어 존댓말만 쓴다.
- [사실 목록]에 있는 수치와 캐릭터·무기 이름만 말한다. 목록에 없는 숫자를 만들거나 계산하지 않고, 숫자는 적힌 모양 그대로 쓴다.
- 무기 특성, 스킬, 빌드 효과, 패치 내용, 강해지거나 약해진 이유는 지어내지 않는다.
- 수치를 말한 뒤 '~같아요'처럼 짧은 생각을 한마디 붙여도 된다.
- 3~5줄로 말한다. 한 줄은 한두 문장, 80자 안쪽이다.
- 줄마다 근거 사실 id를 factIds에 넣는다. 수치를 말하지 않는 줄은 빈 배열이다.
- 듣는 사람은 화면 앞의 한 사람이다. 여러분·시청자·채팅 같은 방송 말은 쓰지 않는다.
- emotion은 아래 감정 중 하나를 고른다: (boriEmotionDescriptions 목록)

- [ ] **Step 1:** 검사 — 가짜 llm이 받은 요청에 사실 id·문장이 들어 있고 닉네임이 없다, 스키마 emotion enum이 `boriEmotionNames`와 같다, 문자열 raw·객체 raw 둘 다 풀린다, 깨진 JSON·모양 틀림은 `ok:false`, llm이 던지면 `ok:false`(이유 보존), 지시에 "존댓말"·"지어내지"가 있고 "여러분"을 쓰라는 말이 없다
- [ ] **Step 2~4**
- [ ] **Step 5:** 커밋 `기능: 사실 목록으로 보리 대사를 쓰는 LLM 호출을 둔다`

### Task 7: 저장 `narration/store.ts`

**Files:** Create `apps/server/src/narration/store.ts`, Test `apps/server/test/narration-store.test.ts`

- `createNarrationStore(filePath, warn?)` → `{ load(): Narration | null; save(narration): void }`. `createConfigFile(filePath, "보리 대사", warn)` 사용. load는 모양 검사(id·createdAt 문자열, source llm|template, lines 배열의 text·emotion 문자열, audioId 선택)를 통과한 것만.
- [ ] **Step 1:** 검사 — 임시 폴더(`mkdtempSync`)에 저장 후 다시 읽기, 파일 없음 null, 깨진 JSON은 null + 원본 `*.unreadable-*` 남김, 모양 틀림 null
- [ ] **Step 2~4**
- [ ] **Step 5:** 커밋 `기능: 최신 보리 대사를 파일에 원자적으로 남긴다`

### Task 8: `createNarrator` `narration/index.ts`

**Files:** Create `apps/server/src/narration/index.ts`, Test `apps/server/test/narration-narrator.test.ts`

```ts
export type NarratorDeps = {
  /** null이면 LLM을 쓰지 않는다(꺼짐·키 없음·회로 열림은 주입하는 쪽이 판단) */
  llm: NarrationLlm | null | (() => NarrationLlm | null);
  prepareAudio: (text: string) => Promise<string | undefined>;
  /** 저장된 음성이 아직 캐시에 있는지. 없으면 다시 듣기 때 새로 만든다. 주지 않으면 있다고 본다 */
  hasAudio?: (audioId: string) => boolean;
  store: NarrationStore;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;      // 기본 20000
  log?: (message: string) => void;
};
export function createNarrator(deps): { narrate(input): Promise<Narration>; latest(): Narration | null; replay(): Promise<Narration | null> };
```

- narrate: facts → (llm 있으면 writeLines → checkLines) → kept 비면 template → 줄마다 차례로 prepareAudio(실패·undefined면 audioId 없음) → 저장(실패는 log, 대사는 돌려줌) → latest 갱신. 동시에 두 번 부르면 차례로 돈다.
- latest: 처음엔 store.load().
- replay: latest가 없으면 null. audioId가 없거나 hasAudio false인 줄만 prepareAudio 다시, 바뀌었으면 저장.
- 로그에는 버린 줄 수와 이유 종류만 남긴다(대사 본문·닉네임 없음).

- [ ] **Step 1:** 검사 — LLM 성공(source llm, 검사 통과 줄만), LLM이 지어낸 숫자 줄만 주면 template, LLM 실패·null이면 template, TTS 실패 줄은 audioId 없음, 저장 후 새 narrator가 latest로 읽음, replay가 없는 음성만 다시 만듦, 저장 실패해도 대사 반환
- [ ] **Step 2~4**
- [ ] **Step 5:** 커밋 `기능: 사실 목록·대사·검사·음성·저장을 묶는 narrator를 만든다`

### Task 9: 화면 규칙 `apps/companion/src/dashboard.ts`

**Files:** Create `apps/companion/src/dashboard.ts`, Test `apps/companion/test/dashboard.test.ts`

```ts
export type SortKey = "pickRate" | "avgRank" | "top1Rate" | "avgMmrGain" | "participants";
export function sortCombos(combos, key, direction: "asc" | "desc"): ErComboStat[];  // null MMR은 항상 뒤
export function defaultDirection(key): "asc" | "desc";   // avgRank만 asc
export type Trend = "up" | "down" | "flat";
export function trendOf(metric: "avgRank" | "top1Rate" | "pickRate" | "avgMmrGain", change: ErComboStat["change"]): Trend | null; // 순위는 작아지면 up
export function selectMovers(combos, limit = 5): { risers: ErComboStat[]; fallers: ErComboStat[] }; // narration rankMovers와 같은 규칙
export function comboKey(combo): string;   // `${characterCode}:${weaponCode}`
export function comboLabel(combo): string; // "재키 쌍검", 무기 없으면 이름만
export function connectionBadge(state): { tone: "ok" | "warn" | "muted" | "busy"; label: string };
export function refreshView(state): { buttonLabel: string; disabled: boolean; progressText: string | null; notice: string | null };
export function pollIntervalMs(state | null): number;  // 갱신 중 2000, 아니면 30000
export function shouldAutoPlay(narration, lastPlayedId): boolean;
export const EQUIPMENT_SLOT_LABELS = ["무기", "옷", "머리", "팔", "다리"];
```

- [ ] **Step 1:** 검사(정렬 방향·null 처리, 추세 방향, movers가 server `rankMovers`와 같은 결과인지는 Task 2처럼 서버 검사 `narration-facts.test.ts`에 추가, 배지 4상태+키 없음, 갱신 버튼 비활성(갱신 중·키 없음), 진행률 문구 `"갱신 중 42%"`, 폴링 간격, 자동 읽기 판단)
- [ ] **Step 2~4**
- [ ] **Step 5:** 커밋 `기능: 대시보드 정렬·추세·배지 규칙을 화면 밖 함수로 둔다`

### Task 10: 대사 차례 재생 `narration-player.ts`

**Files:** Create `apps/companion/src/narration-player.ts`, Test `apps/companion/test/narration-player.test.ts`

```ts
export type PlayerDeps = {
  react(emotion: string): void;
  speak(line: NarrationLine, useAudio: boolean): Promise<"audio" | "text" | "audioBlocked" | "audioFailed">;
  onLine(index: number | null): void;   // 자막. 끝나면 null
};
export async function playNarration(lines, deps, options: { audio: boolean; signal: { cancelled: boolean } }): Promise<"done" | "cancelled" | "audioBlocked">;
```
- 줄마다 onLine(i) → react(emotion) → speak. audioBlocked가 나오면 남은 줄은 글자로(useAudio false) 계속하고 결과로 알린다. 취소되면 바로 멈춘다.
- [ ] **Step 1~4:** 검사(순서, 감정 전달, 음성 꺼짐이면 useAudio false, 차단 뒤 글자, 취소) → 구현
- [ ] **Step 5:** 커밋 `기능: 대사를 줄마다 표정·자막과 함께 차례로 읽는다`

### Task 11: API 클라이언트와 가짜 API

**Files:** Modify `apps/companion/src/api.ts`, `apps/companion/dev/mock-store.ts`, `apps/companion/dev/mock-api.ts`, `apps/companion/test/companion.test.ts`

- `api.ts`: `readResponse`·`ApiError`·`errorKindForStatus`(notFound·conflict·badRequest·server·disconnected) 유지, `api = { getDashboard, refresh, replayNarration }`. 타입은 `import type { DashboardState, Narration } from "@bori/shared"`.
- `mock-store.ts`: `createMockStore(scenario)`, 시나리오 `ready | stale | missing | no-key | refreshing | error | patch-changed | empty-player | not-found`. 가짜 캐릭터 이름은 실제 게임 캐릭터 이름을 써도 된다(공개 정보), 닉네임은 "테스트유저". `refresh()`를 부르면 running → 진행률이 0.1씩 오르고 끝나면 새 narration id. `replay()`는 audioId를 새로 붙여 돌려준다. `no-key`는 connection missing + `refresh.available: false`.
- `mock-api.ts`: 위 경로 + `POST /__mock/scenario {name}` + 기존 `/__mock/down`.
- 검사: 시나리오마다 `DashboardState` 모양(필수 키, combos 픽률 순, 표본 적은 조합 1개 이상), refresh 진행, replay, 없는 경로 404, `readResponse` 분류(기존 검사 유지), `planReaction` 검사 유지.
- [ ] **Step 1~4**
- [ ] **Step 5:** 커밋 `기능: 대시보드 API 클라이언트와 상태별 가짜 API`

### Task 12: 화면 부품과 배치

**Files:** Create `components/{Header,MetaTable,Movers,CharacterDetail,PlayerCard,Narrator}.tsx`, `useDashboard.ts`; Modify `App.tsx`, `styles.css`, `preferences.ts`, `live2d/useBoriLive2D.ts`, `live2d/reaction.ts`(타입만 자체 정의), `index.html` 제목; Delete 채팅 부품·`ui.ts`; Modify `apps/companion/test/ui.test.ts`

- 배치(1920×1080): 위 띠 72px(기준·배지·갱신 버튼·진행 막대), 아래 그리드 `420px | 1fr | 1fr`: 왼쪽 Narrator(Live2D 층, 자막 상자, 다시 듣기·음성 켜기), 가운데 위 MetaTable(세로 스크롤), 가운데 아래 Movers, 오른쪽 위 CharacterDetail, 오른쪽 아래 PlayerCard. 좁은 창(<1280)은 한 열.
- MetaTable: 열 헤더 버튼으로 정렬(`aria-sort`), 행 클릭으로 캐릭터 선택, `lowSample` 행은 `.low-sample`(흐리게 + "표본 적음" 표시), 변화는 ▲▼ 색과 `aria-label`.
- Header: 기준 정보, 배지(최신·오래됨·없음·갱신 중·키 없음), "패치 바뀜" 배지, 오류 문구, 진행 막대.
- Narrator: `useBoriLive2D` 상태 배지(모델 없음 문구), 자막(지금 읽는 줄 강조, 전체 줄 목록), 다시 듣기(`api.replayNarration` 후 재생), 음성 켜기.
- useDashboard: `pollIntervalMs`로 setTimeout 폴링, 끊기면 안내 띠, 갱신 버튼은 `api.refresh` 후 즉시 다시 받기.
- 자동 읽기: `shouldAutoPlay` → `playNarration`, 읽기 시작하면 lastPlayedId 저장.
- ui.test.ts: model-status·preferences 검사만 남긴다.
- [ ] **Step 1:** `npm run typecheck:companion`, `npm --workspace apps/companion run build`, `npm run test:unit`
- [ ] **Step 2:** 커밋 `기능: 1:1 채팅 화면을 메타 대시보드로 바꾼다`

### Task 13: 화면 캡처와 마무리 검사

- [ ] `npm --workspace apps/companion run dev:mock`(4175) 띄우고 Playwright로 1920×1080 `/companion/` 캡처: 시나리오 ready → `C:\Users\stven\AppData\Local\Temp\claude\7bf9b5ab337f088d\47c874e0-6046-4eab-a302-d7e8afb96b48\scratchpad\dashboard-ready.png`, refreshing → `…\dashboard-refreshing.png`. 저장소에 넣지 않는다.
- [ ] 자막·다시 듣기·감정 전달은 콘솔 `[bori] emotion=…` 로그로 확인
- [ ] `npm run typecheck`, `npm run test:unit` 전체 통과 확인(출력 숫자 기록)
- [ ] push, `gh pr create --base feature/er-meta-dashboard`
