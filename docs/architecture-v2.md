# 아키텍처 v2 — 현재 구조 분석과 1:1 모드 확장 계획

작성일: 2026-10-12 · 기준 커밋: `c8b2aa2` (`feat/rolling-summary`) · 대상: Bori 2.0 (방송 모드 + 1:1 companion 모드)

갱신: 2026-10-12 `docs/sync-v2` — Phase 1·2와 닉네임 노출 수정이 main에 병합된 뒤, 해결된 항목에 **해결됨** 표시를 달고(1·3·6절), 7절에 현재 검사 결과를, 8.1절에 문서 차이 처리 결과를 더하고, 10절 단계 번호를 사용자 지시서 기준으로 바꿨다. 본문 분석과 줄 번호는 기준 커밋 당시 기록으로 남긴다.

> **이 문서는 기준 커밋 당시의 분석이다(2026-10-15, 점검 후속 9.7에서 표시).** 1~8절의 "없다·계획" 서술과 `파일:줄`은 `c8b2aa2`(7.1·8.1절은 `4da0220`) 기준이라 지금 코드와 다르다. 예를 들어 `apps/server/src/index.ts:1000-1033` 같은 줄 번호는 지금 파일과 맞지 않는다. 지금 구조는 [아키텍처](./architecture.md), 진행 상태는 [진행 상황](./progress.md)을 본다. 기준 커밋 뒤 크게 바뀐 것:
>
> - 1.3절·5절 "1:1 대화 API·앱 없음" → Phase 3~6에서 구현했다(`apps/server/src/conversation/`, `apps/server/src/companion/`, `apps/companion`).
> - 6.4절 "CORS `*`, 출처 검사·본문 제한 없음" → `apps/server/src/http/guard.ts`가 모든 API 요청의 Host·Origin·Content-Type·본문 크기(64KB)를 검사한다(Phase 4). 방송 화면 Origin은 1:1 대화·기억 API를 부를 수 없다(점검 X-1). 관리 API 인증은 여전히 없다(로컬 단일 사용자).
> - 7절 "CI 없음" → `.github/workflows/ci.yml`(progress 8.3·9.7절).
> - 10절 Phase 3~8 "진행 중·계획" → 모두 완료했다(progress 6절). "3 후속 방송 코드 분리"는 아직 하지 않았다.

이 문서는 두 가지를 한다.

1. 지금 저장소에 **실제로 있는 것**을 코드 위치와 실행 결과로 기록한다. 기존 문서와 코드가 다르면 코드를 따른다. 차이는 8절에 모았다.
2. 같은 캐릭터 엔진을 1:1 채팅에서도 쓰기 위한 목표 구조와 단계별 계획을 제안한다.

표기 규칙

- `파일:줄`은 기준 커밋의 줄 번호다. 줄 번호만 적은 경우 같은 문단의 파일을 가리킨다.
- **[실행]** 은 이 문서를 쓰면서 직접 돌려 본 결과다. 실행 방법은 부록 A에 있다.
- **[수동]** 은 `docs/verification-log.md`의 수동 검증 기록, **[통합]** 은 `tools/test`의 자동 통합 검사다.
- 기존 문서(README, progress 등)의 오류는 이 문서에서 고치지 않고 8절에만 기록한다. 이후 `docs/sync-v2`에서 고친 결과는 8.1절에 있다.

---

## 1. 기능 현황

### 1.1 구현된 기능

| 영역 | 구현 내용 | 코드 위치 |
|---|---|---|
| 채팅 수신 | `POST /api/chat`. 방송 중(`live`)일 때만 받는다. 공백 제거·소문자 정규화 후 `duplicateWindowMinutes`(기본 5분) 안의 같은 문장을 거부한다 | `apps/server/src/index.ts:1000-1033`, `:367-378` |
| 시청자 식별 | 닉네임이 있으면 `local:<정규화 닉네임>`, 없으면 `virtual-viewer` | `apps/server/src/index.ts:1013` |
| 큐 | 메모리 배열. 최대 크기를 넘으면 가장 오래된 것을 버린다. 질문을 우선 고른다 | `:24`, `:1025-1026`, `:753` |
| 발화권 | `speaking` 플래그. 답변·혼잣말이 겹치지 않는다 | `:36`, `:684-702`, `:758` |
| 세션 세대 | `sessionGeneration`. 비동기 결과가 늦게 와도 이전 세션 것이면 버린다 | `:42`, `:612`, `:693`, `:760`, `:778`, `:964`, `:987` |
| 대기·생성 병렬화 | 5~10초 연출 대기와 LLM·TTS 생성을 `Promise.all`로 겹친다 | `:749-808` |
| 응답 라우팅 | 위험 주제 차단 → 규칙 → LLM → 폴백 문장. 질문 규칙은 LLM에 양보, 기억 질문은 LLM으로 | `:480-554` |
| 규칙 응답 | 규칙 6개 + 폴백 문장 3개. 같은 문장 쿨다운 | `:408-472`, `:380-388` |
| 혼잣말 | 하드코딩 7문장. 채팅이 오면 취소 | `:559-577`, `:708-738` |
| LLM 어댑터 | OpenAI(Structured Outputs), Anthropic(강제 도구 호출). gemini는 팩토리가 `null` | `packages/llm/src/index.ts:34-41`, `openai.ts`, `anthropic.ts` |
| 출력 검증 | JSON → reply 길이 → 감정 allowlist → 강도·지속 → 모션 allowlist → layer·priority | `packages/llm/src/validate.ts:12-101` |
| 회로 차단기·통계 | 연속 실패가 기준에 닿으면 `cooldownSeconds` 동안 호출 중단. 호출·실패·지연 통계 | `packages/llm/src/index.ts:54-156` |
| 프롬프트 | 시스템: 페르소나·역할 범위·출력 규칙·모션 설명. 사용자: `[방송 상황]` `[지금까지의 방송]` `[참고 정보]` `[기억]` `[최근 대화]` `[답변할 채팅]` | `packages/llm/src/prompt.ts:7-81` |
| 최근 대화 창 | 발언 10개(채팅 5건 분량) | `apps/server/src/index.ts:47`, `:582-589` |
| 방송 중 누적 요약 | `rollingSummaryTurns`(기본 10, 하한 4)마다 이전 요약 + 새 대화를 한 문단으로 접는다 | `:597-626`, `:848`, `packages/llm/src/summarize.ts:110-149` |
| 키워드 매크로 | `data/macros.json`. 키워드가 나오면 `durationTurns` 동안 `[참고 정보]`에 주입. 동시 5개 | `apps/server/src/index.ts:226-336`, `:823-829` |
| 방송 상황 문장 | 경과 분, 답변 수를 서버가 계산해 주입 | `:341-351` |
| 장기 기억 저장 | 방송 종료 시 규칙으로 취향·경험 후보 추출 + LLM 방송 요약·하이라이트. 같은 문장은 반복 횟수·중요도·수명 갱신 | `:632-673`, `packages/memory/src/extract.ts:19-47`, `store.ts:45-90` |
| 장기 기억 검색 | 임베딩 있으면 코사인 + 중요도×0.05, 없으면 중요도·최신순 top-K | `packages/memory/src/store.ts:97-127` |
| 기억 만료 | 로드 시 `expiresAt` 지난 것 삭제 | `store.ts:31-38` |
| TTS | OpenAI·ElevenLabs. 결과는 메모리 캐시 30건, `GET /api/tts/{id}` | `apps/server/src/index.ts:122-187`, `:912-918`, `packages/llm/src/tts.ts` |
| 키 암호화 | AES-256-GCM, 키는 `사용자명@호스트명`에서 scrypt 파생 | `apps/server/src/secret-store.ts:15-49` |
| 관리자 API | 상태·설정·LLM·TTS·기억 조회/수정/삭제, 매크로 다시 읽기, 표정·모션 테스트 | `apps/server/src/index.ts:814-961` |
| 방송 화면 | React + Cubism SDK. `/api/state`를 250ms마다 폴링. 립싱크·시선·표정·모션 | `apps/broadcast/src/main.tsx:402-415` |
| 채팅 화면 | `chat.html`. 닉네임 저장, 1초 폴링, 보리 답변 표시 | `apps/broadcast/src/chat.tsx:21-43` |
| 관리자 앱 | Electron + React. 1.5초 폴링 | `apps/admin/src/main.tsx:81`, `apps/admin/electron/main.cjs` |
| Live2D 매핑 | 표정 8·모션 4 allowlist, 감정→표정·모션 매핑, 모션 설명 | `packages/live2d/src/index.ts:17-139` |

### 1.2 검증된 기능 — 수동 검증과 통합 검사 구분

**통합 검사 [통합]** — `npm run test`, 가짜 OpenAI(`tools/test/mock-openai.mjs`)에 실제 서버를 붙여 HTTP로 조작한다. 32건 전부 통과 [실행]. (갱신: 현재는 기억 격리 시나리오가 더해져 46건이고, 단위 검사 66건이 따로 있다. 7.1절)

| 시나리오 | 확인하는 것 | 위치 |
|---|---|---|
| 지연 | 매크로 로드·키워드 없는 항목 폐기, 시스템 프롬프트 크기 노출, 대기·생성 병렬(6.0초 기대, [실행] 6007ms), 답변 출처 LLM, 음성 첨부, 매크로·방송 상황·기억 프롬프트 주입, 호출 순서 임베딩→LLM→TTS, 중복 창 거부·만료 후 재허용, 대기가 짧을 때 생성이 지배, 누적 요약 주기·프롬프트·이후 답변 반영 | `tools/test/latency.mjs:28-102` |
| 동작 | 매크로 다시 읽기·켜짐·유지·소멸, LLM 실패 시 폴백, 회로 열림·호출 차단·설정 변경 시 닫힘, 혼잣말 발화와 최근 대화 기록, 세션 재시작 전후 답변과 이전 타이머가 새 말풍선을 지우지 않음 | `tools/test/behavior.mjs:27-116` |

통합 검사가 **다루지 않는 것**: 방송 종료 시 기억 저장(`persistSessionMemories`), 기억 소유자, 닉네임 처리(**해결됨**: 이 세 가지는 이후 `tools/test/isolation.mjs`가 다룬다), `/api/memory`·`/api/tts`·`/api/live2d/test` 엔드포인트, 위험 주제 차단, 실제 LLM·TTS 응답, 화면. `session/end`는 정리용으로만 호출한다(`tools/test/latency.mjs:105`, `behavior.mjs:119`).

**수동 검증 [수동]** — `docs/verification-log.md`(최종 갱신 2026-08-30). 빌드·타입, 화면 렌더링, Live2D, 표정·모션 파라미터, 시선·립싱크, 큐·규칙·혼잣말·세션 재시작, 안전성(allowlist 400, 키 암호화), LLM 출력 검증 11건·실 API·회로 차단기, 기억 저장·회수·요약, OpenAI TTS, 채팅 화면, OBS 송출.

수동 검증 기록은 **2026-09-01 커밋 3개(누적 요약, 지연 단축·매크로, 통합 검사) 이전**이다. 따라서 다음은 실 API로 확인된 기록이 없고 가짜 API 통합 검사로만 뒷받침된다.

- 방송 중 누적 요약 (`5f8fdc3`)
- 키워드 매크로, 대기·생성 병렬화, 방송 상황 문장 (`85ba2b6`)
- 기억 없음 명시 문구 (`5f8fdc3`)

### 1.3 미완성·미검증

| 항목 | 상태 | 근거 |
|---|---|---|
| 기억 검색 소유자 필터 | **해결됨** (Phase 1, main 병합). 당시: 없음. 누구의 질문이든 전체 기억에서 검색 | `packages/memory/src/store.ts:97-127`, 호출부 `apps/server/src/index.ts:528` · [실행] 탐침 결과는 6.1절 |
| 1:1 대화 모드 | 없음. 모든 상태가 방송 단일 세션 전제. (갱신: `companion` 정책 초안과 private 기억 검색 규칙만 생겼고 API·앱은 여전히 없다) | 5절 |
| 치지직 연동 | 없음. `ChatSource`의 `"chzzk"`는 타입뿐이고 생성 값은 항상 `"manual"` | `packages/shared/src/index.ts:9`, `apps/server/src/index.ts:1017` |
| gemini | 팩토리 `null` | `packages/llm/src/index.ts:37` |
| Anthropic 어댑터 | 코드 있음, 실 API 미검증. 임베딩은 OpenAI 업체일 때만 써서 Anthropic 사용 시 기억 검색이 항상 중요도·최신순으로 떨어진다 | `packages/llm/src/anthropic.ts:11`, `apps/server/src/index.ts:217` |
| ElevenLabs | 코드 있음, 실 키 미검증 | `docs/verification-log.md:169` |
| 목소리 이름 검증 | 없음. `PATCH /api/tts`는 업체만 검사하고 `voice`는 그대로 저장 | `apps/server/src/index.ts:879-888` · [실행] `{"voice":"../../evil-voice"}`가 200으로 저장됨 |
| Anthropic + OpenAI TTS 조합 | 결함. TTS가 업체와 무관하게 `llmApiKey`를 OpenAI 키로 쓰므로 LLM 업체가 Anthropic이면 Anthropic 키가 OpenAI TTS로 간다 | `apps/server/src/index.ts:128`, `:130` |
| 기억 기반 혼잣말 | 없음 | `apps/server/src/index.ts:556-577` |
| 원문 채팅 로그 | 없음. 메모리에만 있음 | `:78` |
| 레이아웃 전환 | 없음. `layout`은 항상 `"chat"` | `:353` |
| 요청 본문 크기 제한 | 없음. `body += chunk`로 끝까지 받는다 | `:831`, `:875`, `:928`, `:949`, `:961`, `:1001` |
| 30분 이상 송출 | 미검증 | `docs/verification-log.md:193` |

---

## 2. 모듈 간 의존 관계

### 2.1 워크스페이스 import 그래프

실제 `import` 문 기준이다(`grep -rn "from \"@bori"`). `package.json` 선언과 다른 곳은 따로 표시했다.

```
apps/server ──► @bori/shared (타입)        apps/server/src/index.ts:6
            ──► @bori/live2d (allowlist)   :7
            ──► @bori/llm                  :8
            ──► @bori/memory               :9
            ──► ./secret-store             :10

apps/broadcast ──► @bori/shared (타입)     apps/broadcast/src/main.tsx:3, chat.tsx:3
               ──► @bori/live2d            main.tsx:4
               ──► (Cubism SDK, 저장소 밖)  vite.config.ts:76-82

apps/admin ──► @bori/shared (타입)         apps/admin/src/main.tsx:3
           ──► @bori/live2d (라벨)         main.tsx:4

packages/llm    ──► @bori/shared (타입)    packages/llm/src/index.ts:1, types.ts:1, validate.ts:1
packages/memory ──► (없음)
packages/live2d ──► (없음)
packages/shared ──► (없음)

tools/test ──► (HTTP로만) apps/server     tools/test/run.mjs:49
```

- `packages/llm/package.json:9`는 `@bori/live2d`를 의존성으로 선언하지만 `packages/llm/src`에 import가 없다. 감정·모션 목록은 서버가 `LlmRequest`로 넘긴다(`apps/server/src/index.ts:542-543`).
- `packages/memory/package.json:9`는 `@bori/shared`를 선언하지만 import가 없다.
- 순환 의존은 없다. 패키지는 모두 서버를 모른다.

### 2.2 서버 내부 책임 덩어리

`apps/server/src/index.ts` 1,060줄 한 파일에 아래 책임이 모듈 전역 변수와 함수로 섞여 있다.

| 덩어리 | 상태(전역) | 함수 | 줄 |
|---|---|---|---|
| 큐 | `queue`, `settings`, `recentContents` | `isDuplicateChat`, `syncQueueState`, `scheduleNext` | 13-30, 367-378, 579, 749-808 |
| 발화권 | `speaking`, `responseTimer`, `monologueTimer` | `speak`, `cancelMonologue`, `scheduleMonologue` | 33-36, 675-738 |
| 세션 세대 | `sessionGeneration`, `sessionStartedAt`, `answeredCount` | `/api/session/start`·`end` 처리 | 42, 341-342, 962-999 |
| 규칙 | `replyLastUsedAt`, `rules`, `fallbackReplies`, `unsafePattern`, `memoryQuestionPattern` | `pick`, `evaluateByRule`, `fallbackResponse` | 32, 355-505 |
| LLM | `llmSettings`, `llmApiKey`, `llm`(클라이언트 1개) | `makeResponse`, `loadLlmConfig`, `saveLlmConfig`, `systemPromptSize` | 59-120, 312-325, 511-554 |
| 대화 문맥 | `recentTurns`, `sessionTurns` | `recordTurn` | 76-78, 582-589 |
| 요약 | `sessionSummary`, `summarizedTurnCount`, `summaryInFlight` | `maybeUpdateRollingSummary`, `persistSessionMemories`의 방송 요약 | 80-84, 597-626, 639-660 |
| 기억 | `memoryStore`, `memorySettings` | `loadMemoryConfig`, `currentEmbedding`, `persistSessionMemories` | 189-221, 632-673 |
| 매크로 | `macros`, `activeMacros`, `macroLoadError` | `loadMacros`, `activateMacros`, `tickMacros`, `macroStatus` | 226-336 |
| 방송 상황 | `sessionStartedAt`, `answeredCount` | `broadcastStatusLines` | 341-351 |
| TTS | `ttsSettings`, `elevenLabsApiKey`, `audioCache`, `ttsFailureCount` | `prepareAudio`, `loadTtsConfig`, `saveTtsConfig` | 122-187 |
| 화면 상태 | `state`(BroadcastState), `testActionSeq` | 여러 곳에서 직접 재할당 | 43, 353 |
| HTTP 라우팅 | — | `createServer` 콜백의 if 체인. 라우트 18개 + `OPTIONS` | 810-1035 |
| 기동 | `port`, `listenRetries` | `server.listen`, EADDRINUSE 재시도 | 12, 1036-1060 |

호출 흐름(채팅 한 건):

```
POST /api/chat (1000)
  └─ queue.push → scheduleNext (749)
       ├─ speaking = true, generation 캡처
       ├─ waited: 5~10초 타이머
       └─ prepared: makeResponse (511)
            ├─ evaluateByRule (480) ── blocked → null / matched → 규칙 응답
            ├─ activateMacros (282)
            ├─ memoryStore.search (528)   ← 소유자 정보 없이 content만 전달
            └─ llm.respond (535) ── 실패 → fallbackResponse
          → prepareAudio (165)
       Promise.all 후 세대 검사 (778)
       ├─ recordTurn viewer/bori (790-791) → maybeUpdateRollingSummary (597)
       ├─ tickMacros (794)
       └─ speak (684) → 표시 후 scheduleNext / scheduleMonologue
```

---

## 3. 재사용 가능한 구성 요소 (1:1 모드 관점)

| 구성 요소 | 위치 | 그대로 재사용 | 고쳐야 재사용 |
|---|---|---|---|
| LLM 어댑터·레지스트리 | `packages/llm/src/{openai,anthropic,index}.ts` | O | — |
| 출력 검증기 | `packages/llm/src/validate.ts` | O. 감정·모션 allowlist를 요청으로 받으므로 모드 무관 | — |
| LLM 클라이언트(회로 차단기·통계) | `packages/llm/src/index.ts:54-156` | 구조는 O | 인스턴스를 모드별로 둘지 결정 필요(5.2) |
| 프롬프트 조립 | `packages/llm/src/prompt.ts` | 섹션 조립 방식 | **해결됨** (Phase 2): 페르소나·모드 정책을 `packages/character`에서 받고 `LlmRequest.mode`로 고른다. 당시: 페르소나 문구가 하드코딩(`:9-14`), `[방송 상황]`·`시청자` 라벨이 방송 전용(`:46`, `:74`). 캐릭터·모드 정책을 입력으로 받아야 함 |
| 요약 | `packages/llm/src/summarize.ts` | `summarizeSessionProgress`의 접기 방식 | 프롬프트가 "방송" 전제(`:23-24`, `:92`) |
| TTS | `packages/llm/src/tts.ts`, 서버 `prepareAudio` | O | 캐시가 전역 30건(`apps/server/src/index.ts:132-133`). 1:1 음성 ID가 방송 캐시를 밀어낼 수 있음 |
| 기억 저장소 | `packages/memory/src/store.ts` | 파일 저장·임베딩·만료 | **해결됨** (Phase 1): scope·`ownerId`와 접근 필수 검색. 당시: 소유자·scope 필터가 없음(6.1). 스키마에 scope 필드 필요 |
| 기억 후보 추출 | `packages/memory/src/extract.ts` | 규칙 추출 | 제외 정규식이 키워드 기반이라 1:1처럼 사적인 대화에서 새는 범위가 넓다(6.6) |
| 임베딩 | `packages/memory/src/embedding.ts` | O | — |
| 키 암호화 | `apps/server/src/secret-store.ts` | O(한계는 6.7) | — |
| Live2D 매핑 | `packages/live2d` | O. 1:1에서 아바타를 띄운다면 그대로 사용 | — |
| 규칙 응답 | `apps/server/src/index.ts:408-505` | 판정 로직(`evaluateByRule`) | 문장에 "여러분"이 박혀 있음(`:412`, `:423`, `:439`, `:469`). 규칙 데이터를 모드별로 분리해야 함 |
| 위험 주제 차단 | `:355`, `:482` | 정규식 | 차단 시 무반응(`:516`). 1:1에서는 무반응이 곧 고장처럼 보이므로 거절 문장이 필요 |
| 매크로 | `:226-336` | 파일 형식·활성화 규칙 | `activeMacros`가 전역(`:235`) |
| 통합 검사 하네스 | `tools/test/harness.mjs`, `mock-openai.mjs` | O. 1:1 API 시나리오를 같은 방식으로 추가 가능 | — |

방송 전용으로 남겨야 하는 것: 큐(`:24`), 발화권(`:36`), 세션 세대(`:42`), 연출 대기(`:762-767`), 혼잣말(`:556-738`), 화면 상태 `BroadcastState`(`:353`), 화면 채팅 목록(`:1022-1023`), 방송 상황 문장(`:344-351`).

---

## 4. 리팩터링이 필요한 구조 — 공통 대화 엔진 경계

### 4.1 문제

`makeResponse`(`apps/server/src/index.ts:511-554`)가 대화 엔진의 핵심인데 인자는 `content` 하나뿐이고 나머지는 전부 모듈 전역에서 읽는다: `llmSettings`, `llmApiKey`, `llm`, `recentTurns`, `sessionSummary`, `activeMacros`, `memoryStore`, `memorySettings`, `broadcastStatusLines()`가 읽는 `state`·`sessionStartedAt`·`answeredCount`. 실패 시에는 `state.lastError`를 직접 고친다(`:551`). 그래서 두 번째 대화 세션을 만들 방법이 없다.

`recordTurn`(`:582`)은 문맥 기록과 누적 요약 트리거를 겸하고, 요약 콜백은 방송의 `sessionGeneration`을 본다(`:612`, `:617`). 문맥 관리가 방송 세대에 묶여 있다.

### 4.2 경계 제안

```
┌──────────────── 방송 쪽 (apps/server, 남긴다) ───────────────┐
│ 큐 · 질문 우선 선택 · 중복 창(recentContents)                 │
│ 발화권(speaking) · 응답/혼잣말 타이머 · 연출 대기             │
│ 세션 세대(sessionGeneration) 경합 제어 · BroadcastState       │
│ 혼잣말 · 방송 상황 문장 · 방송 종료 시 기억 저장 트리거       │
└───────────────┬──────────────────────────────────────────────┘
                │ engine.respond(input, session)
                ▼
┌──────────── 공통 대화 엔진 (Phase 3) ────────────────────────┐
│ ConversationSession: recentTurns · sessionTurns ·            │
│   summary · summarizedTurnCount · summaryInFlight ·          │
│   activeMacros · replyLastUsedAt                             │
│ respond(): 위험 차단 → 규칙 → 매크로 → 기억 검색(scope 필터) │
│   → LLM → 검증 → 폴백                                        │
│ record(): 턴 기록 + 누적 요약 트리거                          │
│ 의존성 주입: character(페르소나·모드 정책), llm 클라이언트,   │
│   memory 접근자, 상황 문장 공급자(statusLines)               │
└───────────────┬──────────────────────────────────────────────┘
                ▼
     packages/llm · packages/memory · packages/character
```

엔진 입력·출력 초안(이름은 Phase 3에서 확정한다).

```ts
// 초안 — Phase 3에서 확정
type Speaker = { ownerId: string | null };            // null = 소유자 불명, 기억 읽기·쓰기 모두 막힘
type Mode = "broadcast" | "companion";

type RespondInput = {
  content: string;
  speaker: Speaker;
  statusLines?: readonly string[];                    // 방송 상황 문장은 방송 쪽이 만들어 넘긴다
};

type RespondResult =
  | { kind: "blocked" }                               // 방송은 무반응, 1:1은 정책의 거절 문장
  | { kind: "reply"; response: CharacterResponse; usedMemoryIds: string[] };

interface ConversationEngine {
  createSession(mode: Mode): ConversationSession;
  respond(session: ConversationSession, input: RespondInput): Promise<RespondResult>;
  record(session: ConversationSession, turn: { role: "user" | "character"; text: string; ownerId?: string }): void;
}
```

경계 규칙

1. **방송 큐·발화권·세션 세대 경합 제어는 방송 쪽에 남긴다.** 이들은 "한 화면에 한 번에 한 말풍선"이라는 방송 제약에서 나온 것이고(`:684-702`, `:749-808`), 1:1에는 같은 제약이 없다. 엔진이 이것을 알면 1:1이 방송 타이머에 끌려간다.
2. 엔진은 `BroadcastState`를 읽거나 쓰지 않는다. `state.lastError` 갱신(`:551`)은 결과를 받은 방송 쪽이 한다.
3. 누적 요약의 세대 검사(`:612`, `:617`)는 **세션 객체 교체**로 대신한다. 방송을 다시 시작하면 방송 쪽이 새 `ConversationSession`을 만들고, 늦게 도착한 요약은 버려진 옛 세션에 써질 뿐이다. 반면 `speak`·`scheduleNext`의 세대 검사(`:693-696`, `:778`)는 타이머와 화면에 관한 것이므로 방송 쪽에 그대로 둔다.
4. 매크로 수명은 "답변이 실제로 나갔을 때" 줄어든다(`:793-794`). 이 시점은 방송 쪽만 안다. 엔진은 `tickMacros(session)`을 노출하고 호출 시점은 모드가 정한다.
5. 기억 검색은 엔진이 `speaker`와 `mode`를 함께 넘겨 scope 필터를 강제한다(9.3). 엔진 밖에서 `memoryStore.search`를 직접 부르는 경로를 남기지 않는다.

### 4.3 그 밖의 정리 대상

| 대상 | 내용 | 위치 |
|---|---|---|
| 잘못 붙은 주석 | `isDuplicateChat` 위 주석이 `pick`의 설명("쿨다운이 지나지 않은 문장은 피해서 고른다")이다 | `apps/server/src/index.ts:363-367` |
| 유니코드 이스케이프 문자열 | 규칙·정규식·일부 주석이 `\uXXXX`로 저장돼 있어 검색·리뷰가 어렵다 | `:355-359`, `:391-392`, `:409-472`, `:1006-1021` |
| 중복 응답 본문 | `GET`/`PATCH /api/llm`, `GET`/`PATCH /api/tts`가 같은 응답 객체를 두 번씩 조립 | `:819`·`:852`, `:862-871`·`:898-907` |
| 한 줄 라우트 | `PATCH /api/settings`가 한 줄에 파싱·검증 없는 병합·타이머 재설정 | `:961` |
| 설정 검증 부재 | `PATCH /api/settings`·`/api/memory`·`/api/tts`가 타입·범위 검사 없이 병합 | `:961`, `:931`, `:888` |
| 요약 호출이 통계 밖 | 누적 요약·방송 요약은 `createAdapter`로 직접 호출해 회로 차단기 통계에 잡히지 않는다(열림 여부만 본다) | `:601`, `:607`, `:640` |
| 선언만 된 의존성 | 2.1 참조 | `packages/llm/package.json:9`, `packages/memory/package.json:9` |

---

## 5. 1:1 채팅 추가 시 충돌 지점

### 5.1 모듈 전역 상태가 방송 단일 세션 전제

| 전역 | 선언 | 1:1이 같은 프로세스에 들어오면 |
|---|---|---|
| `recentTurns` | `apps/server/src/index.ts:76` | 방송 시청자 대화와 1:1 대화가 한 창에 섞여 서로의 프롬프트 `[최근 대화]`에 들어간다 |
| `sessionTurns` | `:78` | 방송 종료 시 1:1 대화까지 방송 기억 후보·방송 요약 대상이 된다(`:635`, `:643`) |
| `sessionSummary` | `:80` | 1:1 내용이 `[지금까지의 방송]`으로 방송 프롬프트에 노출된다 |
| `summarizedTurnCount`, `summaryInFlight` | `:82-84` | 두 대화가 하나의 요약 진행 상태를 공유 |
| `activeMacros` | `:235` | 1:1에서 켠 매크로가 방송 답변에 붙고, 방송 답변 수로 1:1 매크로 수명이 줄어든다 |
| `state` | `:353` | `/api/state`가 방송 화면·채팅 화면·관리자에 모두 같은 객체를 준다. 1:1 응답을 여기에 쓰면 방송 말풍선으로 나간다 |
| `replyLastUsedAt` | `:32` | 규칙 문장 쿨다운이 공유되어 한쪽이 다른 쪽의 문장 선택을 바꾼다 |
| `recentContents` | `:30` | 중복 창이 사용자 구분 없이 전역. [실행] 닉네임 `A`가 보낸 `안녕` 직후 닉네임 `B`의 `안녕`이 400 |
| `sessionGeneration` | `:42` | 방송을 재시작하면 세대가 올라 1:1 대화의 요약 콜백도 버려진다(`:617`) |
| `answeredCount`, `sessionStartedAt` | `:341-342` | 1:1 답변이 "지금까지 채팅 N개에 답했다"에 섞인다 |
| `audioCache` | `:132` | 30건 FIFO 공유 |

또한 `POST /api/chat`은 `state.status !== "live"`이면 거부한다(`:1006`). 1:1은 방송 여부와 무관해야 하므로 같은 엔드포인트를 쓸 수 없다.

### 5.2 공유되는 LLM 상태

- 회로 차단기와 통계가 `createLlmClient()` 인스턴스 하나에 있다(`apps/server/src/index.ts:74`, `packages/llm/src/index.ts:58-65`). 1:1 호출이 연속 실패하면 방송의 LLM도 끊기고, 관리자 화면의 호출 수·평균 지연이 두 모드 합계가 된다.
- `PATCH /api/llm`은 `llm.reset()`으로 통계와 회로를 지운다(`:850`). 한쪽 설정 변경이 다른 쪽 상태를 지운다.
- 키·모델·`maxReplyLength`(기본 120자, 말풍선 기준 `packages/shared/src/index.ts:59`)가 하나뿐이다.

권고: 키는 공유하되 `createLlmClient()` 인스턴스를 모드별로 하나씩 두어 회로·통계를 분리한다. 같은 키의 업체 측 한도(rate limit)는 공유된다는 점은 남는다.

### 5.3 프롬프트·규칙의 방송 전제

- 시스템 프롬프트: "시청자를 부를 때는 '여러분'이라고 한다"(`packages/llm/src/prompt.ts:12`), "시청자 닉네임은 절대 부르지 않는다"(`:13`), "밝고 편안한 소통 방송 진행자다"(`:14`), 역할 범위의 "방송 이야기"(`:17`).
- 사용자 프롬프트 라벨: `[방송 상황]`(`:46`), `[지금까지의 방송]`(`:52`), `시청자:`(`:74`), `[답변할 채팅]`(`:79`).
- 요약 프롬프트: "방송 기록을 정리하는 도우미"(`packages/llm/src/summarize.ts:23-24`), "진행 중인 방송의 흐름"(`:92`).
- 규칙 문장: "여러분, 안녕하세요!"(`apps/server/src/index.ts:412`), "여러분 덕분에"(`:423`), "여러분은 요즘 어떤 노래를"(`:439`), "여러분의 이야기 잘 보고 있어요"(`:469`). 혼잣말도 "여러분"을 쓴다(`:565`).
- 서버가 계산하는 `systemPromptSize()`는 방송 프롬프트 하나만 잰다(`:312-325`).

1:1에서 "여러분"은 틀린 호칭이고, "닉네임 금지"는 1:1에서 사용자가 원하면 이름을 불러도 되는지라는 별도 결정이 필요하다. 이 결정은 `packages/character`의 모드 정책 데이터로 둔다(Phase 2, 결정은 미확정·검토 필요). (갱신: Phase 2는 main에 병합되었고, 1:1 정책 값은 초안이며 `검토 필요` 항목은 그대로 둔다)

### 5.4 `persistSessionMemories`의 기억 저장 경로

```ts
const candidates = extractMemoryCandidates(sessionTurns, "virtual-viewer")   // apps/server/src/index.ts:635
```

- 방송 종료 한 곳에서만 기억을 쓴다(`:996`). 1:1에는 "종료" 시점이 없으므로 쓰기 시점(대화 N턴마다, 세션 유휴 시 등)을 따로 정해야 한다.
- 소유자 기본값이 `virtual-viewer`다. 발언에 `viewerId`가 있으면 그것을 쓰고(`packages/memory/src/extract.ts:34`), 없으면 이 값이 된다. 실제로는 서버가 모든 채팅에 `viewerId`를 넣으므로(`apps/server/src/index.ts:1013`, `:790`) 익명 채팅이 `virtual-viewer` 한 소유자로 묶인다.
- 방송 요약·하이라이트는 `viewerId` 없이 `kind: "broadcast"`로 저장된다(`:647`, `:651`). 접근 규칙표의 `broadcast / -(요약)` 행에 해당한다.
- 저장 시 scope 개념이 없다. 1:1 대화가 이 함수로 들어가면 개인 대화가 방송 기억(`kind: "viewer"`)으로 저장되고, 검색 필터가 없으므로 방송 프롬프트에 나온다.

---

## 6. 보안·데이터 격리 문제

### 6.1 기억 검색에 소유자 필터가 없다

> **해결됨** (Phase 1, main 병합). `search`가 접근 정보(방송의 말한 시청자 또는 1:1 사용자)를 필수로 받고, 9.3 규칙표에 맞는 기억만 남긴 뒤 유사도 순위와 폴백 정렬을 계산한다. 규칙표 밖 조합과 알 수 없는 scope는 제외한다. `packages/memory/test`와 `tools/test/isolation.mjs`가 확인한다. 아래는 당시 기록이다.

`search(query, settings, embedding)`(`packages/memory/src/store.ts:97`)에는 요청자를 넘길 매개변수가 없고, 호출부도 `content`만 넘긴다(`apps/server/src/index.ts:528`). 임베딩이 없으면 질문과 무관하게 중요도·최신순 top-K를 돌려준다(`store.ts:110-116`). 즉 키가 없거나 Anthropic을 쓰면(`apps/server/src/index.ts:217`) **매 답변마다 다른 시청자의 기억 상위 5건이 그대로 프롬프트에 들어간다.**

[실행] 저장소 밖 임시 디렉터리에서 `packages/memory`를 직접 불러 확인했다.

```
candidates [ 'local:a: 저는 요즘 퇴근하고 재즈를 자주 듣고 있어요',
             'virtual-viewer: 다음 주에 병원 예약이 있어서 이사 준비가 힘들었어요' ]
hits for anyone [ 'local:a: …재즈…', 'virtual-viewer: …병원 예약…' ]
```

`local:a`의 기억이 누구의 질문에도 반환된다.

### 6.2 익명 채팅이 `virtual-viewer` 한 소유자로 묶인다

> **해결됨** (Phase 1, main 병합). 익명 발언은 기억 후보가 되지 않고, 기존 `virtual-viewer`·소유자 없는 시청자 기억은 기동 시 마이그레이션으로 지워진다(원본 백업 유지). 채팅의 `viewerId` 값 자체는 여전히 `virtual-viewer`다. 아래는 당시 기록이다.

닉네임 없는 채팅은 모두 `viewerId: "virtual-viewer"`(`apps/server/src/index.ts:1013`). 관리자 앱의 테스트 채팅은 닉네임을 보내지 않으므로(`apps/admin/src/main.tsx:78`) 항상 이 소유자다. 서로 다른 익명 시청자의 기억이 한 사람의 기억처럼 쌓인다. 사용자 결정에 따라 이 기억들은 소유자 불명으로 보고 마이그레이션 시 삭제한다(백업 유지, 9.3).

### 6.3 `local:<닉네임>`은 인증이 아니다

- ID는 클라이언트가 보낸 닉네임을 소문자화·공백 제거한 값이다(`apps/server/src/index.ts:356`, `:1010-1013`). 같은 닉네임을 입력하면 누구든 같은 ID가 된다. `Steven Kim`과 `stevenkim`도 같은 ID다.
- 닉네임은 브라우저 `localStorage`에만 있다(`apps/broadcast/src/chat.tsx:11`, `:50`).
- **해결됨** (`dffbf24`, main 병합): `/api/state`의 `visibleChats`는 `VisibleChat`(`id`·`content`·`receivedAt`·`category`)만 싣는다. 통합 검사 2건이 확인한다. 당시: 방송 화면에는 닉네임을 숨기지만(`apps/server/src/index.ts:1021-1022`) **`viewerId`는 그대로 `visibleChats`에 남아 `/api/state`로 나간다.** [실행] 닉네임 `Steven Kim`으로 채팅한 뒤 `/api/state`의 `visibleChats[0].viewerId`가 `"local:stevenkim"`이었다. 방송 화면·채팅 화면·관리자가 모두 이 JSON을 폴링한다.

`viewerId` 노출은 해결됐지만 앞의 두 항목(닉네임 파생 ID, 인증 없음)은 남아 있다. 따라서 방송 쪽 소유자 ID로 개인 기억(private)을 열면 사칭으로 남의 1:1 기억을 읽을 수 있다. 접근 규칙표가 방송에서 private를 전부 X로 둔 것이 이 위험을 막는다. 1:1 사용자 ID는 닉네임에서 파생하지 않는다.

### 6.4 CORS `*`와 인증 없는 관리 API

- 모든 응답에 `Access-Control-Allow-Origin: *`(`apps/server/src/index.ts:812`). [실행] `OPTIONS /api/chat` 응답 헤더로 확인.
- 인증이 없다. 같은 포트에 `DELETE /api/memory/all`(`:941`), `PATCH /api/llm`의 키 교체(`:841`), `GET /api/memory`의 기억 원문 50건(`:920-925`)이 있다.
- 서버 쪽에는 출처 검사가 없으므로, 같은 컴퓨터의 브라우저에서 연 임의 웹 페이지가 `http://127.0.0.1:4310/api/memory`를 읽을 수 있는 구조다. 브라우저의 사설망 접근 정책(Private Network Access 등)이 막을 수는 있으나 서버가 기대할 수 있는 방어가 아니다. 실제 브라우저에서 외부 출처 요청이 통과하는지는 **미검증**이다.

### 6.5 127.0.0.1 바인딩과 "휴대폰 채팅" 서술

코드로 확인한 결과, 현재 설정으로는 **휴대폰·LAN에서 `chat.html`을 열 수 없다.**

| 구성 | 바인딩 | 위치 |
|---|---|---|
| API 서버 | `127.0.0.1` | `apps/server/src/index.ts:1054`, `:1057` |
| 방송·채팅 화면 dev | `vite --host 127.0.0.1 --port 4173` | `apps/broadcast/package.json:7` |
| 방송·채팅 화면 preview | `host: "127.0.0.1"` | `apps/broadcast/vite.config.ts:88` |

[실행] 서버를 4422 포트로 띄우고 `netstat`에서 `127.0.0.1:4422 LISTENING`, 같은 컴퓨터의 LAN 주소(`192.168.55.246:4422`)로는 `curl` 연결 거부(종료 코드 7), `127.0.0.1:4422`로는 정상 응답.

그런데 README(`README.md:39`), progress(`docs/progress.md:52`, `:209`), Vite 설정 주석(`apps/broadcast/vite.config.ts:84`)은 휴대폰에서 연다고 쓴다(8절 표). 휴대폰 접속을 위해 Vite를 `--host 0.0.0.0`으로 바꾸면 Vite 프록시가 `/api` 전체를 서버로 넘기므로(`apps/broadcast/vite.config.ts:86`) 6.4의 관리 API까지 LAN에 무인증으로 열린다. 채팅 화면만 열고 싶다면 `/api/chat`·`/api/state`만 통과시키는 별도 경로가 필요하다.

### 6.6 개인 대화 API를 외부에 열면 안 되는 이유

1:1 API를 지금 서버 구조 그대로 LAN·인터넷에 열면:

1. 사용자 ID가 자기 신고값이다(6.3). 남의 ID로 1:1 대화를 열면 그 사람의 private 기억이 프롬프트에 들어가고 답변으로 새어 나온다.
2. 같은 포트의 관리 API(6.4)가 함께 열린다. 기억 전체 조회·삭제, API 키 교체가 가능하다.
3. 요청 본문 크기 제한·속도 제한이 없다(1.3). LLM·TTS 비용은 소유자의 키로 청구된다.
4. 기억 제외 규칙이 키워드 정규식이다(`packages/memory/src/extract.ts:4`). [실행] "병원 예약이 있어서 이사 준비가 힘들었어요"가 `의료` 키워드에 걸리지 않고 후보로 뽑혔다. 1:1 대화는 방송보다 사적인 내용이 많아 새는 범위가 넓다.
5. `data/memories.json`은 평문이다(`packages/memory/src/store.ts:25-28`). 암호화는 API 키에만 적용된다.

권고(10절에서 Phase 4의 선행 조건으로 배치): 1:1 API는 `127.0.0.1` 전용으로 두고, 별도 경로 접두사(`/api/companion/*`)와 서버가 발급한 로컬 토큰을 요구한다. CORS는 알려진 출처(4173, 5174, companion 앱)만 허용한다. 외부 공개는 이번 범위에 넣지 않는다.

### 6.7 API 키 암호화의 한계

- 암호화 키는 `os.userInfo().username`과 `os.hostname()`에 고정 salt를 붙여 scrypt로 만든다(`apps/server/src/secret-store.ts:15-19`). 두 값은 비밀이 아니므로, 설정 파일을 손에 넣은 사람이 사용자명·호스트명을 알면 복호화할 수 있다. 코드 주석도 이 한계를 적고 있다(`:11-13`).
- 환경변수 키(`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`)는 저장된 키가 없을 때 쓰이며(`apps/server/src/index.ts:72`, `:125`) `.env` 평문이다.
- 키 교체 API에 인증이 없다(`:841`).
- 키를 응답으로 내보내지 않는 점은 확인된다(`:817-819`, `packages/shared/src/index.ts:106-112`).

---

## 7. 자동화 테스트·빌드 상태

[실행] 2026-10-12, Node v24.12.0, Windows 11, 이 worktree.

| 명령 | 결과 | 시간 |
|---|---|---|
| `npm run typecheck` | 종료 코드 0. shared·server·broadcast·admin 4개 | 10.4초 |
| `npm run typecheck:live2d` | 종료 코드 0 | 2.5초 |
| `npm run typecheck:llm` | 종료 코드 0 | 2.5초 |
| `npm run typecheck:memory` | 종료 코드 0 | 2.1초 |
| `MOCK_PORT=4420 BORI_TEST_PORT=4421 npm run test` | **32건 중 32건 통과, 0건 실패 (97.7초)**, 종료 코드 0 | 전체 1분 41.8초 |

- 루트 `typecheck`에서 **live2d·llm·memory 3개 워크스페이스가 빠져 있다**(`package.json:18`). 개별 스크립트는 `package.json:23-25`에 있다. 다만 server의 `tsc`는 import를 따라가므로 세 패키지 소스 중 서버가 불러오는 부분은 서버 설정으로 함께 검사된다. 각 패키지 자체 `tsconfig`(예: `packages/memory/tsconfig.json:3`의 `types: ["node"]`) 기준 검사는 개별 스크립트로만 돈다.
- 단위 테스트는 0건이다(`*.test.*`·`*.spec.*` 없음). 통합 검사 32건은 `tools/test`에 있다.
- CI 설정이 없다(`.github/` 없음).
- `npm run build`는 Cubism SDK·구매 모델이 저장소 밖에 있어 이 환경에서 **실행하지 않았다(미검증)**. `apps/broadcast/vite.config.ts:61-71`이 비공개 경로를 복사한다.

### 7.1 갱신 (2026-10-12, `docs/sync-v2`, main `4da0220` 기준)

[실행] Node v24.12.0, Windows 11.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 종료 코드 0. **8개 워크스페이스**(shared·server·broadcast·admin·live2d·llm·memory·character). 루트 스크립트에 live2d·llm·memory·character를 더했다 |
| `npm run test:unit` | 66건 중 66건 통과. `packages/{memory,llm,character}/test/*.test.ts` |
| `MOCK_PORT=4470 BORI_TEST_PORT=4471 npm run test` | 46건 중 46건 통과 (128.6초). 지연 16, 동작 16, 기억 격리 14 |

- 위 목록의 "typecheck 범위 누락"과 "단위 테스트 0건"은 해소되었다. CI 설정이 없고 `npm run build`가 미검증인 것은 그대로다.

---

## 8. 문서와 실제 코드의 차이

코드를 기준으로 한다. 기존 문서는 이 작업에서 고치지 않았다.

| # | 문서 위치 | 문서 서술 | 실제 코드·실행 결과 | 영향 |
|---|---|---|---|---|
| 1 | `README.md:177` | "자동화 테스트가 없다. 테스트 파일과 CI 설정이 없고" | `tools/test`에 통합 검사 32건(`tools/test/run.mjs`, `package.json:17`). [실행] 32/32 통과. 같은 README의 `:136`은 32건이라고 써서 문서 안에서도 모순 | 높음 |
| 2 | `docs/progress.md:215`, `:234` | "자동화 테스트 0건", 4절은 "자동화 테스트가 아니라 수동 검증" | 1과 같음. 단위 테스트(`*.test.*`)가 0건인 것만 맞다 | 높음 |
| 3 | `docs/verification-log.md:5` | "이 프로젝트에는 테스트 코드가 0건" | 1과 같음 | 높음 |
| 4 | `docs/decisions.md:469`, `docs/implementation-plan.md:40`, `:563` | "자동화 테스트는 하나도 없다", "미도입… 검증은 모두 수동" | 1과 같음. CI가 없다는 부분(`.github/` 없음)만 맞다 | 중간 |
| 5 | `docs/progress.md:219`, `:288`, `docs/decisions.md:397` | "`duplicateWindowMinutes`가 로직에서 사용되지 않는다. 실제 중복 차단은 세션 내내 무한 누적되는 Set"; 단기 과제 6번 | `recentContents`는 Map이고 `isDuplicateChat`이 창 안에서만 중복으로 보며 지난 기록을 지운다(`apps/server/src/index.ts:30`, `:367-378`). [통합] "창이 지나면 같은 문장이 다시 들어감" 통과(`tools/test/latency.mjs:67`). 과제 6번은 이미 끝남. `docs/architecture.md:127`의 설명은 코드와 맞다 | 높음 |
| 6 | `docs/progress.md:3`, `docs/verification-log.md:3` | 최종 갱신 2026-08-30 | 2026-09-01 커밋 3개가 반영되지 않음: 방송 중 누적 요약(`5f8fdc3`), 키워드 매크로·대기/생성 병렬화·방송 상황 문장(`85ba2b6`), 통합 검사(`c8b2aa2`). progress 1절·2절 어디에도 세 기능이 없다 | 높음 |
| 7 | `docs/progress.md:134` | 유저 프롬프트는 "`[기억] → [최근 대화 6턴] → [답변할 채팅]` 3섹션" | 6섹션: `[방송 상황]` `[지금까지의 방송]` `[참고 정보]` `[기억]` `[최근 대화]` `[답변할 채팅]`(`packages/llm/src/prompt.ts:45-79`). 최근 대화는 발언 10개(`apps/server/src/index.ts:47`). `[기억]` 섹션은 비어도 "기억 없음" 문장을 넣는다(`prompt.ts:63-68`) | 중간 |
| 8 | `docs/architecture.md:244` | "`llm.respond()`에 … 최근 6턴" | 10턴(`apps/server/src/index.ts:47`), 누적 요약·매크로·방송 상황도 함께 넘긴다(`:535-546`) | 중간 |
| 9 | `docs/progress.md:37`, `docs/decisions.md:87`, `docs/operations.md:22`, `docs/architecture.md:177` | 방송 화면 폴링 1초 | 방송 화면 250ms(`apps/broadcast/src/main.tsx:413`). 채팅 화면 1초(`chat.tsx:41`), 관리자 1.5초(`apps/admin/src/main.tsx:81`)는 맞다. `docs/architecture.md:148`의 0.25초는 맞다 | 낮음 |
| 10 | `docs/progress.md:204`, `docs/operations.md:111`, `docs/decisions.md:285` | 음성을 다 만든 뒤 띄우므로 "1~2초가 더 걸린다", "최대 20초 안팎" | 생성(LLM+TTS)이 연출 대기와 병렬이다(`apps/server/src/index.ts:765-775`). 생성이 대기보다 짧으면 추가 지연 0. [통합] 6007ms(직렬 9.8초 기대) | 중간 |
| 11 | `docs/decisions.md:264-270`, `docs/architecture.md:350-363` | `makeResponse().then(...)` 후 `prepareAudio()`를 잇는 코드 예시, 세대 캡처 지점 "세 곳" | `Promise.all([prepared, waited])` 한 곳에서 합류(`apps/server/src/index.ts:775`). 세대 캡처는 응답(`:760`), 혼잣말(`:722`), 말풍선 타이머(`:693`), 누적 요약(`:612`) 네 곳 | 낮음 |
| 12 | `docs/progress.md:158`, `docs/verification-log.md:106` | "허용되지 않은 목소리 이름은 400으로 거부" / "확인" | `PATCH /api/tts`는 업체만 검사하고 `voice`는 검사 없이 병합(`apps/server/src/index.ts:879-888`). [실행] `{"voice":"../../evil-voice"}` → 200, 설정에 그대로 저장 | 높음 |
| 13 | `README.md:39`, `docs/progress.md:52`, `:209`, `docs/operations.md:24-26`, `docs/architecture.md:697`, `docs/decisions.md:238`, `apps/broadcast/vite.config.ts:84`(주석) | `chat.html`을 휴대폰에서 연다 / LAN에 노출하는 사용 방식이 있다 | 서버·dev·preview가 모두 `127.0.0.1` 바인딩(`apps/server/src/index.ts:1057`, `apps/broadcast/package.json:7`, `vite.config.ts:88`). 바꾸는 옵션·스크립트도 없다. [실행] LAN 주소 연결 거부. 바인딩을 바꾸면 `/api` 전체가 프록시로 열린다(6.5) | 높음 |
| 14 | `docs/progress.md:54`, `docs/architecture.md:418`, `:764` | 닉네임은 방송 화면 채팅 목록에 내보내지 않는다 / 기억에 닉네임 원문 대신 `viewerId`만 기록 | `viewerId = "local:" + 소문자·공백 제거 닉네임`(`apps/server/src/index.ts:1013`)이 `/api/state`의 `visibleChats`에 남고(`:1022`) 기억 레코드에도 저장된다(`packages/memory/src/store.ts:68`). [실행] `"local:stevenkim"` 노출 확인. 화면에 그리지만 않을 뿐 닉네임이 사실상 나간다 | 높음 |
| 15 | `docs/operations.md:64`, `README.md:155` | `.env.example`을 `.env`로 복사하면 동작 | `.env`를 읽는 코드가 없다(dotenv·`--env-file`·`process.loadEnvFile` 없음, 서버 dev 스크립트는 `tsx watch src/index.ts` `apps/server/package.json:7`). 셸 환경변수로 넣어야 한다. `.env.example:12`의 `ANTHROPIC_API_KEY`는 어디서도 읽지 않는다 | 중간 |
| 16 | `docs/implementation-plan.md:552`, `:555` | 채팅 간격·혼잣말 "즉시 적용·자동 저장", LLM·TTS 업체 "저장 후 앱 재시작" | 큐 설정은 메모리에만 반영되고 파일에 저장하지 않아 재시작하면 기본값으로 돌아간다(`apps/server/src/index.ts:13-23`, `:961`). LLM·TTS 업체는 재시작 없이 즉시 반영(`:844-851`, `:888`) | 중간 |
| 17 | `docs/decisions.md:311-313`, `docs/operations.md:44` | 평문 키는 읽는 즉시 암호문으로 재저장, 복호화 실패 시 경고 로그 | LLM 키만 그렇다(`apps/server/src/index.ts:91-102`). ElevenLabs 키는 재저장도 경고도 없다(`:140-144`) | 낮음 |
| 18 | `docs/progress.md:218`, `docs/decisions.md:471` | `emotion.secondary`는 쓰이지 않는 죽은 필드 | 검증기가 검사하고 결과에 넣는다(`packages/llm/src/validate.ts:43-49`, `:92`). 스키마(`prompt.ts:88-97`)에 없어 모델이 낼 수 없을 뿐이다 | 낮음 |
| 19 | `docs/decisions.md:143`, `:447` | 서버 "847줄" | 1,060줄(`apps/server/src/index.ts`) | 낮음 |
| 20 | `docs/decisions.md:117` | REST 엔드포인트 "15개 남짓" | 라우트 18개 + `OPTIONS`(`apps/server/src/index.ts:813-1033`, `request.method ===` 19회) | 낮음 |
| 21 | `docs/architecture.md:12`, `docs/progress.md:29` | 독립 스크립트 디렉터리 1개(`tools/obs`) | `tools/test`도 있다 | 낮음 |
| 22 | `README.md:9` | 전체 소스 "약 3,259줄" | `apps`·`packages`의 추적 중인 `.ts/.tsx/.cjs` 3,490줄, `tools` 포함 `.ts/.tsx/.mjs/.cjs` 4,286줄(`git ls-files … \| xargs wc -l`) | 낮음 |
| 23 | `README.md:78` | 런타임에 설치되는 서드파티 코드는 React와 Electron뿐 | `@vitejs/plugin-react`가 broadcast의 `dependencies`에 있다(`apps/broadcast/package.json:15`). 실제 쓰임은 빌드 도구 | 낮음 |

차이 **23건**(높음 8, 중간 6, 낮음 9). 기존 문서 중 코드와 맞는 것으로 확인한 주요 서술: 루트 typecheck가 4개만 검사(`README.md:138`, `docs/progress.md:216`), 기억 검색에 시청자 필터 없음(`README.md:180`, `docs/progress.md:196`), gemini 미구현, 치지직 미구현, CORS `*`·127.0.0.1 바인딩(`docs/architecture.md`), 키 암호화 방식, 기억·회로 차단기·TTS 기본값.

### 8.1 처리 결과 (`docs/sync-v2`)

이 작업이 고칠 수 있는 문서는 README, `docs/progress.md`, `docs/verification-log.md`, `docs/index.html`, 이 문서다. `docs/decisions.md`는 Phase 3 작업이, `docs/architecture.md`·`docs/operations.md`·`docs/implementation-plan.md`는 이번 작업 범위 밖이라 고치지 않았다. 코드도 고치지 않았다.

- **해소**: 표에 적힌 문서 위치가 모두 코드와 맞게 되었다.
- **부분 해소**: 소유 문서 쪽은 고쳤고 범위 밖 문서의 서술이 남았다.
- **잔존**: 표에 적힌 문서가 전부 범위 밖이라 그대로다.
- **의도된 차이**: 해당 없음. 23건 중 의도된 차이로 판단한 행은 없다.

| # | 처리 | 내용 |
|---|---|---|
| 1 | 해소 | README 한계 절에서 "자동화 테스트가 없다"를 지우고 CI 없음과 검사 수치(단위 66, 통합 46)로 바꿨다. 실행 절의 32건도 46건으로 고쳤다 |
| 2 | 해소 | progress 3.2절 "자동화 테스트 0건"을 검사 범위와 CI 행으로, 4절을 자동 검사(4.1)와 수동 검증(4.2)으로 나눴다 |
| 3 | 해소 | verification-log 머리말을 자동 검사(0절)와 수동 검증(1~12절) 구분으로 바꿨다 |
| 4 | 잔존 | `docs/decisions.md:469`(Phase 3 작업 소유), `docs/implementation-plan.md:40`, `:563`(범위 밖) |
| 5 | 부분 해소 | progress 3.2절 행과 6절 과제를 지우고 1.6절에 창 동작을 적었다. `docs/decisions.md:397` 잔존 |
| 6 | 해소 | progress·verification-log 최종 갱신을 2026-10-12로 바꾸고, 2026-09-01 기능을 progress 1.15절과 2절에 넣었다 |
| 7 | 해소 | Phase 2에서 progress 1.11절이 7계층 서술로 바뀌었다(이 작업 이전). 3섹션 서술은 남아 있지 않다 |
| 8 | 잔존 | `docs/architecture.md:244`(범위 밖) |
| 9 | 부분 해소 | progress 1.2절 방송 화면 폴링을 250ms로 고쳤다. `docs/decisions.md:87`, `docs/operations.md:22`, `docs/architecture.md:177` 잔존 |
| 10 | 부분 해소 | progress 3.1절 TTS 스트리밍 행과 1.13절을 병렬 생성 기준으로 고쳤다. `docs/operations.md:111`, `docs/decisions.md:285` 잔존 |
| 11 | 잔존 | `docs/decisions.md:264-270`, `docs/architecture.md:350-363`(범위 밖) |
| 12 | 해소(문서) | progress 1.13절·4.2절과 verification-log 7절에 "현재 코드는 목소리 이름을 검사하지 않는다"를 적었다(수동 기록 원문은 보존). 코드 결함 자체는 남아 Phase 4 선행 조건에 넣었다 |
| 13 | 부분 해소 | README 주요 기능, progress 1.4절·3.1절을 `127.0.0.1` 바인딩 기준으로 고쳤다. `docs/operations.md:24-26`, `docs/architecture.md:697`, `docs/decisions.md:238`, `apps/broadcast/vite.config.ts:84` 주석 잔존 |
| 14 | 부분 해소 | `/api/state` 노출은 코드(`dffbf24`, `VisibleChat`)로 해결되어 progress 1.4절 서술이 맞게 되었고 그 내용을 덧붙였다. `docs/architecture.md:418`, `:764`의 "닉네임 원문은 저장하지 않는다"는 정규화한 닉네임이 `ownerId`(`local:<닉네임>`)로 남는다는 점을 빠뜨린 채 잔존 |
| 15 | 부분 해소 | README 설치 절을 셸 환경변수 기준으로 고치고 `ANTHROPIC_API_KEY`를 읽지 않는다고 적었다. progress 3.1절에도 행을 더했다. `docs/operations.md:64` 잔존 |
| 16 | 잔존 | `docs/implementation-plan.md:552`, `:555`(범위 밖). 실제 동작(큐 설정 미저장)은 progress 3.2절에 적었다 |
| 17 | 잔존 | `docs/decisions.md:311-313`, `docs/operations.md:44`(범위 밖). 실제 동작(LLM 키만 재저장·경고)은 progress 1.7절에 적었다 |
| 18 | 부분 해소 | progress 3.2절 죽은 타입 필드에서 `emotion.secondary`를 빼고 실제 상태를 적었다. `docs/decisions.md:471` 잔존 |
| 19 | 잔존 | `docs/decisions.md:143`, `:447`(Phase 3 작업 소유) |
| 20 | 잔존 | `docs/decisions.md:117`(Phase 3 작업 소유) |
| 21 | 부분 해소 | progress 1.1절에 `tools/test`와 `packages/character`를 넣었다. `docs/architecture.md:12` 잔존 |
| 22 | 해소 | README 소스 줄 수를 다시 셌다: `apps`·`packages`의 `.ts/.tsx/.cjs` 테스트 제외 3,865줄, 포함 4,527줄(2026-10-12). `docs/index.html`도 같은 기준으로 고쳤다 |
| 23 | 해소 | README 기술 스택 절에 broadcast `dependencies`의 `@vitejs/plugin-react`를 적었다 |

집계: 해소 8(#1·2·3·6·7·12·22·23, #12는 문서만 해소), 부분 해소 8(#5·9·10·13·14·15·18·21), 잔존 7(#4·8·11·16·17·19·20), 의도된 차이 0. 남은 서술은 모두 범위 밖 문서에 있다.

코드 쪽 결함으로 따로 남기는 것(문서와의 차이는 아님)

- LLM 업체를 Anthropic으로 두면 OpenAI TTS에 Anthropic 키가 넘어간다. TTS 자격 증명이 업체와 무관하게 `llmApiKey`를 OpenAI 키로 쓴다(`apps/server/src/index.ts:128`, `:130`). 임베딩은 업체를 확인하지만(`:217`) TTS는 확인하지 않는다.
- `isDuplicateChat` 위 주석이 다른 함수의 설명이다(4.3).

---

## 9. 목표 아키텍처

### 9.1 구성

```
apps/
  server/        방송 오케스트레이션 + HTTP. 1:1 API(/api/companion/*)도 같은 프로세스
    src/conversation/   공통 대화 엔진 (Phase 3, 서버 내부 모듈)
    src/broadcast/      큐 · 발화권 · 세션 세대 · 혼잣말 (index.ts에서 분리, Phase 3 후속 정리)
  broadcast/     방송 화면 · chat.html (변경 최소)
  admin/         관리자 앱
  companion/     신규. 1:1 채팅 UI (Phase 5)
packages/
  shared/        타입
  llm/           어댑터 · 검증 · 요약 · TTS (프롬프트는 캐릭터 정책을 입력으로 받게 변경)
  memory/        저장소 · scope/owner 필터 (Phase 1, 완료)
  live2d/        모델 매핑
  character/     페르소나 · 모드 정책 데이터 (Phase 2, 완료)
```

- **apps/companion**: 1:1 채팅 화면. 서버의 `/api/companion/*`만 호출한다. 방송 상태(`/api/state`)를 읽지 않는다.
- **packages/character**: 코드가 아니라 데이터 중심 패키지. 페르소나(이름, 말투, 역할 범위), 모드별 정책(호칭, 닉네임 사용 여부, 최대 답변 길이, 규칙 문장 세트, 차단 시 행동, 기억 읽기·쓰기 scope). 기존 설정(`packages/llm/src/prompt.ts:9-36`, `apps/server/src/index.ts:408-472`, `:559-567`)을 그대로 옮겨 보존하고, 1:1 정책처럼 새로 필요한 값은 초안으로 두고 `검토 필요`로 표시한다.

### 9.2 공통 대화 엔진 위치 — 권고: 서버 내부 모듈

Phase 3에서 `packages/conversation`이 아니라 **`apps/server/src/conversation/`** 으로 시작할 것을 권고한다.

근거

1. **소비자가 서버 하나다.** 방송과 1:1 모두 같은 서버 프로세스가 처리한다. 두 번째 런타임이 생기기 전에는 패키지 분리가 얻는 것이 없다.
2. **기억 파일의 단일 작성자 제약.** 저장소는 시작 시 파일을 메모리에 읽고 저장할 때 통째로 덮어쓴다(`packages/memory/src/store.ts:15-28`). 두 프로세스가 같은 `memories.json`을 쓰면 마지막 작성자가 상대의 기록을 지운다. 엔진을 패키지로 빼서 companion이 별도 프로세스로 쓰게 되는 경로를 처음부터 막는 편이 안전하다.
3. **설정·키 로딩이 서버에 있다.** `llmSettings`·`llmApiKey`·`memorySettings`의 로드·저장(`apps/server/src/index.ts:86-120`, `:194-212`)을 엔진이 다시 구현할 이유가 없다. 엔진은 주입받는다.
4. **이미 재사용 단위는 패키지다.** 어댑터·검증·요약(`packages/llm`), 저장소(`packages/memory`), 캐릭터 데이터(`packages/character`)가 패키지이므로, 엔진은 이들을 엮는 얇은 조정 계층이다.

승격 조건: companion이 별도 Node 백엔드를 갖게 되거나, 엔진을 서버 없이 테스트·재사용해야 할 때 `packages/conversation`으로 옮긴다. 이때는 기억 저장소를 다중 작성자에 안전한 형태로 먼저 바꿔야 한다.

### 9.3 기억 scope 모델과 접근 규칙

scope는 `character` / `broadcast` / `private` 3종이다(사용자 확정).

기억 접근 규칙(사용자 확정):
```
scope      owner     방송(A 발언)  방송(B 발언)  1:1(A)  1:1(B)
character  -         O             O             O       O
broadcast  -(요약)   O             O             X       X
broadcast  A         O             X             X       X
private    A         X             X             O       X
```

규칙의 해석

- 방송에서 A가 말할 때 읽는 것: character 전체, 소유자 없는 broadcast 요약, A 소유 broadcast.
- 1:1에서 A가 말할 때 읽는 것: character 전체, A 소유 private.
- 방송 기억은 1:1에서 쓰지 않는다. 방송 ID와 1:1 사용자 연결(계정 연동)은 이번 범위 밖이다.
- 소유자가 불명확한 기억은 검색에서 제외한다(fail closed). "소유자 없음이 정상인 기억"(character, broadcast 요약)과 "소유자를 모르는 기억"은 스키마에서 구분돼야 한다. 현재 `MemoryRecord`(`packages/memory/src/types.ts:2-20`)는 `kind: "broadcast" | "viewer"`와 선택적 `viewerId`뿐이라 둘을 구분할 수 없다.
- 소유자 불명 기존 기억(`viewerId: "virtual-viewer"` 등)은 마이그레이션 시 **삭제**하고, 삭제 전 백업 파일을 남긴다.
- 쓰기 규칙(제안): 방송 종료 시 시청자 기억은 `broadcast/<owner>`, 방송 요약은 `broadcast/-`. 1:1은 `private/<owner>`만 쓴다. `character`는 관리자만 쓴다. 익명(`ownerId: null`) 발언은 기억을 쓰지 않는다.

스키마·필터의 구체 구현은 Phase 1(`feature/memory-isolation`)에서 정했고 main에 병합되었다(**완료**). 이 문서는 요구만 적는다.

### 9.4 모드별 정책·상태 주입

| 무엇 | 출처 | 주입 방식 |
|---|---|---|
| 페르소나 문구 | `packages/character` | 엔진 생성 시 한 번. `buildSystemPrompt`가 캐릭터·모드 정책을 인자로 받는다 |
| 모드 정책(호칭, 닉네임, 답변 길이, 규칙 세트, 차단 시 행동, 기억 scope) | `packages/character` | `createSession(mode)`에서 세션에 고정 |
| 대화 상태(최근 대화, 누적 요약, 매크로, 문장 쿨다운) | 엔진의 `ConversationSession` | 세션 객체. 방송은 방송 시작마다 새로 만들고, 1:1은 사용자별로 만든다 |
| 상황 문장 | 방송 쪽 `broadcastStatusLines` | `respond` 입력의 `statusLines`. 1:1은 비우거나 별도 공급자 |
| 화자 | 방송 쪽 `ChatMessage.viewerId`, 1:1 쪽 로컬 사용자 ID | `respond` 입력의 `speaker` |
| LLM 클라이언트 | 서버 | 모드별 `createLlmClient()` 인스턴스(5.2) |
| 기억 접근자 | 서버가 `packages/memory`로 만든 scope 필터 래퍼 | 엔진 생성 시 주입. 엔진은 날 `search`를 볼 수 없다 |

---

## 10. 단계별 계획

단계 번호는 사용자 지시서 기준이다(2026-10-12 `docs/sync-v2`에서 바꿈). 처음 이 문서가 제안한 "방송 코드 분리"와 "API 보안 강화"는 별도 번호를 두지 않고 각각 Phase 3의 후속 정리, Phase 4의 선행 조건으로 넣었다. 문서 정합성 정리(`docs/sync-v2`)도 번호 없이 수시로 한다.

| Phase | 브랜치 | 내용 | 상태 |
|---|---|---|---|
| 1 | `feature/memory-isolation` | 기억 scope·소유자 모델, 검색 필터(fail closed), 소유자 불명 기억 삭제 마이그레이션(백업) | **완료 (main 병합)** |
| 2 | `feature/character-persona` | `packages/character` 신설, 기존 페르소나·규칙·혼잣말 데이터 이전, 프롬프트 7계층, 모드 정책 초안(`검토 필요`) | **완료 (main 병합)** |
| 3 | 별도 PR | 공통 대화 엔진. `apps/server/src/conversation/` 추출. 방송 동작 불변 | **진행 중 (별도 PR)** |
| 3 후속 | 미정 | 방송 코드 분리. `index.ts`에서 방송 오케스트레이션(큐·발화권·세대·혼잣말)과 HTTP 라우팅 분리 | 계획 |
| 4 선행 | 미정 | API 보안 강화. CORS 출처 제한, 로컬 토큰, 요청 본문 크기 제한, 설정 검증(`PATCH /api/settings`·`/api/memory`·`/api/tts`), 목소리 이름 검증 | 계획 |
| 4 | 미정 | 1:1 대화 API. `/api/companion/*`, 1:1 세션 관리, private 기억 읽기·쓰기, 모드별 LLM 클라이언트 | 계획 |
| 5 | 미정 | Companion 앱. `apps/companion` UI | 계획 |
| 6 | 미정 | 캐릭터 반응·관계. 세부 범위는 아직 정하지 않았다 | 계획 |
| 7 | 별도 PR | 대화 품질 평가. 평가 시나리오는 `docs/content/dialogue-scenarios.md` | **선행 작업 진행 중 (별도 PR)** |
| 8 | 미정 | 방송 연동과 안정화. 세부 범위는 아직 정하지 않았다. 30분 이상 송출 검증, 2026-09 이후 기능의 실 API 수동 검증이 여기에 해당한다 | 계획 |

처음 제안에 있던 "`/api/state`의 `viewerId` 제거"는 **해결됨**(`dffbf24`, main 병합)이라 4 선행에서 뺐다.

의존 관계

```
Phase 1 (완료) ─┐
                ├─► Phase 3 ─► 3 후속(방송 코드 분리)
Phase 2 (완료) ─┘      │
                       ▼
4 선행(API 보안) ──► Phase 4 ─► Phase 5
                       │
                       └─────► Phase 6

Phase 7: 선행 작업은 병렬로 진행. 1:1 대화 평가는 Phase 4 이후
Phase 8: 각 Phase 병합 뒤 방송 쪽 회귀 확인과 안정화
```

- Phase 3은 Phase 1의 scope 필터 API와 Phase 2의 정책 데이터 형태를 소비한다. 둘 다 병합되었다.
- **4 선행(API 보안 강화)은 Phase 4보다 먼저 병합해야 한다.** 1:1 API를 보안 경계 없이 연 상태가 한 번도 없도록 하기 위해서다. Phase 3과는 독립적으로 진행할 수 있다.
- 3 후속(방송 코드 분리)은 Phase 3 직후가 충돌이 가장 적다. 엔진이 빠진 뒤 남은 방송 코드만 옮기면 된다.
- Phase 6은 1:1 대화 경로(Phase 4)가 있어야 확인할 수 있다. Phase 6·8의 세부 의존은 범위가 정해진 뒤 적는다.

### 완료 기준 (검증 가능한 것만)

| Phase | 완료 기준 |
|---|---|
| 1 | **충족** (2026-10-12 `npm run test:unit`·`npm run test`로 재확인). `node --import tsx --test`로 9.3 표의 16칸(4행×4열)이 각각 기대대로 O/X인 단위 테스트 통과. 소유자 불명 기록이 어떤 모드에서도 반환되지 않는 테스트. 마이그레이션 후 `virtual-viewer` 기록 0건 + 백업 파일 존재. `npm run test` 32건 이상 통과 |
| 2 | main 병합. 제안 당시 기준: 기존 시스템 프롬프트 문자열이 이전 전후 동일함을 비교하는 테스트(방송 모드). `systemPromptChars` 값 불변. 새 정책 값에 `검토 필요` 표시. `npm run test` 통과. 현재 단위 검사가 확인하는 것은 기존 방송 문장이 모두 들어가는지까지이고, user 섹션 순서는 계층 정의에 맞춰 `[참고 정보]`↔`[기억]`이 바뀌었다(PR #4). `systemPromptChars` 불변은 이 작업에서 다시 확인하지 않았다 |
| 3 | `makeResponse`·`recordTurn`·`maybeUpdateRollingSummary`·매크로 함수가 `index.ts`에서 사라지고 엔진으로 이동. 엔진 단위 테스트: 세션 두 개의 `recentTurns`·요약·매크로가 서로 섞이지 않음. 방송 통합 검사 46건 통과(동작 불변) |
| 3 후속 | `index.ts`가 기동·라우팅 조립만 남음. 통합 검사 통과 |
| 4 선행 | 허용 목록 밖 `Origin`의 요청이 거부되는 통합 검사. 토큰 없는 관리·1:1 요청 401. 상한 초과 본문 413. `PATCH /api/settings`의 잘못된 타입·범위 입력 400. 허용 밖 `voice` 400 |
| 4 | 통합 검사 추가: 1:1 사용자 A의 private 기억이 B의 1:1·방송 프롬프트에 나오지 않음, 방송 broadcast 기억이 1:1 프롬프트에 나오지 않음, 1:1 대화가 방송 `/api/state`·`[최근 대화]`·누적 요약에 나오지 않음, 1:1 LLM 실패가 방송 회로를 열지 않음. 방송 통합 검사 통과 |
| 5 | `apps/companion` typecheck가 루트 `typecheck`에 포함되어 통과. 화면 동작은 수동 검증 기록(verification-log)에 남김 |
| 6 | 범위가 정해진 뒤 적는다 |
| 7 | 범위가 정해진 뒤 적는다 |
| 8 | 범위가 정해진 뒤 적는다. 최소한 30분 이상 송출 수동 검증 기록 |
| 문서 정합성 | 제안 당시 기준: 8절 표의 각 행이 해소되었거나 "의도된 차이"로 표시됨, 루트 `typecheck`가 7개 이상 워크스페이스를 검사. `docs/sync-v2` 결과: typecheck는 **충족**(8개). 8절은 **부분 충족** — 각 행의 처리 결과를 8.1절에 적었고, 범위 밖 문서(`decisions.md`·`architecture.md`·`operations.md`·`implementation-plan.md`)에 7행 전체와 8행 일부가 남았다 |

---

## 부록 A. 이 문서를 위해 실행한 것

| 확인 | 방법 | 결과 |
|---|---|---|
| 타입 검사 | `npm run typecheck`, `npm run typecheck:{live2d,llm,memory}` | 모두 종료 코드 0 (7절) |
| 통합 검사 | `MOCK_PORT=4420 BORI_TEST_PORT=4421 npm run test` | 32/32 통과, 97.7초 |
| 바인딩 | 임시 데이터 디렉터리로 서버를 4422에 띄우고 `netstat -ano`, `curl` | `127.0.0.1:4422`만 LISTEN, LAN 주소 연결 거부 |
| CORS | `curl -i -X OPTIONS /api/chat` | `Access-Control-Allow-Origin: *` |
| 목소리 검증 | `PATCH /api/tts {"voice":"../../evil-voice"}` | 200, 그대로 저장 |
| 중복 창 전역성 | 닉네임 A·B로 같은 문장 `안녕` 연속 전송 | A 200, B 400 |
| viewerId 노출 | 닉네임 `Steven Kim`으로 채팅 후 `GET /api/state` | `visibleChats[0].viewerId = "local:stevenkim"` |
| 기억 검색 필터 | 저장소 밖 임시 스크립트에서 `createMemoryStore`·`extractMemoryCandidates` 직접 호출 | 6.1 결과 |

모든 실행은 `BORI_DATA_DIR`로 임시 디렉터리를 주어 `data/`를 건드리지 않았고, 끝난 뒤 서버를 종료하고 임시 디렉터리를 지웠다. 실제 LLM·TTS API, Live2D 자산, 브라우저 화면은 쓰지 않았다.
