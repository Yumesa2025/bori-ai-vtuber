# T1 ER 집계 확장 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이터널리턴 경기 상세에서 (캐릭터, 무기) 조합별 원래 개수를 모으고, 서버 `er/`가 그것을 저장·비교·자동 갱신 판정해 `DashboardState`의 `connection`·`refresh`·`basis`·`combos`·`player`를 만든다.

**Architecture:** `packages/er`는 API에서 원래 개수(합·횟수)만 모은다. 비율·변화량·표본 기준은 서버 `apps/server/src/er/`의 순수 함수가 계산한다. 갱신마다 집계를 `data/er-history/`에 하나씩 남기고(최근 10개), 직전 것과 비교한다. 대시보드 조립(`createDashboardData`)은 `index.ts`에 연결하지 않는다(마무리 단계에서 코디네이터가 연결). 기존 방송 경로(`stats()`·`top5()`·`basis()`·`lookupPlayer()`)는 T2가 지울 때까지 `er/legacy.ts` 변환으로 계속 동작한다.

**Tech Stack:** Node 22+, TypeScript, node:test(`node --import tsx --test`), 이터널리턴 Open API.

설계: `docs/superpowers/specs/2026-11-21-er-meta-dashboard-design.md` 1절·4절. 총괄 계획: `docs/superpowers/plans/2026-11-21-er-meta-dashboard.md`의 T1.

---

## 실제 응답으로 정한 것 (2026-11-21 조사 원문 확인)

- 경기 상세 `/v1/games/{id}` 행: `seasonId`(43 = `/v2/data/Season`의 `seasonID` 43, Season22), `versionSeason`(13 = 게임 표기 시즌 13), `versionMajor` 1, `versionMinor` 0.
- **시즌 판정 필드는 `seasonId`로 한다.** 사전의 `seasonId`(Season API `seasonID`)와 같은 번호 체계라 바로 비교된다. `versionSeason`은 게임 표기 번호라 사전과 맞추려면 `EARLY_ACCESS_SEASONS` 변환이 필요하다. 유저 경기 목록(`/v1/user/games/uid`) 행에도 `seasonId`가 있어(`versionSeason`은 없음) 경기 상세를 받기 전에 지난 시즌 경기를 걸러 호출을 아낀다.
- 패치는 설계대로 `"${versionMajor}.${versionMinor}"`(실제 값 "1.0"). 경기 수 기준 최빈값, 같으면 큰 버전.
- 랭크 행에만 `mmrGain`이 있다. 킬 `playerKill`, 어시 `playerAssistant`, 데스 `playerDeaths`, 딜 `damageToPlayer`, 코어 특성 `traitFirstCore`, 장비 `equipment`(`{"0":코드,…,"4":코드}`).
- l10n: `Item/Name/{code}`(1127개, `_D` 같은 변형 키는 빼고 숫자 키만), `Trait/Name/{code}`(184개).
- `/v2/user/stats`: `mmr`, `rankPercent`, `averageKills`, `averageAssistants`.
- Season API `seasonEnd`는 `"2027-02-18 09:00:00"` 형식이다. 시간대 표기가 없어 한국 시간(+09:00)으로 읽는다(경기 `startDtm`이 +0900이라 그렇게 본다. 공식 문서로 확인하지 못함).

## 파일 구조

| 파일 | 역할 |
|---|---|
| `packages/er/src/dictionary.ts` | 사전에 `itemNames`·`traitNames`·`seasonEnd` 추가 |
| `packages/er/src/meta.ts` | `collectMeta` → `ErMetaCollection`(조합별 원래 개수 + 기준) |
| `packages/er/src/player.ts` | `lookupPlayer` → `ErPlayerLookup`(ErPlayerSummary 재료 + 주캐릭터 code) |
| `packages/er/src/index.ts` | 새 타입 내보내기 |
| `packages/er/test/fixtures/*` | 실제 필드 모양으로 늘림(가짜 닉네임·uid) |
| `apps/server/src/er/combos.ts` | 원래 개수 → `ErComboStat`·`ErMetaBasisV2`, 비교·`patchChanged`(순수) |
| `apps/server/src/er/history.ts` | `data/er-history/` 최근 10개 보존, 직전 집계 찾기 |
| `apps/server/src/er/auto-refresh.ts` | 갱신 필요 판정(순수) + 하루 한 번 문 |
| `apps/server/src/er/dashboard-settings.ts` | `data/dashboard-settings.json` 닉네임 |
| `apps/server/src/er/legacy.ts` | 예전 방송 경로용 변환(`ErCharacterStat`·`ErMetaBasis`·`ErPlayerReport`). T2가 방송을 지운 뒤 같이 지운다 |
| `apps/server/src/er/er-data.ts` | 새 형식 저장·읽기, history, `onRefreshed`, `lookupPlayerSummary` |
| `apps/server/src/er/dashboard-state.ts` | `createDashboardData` |
| `apps/server/test/er-*.test.ts` | 단위 검사 |
| `tools/test/fixtures/fake-er.mjs` | 확장 필드는 고정 자료에서 그대로 나간다. 설명만 고친다 |

파일 쓰기는 `createConfigFile`(원자적)과 `node:fs`(목록·오래된 history 삭제)만 쓴다. `@bori/memory`를 직접 import하지 않는다(T2가 지운다).

## 타입

```ts
// packages/er/src/meta.ts
export type ErComboTally = {
  characterCode: number;
  weaponCode: number;          // 모르면 0
  participants: number;
  rankSum: number;
  top1: number;
  mmrGainSum: number;
  mmrGainSamples: number;
  kills: number; assists: number; deaths: number; damage: number;
  traits: Record<string, number>;                     // 코어 특성 코드 → 횟수
  equipment: Record<string, Record<string, number>>;  // 부위 "0"~"4" → 장비 코드 → 횟수
};
export type ErMetaCollectionBasis = {
  seasonId: number; seasonName: string; patch: string | null;
  games: number; participants: number;
  rankers: number;          // uid를 찾은 랭커 수
  gamesPerRanker: number;
  collectedAt: string;
};
export type ErMetaCollection = { combos: ErComboTally[]; basis: ErMetaCollectionBasis };

// packages/er/src/player.ts
export type ErPlayerLookup = Omit<ErPlayerSummary, "mainCharacters"> & {
  mainCharacters: Array<{ code: number; name: string; games: number; avgRank: number }>;
};
```

```ts
// apps/server/src/er/dashboard-state.ts
export type DashboardData = {
  state(): Omit<DashboardState, "narration">;
  maybeAutoRefresh(): boolean;          // GET /api/dashboard 마다 부른다. 하루 첫 호출에만 판정
  refresh(): boolean;                   // 버튼. 시작했으면 true
  settings(): DashboardSettings;
  setSettings(next: DashboardSettings): Promise<void>; // 저장 후 전적 조회가 끝날 때까지 기다린다(갱신 중이면 갱신 뒤로 미룸)
  onRefreshed(listener: (state: Omit<DashboardState, "narration">) => void): () => void; // 갱신 성공 + 전적 다시 조회 뒤
};
export function createDashboardData(options: { erData: ErData; settings: DashboardSettingsStore; now?: () => number }): DashboardData;
```

계산 규칙:
- `pickRate = participants / basis.participants`, `avgRank = rankSum / participants`, `top1Rate = top1 / participants`, `avgMmrGain = mmrGainSamples > 0 ? mmrGainSum / mmrGainSamples : null`, 킬·어시·데스·딜은 `/ participants`.
- `topTraits` 최대 2개, `rate = 횟수 / participants`. `topEquipment`는 부위 0~4 순, 부위마다 최대 2개, `rate = 횟수 / participants`. 같은 횟수면 코드가 작은 쪽.
- `lowSample = participants < 30`.
- `combos` 정렬: 픽률(참가자) 내림차순 → 평균 순위 오름차순 → 캐릭터 코드 → 무기 코드.
- `change`: 직전 집계에 같은 `characterCode`+`weaponCode`가 있으면 `현재 - 직전`(avgMmrGain은 둘 다 있을 때만, 아니면 null). 없으면 null. 직전 집계가 없으면 모두 null.
- `patchChanged`: 직전이 있고 `seasonId`나 `patch`가 다르다.
- 이름: 캐릭터 사전에 없으면 `캐릭터 ${code}`, 무기 0이면 `""`, 특성 `특성 ${code}`, 장비 `장비 ${code}`.
- `metaRank`: `combos`(픽률 순)에서 그 캐릭터가 처음 나오는 위치(1부터). 없으면 null.

자동 갱신 판정(`refreshReason`):
- 집계 없음 → `"missing"`
- `now - collectedAt > 24시간` → `"old"`
- 사전 `seasonEnd`가 지났거나 집계 `seasonId`가 사전과 다르다 → `"season"`
- 아니면 null
- 하루 문: 한국 날짜(UTC+9) 기준으로 그날 첫 `maybeAutoRefresh`만 판정한다. 판정 뒤 갱신이 실패해도 그날은 다시 판정하지 않는다. 문 상태는 메모리에만 둔다(앱을 다시 켜면 다시 판정).

`connection`:
- 갱신 중 `refreshing` → 키 없음 `missing` → 사전이나 새 형식 집계 없음 `missing` → `collectedAt` 24시간 넘음 `stale` → `ready`.
- 키가 없으면 `refresh.lastError`에 "ER_API_KEY가 없어 …"를 넣는다.

---

### Task 1: 사전에 장비·특성 이름과 시즌 끝 시각

**Files:** Modify `packages/er/src/dictionary.ts`, `packages/er/test/fixtures/l10n-korean.txt`; Test `packages/er/test/dictionary.test.ts`

- [ ] **Step 1: 실패하는 검사** — `dictionary.test.ts`에 추가

```ts
test("장비·특성 한국어 이름과 현재 시즌 끝 시각을 담는다", async () => {
  const dict = await loadDictionary(fakeClient(dictionaryRoutes()));
  assert.equal(dict.itemNames[117406], "저지먼트");
  assert.equal(dict.traitNames[7000601], "아드레날린");
  // 숫자가 아닌 변형 키(202529_D)는 넣지 않는다
  assert.equal(Object.keys(dict.itemNames).some((key) => !/^\d+$/.test(key)), false);
  // "2026-11-12 09:00:00"은 한국 시간으로 읽는다
  assert.equal(dict.seasonEnd, "2026-11-12T00:00:00.000Z");
});
```

l10n 고정 자료에 `Item/Name/117406┃저지먼트`, `Item/Name/202529┃화령장`, `Item/Name/202529_D┃화령장 [다비드]`, `Trait/Name/7000601┃아드레날린`, `Trait/Name/7000201┃취약` 등 집계 검사에 쓰는 코드를 더한다.

- [ ] **Step 2: 실행해 실패 확인** — `node --import tsx --test packages/er/test/dictionary.test.ts` → `itemNames` undefined로 실패
- [ ] **Step 3: 구현** — `ErDictionary`에 `itemNames: Record<number,string>`, `traitNames: Record<number,string>`, `seasonEnd: string | null`. l10n 맵에서 `/^Item\/Name\/(\d+)$/`, `/^Trait\/Name\/(\d+)$/` 키만 모은다. `seasonEnd`는 `"YYYY-MM-DD HH:mm:ss"` → `"YYYY-MM-DDTHH:mm:ss+09:00"` → ISO, 못 읽으면 null.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `npm run typecheck:er`
- [ ] **Step 5: 커밋** `기능: ER 사전에 장비·특성 이름과 시즌 끝 시각을 더한다`

### Task 2: 조합별 원래 개수 집계

**Files:** Modify `packages/er/src/meta.ts`, `packages/er/src/index.ts`, fixtures `game-1001.json`·`game-1002.json`(필드 추가: `seasonId` 41, `versionSeason` 12, `versionMajor` 7, `versionMinor` 0, `matchingTeamMode` 3, `mmrGain`, `playerKill`, `playerAssistant`, `playerDeaths`, `damageToPlayer`, `traitFirstCore`, `equipment`, 가짜 `nickname`); Test `packages/er/test/meta.test.ts`(다시 씀)

손계산(2경기 × 4명, 참가자 8):
- 1001: 재키·단검 1등, 아야·권총 2등, 피오라·레이피어 3등, 재키·양손검 4등(`mmrGain` 없음)
- 1002: 아야·권총 1등, 재키·단검 2등, 아야·돌격 소총 3등, 리 다이린·글러브 4등
- (재키, 단검): 참가자 2, 순위 합 3, 1등 1, MMR 40+25(표본 2), 킬 5+4, 특성 7000201 ×2, 장비 부위 0 117406 ×1 …

- [ ] **Step 1: 실패하는 검사**

```ts
test("상위 랭커의 이번 시즌 랭크 경기를 (캐릭터, 무기) 조합별 원래 개수로 모은다", async () => {
  const { dict, client } = await setup();
  const { combos, basis } = await collectMeta(client, dict, { rankers: 2, gamesPerRanker: 2, now: () => Date.parse("2026-11-21T00:00:00Z") });
  assert.deepEqual(combos.map((c) => [c.characterCode, c.weaponCode, c.participants]), [[1, 15, 2], [2, 9, 2], [1, 16, 1], [2, 10, 1], [3, 21, 1], [10, 1, 1]]);
  assert.deepEqual(combos[0], { characterCode: 1, weaponCode: 15, participants: 2, rankSum: 3, top1: 1, mmrGainSum: 65, mmrGainSamples: 2, kills: 9, assists: 8, deaths: 3, damage: 36000, traits: { "7000201": 2 }, equipment: { "0": { "117406": 1, "118403": 1 }, … } });
  assert.deepEqual(basis, { seasonId: 41, seasonName: "시즌 12", patch: "7.0", games: 2, participants: 8, rankers: 2, gamesPerRanker: 2, collectedAt: "2026-11-21T00:00:00.000Z" });
});
test("다른 시즌·랭크 아닌 행과 경기는 세지 않는다", …); // 경기 목록의 seasonId 40 경기는 상세를 받지 않고, 상세 행 중 seasonId·matchingMode가 다른 행은 뺀다
test("무기를 모르는 행은 무기 0으로 센다", …);
test("패치는 경기 수 최빈값, 같으면 큰 버전, 버전 필드가 없으면 null", …);
test("MMR 증감이 없는 행은 MMR 표본에서 뺀다", …); // 재키·양손검 mmrGainSamples 0
```

기존 검사(호출 순서·건너뛰기·진행률·빈 경기·랭커 목록 오류)는 새 반환 모양으로 고쳐 남긴다. 예전 `description`(천 단위 쉼표) 검사는 legacy로 옮긴다.

- [ ] **Step 2: 실패 확인** — `node --import tsx --test packages/er/test/meta.test.ts`
- [ ] **Step 3: 구현** — 경기 목록 필터 `matchingMode === 3 && seasonId === dict.seasonId`, 상세 행 필터 같음 + `characterNum`·`gameRank` 있음. 키 `${characterNum}:${bestWeapon ?? 0}`. 경기에 센 행이 하나라도 있으면 `games += 1`, 그 경기의 첫 행 버전으로 패치 표를 센다.
- [ ] **Step 4: 통과 확인** + `npm run typecheck:er`
- [ ] **Step 5: 커밋** `기능: ER 메타를 캐릭터·무기 조합별 원래 개수로 모으고 이번 시즌 랭크만 센다`

### Task 3: 전적 요약 재료

**Files:** Modify `packages/er/src/player.ts`, `packages/er/test/fixtures/user-games-player.json`(행에 `bestWeapon`, `playerKill`, 랭크 행 `mmrGain`), `user-stats-ranked.json`(`rankPercent`, `averageKills`, `averageAssistants`); Test `packages/er/test/player.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("랭크 통계로 MMR·백분위·평균 킬과 최근 10판·주캐릭터 code를 만든다", async () => {
  const { report } = await lookup(playerRoutes());
  assert.equal(report?.nickname, NICK);
  assert.equal(report?.mmr, 3107);
  assert.equal(report?.rankPercent, 0.41);
  assert.equal(report?.avgKills, 2.5);
  assert.equal(report?.recent.length, 10);
  assert.deepEqual(report?.recent[0], { characterName: "아야", weaponName: "권총", rank: 3, kills: 4, mmrGain: 12 });
  assert.deepEqual(report?.mainCharacters[0], { code: 2, name: "아야", games: 20, avgRank: 2.9 });
});
test("일반 대전으로 넘어가면 MMR·백분위는 null이고 최근 경기 MMR 증감도 null", …);
```

- [ ] **Step 2~4:** 실패 확인 → 구현(`ErPlayerLookup`) → 통과, `npm run typecheck:er`
- [ ] **Step 5: 커밋** `기능: 전적 조회가 대시보드 내 전적 칸 재료를 돌려준다`

### Task 4: 조합 수치와 비교 (서버 순수 함수)

**Files:** Create `apps/server/src/er/combos.ts`; Test `apps/server/test/er-combos.test.ts`

- [ ] **Step 1: 실패하는 검사** — `toComboStats`(비율·이름·topTraits/topEquipment 최대 2·lowSample 경계 29/30·정렬), `withChanges`(변화량·새 조합 null·MMR null), `isPatchChanged`(시즌·패치), `toBasisV2`(previousCollectedAt·patchChanged)
- [ ] **Step 2~4:** 실패 확인 → 구현 → `node --import tsx --test apps/server/test/er-combos.test.ts` PASS
- [ ] **Step 5: 커밋** `기능: 조합 원래 개수를 대시보드 수치로 바꾸고 직전 갱신과 비교한다`

### Task 5: history 보존

**Files:** Create `apps/server/src/er/history.ts`; Test `apps/server/test/er-history.test.ts`

- 파일 이름: `collectedAt`의 `:`를 `-`로 바꾼 것 + `.json`(Windows가 `:`를 못 쓴다). 내용은 `ErMetaCollection` + `format: 2`.
- `save(collection)`: 쓰고 나서 이름순(시각순) 오래된 것부터 지워 `keep`(기본 10)개만 남긴다. 다른 파일(`.json`이 아니거나 `.unreadable-`)은 건드리지 않는다.
- `previous(collectedAt)`: `collectedAt`보다 이른 것 중 가장 최근. 깨진 파일은 건너뛴다.

- [ ] **Step 1: 실패하는 검사** — 12번 저장하면 10개만 남고 가장 오래된 2개가 지워짐 / `previous`가 직전 것을 돌려줌 / 첫 것은 null / 깨진 파일 건너뜀
- [ ] **Step 2~4**
- [ ] **Step 5: 커밋** `기능: ER 집계를 갱신마다 history에 남기고 최근 10개만 둔다`

### Task 6: 자동 갱신 판정

**Files:** Create `apps/server/src/er/auto-refresh.ts`; Test `apps/server/test/er-auto-refresh.test.ts`

```ts
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export type RefreshReason = "missing" | "old" | "season";
export function refreshReason(input: { collectedAt: string | null; metaSeasonId: number | null; dictionarySeasonId: number | null; seasonEnd: string | null; now: number }): RefreshReason | null;
export function koreanDay(now: number): string; // "2026-11-21"
export function createDailyGate(now: () => number): { tryToday(): boolean };
```

- [ ] **Step 1: 실패하는 검사** — 없음/24시간 경계(정확히 24시간은 아직, 넘으면 old)/시즌 끝 지남/집계 시즌과 사전 시즌 다름/한국 날짜 경계(UTC 14:59 vs 15:00)/같은 날 두 번째 false·다음 날 true
- [ ] **Step 2~4**
- [ ] **Step 5: 커밋** `기능: 대시보드 자동 갱신 판정(없음·24시간·시즌, 하루 한 번)`

### Task 7: 대시보드 설정 파일

**Files:** Create `apps/server/src/er/dashboard-settings.ts`; Test `apps/server/test/er-dashboard-settings.test.ts`

- `parseDashboardSettings(value: unknown): DashboardSettings` — `{ nickname }`에서 앞뒤 공백을 자르고 빈 문자열은 null. 문자열·null이 아니거나 32자 넘으면 `DashboardSettingsError`.
- `createDashboardSettings(dataDir)` → `{ get(), set(next) }`. 파일 `dashboard-settings.json`, `createConfigFile`로 원자적으로 쓴다. 파일이 깨졌거나 값이 틀리면 null로 시작(`rejected`로 원본 보존).

- [ ] **Step 1: 실패하는 검사** — 없으면 null / 저장 후 다시 읽음 / 공백 정리 / 틀린 값 오류 / 깨진 파일 null
- [ ] **Step 2~4**
- [ ] **Step 5: 커밋** `기능: 대시보드 게임 닉네임 설정 파일`

### Task 8: er-data 새 형식 저장과 legacy 변환

**Files:** Modify `apps/server/src/er/er-data.ts`; Create `apps/server/src/er/legacy.ts`; Test `apps/server/test/er-data.test.ts`(고침)

- `er-meta.json`은 `{ format: 2, combos, basis, seasonLabel }`. `combos`가 없는 예전 파일은 null(missing).
- 갱신 성공: `er-meta.json` 쓰기 → history `save` → 직전 집계 `history.previous(collectedAt)`를 캐시 → `onRefreshed` 듣는 쪽 부르기.
- `load()`도 직전 집계를 캐시한다.
- 새 메서드: `meta()`, `previousMeta()`, `hasClient()`, `onRefreshed(cb)`, `lookupPlayerSummary(nickname)`.
- legacy: `stats()`·`top5()`는 조합을 캐릭터로 합친 `ErCharacterStat`, `basis()`는 `ErMetaBasis`, `lookupPlayer()`는 `ErPlayerReport`(닉네임 가림).
- `connection()`의 stale 기준을 24시간으로(자동 갱신과 같게).

- [ ] **Step 1: 실패하는 검사** — 새 형식 파일과 history 파일이 생김 / 두 번 갱신하면 `previousMeta()`가 첫 집계 / 예전 형식 meta는 missing / 25시간이면 stale / `onRefreshed`가 성공 때만 불림 / legacy top5가 캐릭터 합계
- [ ] **Step 2~4** — `node --import tsx --test apps/server/test/er-data.test.ts`, `npm run typecheck:server`
- [ ] **Step 5: 커밋** `기능: ER 데이터가 조합 집계를 새 형식으로 저장하고 history와 비교한다`

### Task 9: createDashboardData

**Files:** Create `apps/server/src/er/dashboard-state.ts`; Test `apps/server/test/er-dashboard-state.test.ts`

- [ ] **Step 1: 실패하는 검사**
  - 데이터 없음 → `connection: "missing"`, `basis: null`, `combos: []`, `player.status: "unset"`
  - `maybeAutoRefresh()` 첫 호출 → 갱신 시작, `refresh.autoStarted: true`, 같은 날 두 번째 → false
  - 갱신이 실패해도 그날은 다시 시작하지 않음, 다음 날은 시작
  - 신선한 데이터면 판정만 쓰고 갱신 안 함
  - 갱신 뒤 `combos` 픽률 순·`basis.participants`·`games` 분리
  - 두 번째 갱신 뒤 `change`와 `previousCollectedAt`
  - 키 없음 → `missing` + `lastError`에 ER_API_KEY, `maybeAutoRefresh()` false
  - `setSettings({ nickname })` → 파일 저장, `player.status: "ready"`, `summary.mainCharacters[].metaRank`
  - 없는 닉네임 → `not-found`, 조회 오류 → `error`, `null` → `unset`
  - 갱신 중 `setSettings` → `loading`, 갱신 뒤 조회
  - `onRefreshed`는 전적 다시 조회 뒤 한 번 불림
- [ ] **Step 2~4** — `node --import tsx --test apps/server/test/er-dashboard-state.test.ts`
- [ ] **Step 5: 커밋** `기능: 대시보드 상태(createDashboardData) — 연결·갱신·기준·조합·전적`

### Task 10: 가짜 ER 서버와 마무리 검사

**Files:** Modify `tools/test/fixtures/fake-er.mjs`(설명: 확장 필드는 고정 자료에서 그대로 나간다, 경기 목록 `?next=`는 쓰지 않는다)

- [ ] `npm run typecheck`, `npm run test:unit` 전체 통과
- [ ] `npm test`(통합, 아직 방송 경로)도 돌려 본다. 실패하면 T1 때문인지 가려 보고한다
- [ ] 실제 키 실험: 임시 폴더 `BORI_DATA_DIR`, 랭커 3명·1판. 스크래치 스크립트가 `createErData`+`createDashboardData`를 만들어 갱신하고 조합 수·걸린 시간·경기 행 `seasonId`/`versionSeason` 값을 찍는다(닉네임·uid는 찍지 않는다)
- [ ] 커밋 `검사: 가짜 ER 서버 설명을 확장 필드에 맞춘다`

---

## 자체 점검

- 설계 1.1(거르기·조합·수치·사전 이름·경기/참가자 분리·표본 기준) → Task 1·2·4
- 1.2 전적 → Task 3·9(metaRank)
- 1.3 저장(meta·history 10개·설정 원자적, 실패 시 지난 파일 유지) → Task 5·7·8
- 1.4 비교·patchChanged·null → Task 4·8
- 1.5 자동 갱신(없음·24시간·시즌·하루 한 번) → Task 6·9
- 6절 오류 처리(키 없음·갱신 실패·닉네임 없음·조회 실패) → Task 8·9
- `index.ts` 연결 없음 → PR 본문에 인터페이스와 사용 예
