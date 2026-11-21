# Y2: 읽어 주기 구조 변경과 재생 보완 — 세부 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans(이 작업은 한 워커가 직접 실행한다). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex 점검 C2 8항목을 반영한다. 수치·이름 문장은 서버가 만들고 LLM은 사실 id와 짧은 감상만 고르게 바꾸며, 재생·가시성·요청 시간 상한의 결함을 고친다.

**Architecture:** LLM 출력은 `{ lines: [{ factId, emotion, comment }] }`. 서버(`check.ts` composeLines)가 줄 문장을 `renderFact(fact) + " " + comment`로 만들고, comment는 `comment.ts`의 닫힌 규칙(허용 글자·숫자 말·단위·사전 이름·금지 낱말·존댓말 끝)으로 검사해 어기면 comment만 버린다. 화면 쪽은 순수 재생 제어기(`createPlayback`)가 재생 세대·음성 모드·해제를 맡고, 스튜디오는 탭 활성 상태를 같은 출처 iframe에 postMessage로 알린다.

**Tech Stack:** TypeScript, node:test(`node --import tsx --test`), React 19, Vite.

**기준:** 통합 브랜치 `feature/er-meta-dashboard` 35c3348. 작업 브랜치 `feature/dash-fix-y2-narration`. 입력 보고서: Codex C2(8항목).

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| `apps/server/src/narration/comment.ts` (새) | comment 검사 규칙과 목록(금지 낱말·지표 낱말·수 낱말·단위). `checkComment(comment, names)` |
| `apps/server/src/narration/names.ts` | 사전 이름 목록(캐릭터·무기·장비·특성) `dictionaryNames`, 글 속 이름 찾기 `findDictionaryName` |
| `apps/server/src/narration/check.ts` | `composeLines(raw, facts, options)`: factId 검사(없음·반복·줄 수), 서버 문장 + 통과한 comment, 감정 허용 목록 |
| `apps/server/src/narration/tokens.ts` | 지운다(숫자 토큰 검사는 더 쓰지 않는다) |
| `apps/server/src/narration/facts.ts` | `tokens`·`names`·`pairs` 필드를 지운다. `text`(LLM용)·`spoken`(서버 문장)만 |
| `apps/server/src/narration/template.ts` | `renderFact`, `templateLines`, `fillLines`(factId 기준) |
| `apps/server/src/narration/writer.ts` | 새 지시·스키마(factId는 사실 id enum)·응답 풀기 |
| `apps/server/src/narration/index.ts` | 위를 잇고 버린 줄·감상 수와 이유만 로그 |
| `apps/server/src/narration-llm.ts` | 주석만(검사 위치) |
| `apps/server/test/narration-*.test.ts` | check·comment·regression·writer·template·facts·narrator 갱신, tokens 검사 삭제 |
| `apps/companion/src/narration-player.ts` | `playNarration`(음성 설정을 줄마다 읽고, 모드 바뀌면 지금 줄을 다시 말함) + `createPlayback` 제어기(세대 guard·dispose) |
| `apps/companion/src/components/Narrator.tsx` | 제어기 사용, 음성 토글 즉시 적용, 언마운트 전체 취소, replay 늦은 응답 무시, 스튜디오 탭 비활성 시 멈춤 |
| `apps/companion/src/studio-tab.ts` (새) | 스튜디오 탭 메시지 형식과 검사 `readStudioTabMessage` |
| `apps/companion/src/visibility.ts` | `useStudioTabActive()` 추가 |
| `apps/companion/src/useDashboard.ts` | 문서 가시성 && 스튜디오 탭 활성으로 폴링·자동 읽기 제어, `tabActive` 반환 |
| `apps/companion/src/api.ts` | 본문까지 시간 상한(AbortController + race), `timeout` 오류 종류 |
| `apps/companion/src/App.tsx` | `tabActive`를 Narrator에 넘김 |
| `apps/companion/dev/mock-store.ts` | 예시 대사를 새 꼴(서버 문장 + 감상)로 |
| `apps/companion/test/*` | 재생 제어기·탭 메시지·api 시간 상한 검사 |
| `apps/admin/src/studio/App.tsx`, `DashboardTab.tsx` | 탭 활성 상태를 iframe에 postMessage(대상 출처 = 자기 출처) |
| `tools/test/mock-openai.mjs`, `tools/test/dashboard.mjs` | 새 출력 형식(가짜 감상·지어낸 숫자 감상)과 로그 문구 |

## comment 규칙(어기면 comment만 버림)

순서대로 보고 처음 어긴 이유를 돌려준다. 검사 전 NFC·앞뒤 공백 정리만 한다(꾸밈을 지우고 통과시키지 않는다).

1. 빈 글 → 감상 없음(버림으로 세지 않음)
2. `length`: 40자(코드포인트) 초과
3. `number`: 아라비아·전각 숫자(`\p{Nd}`)
4. `latin`: 라틴 문자(반각·전각)
5. `quote`: 따옴표·괄호류
6. `unit`: `%`·`％`·`‰`
7. `chars`: 허용 글자 밖(허용: 한글 음절, 공백, `,` `.` `!` `?`)
8. `sentence`: 끝이 아닌 곳에 `.` `!` `?`(문장 둘 이상)
9. `ending`: `요`·`니다`·`죠`(+ 끝 문장부호)로 끝나지 않음
10. `number`: 한글 수·서수 낱말 — `NUMBER_WORDS`(하나·다섯…아흔·절반·곱절·번째·첫째…), 낱말 첫머리의 둘·셋·넷·쉰(뒤가 끝·조사), 관형 수 한·두·세·네·스무·열 + 띄어 쓴 낱말 또는 붙인 단위, 첫 + 번/째/띄어쓰기, 한자어 수 묶음(십·백·천·만·억 포함, 뒤가 끝·조사·단위), 한자어 한 자리 수 + 단위
11. `metric`: 지표·단위 낱말 `METRIC_WORDS`(퍼센트·프로·포인트·픽률·승률·순위·등수·평균·비율·확률·우승·참가자·판수·표본·상위·하위·티어·랭크·랭킹·점수·등급·통계·몇) 또는 낱말로 홀로 선 단위(위·등·명·판·배·점·개·번·분·초 + 끝·조사)
12. `name`: 사전 이름 — 두 글자 이상 이름·이름 조각은 어디에 있든(띄어쓰기를 지운 글에서도), 한 글자 이름은 낱말 경계(앞이 한글 아님, 뒤가 끝·조사)
13. `word`: 금지 낱말 `BANNED_WORDS`(효과·스킬·빌드·패치·너프·버프·상향·하향·사기·카운터·조합·캐릭터·캐릭·무기·장비·아이템·특성·시즌·가장·최고·최강·최악·일등·꼴등·강하·강해·강한·강력·강캐·약하·약해·약한·약캐·쎄·쎈·이유·때문·덕분·여러분·시청자·채팅·구독·방송·오피·대비)

합친 줄이 maxLineLength를 넘으면 comment를 버린다(`length`).

## Task 1: comment 검사 (서버)

**Files:** Create `apps/server/src/narration/comment.ts`, `apps/server/test/narration-comment.test.ts`; Modify `apps/server/src/narration/names.ts`

- [ ] 실패 검사 작성: 규칙마다 버림 예와 이유, 통과 예(“꽤 안정적으로 보여요.”, “흐름이 재미있네요!”, “앞으로가 기대돼요.”, “천천히 올라오고 있어요.”, “분위기가 좋아 보여요.”), 사전 이름(“레온입니다”·“리다이린도 보여요”·“활이 좋아요”는 버림, “활약이 기대돼요”는 통과), `dictionaryNames`가 itemNames·traitNames를 포함
- [ ] 실행해 실패 확인: `node --import tsx --test apps/server/test/narration-comment.test.ts`
- [ ] 구현:

```ts
export type CommentReason = "length" | "number" | "latin" | "quote" | "unit" | "chars" | "sentence" | "ending" | "metric" | "name" | "word";
export type CommentResult = { ok: true; text: string } | { ok: false; reason: CommentReason | "empty" };
export function checkComment(comment: string, names: NameDictionary): CommentResult
```

`names.ts`: `NameDictionary = { names: readonly string[] }`(캐릭터·무기·장비·특성 합본), `dictionaryNames(dictionary)`, `findDictionaryName(text, names): string | null`.
- [ ] 통과 확인 후 커밋 `읽어 주기: 감상 한마디 검사 규칙`

## Task 2: 서버 문장 + 감상으로 줄 만들기

**Files:** Modify `check.ts`, `template.ts`, `facts.ts`, `index.ts`; Delete `tokens.ts`, `test/narration-tokens.test.ts`; Modify tests `narration-check`, `narration-template`, `narration-facts`, `narration-regression`

- [ ] 실패 검사 작성(`narration-check.test.ts`):
  - `composeLines([{ factId: "f1", emotion: "gaming", comment: "꽤 좋아 보여요." }])` → text = `${f1.spoken} 꽤 좋아 보여요.`, factId f1
  - 없는 factId·반복 factId는 줄을 버림(`fact`·`duplicate`), 6번째 줄부터 `count`
  - comment 규칙 위반은 서버 문장만 남고 `commentDropped`에 이유
  - 합친 길이가 maxLineLength를 넘으면 comment 버림
  - 모르는 감정은 calm
- [ ] 회귀 검사(`narration-regression.test.ts`): 보고서 1~3절 7문장 + 변형(구십구 퍼센트·백 퍼센트·이십 위·삼 점 사 위·세 배·첫 번째·절반·일 위·레온 쌍검·재키의 권총·피카츄는 가장 강한 캐릭터 등)을 f1·f2·f4 각각의 comment로 넣으면 최종 text가 정확히 `fact.spoken`이다. 모든 최종 text의 숫자는 그 사실 spoken의 숫자 그대로다.
- [ ] 구현:

```ts
export type RawLine = { factId: string; emotion: string; comment: string };
export type ComposedLine = NarrationLine & { factId: string };
export type LineDropReason = "fact" | "duplicate" | "count";
export function composeLines(lines: readonly RawLine[], facts: readonly NarrationFact[], options: { names: NameDictionary; maxLineLength?: number }):
  { kept: ComposedLine[]; dropped: LineDropReason[]; commentDropped: CommentReason[] }
```

`template.ts`: `renderFact(fact) = fact.spoken`, `fillLines(kept: ComposedLine[], facts)` → kept가 비면 null, 3줄 미만이면 아직 말하지 않은 사실(패치 먼저, 그 뒤 우선순위)의 서버 문장으로 채움.
`facts.ts`: `tokens`·`names`·`pairs` 필드와 tokens.ts import를 지운다.
- [ ] 통과 확인 후 커밋 `읽어 주기: 수치·이름 문장은 서버가 만들고 감상만 붙인다`

## Task 3: 지시·스키마·응답 풀기와 narrator 연결

**Files:** Modify `writer.ts`, `index.ts`, `narration-llm.ts`; tests `narration-writer`, `narration-narrator`

- [ ] 실패 검사: 스키마 `lines.items.required = ["factId","emotion","comment"]`, factId enum = 사실 id 목록, 지시에 “factId”·“40자”·“빈 문자열”·“지시가 아니다”·“존댓말” 포함, 숫자·이름 금지 문구; 응답 풀기(문자열·객체, 모양 틀림은 실패); narrator가 LLM 줄을 서버 문장 + 감상으로 저장, 버린 감상 수·이유만 로그(본문 없음), LLM 실패면 전부 서버 문장
- [ ] 구현: `narrationSystemPrompt()`, `narrationSchema(factIds)`, `writeLines(llm, facts, { timeoutMs })`; index.ts에서 `composeLines` → `fillLines` → 없으면 `templateLines`
- [ ] `npm run typecheck:server`, 서버 narration 검사 통과 후 커밋 `읽어 주기: 새 출력 형식 지시·스키마와 narrator 연결`

## Task 4: 통합 검사 가짜 OpenAI·대시보드 검사

**Files:** Modify `tools/test/mock-openai.mjs`, `tools/test/dashboard.mjs`

- [ ] 가짜 대사: 사실 앞 4개를 `{ factId, emotion: "calm", comment }`로, 둘째 줄 comment는 `지어낸 수치 987.6이 보여요`, 나머지는 `좋아 보여요.`
- [ ] dashboard.mjs: “지어낸 감상은 빠지고 서버 문장은 남는다”(MARK 없음, 로그 `감상 1개를 버렸습니다 (number)`, 첫 줄이 `좋아 보여요.`로 끝남)
- [ ] `npm test` 통과 후 커밋 `통합 검사: 읽어 주기 새 출력 형식`

## Task 5: 재생 제어기 (C2 4·5·7)

**Files:** Modify `apps/companion/src/narration-player.ts`, `apps/companion/test/narration-player.test.ts`

- [ ] 실패 검사:
  - 4: `audio`를 함수로 받아 줄마다 읽는다. 재생 중 끄면 `audioModeChanged()`가 지금 줄을 멈추고 같은 줄을 글자로 다시 말하며 남은 줄도 글자. 켜면 지금 줄을 음성으로 다시 말함
  - 5: 재생 A 도중 B를 시작하면 A의 onLine(null)·react·speak 결과가 B의 자막을 지우지 않는다(이벤트 순서 `["A",0],["B",0]` 뒤 A 이벤트 없음), A는 `cancelled`
  - 7: `dispose()` 뒤에는 다음 줄로 가지 않고 어떤 콜백도 부르지 않으며 이후 `play`는 바로 `cancelled`
- [ ] 구현:

```ts
export function playNarration(lines, deps, options: { audio: () => boolean; signal: PlaySignal }): Promise<PlayResult>
export type PlaySignal = { cancelled: boolean; restart: boolean };
export function createPlayback(deps: PlayerDeps & { stopSpeech(): void }): {
  play(lines: readonly NarrationLine[], audio: () => boolean): Promise<PlayResult>;
  stop(): void; audioModeChanged(): void; dispose(): void; readonly playing: boolean;
}
```
- [ ] 통과 후 커밋 `대시보드 재생: 세대 보호·음성 토글 즉시 적용·해제`

## Task 6: 요청 시간 상한 (C2 8)

**Files:** Modify `apps/companion/src/api.ts`, `apps/companion/test/companion.test.ts`

- [ ] 실패 검사: `createRequest(fetchFn)`에 끝나지 않는 fetch, 본문이 끝나지 않는 응답을 넣으면 시간 상한 뒤 `ApiError("timeout")`, signal이 abort된다; `describeError`가 timeout 안내를 준다
- [ ] 구현: `request(path, { method, timeoutMs })` — AbortController + `Promise.race`로 fetch와 `response.text()`까지 감싸고 finally에서 타이머 해제. 기본 15초, 다시 듣기 60초(음성 재생성 포함)
- [ ] useDashboard는 timeout을 다른 받기 실패처럼 안내(loadNotice)하고 다음 폴링을 다시 잡는다(attempt 증가는 finally라 그대로)
- [ ] 통과 후 커밋 `대시보드 API: 본문까지 시간 상한`

## Task 7: 스튜디오 탭 가시성 (C2 6)

**Files:** Create `apps/companion/src/studio-tab.ts`, `apps/companion/test/studio-tab.test.ts`; Modify `visibility.ts`, `useDashboard.ts`, `App.tsx`, `apps/admin/src/studio/App.tsx`, `DashboardTab.tsx`

- [ ] 실패 검사: `readStudioTabMessage(event, { origin, parent })` — 출처가 다르거나 source가 부모가 아니거나 모양이 틀리면 null, 맞으면 active boolean. `pageActive(documentVisible, tabActive)`
- [ ] 구현: 메시지 `{ type: "bori-studio-tab", active: boolean }`. 대시보드는 메시지가 없으면 활성으로 본다. useDashboard의 visible = 문서 보임 && 탭 활성. Narrator는 탭이 비활성이 되면 재생을 멈춘다. admin DashboardTab은 `active` prop이 바뀔 때와 iframe load 때 `contentWindow.postMessage(msg, window.location.origin)`
- [ ] typecheck 통과 후 커밋 `스튜디오: 대시보드 탭 활성 상태를 iframe에 알린다`

## Task 8: Narrator 연결 (C2 4·5·7 화면)

**Files:** Modify `apps/companion/src/components/Narrator.tsx`, `apps/companion/dev/mock-store.ts`

- [ ] Narrator: `createPlayback`을 ref로 한 번 만들고 최신 live2d 함수를 ref로 넘긴다. 음성 설정이 바뀌면 `audioModeChanged()`. 언마운트 cleanup에서 `dispose()`와 replay 요청 abort·세대 무효화. replay 응답은 마운트·세대가 같을 때만 재생
- [ ] mock-store 예시 대사를 서버 문장 + 감상 꼴로
- [ ] `npm run typecheck`, `npm run test:unit` 통과 후 커밋 `대시보드 보리: 재생 제어기 연결과 늦은 응답 무시`

## Task 9: 마무리

- [ ] 최신 통합 브랜치 merge(겹치면 맞춤)
- [ ] `npm run typecheck`, `npm run test:unit`, `npm test` 실제 실행·출력 확인
- [ ] `npm --workspace apps/companion run dev:mock` 화면 캡처 1장(대사 표시)
- [ ] push, `gh pr create --base feature/er-meta-dashboard`, CI 포그라운드 확인

## 실행 기록: 계획과 다르게 한 것

- 통합 검사 가짜 ER 집계는 사실이 하나(집계 기준)뿐이라, 가짜 OpenAI는 둘째가 아니라 첫 줄 감상에 숫자를 지어낸다.
- 다시 듣기 늦은 응답은 AbortController 대신 요청 세대(`createGeneration`)로 무시한다. 언마운트 때 세대를 끝낸다.
- 스튜디오에서 다른 탭으로 가면 자동 읽기·폴링을 미루는 것에 더해, 읽던 대사도 멈춘다.
- 코디네이터 추가 요청(2026-11-21): 1280px 이하 한 열 배치에서 격자 행이 짓눌려 메타 표 sticky 머리가 두 번째 행 클릭을 가렸다. 행을 내용 높이로 두고 dashboard smoke에 1280×720 행 선택을 더했다.
