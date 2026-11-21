# 과제 A 세부 계획: 보리 감상 한마디 다양화

브랜치 `feature/comment-variety` (main 6015051에서).
경계: `apps/server/src/narration/**`, `apps/server/test/narration-*`, (생성 설정이 필요할 때만) `apps/server/src/narration-llm.ts`, (필요하면) `tools/test/mock-openai.mjs`.

## 목표

#63(Z1) 뒤 감상이 남는 비율은 90% 이상이 됐지만, gpt-4o-mini가 지시문의 예시를 그대로 베껴 말이 단조롭다(고정 사실 50줄 중 48줄이 예시 복사).
안전장치(comment.ts 규칙, 수치·이름은 서버 문장만)는 그대로 두고 감상을 다양하게 만든다.

목표 지표(실제 사실·고정 사실 각각 10회 이상, gpt-4o-mini, 서버 기본 설정):
- 감상이 남는 줄 비율 ≥ 70%
- 남은 감상 중 서로 다른 문장 비율 ≥ 70%
- 예시 복사 비율(LLM 원래 감상 중 예시와 같은 것) — 줄어드는지 본다. 복사는 이제 버리므로 남은 감상에는 0이어야 한다.

## 1. 예시 묶음과 무작위 고르기 — 새 파일 `narration/examples.ts`

- `COMMENT_EXAMPLE_POOL`: 사실 종류(kind)마다 감상 예시 10개 안팎. 기존 21개를 포함한다.
- `pickCommentExamples(random, perKind = 2)`: 종류마다 `perKind`개를 무작위로 고른다(부분 Fisher–Yates). `random`은 `() => number`(0 이상 1 미만).
- `seededRandom(seed)`: 검사·측정용 시드 난수(mulberry32).
- 검사(`narration-examples.test.ts` 새 파일):
  - 묶음의 모든 예시는 `checkComment`를 통과한다(고정 이름 사전).
  - 모든 종류에 `perKind`보다 많은 예시가 있다. 묶음 안에 같은 문장(정규화 기준)이 없다.
  - 같은 시드면 같은 결과, 다른 시드면 대체로 다른 결과. 고른 예시는 모두 그 종류 묶음 안에 있고 겹치지 않는다.

## 2. 지시에 고른 예시만 싣기 — `writer.ts`

- `narrationSystemPrompt(examples)`: 고른 예시를 받는다. `GOOD_COMMENT_EXAMPLES` 상수는 묶음(examples.ts)으로 옮긴다.
- 지시에 "예시 문장을 그대로 쓰면 서버가 버린다"를 더한다.
- `writeLines(llm, facts, { timeoutMs, random? })`: 부를 때마다 `random`(기본 `Math.random`)으로 예시를 고른다.
- `NarratorDeps.random?`: narrator가 writeLines에 넘긴다(검사에서 시드 고정).
- 검사(narration-writer): 같은 시드면 같은 지시, 지시에 든 좋은 예시는 고른 것뿐이고 고르지 않은 예시는 없다.

## 3. 베낀 감상·되풀이 감상 버리기 — `check.ts`

- `commentKey(text)`: NFC, 공백·문장부호(`.,!?~…` 등 글자·숫자가 아닌 것)를 지운 글. examples.ts에 둔다.
- 감상이 안전 규칙(checkComment)을 통과한 뒤:
  - 키가 묶음의 어떤 예시와 같으면 `copied`로 버린다(지시에 실린 것만이 아니라 묶음 전체).
  - 키가 같은 대사에서 이미 붙인 감상과 같으면 `repeated`로 버린다(두 번째부터).
- 버린 이유 타입: `CommentDropReason = CommentReason | "copied" | "repeated"`. narrator 로그 요약(`검사에서 감상 N개를 버렸습니다 (…)`)에 그대로 나온다.
- 검사 먼저(narration-check, narration-narrator): 예시 그대로·공백/문장부호만 다른 것은 copied, 낱말이 다르면 남음, 같은 감상 두 번째는 repeated, 로그에 copied·repeated.
- mock-openai: 지금은 2~4번 줄에 같은 감상("좋아 보여요.")을 붙여 두 번째부터 repeated로 버려진다. 줄마다 다른 감상(모두 " 좋아 보여요."로 끝남: dashboard.mjs 검사와 맞춤)으로 바꾼다.

## 4. 생성 설정

- `LlmRequest`(packages/llm, 경계 밖)에 temperature 칸이 없다. OpenAI 기본 온도는 1이다.
- 먼저 1~3만으로 측정하고, 서로 다른 감상 비율이 목표에 못 미칠 때만 코디네이터에게 묻는다.

## 5. 측정

- 측정 스크립트는 저장소에 넣지 않는다(세션 스크래치, 키 사용).
- 키는 원래 체크아웃 `.env`의 `OPENAI_API_KEY`만 명령 환경변수로 넘긴다(출력·기록 금지).
- 실제 사실: `C:\project\HroovProject\data\er-snapshot.json`만 OS 임시 폴더로 복사해 `createErData`로 읽고 `buildFacts`(사전 이름 검사 포함).
- 고정 사실: narration-fixtures.
- 각 10회 `writeLines` → `composeLines`. 수정 전은 main 코드(같은 스크립트, 워크트리 main 커밋)로 다시 잰다.

## 6. 확인

`npm run typecheck`, `npm run test:unit`, `npm test`, `npm run test:harness`, `npm run test:dashboard-smoke`.

## 실행 기록

(작업하면서 채운다)
