# X1 데이터·서버 보완 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 점검 V1(데이터 정확성) 15항목과 추가 항목(가벼운 상태 경로, 닉네임 정리, 죽은 코드·옛 타입 삭제, 로그 uid)을 `packages/er`·`apps/server/src/er`·대시보드 라우트·스튜디오 설정 탭에서 고친다.

**Architecture:** 설계(`docs/superpowers/specs/2026-11-21-er-meta-dashboard-design.md`)와 총괄 계획의 파일 경계를 따른다. `DashboardState` 등 `packages/shared`의 대시보드 타입 모양은 바꾸지 않는다. 화면(`apps/companion`)·대사(`apps/server/src/narration`)는 고치지 않고, 데이터 규칙으로 일관성을 맞춘다.

**Tech Stack:** Node 22, TypeScript, node:test(`node --import tsx --test`), 이터널리턴 Open API.

기준: `feature/er-meta-dashboard` 95ef8ec. 브랜치 `feature/dash-fix-x1-data`.

---

## 항목 지도 (점검 V1 번호)

| # | 처리 | 작업 |
|---|---|---|
| 1 갱신 실패 시 loading 갇힘 | 고침 | Task 7, 8 |
| 2 하루 문을 판정 전에 소모 | 고침 | Task 8 |
| 3 직전 표본 적음 변화량 | 고침(규칙: 직전·이번 중 하나라도 lowSample이면 change null) | Task 5 |
| 4 첫 갱신 "새로" 태그 | 안 고침: 화면(`apps/companion`)은 X2 소유. 서버는 `basis.previousCollectedAt`을 이미 준다 | — |
| 5 집계 실패해도 사전 파일 바뀜 | 고침 | Task 7 |
| 6 일반 대전인데 "이번 시즌 N판" | 안 고침: 문장은 `narration/facts.ts`(X2·X3 소유). 데이터는 이미 `summary.seasonName = "일반 대전"`을 준다 | — |
| 7 경기 목록 404면 전적 error | 고침 | Task 2 |
| 8 랭커당 경기 > 10 | 고침: 실제 API로 한 쪽 10판·`next` 숫자 확인(2026-11-21). `next`로 쪽을 넘긴다 | Task 3 |
| 9 건너뛴 요청이 안 남음, rankers 셈 | 고침: rankers = 이번 시즌 랭크 경기를 하나라도 낸 랭커 수, 건너뛴 랭커·경기 수를 로그에 | Task 3, 7 |
| 10 깨진 history 사본 쌓임 | 고침: history는 사본 없이 건너뛰고 경고는 파일당 한 번 | Task 6 |
| 11 metaRank가 표본 적은 조합도 셈 | 고침: 표본 충분한 조합 안에서 센다(없으면 null) | Task 8 |
| 12 직전 = history 최신 | 고침: 갱신 때는 메모리의 지난 집계(화면에 보이던 것)를 직전으로. 덧붙임(시계 역행 시 방금 쓴 파일 삭제)도 고침 | Task 6, 7 |
| 13 uid가 오류·로그에 | 고침: 오류 라벨에서 `/uid/<값>`을 `/uid/…`로 | Task 1 |
| 14 채팅·방송 시절 코드 | 고침: `findCharacter`·별칭표·`maskNickname` 삭제 | Task 4 |
| 15 검사 빈틈 | 각 Task에 회귀 검사. 24행 경기 픽스처·기본 픽스처 시즌 끝 변경은 하지 않음(수식 영향 없음, 기존 검사 다수 재작성 필요) | 전부 |

추가 항목

| 항목 | 작업 |
|---|---|
| 가벼운 상태 경로 `GET /api/dashboard/status`, 스튜디오 설정 탭이 사용 | Task 9 |
| 닉네임 `cleanInputText` + 개행·탭 제거, 상한 32 하나, 스튜디오 입력칸 maxLength 32 | Task 10 |
| `packages/er` 죽은 코드, shared 옛 타입(`ErCharacterStat`·`ErMetaBasis`·`ErPlayerReport`) 삭제 | Task 4 |
| 로그 uid | Task 1 |

## 파일 구조

- `packages/er/src/client.ts`: 오류 라벨 uid 가림
- `packages/er/src/player.ts`: 경기 목록 404 → 빈 목록
- `packages/er/src/meta.ts`: 경기 목록 쪽 넘김, rankers 셈, `onSkip`
- `packages/er/src/dictionary.ts`, `index.ts`, 삭제 `aliases.ts`·`mask.ts`·`test/mask.test.ts`
- `packages/shared/src/index.ts`: 옛 ER 타입 3개 삭제
- `apps/server/src/er/combos.ts`: 변화량 규칙
- `apps/server/src/er/history.ts`: 깨진 파일 처리, 방금 쓴 파일 보존
- `apps/server/src/er/er-data.ts`: 사전 쓰기 순서, 직전 집계, 실패 알림, 건너뜀 로그
- `apps/server/src/er/dashboard-state.ts`: 하루 문, loading 풀기, metaRank, `status()`
- `apps/server/src/er/dashboard-settings.ts`: 닉네임 정리
- `apps/server/src/http/dashboard-routes.ts`: `GET /api/dashboard/status`
- `apps/admin/src/studio/SettingsTab.tsx`, `status-view.ts`: 상태 경로, maxLength
- 검사: `packages/er/test/{client,player,meta,dictionary}.test.ts`, `apps/server/test/er-*.test.ts`, `dashboard-routes.test.ts`, `apps/admin/test/status-view.test.ts`

---

### Task 1: 오류 라벨에서 uid 가리기 (#13)

**Files:** Modify `packages/er/src/client.ts:53`, Test `packages/er/test/client.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("오류 메시지에 경로 속 uid가 들어가지 않는다", async () => {
  const client = createErClient({ apiKey: "k", minIntervalMs: 0, fetch: async () => new Response(JSON.stringify({ code: 500 }), { status: 500 }) });
  await assert.rejects(client.get("/v2/user/stats/uid/secret-uid-123/41/3"), (error: unknown) =>
    error instanceof ErApiError && !error.message.includes("secret-uid-123") && error.message.includes("/v2/user/stats/uid/…/41/3"));
  await assert.rejects(client.get("/v1/user/games/uid/secret-uid-123?next=5"), (error: unknown) =>
    error instanceof ErApiError && !error.message.includes("secret-uid-123") && error.message.includes("/v1/user/games/uid/…"));
});
```

- [ ] **Step 2:** `node --import tsx --test packages/er/test/client.test.ts` → FAIL(uid가 메시지에 있음)
- [ ] **Step 3: 구현**

```ts
/** 오류 메시지용 경로. 쿼리(닉네임)를 빼고 /uid/ 뒤 계정 식별자를 가린다. */
const errorLabel = (path: string) => path.split("?")[0]!.replace(/\/uid\/[^/]+/g, "/uid/…");
// send() 안
const label = external ? "언어 데이터 파일" : errorLabel(path);
```

- [ ] **Step 4:** 같은 명령 → PASS
- [ ] **Step 5:** 커밋 `수정: 이터널리턴 API 오류 메시지에서 uid를 가린다`

### Task 2: 경기 목록 404는 빈 목록 (#7)

**Files:** Modify `packages/er/src/player.ts:73`, Test `packages/er/test/player.test.ts`

- [ ] **Step 1: 실패하는 검사** — 랭크 통계는 있고 `/v1/user/games/uid/uid-p` 경로가 없는(가짜 클라이언트 404) 경우 `recent`가 `[]`이고 전적은 그대로 나온다.

```ts
test("최근 경기 목록이 404(경기 없음)여도 전적은 나오고 최근 경기는 비어 있다", async () => {
  const routes = playerRoutes();
  delete routes["/v1/user/games/uid/uid-p"];
  const summary = await lookupPlayer(fakeClient(routes), dict, PLAYER);
  assert.equal(summary?.games, 32);
  assert.deepEqual(summary?.recent, []);
});
```

(이름은 player.test.ts에 이미 있는 도우미에 맞춘다.)

- [ ] **Step 2:** FAIL(ErApiError 404)
- [ ] **Step 3: 구현**

```ts
/** 경기 목록. 경기가 하나도 없는 계정은 404로 올 수 있어 빈 목록으로 본다. */
async function fetchGames(client: ErClient, path: string): Promise<GameRow[]> {
  try {
    return (await client.get<GamesResponse>(path)).userGames ?? [];
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}
```

- [ ] **Step 4:** PASS. **Step 5:** 커밋 `수정: 전적 조회에서 경기 목록 404를 0경기로 본다`

### Task 3: 메타 수집 쪽 넘김·랭커 셈·건너뜀 알림 (#8, #9)

**Files:** Modify `packages/er/src/meta.ts`, Test `packages/er/test/meta.test.ts`

실제 응답(2026-11-21 확인): `/v1/user/games/uid/{uid}`는 한 쪽 10판, `next`(숫자)가 있으면 `?next=<값>`으로 다음 쪽(겹침 없음).

- [ ] **Step 1: 실패하는 검사 셋**

```ts
test("경기 목록이 모자라면 next로 다음 쪽을 받아 gamesPerRanker개까지 채운다", async () => {
  const page1 = { code: 200, message: "Success", next: 77, userGames: [ { gameId: 1001, matchingMode: 3, seasonId: 41 } ] };
  const page2 = { code: 200, message: "Success", userGames: [ { gameId: 1002, matchingMode: 3, seasonId: 41 } ] };
  const routes = { ...metaRoutes(), "/v1/user/games/uid/uid-a": page1, "/v1/user/games/uid/uid-a?next=77": page2 };
  const { dict, client } = await setup(routes);
  const { basis } = await collectMeta(client, dict, { rankers: 1, gamesPerRanker: 2 });
  assert.ok(client.calls.includes("/v1/user/games/uid/uid-a?next=77"));
  assert.equal(basis.games, 2);
});

test("이전 시즌 랭크 경기가 나오면 다음 쪽을 받지 않는다", async () => {
  const page1 = { code: 200, message: "Success", next: 77, userGames: [ { gameId: 1001, matchingMode: 3, seasonId: 41 }, { gameId: 900, matchingMode: 3, seasonId: 40 } ] };
  const routes = { ...metaRoutes(), "/v1/user/games/uid/uid-a": page1 };
  const { dict, client } = await setup(routes);
  await collectMeta(client, dict, { rankers: 1, gamesPerRanker: 5 });
  assert.equal(client.calls.some((call) => call.includes("next=")), false);
});

test("랭커 수는 이번 시즌 랭크 경기를 낸 랭커만 세고, 건너뛴 랭커·경기를 알린다", async () => {
  const routes = { ...metaRoutes(), "/v1/user/games/uid/uid-b": new ErApiError(500, 500, "서버 오류"), "/v1/games/1001": new ErApiError(500, 500, "서버 오류") };
  const { dict, client } = await setup(routes);
  const skipped: string[] = [];
  const { basis } = await collectMeta(client, dict, { rankers: 3, gamesPerRanker: 2, onSkip: (what) => skipped.push(what) });
  // 랭커C: uid 못 찾음, 랭커B: 경기 목록 실패 → 랭커 A만 센다
  assert.equal(basis.rankers, 1);
  assert.deepEqual(skipped.sort(), ["game", "ranker", "ranker"]);
});
```

기존 "닉네임이 바뀌어…" 검사의 `basis.rankers` 기대값은 그대로 2(A·B 모두 경기를 냄). 진행률 검사(`[7, 7]`)도 그대로 통과해야 한다(쪽을 더 받을 때만 total이 는다).

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 구현** (요지)

```ts
/** 유저 경기 목록 한 쪽은 10판이다(2026-11-21 실제 응답). 랭커 한 명에게 받는 쪽 수 상한 */
const GAMES_PAGE_SIZE = 10;
type GamesResponse = { userGames?: GameRow[]; next?: number };
export type MetaSkip = "ranker" | "game";
// options에 onSkip?: (what: MetaSkip) => void

// 3단계
let activeRankers = 0;
const maxPages = Math.ceil(gamesPerRanker / GAMES_PAGE_SIZE) + 1;
for (const uid of uids) {
  const picked: number[] = [];
  let next: number | undefined;
  let failed = false;
  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0) total += 1; // 더 받는 쪽만큼 진행률 분모를 늘린다
    const path = `/v1/user/games/uid/${encodeURIComponent(uid)}${next === undefined ? "" : `?next=${next}`}`;
    const games = await orSkip(client.get<GamesResponse>(path));
    if (page > 0) step();
    if (!games) { failed = page === 0; break; }
    const rows = games.userGames ?? [];
    for (const game of rows.filter(isCurrentRanked)) if (picked.length < gamesPerRanker) picked.push(game.gameId);
    // 목록은 최신 먼저라 지난 시즌 랭크 경기가 보이면 더 볼 필요가 없다
    const reachedOlder = rows.some((row) => row.matchingMode === RANKED_MODE && row.seasonId !== dict.seasonId);
    if (picked.length >= gamesPerRanker || reachedOlder || typeof games.next !== "number" || rows.length === 0) break;
    next = games.next;
  }
  if (failed) options.onSkip?.("ranker");
  if (picked.length > 0) activeRankers += 1;
  for (const id of picked) gameIds.add(id);
  step();
}
// 닉네임 못 찾음도 onSkip("ranker"), 경기 상세 실패도 onSkip("game")
// basis.rankers = activeRankers
```

`total` 재계산(`1 + rankers.length + uids.length + gameIds.size`)은 더 받은 쪽 수(`extraPages`)를 더해 끝에서 done === total이 되게 한다.

- [ ] **Step 4:** `node --import tsx --test packages/er/test/meta.test.ts` → PASS
- [ ] **Step 5:** 커밋 `수정: 메타 수집이 경기 목록 다음 쪽을 받고 실제로 경기를 낸 랭커만 센다`

### Task 4: 죽은 코드와 옛 타입 삭제 (#14, 추가)

**Files:** Delete `packages/er/src/aliases.ts`, `packages/er/src/mask.ts`, `packages/er/test/mask.test.ts`; Modify `packages/er/src/dictionary.ts`(findCharacter·jamo·editDistance·normalize·bare·maxSuggestDistance 삭제, 머리 주석), `packages/er/src/index.ts`, `packages/er/test/dictionary.test.ts`(findCharacter 검사 삭제), `packages/shared/src/index.ts`(`ErCharacterStat`·`ErMetaBasis`·`ErPlayerReport` 삭제)

- [ ] **Step 1:** `git grep -n "findCharacter\|characterAliases\|maskNickname\|ErCharacterStat\|ErPlayerReport\|ErMetaBasis\b" -- ':!docs'` 로 쓰는 곳이 검사·정의뿐인지 확인
- [ ] **Step 2:** 삭제
- [ ] **Step 3:** `npm run typecheck`, `node --import tsx --test "packages/er/test/*.test.ts"` → PASS
- [ ] **Step 4:** 커밋 `정리: 채팅·방송 시절 ER 코드와 옛 ER 타입을 지운다`

### Task 5: 변화량 규칙 — 표본 적음이면 null (#3)

**Files:** Modify `apps/server/src/er/combos.ts:65-80`, Test `apps/server/test/er-combos.test.ts`, `apps/server/test/er-dashboard-state.test.ts`(기존 변화량 검사)

규칙: 직전이나 이번 중 하나라도 `lowSample`이면 `change = null`. 화면 ▲▼·오르고 내린 조합·대사가 모두 같은 기준을 본다.

- [ ] **Step 1: 실패하는 검사**

```ts
test("직전이나 이번 중 하나라도 표본이 적으면 변화량은 null이다", () => {
  const previous = collection([tally({ characterCode: 1, weaponCode: 15, participants: 5 }), tally({ characterCode: 2, weaponCode: 9, participants: 40 })]);
  const current = collection([tally({ characterCode: 1, weaponCode: 15, participants: 35 }), tally({ characterCode: 2, weaponCode: 9, participants: 10 })]);
  const stats = dashboardCombos(current, previous, dict);
  assert.equal(stats.find((s) => s.characterCode === 1)?.change, null);
  assert.equal(stats.find((s) => s.characterCode === 2)?.change, null);
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 구현** — `withChanges`에서 `if (!old || old.lowSample || stat.lowSample) return stat;`
- [ ] **Step 4:** er-dashboard-state의 "두 번째 갱신 뒤…" 검사는 고정 자료가 모두 표본 적음이라 `aya.change === null`로 바꾸고, 수치 변화량은 er-combos 검사(표본 충분)로 본다. 둘 다 PASS
- [ ] **Step 5:** 커밋 `수정: 직전이나 이번 표본이 적은 조합은 변화량을 내지 않는다`

### Task 6: history 깨진 파일·방금 쓴 파일 (#10, #12 덧붙임)

**Files:** Modify `apps/server/src/er/history.ts`, Test `apps/server/test/er-history.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("깨진 파일은 몇 번 읽어도 사본을 만들지 않고 경고는 한 번이다", () => {
  const warnings: string[] = [];
  const history = createErHistory({ dir, warn: (m) => warnings.push(m) });
  history.save(collection("2026-11-20T00:00:00.000Z"));
  writeFileSync(join(dir, historyFileName("2026-11-21T00:00:00.000Z")), "{깨짐");
  history.previous("2026-11-22T00:00:00.000Z");
  history.previous("2026-11-22T00:00:00.000Z");
  assert.equal(readdirSync(dir).length, 2);
  assert.equal(warnings.length, 1);
});

test("시계가 뒤로 가도 방금 쓴 파일은 지우지 않는다", () => {
  const history = createErHistory({ dir, keep: 2 });
  history.save(collection("2026-11-20T00:00:00.000Z"));
  history.save(collection("2026-11-21T00:00:00.000Z"));
  history.save(collection("2026-11-19T00:00:00.000Z"));
  assert.ok(history.names().includes(historyFileName("2026-11-19T00:00:00.000Z")));
  assert.equal(history.names().length, 2);
});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 구현** — `previous()`는 `readFileSync`+`JSON.parse`로 직접 읽는다. 실패하면 `warned` Set에 이름이 없을 때만 경고(파일 이름만, 내용 없음). `save()`는 지울 목록에서 방금 쓴 이름을 뺀다.
- [ ] **Step 4:** PASS. **Step 5:** 커밋 `수정: 깨진 집계 기록을 읽을 때 사본을 쌓지 않는다`

### Task 7: er-data — 사전 쓰기 순서·직전 집계·실패 알림·건너뜀 로그 (#5, #12, #1, #9)

**Files:** Modify `apps/server/src/er/er-data.ts`, Test `apps/server/test/er-data.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("집계가 실패하면 사전 파일과 메모리 사전도 그대로다", async () => { /* 첫 갱신 → Season 응답을 42로 바꾸고 rank/top/42/3 없음 → 실패 → dictionary().seasonId === 41, 파일도 41 */ });
test("갱신 때 직전 집계는 history가 아니라 지난번 메모리 집계다", async () => { /* 첫 갱신 → er-history 폴더 지움 → 둘째 갱신 → previousMeta().basis.collectedAt === 첫 시각 */ });
test("갱신이 실패하면 onRefreshFailed를 부른다", async () => { /* rank/top 없음 → 한 번 */ });
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 구현**

```ts
const nextDictionary = await loadDictionary(client);
const skipped = { ranker: 0, game: 0 };
const collected = await collectMeta(client, nextDictionary, { ..., onSkip: (what) => { skipped[what] += 1; } });
// 집계까지 성공한 뒤에만 둘 다 쓴다(설계 1.3 "실패하면 지난 파일 그대로")
dictionaryFile.write({ ...nextDictionary, seasonLabel: SEASON_LABEL });
metaFile.write({ format: COLLECTION_FORMAT, ...collected, seasonLabel: SEASON_LABEL });
const shown = meta;
dictionary = nextDictionary;
meta = collected;
history.save(...) // 그대로
// 직전 = 화면에 보이던 집계. 처음이면 history에서 찾는다
previous = shown ?? findPrevious(collected);
console.log(`... 조합 N개, 건너뜀 랭커 a명·경기 b판)`);
```

`onRefreshFailed(listener)`를 더하고 실패 경로에서 부른다.

- [ ] **Step 4:** PASS. **Step 5:** 커밋 `수정: ER 갱신은 집계까지 성공해야 사전을 바꾸고, 직전은 보이던 집계로 한다`

### Task 8: dashboard-state — 하루 문·loading 풀기·metaRank·status() (#2, #1, #11, 추가)

**Files:** Modify `apps/server/src/er/dashboard-state.ts`, Test `apps/server/test/er-dashboard-state.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("같은 날 새것이라 넘긴 뒤 24시간을 넘기면 그날 안에 갱신한다", async () => {
  // 시즌 끝을 먼 미래로. 한국 11-20 20:00(11:00Z)에 수집 → 11-21 19:00(+23h) 판정 없음 → 21:00(+25h) 갱신
});
test("갱신 중 저장 → 갱신 실패 → 사전이 있으면 조회해 ready", async () => {});
test("사전 없이 첫 갱신이 실패하면 loading이 아니라 error", async () => {});
test("주캐릭터의 조합이 모두 표본 적음이면 metaRank는 null", async () => {});
test("status()는 연결·갱신·기준만 내고 자동 갱신을 판정하지 않는다", async () => {});
```

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 구현**
  - `maybeAutoRefresh`: `reason`을 먼저 계산하고, 이유가 있을 때만 `gate.tryToday()` → `erData.refresh()`.
  - `lookupPlayer`: 갱신 중이면 loading. 사전이 없을 때 `refreshEnded`(갱신이 한 번이라도 끝남)면 error, 아니면 loading.
  - `erData.onRefreshFailed`: `refreshEnded = true`, player가 loading이면 다시 `lookupPlayer()`.
  - `toPlayerSummary`: 표본 충분한 조합만 걸러 그 안에서 순위(픽률 순이라 표본 적은 조합은 늘 뒤라 기존 순위는 그대로이고, 표본 적은 조합만 있는 캐릭터만 null).
  - `status(): Pick<DashboardState, "connection" | "refresh" | "basis">`, `state()`가 이를 쓴다.
- [ ] **Step 4:** PASS. **Step 5:** 커밋 `수정: 자동 갱신 하루 문은 갱신을 시작할 때만 닫고, 실패한 갱신 뒤 전적 loading을 푼다`

### Task 9: `GET /api/dashboard/status`와 스튜디오 설정 탭 (추가)

**Files:** Modify `apps/server/src/http/dashboard-routes.ts`, `apps/admin/src/studio/SettingsTab.tsx:76-83`; Test `apps/server/test/dashboard-routes.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("GET /api/dashboard/status는 연결·갱신·기준만 주고 자동 갱신을 판정하지 않는다", async () => {
  const { status, body } = await send("GET", "/api/dashboard/status");
  assert.equal(status, 200);
  assert.deepEqual(body, { connection: "ready", refresh: STATE.refresh, basis: null });
  assert.deepEqual(fake.calls, ["status"]);
});
```

- [ ] **Step 2:** FAIL(404 다음 라우트)
- [ ] **Step 3: 구현** — 라우트 `if (method === "GET" && path === "/api/dashboard/status") { send(response, 200, dashboard.status()); return true; }`. 설정 탭 `refreshStatus`가 `getJson<ErDataView>('/api/dashboard/status')`를 쓰고 그대로 `setEr`.
- [ ] **Step 4:** PASS, `npm run typecheck:admin`. **Step 5:** 커밋 `연결: 스튜디오 설정 탭은 가벼운 상태 경로를 폴링한다`

### Task 10: 닉네임 정리와 상한 하나 (추가)

**Files:** Modify `apps/server/src/er/dashboard-settings.ts`, `apps/admin/src/studio/status-view.ts`(NICKNAME_MAX export), `apps/admin/src/studio/SettingsTab.tsx:186`(maxLength), Test `apps/server/test/er-dashboard-settings.test.ts`, `dashboard-routes.test.ts`

- [ ] **Step 1: 실패하는 검사**

```ts
test("제어문자·방향 바꿈·개행·탭을 지운 뒤 앞뒤 공백을 자른다", () => {
  assert.deepEqual(parseDashboardSettings({ nickname: " 보리‮팬\u0000\n\t " }), { nickname: "보리팬" });
  assert.deepEqual(parseDashboardSettings({ nickname: "‮\u0000" }), { nickname: null });
});
```

라우트 검사: PUT `{"nickname":"보리‮팬"}` → 200, 저장값 `보리팬`.

- [ ] **Step 2:** FAIL
- [ ] **Step 3: 구현** — `const cleaned = cleanInputText(nickname).replace(/[\n\t]/g, "").trim();` 상한은 정리한 값 기준 32자. 스튜디오 입력칸 `maxLength={NICKNAME_MAX}`.
- [ ] **Step 4:** PASS. **Step 5:** 커밋 `수정: 게임 닉네임을 저장 전에 정리하고 입력 상한을 32자로 맞춘다`

### Task 11: 마무리 검사

- [ ] `npm run typecheck` → 통과
- [ ] `npm run test:unit` → 실패 0
- [ ] `npm test` → 통과
- [ ] push, `gh pr create --base feature/er-meta-dashboard`, `gh pr checks <번호> --watch`
