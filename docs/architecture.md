# 아키텍처

로컬 실행형 AI 버추얼 스트리머 "보리"의 구조 문서다.
설계 결정의 배경과 트레이드오프는 [decisions.md](./decisions.md)에 따로 정리했다.

관련 문서: [../README.md](../README.md) · [requirements.md](./requirements.md) · [implementation-plan.md](./implementation-plan.md) · [operations.md](./operations.md) · [progress.md](./progress.md) · [verification-log.md](./verification-log.md)

---

## 1. 전체 구조

npm workspaces 기반 모노레포다. 애플리케이션 3개, 패키지 4개, 독립 스크립트 디렉터리 1개로 이루어진다.
루트 `package.json`의 `workspaces`는 `apps/*`와 `packages/*`만 포함하고, `tools/obs`는 워크스페이스로 등록하지 않은 채 `node`로 직접 실행한다. 의존성이 하나도 없어서 설치 대상이 될 이유가 없기 때문이다.

| 디렉터리 | 소유하는 것 | 스택 |
|---|---|---|
| `apps/server` | 방송 상태, 채팅 큐, 응답 규칙, 세션 수명, REST API | TypeScript + `node:http` |
| `apps/broadcast` | 방송 송출 화면, 시청자 채팅 화면, Cubism SDK 연동 | React 19 + Vite 6 |
| `apps/admin` | 관리자 조작 UI(세션·설정·키·기억·표정 테스트) | Electron 34 + React 19 |
| `packages/shared` | 프로세스 경계를 넘는 타입 정의 | TypeScript (런타임 코드 없음) |
| `packages/llm` | LLM 어댑터, 프롬프트, 구조화 출력 검증, 요약, TTS | TypeScript + `fetch` |
| `packages/memory` | 장기 기억 저장·검색·추출, 임베딩, 코사인 유사도 | TypeScript |
| `packages/live2d` | 표정·모션 allowlist, 감정 매핑, 모션 설명 | TypeScript (순수 데이터) |
| `tools/obs` | OBS WebSocket v5 클라이언트와 씬 자동 구성 | ESM 스크립트, 의존성 0 |

### 의존 방향

```
                        packages/shared
                    (타입만. 런타임 코드 0줄)
                              ▲
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    packages/llm        packages/memory     packages/live2d
   (어댑터·검증·TTS)     (저장·검색·추출)    (allowlist·매핑)
          ▲                   ▲              ▲    ▲    ▲
          │                   │              │    │    │
          └─────────┬─────────┘              │    │    │
                    │                        │    │    │
              apps/server ────────────────────┘   │    │
             (상태머신·큐·라우팅)                   │    │
                    │ HTTP(폴링/명령)              │    │
          ┌─────────┴─────────┐                   │    │
    apps/broadcast        apps/admin ─────────────┘    │
   (방송·시청자 채팅) ────────────────────────────────────┘
          │
          │ Cubism SDK for Web (private-assets/, 저장소 밖)
          ▼
      WebGL 캔버스 ──► OBS Browser Source (tools/obs가 구성)
```

화살표는 컴파일타임 의존을 뜻한다. 역방향 의존은 없다.
`apps/server`와 두 프런트엔드 사이는 HTTP뿐이고 공유 코드는 `packages/shared`의 타입 선언만이다.

### 소유권 규칙

**표정·모션 allowlist는 `packages/live2d`가 단일 소유자다.**
`boriExpressionNames`(8종), `boriMotionGroupNames`(4종), `boriEmotionMap`, `boriMotionDescriptions`가 모두 이 패키지에만 있고 세 곳이 이것을 참조한다.

- `apps/server/src/index.ts`는 `boriEmotionNames`·`boriMotionGroupNames`·`boriMotionDescriptions`를 LLM 요청에 실어 보내고, `isBoriExpression`·`isBoriMotionGroup`으로 `/api/live2d/test`의 입력을 검사한다.
- `apps/broadcast/src/main.tsx`는 `resolveExpression`·`resolveMotion`·`motionPairedExpression`으로 응답을 모델 조작으로 바꾼다.
- `apps/admin/src/main.tsx`는 `boriExpressionLabels`·`boriMotionLabels`로 테스트 버튼을 그린다.

`packages/llm`은 이 패키지를 **import하지 않는다.** 검증기는 허용 목록을 `LlmRequest.allowedEmotions`·`allowedMotions`로 인자를 통해 받는다. 모델 자산 지식이 LLM 계층으로 새지 않게 하려는 의존성 역전이다. 다만 `packages/llm/package.json`에는 `@bori/live2d` 의존이 선언만 되어 있고 실제로 쓰이지 않는다 — 정리 대상이다.

`packages/*`는 빌드 산출물을 만들지 않는다. `main`이 `./src/index.ts`를 직접 가리키고, 소비하는 쪽(`tsx`, Vite)이 TypeScript 원본을 그대로 읽는다. `packages/shared`의 `build` 스크립트는 실제로 `tsc --noEmit`이라 산출물이 없는데, 이 구조에서는 의도한 동작이다.

---

## 2. 데이터 흐름

채팅 한 건이 화면에 나타나기까지의 경로다. 각 단계에서 무엇이 걸러지고 무엇이 붙는지를 함께 적는다.

```
POST /api/chat
  │  걸러짐: 빈 문자열, status !== "live", 정규화 후 중복(duplicateWindowMinutes 창 안)
  │  붙음:   id(UUID), viewerId, receivedAt, source="manual", category
  ▼
큐 push + visibleChats 갱신
  │  걸러짐: 큐가 maxQueueSize(100)를 넘으면 가장 오래된 항목이 밀려남
  │  붙음:   방송 화면용 사본에서 viewerNickname 제거
  ▼
scheduleNext()  — 답변할 채팅을 즉시 고르고 발화권을 잡는다
  │  걸러짐: 이미 발화 중이거나 타이머가 있으면 예약하지 않음
  │  붙음:   질문 우선 선택(isQuestion)
  │
  ├── 5~10초 랜덤 지연 타이머 ──────────────────────────────┐
  │                                                          │
  └── makeResponse()                                         │
        │  1) unsafePattern 사전 차단  → null(무반응), unprocessedCount++
        │  2) 기억 질문 패턴           → 규칙 건너뛰고 LLM으로
        │  3) 규칙 매칭                → llmPreferred면 LLM에 양보
        │  4) activateMacros()         → 키워드가 맞는 매크로를 켠다(왕복 없음)
        │  5) memoryStore.search()     → 관련 기억 최대 5건 주입(임베딩 왕복 1회)
        │  6) llm.respond() → validateLlmOutput
        │  7) 실패 시 규칙 폴백 문장
        ▼                                                    │
      prepareAudio()  — TTS mp3 합성 후 메모리 캐시(30건)     │
        │  걸러짐: TTS가 꺼져 있거나 키가 없으면 undefined. 실패해도 방송은 계속
        │  붙음:   audioId(UUID)                              │
        └──────────────────────────────────────────────────┬─┘
                                                           ▼
                                        Promise.all — 둘 다 끝나야 다음으로
  ▼
recordTurn() ×2  (recentTurns 최대 10턴, sessionTurns 무제한 누적)
  │  부수 효과: 누적 요약 주기에 닿으면 요약 호출을 비동기로 띄운다
  │  tickMacros() — 켜져 있던 매크로의 남은 턴을 하나 줄인다
  ▼
speak()  — state.currentResponse / currentEmotion / currentAudioId 반영
  │  붙음:   표시 시간 계산(음성 있으면 글자수×110ms, 5~15초로 제한)
  ▼
방송 화면 0.25초 폴링이 감지
  ▼
표정 + 모션 실행 · /api/tts/{id} 재생 · 파형 립싱크
```

**지연 대기와 생성을 겹치는 이유**
5~10초 랜덤 지연은 사람처럼 보이기 위한 장치이지 계산 시간이 아니다. 예전에는 이 타이머가 끝난 **뒤에** LLM과 TTS를 불렀기 때문에 둘이 그대로 더해졌다. 임베딩 0.3초 + LLM 2초 + TTS 1.5초를 가정하면 체감 지연이 9.8초까지 늘어난다. 지금은 채팅을 미리 고르고 두 작업을 나란히 돌리므로 `max(대기, 생성)`만 걸린다. 같은 조건에서 6.0초다. 생성이 대기보다 빠른 한 지연은 0이 된다.

대신 답변할 채팅을 대기 전에 고르게 되므로, 대기하는 5~10초 사이에 들어온 채팅은 이번 차례의 후보가 아니라 다음 차례로 넘어간다. 질문 우선 선택의 후보 집합이 좁아지는 것이 이 구조의 비용이다.

세부 근거는 다음과 같다.

**입력 정규화와 중복 차단** (`apps/server/src/index.ts`)
`normalize()`는 소문자로 바꾸고 모든 공백을 제거한다. "안녕 하세요"와 "안녕하세요"가 같은 키가 된다. 이 키를 `recentContents` Map에 시각과 함께 넣고, `duplicateWindowMinutes` 안에 같은 키가 있으면 400으로 거절한다.

예전에는 Set이었고 세션이 시작될 때만 비워졌다. 설정에 `duplicateWindowMinutes`가 있는데도 시간 창을 쓰지 않아, 한 번 나온 문장은 방송이 끝날 때까지 막혔다. 두 번째 시청자가 "안녕하세요"를 치면 거절되는 동작이었다. 지금은 조회할 때마다 창을 넘긴 기록을 함께 지우므로, 긴 방송에서도 맵이 무한정 커지지 않는다.

**닉네임의 처리 경계**
닉네임은 20자로 자른 뒤 `local:<정규화된 닉네임>` 형태의 `viewerId`로만 남는다. 방송 화면에 넘기는 사본은 `viewerNickname: undefined`로 지운 복사본이다. 큐에 들어가는 원본에는 닉네임이 남아 기억 저장 시 소유자 식별에 쓰이지만, 화면과 LLM 프롬프트 어느 쪽에도 전달되지 않는다.

**질문 우선 선택**
`queue.reduce`로 "현재 최선 후보가 질문이 아니고 지금 항목이 질문이면 교체"를 수행한다. 결과적으로 가장 앞선 질문 하나가 선택되고, 질문이 없으면 큐의 첫 항목이 선택된다. 우선순위 큐가 아니라 한 번의 선형 스캔이다.

**같은 문장 반복 억제**
`pick()`은 `sameReplyCooldownMinutes` 안에 쓴 문장을 후보에서 뺀다. 모든 후보가 쿨다운이면 가장 오래전에 쓴 문장 하나만 남긴다. 답변을 아예 못 하는 것보다 반복이 낫다는 판단이다.

---

## 3. 상태 동기화 방식

이 시스템에는 **WebSocket도 SSE도 없다.** 실시간처럼 보이는 모든 동작은 클라이언트 폴링과 상태 필드 비교로 만들어진다.

### 폴링 주기

| 클라이언트 | 주기 | 근거 |
|---|---|---|
| 방송 화면 | 0.25초 | `apps/broadcast/src/main.tsx` |
| 시청자 채팅 화면 | 1초 | `apps/broadcast/src/chat.tsx` |
| 관리자 앱 | 1.5초 | `apps/admin/src/main.tsx` |

세 클라이언트 모두 `GET /api/state` 하나만 본다. 서버는 이벤트를 발행하지 않고, 요청이 올 때마다 현재 `BroadcastState` 객체 전체를 그대로 직렬화해 돌려준다.

방송 화면만 주기가 짧다. 서버가 말풍선과 음성을 준비한 뒤 화면에 뜰 때까지가 그대로 체감 지연에 더해지기 때문이다. 1초 주기에서는 평균 0.5초가 그냥 붙었다.

주기를 줄이려면 한 가지를 먼저 고쳐야 했다. 응답 본문이 같아도 `setState`를 부르면 객체 참조가 새로 만들어지고, `state.currentResponse`를 의존성으로 갖는 시선 이펙트가 폴링마다 다시 돈다. 이 이펙트는 시선 목표를 매번 새로 뽑으므로 주기를 4배로 올리면 눈이 초당 4번 흔들린다. 그래서 응답을 `text()`로 받아 직전 원문과 비교하고, 바뀐 것이 없으면 `setState`를 건너뛴다. 상태가 실제로 변할 때만 리렌더가 일어나므로 0.25초 주기가 1초 주기보다 오히려 이펙트 실행 횟수가 적다.

### 이벤트 버스가 아니라 상태 필드 diff

서버는 "말했다", "표정을 바꿔라" 같은 이벤트를 보내지 않는다. 대신 상태 필드에 값을 써 두고 클라이언트가 **직전에 적용한 값과 다른지**를 스스로 판단한다. 클라이언트는 마지막 적용값을 React state가 아니라 `useRef`에 담는다. ref는 값이 바뀌어도 재렌더를 유발하지 않으므로 "적용 여부 기록" 용도로 적합하다.

| 상태 필드 | 클라이언트가 만드는 diff 키 | 저장 위치 |
|---|---|---|
| `currentResponse` | `` `${emotion.primary}|${reply}` `` | `appliedResponseRef` |
| `currentAudioId` | 값 자체(UUID) | React effect 의존성 |
| `lastTestAction` | `seq` 정수 | `appliedTestSeqRef` |
| `visibleChats` | 마지막 항목의 `id` | `lastChatIdRef` |
| `currentResponse.reply` | 문자열 자체(채팅 화면) | `lastReplyRef` |
| 재생 중 모션 | 모션 그룹 이름 | `playingMotionRef` |

`lastTestAction`이 `seq` 정수를 갖는 이유가 이 설계를 잘 보여준다. 관리자가 같은 표정 버튼을 두 번 누르면 `kind`와 `name`은 동일하다. 값만 비교하면 두 번째 클릭이 사라진다. 그래서 서버가 `++testActionSeq`로 단조 증가하는 번호를 붙이고 클라이언트는 번호로만 판단한다. 즉 **명령을 상태로 표현하기 위해 서버가 멱등성 토큰을 부여하는 구조**다.

모델이 아직 로드되지 않았으면 클라이언트는 ref를 갱신하지 않고 그냥 반환한다. 다음 폴링에서 자연스럽게 다시 시도된다. 재시도 로직을 따로 쓰지 않아도 폴링 자체가 재시도가 된다.

### 이 선택의 이점

- **재연결 로직이 필요 없다.** 서버가 죽었다 살아나도 클라이언트는 다음 1초에 그냥 성공한다. WebSocket이라면 끊김 감지, 지수 백오프 재연결, 재연결 후 상태 재동기화를 전부 구현해야 한다. 이 코드에는 그 세 가지가 모두 없다.
- **상태 재동기화 문제가 원천적으로 없다.** 매 요청이 전체 스냅샷이므로 "놓친 이벤트를 어떻게 따라잡을 것인가"라는 문제가 생기지 않는다. 새 창을 열면 즉시 올바른 화면이 나온다.
- **서버가 클라이언트 목록을 관리하지 않는다.** 연결 추적, 브로드캐스트 대상 관리, 죽은 연결 청소가 전부 불필요하다. 서버는 `state` 변수 하나만 최신으로 유지하면 된다.
- **디버깅이 쉽다.** 브라우저로 `/api/state`를 열면 시스템 상태 전부가 보인다.

전제는 "단일 로컬 머신, 클라이언트 3개"다. 초당 약 3회 요청은 127.0.0.1 루프백에서 무시할 수 있는 부하다.

### 이 선택의 비용

- **최대 1초의 지연.** 서버가 발화를 시작한 시점과 화면이 반응하는 시점 사이에 0~1초의 간격이 생긴다. 응답 표시 시간이 최소 5초라 사람 눈에는 문제가 되지 않지만, 지연이 0이 아니라는 사실 자체는 남는다.
- **폴링 간격보다 짧은 상태는 관측되지 않는다.** 이 구조의 정확성은 "상태가 폴링 주기보다 오래 유지된다"는 전제에 의존한다. 현재는 표시 시간 5초 이상, 응답 간격 5~10초라 여유가 크지만, 이 값들을 1초 아래로 낮추면 조용히 깨진다. 코드에 이를 강제하는 장치는 없다.
- **아무 일도 없을 때도 요청이 계속 나간다.** 대기 중에도 초당 3회가 발생한다. 로컬에서는 비용이 아니지만 원격 배포에서는 그대로 비용이 된다.
- **응답 본문이 매번 전체 상태다.** `visibleChats` 8건을 포함해 매초 전송된다. 상태가 커지면 그대로 낭비가 된다.

### 확장 시의 변경 지점

클라이언트가 늘어나거나 서버가 원격으로 이동하면 SSE 또는 WebSocket으로 교체해야 한다. 교체 대상은 `GET /api/state` 하나와 클라이언트 3곳의 `setInterval`이며, 상태 필드 diff 구조 자체는 그대로 쓸 수 있다. 서버가 이벤트를 밀어 주더라도 클라이언트가 ref로 중복 적용을 막는 방어는 남겨 두는 편이 안전하다.

---

## 4. 응답 생성: 3단 폴백과 회로 차단기

`makeResponse()`는 규칙 → LLM → 폴백의 3단 구조다. 단순히 순서대로 시도하는 것이 아니라, 세 가지 서로 다른 조건이 각각 다른 분기로 처리된다.

### 진입 조건

```
llmAvailable = llmSettings.enabled
             && llmApiKey.trim().length > 0
             && !llm.isCircuitOpen()
```

세 조건 중 하나라도 거짓이면 LLM은 없는 것으로 간주하고 규칙만으로 동작한다. 회로가 열려 있을 때 규칙이 그대로 답하는 것이 이 설계의 핵심이다.

### 분기 1 — 위험 주제 사전 차단

`evaluateByRule()`의 첫 줄에서 `unsafePattern`(정치·의료·법률·투자·개인정보·비밀번호·해킹·자해·프롬프트·시스템 메시지)을 검사하고, 걸리면 `{ kind: "blocked" }`를 반환한다. `makeResponse()`는 `null`을 돌려주고 호출자는 `unprocessedCount`만 올린 뒤 다음 후보로 넘어간다. 보리는 아무 반응도 하지 않는다.

**차단이 LLM 호출보다 앞에 있다는 점이 중요하다.** 프롬프트 인젝션 시도가 모델에 도달하지 않고, 위험 주제에 대한 토큰 비용도 발생하지 않는다. 시스템 프롬프트에도 같은 금지 규칙을 적어 두었지만(`packages/llm/src/prompt.ts`), 그것은 두 번째 방어선이지 첫 번째가 아니다.

한계는 정규식이라는 점이다. 단어를 우회하는 표현은 통과한다. 저비용 1차 필터로 설계된 것이고 완전한 차단 장치가 아니다.

### 분기 2 — 기억 질문 우회

```
if (llmAvailable && memoryQuestionPattern.test(content)) return { kind: "unmatched" };
```

"기억", "아세요", "말했던", "저번에" 같은 표현이 들어간 채팅은 **규칙 매칭 자체를 건너뛴다.** 이 검사가 `rules.find()`보다 위에 있는 것이 의도다. "저번에 말했던 그 노래 기억나세요?"는 물음표가 있어 질문 규칙에 걸리지만, 규칙 문장으로는 답할 수 없다. 장기 기억을 프롬프트로 받는 LLM만 답할 수 있는 종류의 질문이다.

`llmAvailable`이 조건에 함께 있어서, LLM을 쓸 수 없을 때는 이 우회가 작동하지 않고 규칙이 정상적으로 처리한다.

### 분기 3 — `llmPreferred` 양보

규칙에는 `llmPreferred` 플래그가 있다. 현재 이 플래그를 가진 규칙은 질문 규칙 하나다.

```
if (rule.llmPreferred && llmAvailable) return { kind: "unmatched" };
```

규칙이 매칭됐는데도 LLM에 양보한다. 질문은 LLM이 더 잘 답하지만, LLM이 꺼져 있거나 회로가 열려 있으면 답이 아예 없는 것보다 규칙 문장이라도 나가는 편이 낫기 때문이다. **같은 규칙이 상황에 따라 1순위가 되기도 하고 안전망이 되기도 한다.**

### LLM 단계

규칙에 걸리지 않은 채팅만 여기까지 온다.

1. `memoryStore.search()`로 관련 기억을 찾는다. `try/catch`로 감싸 검색이 실패해도 답변 생성은 계속된다.
2. `llm.respond()`에 채팅 내용, 최근 6턴, 기억, 허용 감정·모션 목록, 최대 길이, 타임아웃을 넘긴다.
3. 성공하면 검증을 통과한 `CharacterResponse`가, 실패하면 이유가 담긴 실패 결과가 온다.

실패 시 `state.lastError`에 이유를 기록하고 폴백 문장을 반환한다. **실패는 관리자 화면에만 노출되고 방송은 끊기지 않는다.**

### 회로 차단기

`packages/llm/src/index.ts`의 `createLlmClient()`가 클로저 안에 카운터를 들고 있다.

- 호출 실패와 검증 실패를 각각 다른 카운터(`failureCount`, `validationFailureCount`)에 기록하되, 연속 실패(`consecutiveFailures`)는 둘 다 올린다.
- `consecutiveFailures >= failureThreshold`(기본 3)가 되면 `circuitOpenUntil = now + cooldownSeconds * 1000`(기본 60초)을 설정한다.
- 개방된 동안 `respond()`는 즉시 `kind: "circuit"`을 반환하고 네트워크 호출을 하지 않는다.
- 성공하면 `consecutiveFailures`를 0으로 되돌린다. 회로는 별도 half-open 상태 없이, cooldown이 지난 첫 호출이 곧 시험 호출이 된다.
- 설정을 변경하면 `llm.reset()`으로 통계와 회로가 함께 초기화된다.

호출 수·실패 수·검증 실패 수·연속 실패·평균 지연·마지막 오류가 `LlmStatus`로 관리자 화면에 노출된다. 평균 지연은 성공·실패와 무관하게 어댑터가 반환한 모든 호출을 누적해 계산한다.

회로 차단기가 없으면 API 키 만료 같은 상황에서 채팅마다 8초 타임아웃을 기다리게 되고, 5~10초 간격이어야 할 답변이 13~18초로 늘어난다. 방송이 눈에 띄게 느려진다. 회로를 열면 즉시 규칙 문장으로 전환되어 리듬이 유지된다.

---

## 5. LLM 출력 신뢰 경계

LLM 출력은 **신뢰할 수 없는 입력**으로 다룬다. 이 출력이 결정하는 것이 텍스트만이 아니라 파일 시스템의 표정·모션 자산을 실행하는 이름이기 때문이다.

### 구조화 출력은 형식만 보장한다

`packages/llm/src/prompt.ts`의 `responseJsonSchema` 하나를 두 어댑터가 각자의 방식으로 강제한다.

| 프로바이더 | 강제 방식 | 반환 형태 |
|---|---|---|
| OpenAI | `response_format: { type: "json_schema", json_schema: { strict: true, schema } }` | 메시지 `content` 문자열 |
| Anthropic | `tools: [{ input_schema: schema }]` + `tool_choice: { type: "tool", name }` | `tool_use` 블록의 `input` 객체 |

Anthropic 어댑터는 받은 객체를 `JSON.stringify`로 문자열로 되돌린다. 뒤에 오는 검증기가 원본 문자열을 받는 인터페이스라, 이렇게 하면 두 프로바이더의 결과가 같은 코드 경로를 탄다. **어댑터가 둘이어도 검증 코드는 하나다.**

여기서 핵심은 스키마가 `emotion.primary`를 `{ type: "string" }`으로만 선언한다는 점이다. 값의 범위는 스키마에 없다. 구조화 출력이 보장하는 것은 **모양이지 내용이 아니다.** allowlist 검증이 필요한 이유가 여기에 있다.

스키마에 `enum`을 넣어 허용 값을 강제하는 방법도 있지만, 그렇게 해도 검증기는 제거할 수 없다. 프로바이더가 스키마를 지킨다는 것 역시 프로바이더에 대한 신뢰이고, 신뢰 경계 안쪽에서 한 번 더 확인하는 편이 안전하기 때문이다.

### 검증 6단계

`packages/llm/src/validate.ts`의 `validateLlmOutput()`은 순서대로 검사하고 첫 실패에서 이유와 함께 중단한다.

1. **JSON 파싱** — 파싱 실패, 객체가 아닌 값 거부
2. **`reply` 길이** — 문자열 여부, 공백 제거 후 비어 있지 않을 것, `maxReplyLength`(기본 120자) 이내
3. **감정 allowlist** — `emotion.primary`가 `request.allowedEmotions`에 있을 것. `secondary`도 있으면 같은 검사
4. **수치 범위** — `intensity` 0~1, `durationSeconds` 1~60, 둘 다 유한한 수
5. **모션 allowlist** — 각 `action.name`이 `request.allowedMotions`에 있을 것
6. **레이어와 우선순위** — `layer`가 `face`/`body`/`system` 중 하나, `priority`가 0~3 정수

통과하면 `source: "llm"`이 붙은 `CharacterResponse`를 조립해 반환한다. 이때 **모델이 보낸 객체를 그대로 넘기지 않고 검증된 필드만 골라 새 객체를 만든다.** 스키마에 없는 속성이 딸려 들어오는 것을 막는 마지막 처리다.

실패는 `validationFailureCount`로 집계되고 회로 차단기의 연속 실패에도 반영된다. 모델이 계속 잘못된 형식을 뱉으면 호출 실패와 마찬가지로 회로가 열린다.

### 이중 방어: 서버도 같은 allowlist를 강제한다

LLM 경로만 검사하는 것으로는 부족하다. `POST /api/live2d/test`는 관리자가 표정·모션을 직접 실행하는 API이고, LLM을 거치지 않는다.

```
const valid = input.kind === "expression" ? isBoriExpression(name)
            : input.kind === "motion"     ? isBoriMotionGroup(name)
            : false;
if (!valid) { sendJson(response, 400, { error: "등록되지 않은 표정·모션입니다." }); return; }
```

같은 `packages/live2d`의 판별 함수를 쓴다. 결과적으로 **모델 자산을 실행하는 모든 경로가 같은 단일 소유자의 allowlist를 통과한다.** LLM이 넣은 이름이든 HTTP 요청이 넣은 이름이든 마찬가지다.

방송 화면에도 세 번째 검사가 있다. `resolveMotion()`은 `layer === "body"`이면서 `isBoriMotionGroup(name)`인 action만 남기고, 남은 것이 없으면 감정 매핑의 기본 모션으로 폴백한다. 서버를 통과한 값이라도 렌더러 앞에서 한 번 더 걸러진다.

---

## 6. 동시성 제어

Node의 이벤트 루프는 단일 스레드지만, 이 시스템에는 최대 23초에 걸친 비동기 구간이 있다. LLM 타임아웃 8초와 TTS 타임아웃 15초다. 그 사이에 관리자가 방송을 종료하거나 다시 시작할 수 있다.

### `state.status`만으로는 부족하다

가장 단순한 방어는 콜백에서 `state.status !== "live"`를 확인하는 것이다. 이것으로 막히는 것은 "종료된 뒤 도착한 응답"뿐이다.

막히지 않는 경우가 있다.

```
t0   방송 시작 (세션 A)
t1   채팅 처리 시작 → LLM 호출 (8초 걸리는 중)
t2   관리자가 방송 종료
t3   관리자가 방송 다시 시작 (세션 B)
t4   세션 A의 LLM 응답 도착 → status는 "live" → 통과
```

t4 시점에서 `status`는 다시 `"live"`다. 상태 값만으로는 이것이 A의 응답인지 B의 응답인지 구분할 수 없다. **`status`는 현재 상태를 나타낼 뿐 시간 축의 정체성을 담지 못한다.**

실제로 이 문제가 발생했다. 이전 세션에서 보낸 채팅의 LLM 응답이 새로 시작한 세션 화면에 나타났다.

### 세션 세대(generation)

해결은 단조 증가 정수 하나다.

```
let sessionGeneration = 0;
```

`POST /api/session/start`와 `POST /api/session/end` **양쪽 모두**에서 `sessionGeneration += 1`을 수행한다. 종료에서도 올리는 이유는, 종료만 하고 재시작하지 않은 상태에서 도착하는 응답도 무효로 만들기 위해서다.

비동기 작업을 시작하는 지점에서 현재 세대를 지역 변수로 캡처한다.

```
const generation = sessionGeneration;
void makeResponse(chat.content).then(responseForChat => {
  if (generation !== sessionGeneration) return;      // 이전 세션의 응답이므로 폐기
  if (state.status !== "live") { speaking = false; return; }
  ...
});
```

캡처가 필요한 지점은 세 곳이고 모두 적용되어 있다.

- 채팅 응답 생성 후 콜백
- 음성 합성 후 콜백(응답 경로)
- 음성 합성 후 콜백(혼잣말 경로)

세대와 상태를 함께 보는 이유는 각각 막는 것이 다르기 때문이다. 세대 검사는 "다른 세션의 결과"를, 상태 검사는 "같은 세션이지만 이미 끝난 경우"를 막는다. 둘 중 하나만으로는 위 시나리오를 전부 덮지 못한다.

정수 비교 한 줄이라는 점이 이 패턴의 장점이다. 진행 중인 작업을 취소하려 하지 않고, 결과가 도착했을 때 유효한지만 판단한다. `AbortController`로 취소를 시도하는 방식보다 단순하고, 취소 신호가 늦게 전파되는 경우에도 안전하다.

### 발화권 뮤텍스

세대와 별개로, 답변과 혼잣말이 동시에 화면에 나가지 않게 하는 장치가 필요하다.

```
let speaking = false;
```

`speaking`은 **비동기 작업을 시작하기 전에** 설정된다. LLM 호출이 끝난 뒤가 아니다. 응답을 만드는 8초 동안에도 발화권이 점유되어 있어야 그 사이에 혼잣말 타이머가 발화를 시작하지 않는다.

해제되는 경로는 다섯 가지다.

- `speak()`의 표시 타이머 만료 시점 — 정상 경로
- 차단된 채팅(결과가 `null`)
- 세대 불일치 또는 상태 불일치로 결과를 폐기할 때
- 세션 시작·종료 시 강제 초기화
- 예상하지 못한 예외 — `Promise.all` 체인의 `.catch()`

마지막 경로가 없으면 한 번의 예외로 방송 전체가 멈춘다. `speaking`이 `true`인 채로 남고 이를 되돌릴 주체가 없기 때문이다. 안쪽 함수들이 각자 예외를 삼키고 있어 실제로 여기까지 오는 경우는 드물지만, 뮤텍스를 잡는 코드는 어떤 경로로도 반드시 놓아야 한다.

Node가 단일 스레드이므로 검사와 설정 사이에 `await`가 없는 한 원자적이다. `scheduleNext()`는 `speaking = true`를 동기적으로 설정한 뒤 비동기 작업을 시작하므로 이 조건을 만족한다. 락 라이브러리가 필요 없는 것은 런타임 모델 덕분이지 설계가 특별히 정교해서가 아니다.

혼잣말 쪽에는 추가 방어가 있다. `scheduleMonologue()`는 예약 시점과 타이머 발화 시점에서 `status`, `speaking`, `queue.length`를 **두 번** 확인한다. 대기하는 30~60초 사이에 채팅이 들어올 수 있기 때문이다. 채팅이 들어오면 `POST /api/chat` 핸들러가 `cancelMonologue()`를 호출해 예약 자체를 취소하므로, 새 채팅 반응이 항상 혼잣말보다 우선한다.

### 표시 타이머와 세대

`speak()`가 거는 표시 타이머는 세션 종료 시 취소되지 않는다. 취소하지 않아도 되도록 타이머 자신이 세대를 본다.

세대 검사가 없을 때 실제로 문제가 되는 경로는 "종료 후 곧바로 재시작"이다. 이전 세션의 타이머가 만료되면서 새 세션이 방금 올린 `currentResponse`를 지우고 `speaking = false`로 만든다. 새 세션 입장에서는 말풍선이 이유 없이 사라지고 발화권이 풀린다. `state.status !== "live"` 검사만으로는 이 경우를 걸러 낼 수 없다. 재시작 뒤에는 상태가 다시 `live`이기 때문이다.

그래서 `speak()`는 타이머를 걸 때 호출 시점의 `sessionGeneration`을 캡처하고, 콜백 첫 줄에서 세대가 같은지 확인한 뒤에만 상태를 건드린다. 세대가 다르면 아무것도 하지 않고 그대로 사라진다. LLM·TTS 결과를 폐기할 때 쓰는 것과 같은 장치를 타이머에도 적용한 것이다.

---

## 7. 장기 기억

`packages/memory`는 세 부분으로 나뉜다. 저장·검색(`store.ts`), 규칙 추출(`extract.ts`), 임베딩과 유사도(`embedding.ts`).

### 저장 구조

저장소는 `data/memories.json` 파일 하나다. SQLite도 벡터DB도 쓰지 않는다. 프로세스 시작 시 전체를 읽어 인메모리 배열에 담고, 변경이 있을 때마다 배열 전체를 다시 직렬화해 덮어쓴다.

레코드는 다음과 같다.

| 필드 | 의미 |
|---|---|
| `id` | UUID |
| `text` | 기억 문장. 방송 화면에 나가지 않고 LLM 프롬프트로만 쓰인다 |
| `kind` | `"broadcast"`(방송 요약) 또는 `"viewer"`(시청자 관련) |
| `viewerId` | 내부 식별자. 닉네임 원문은 저장하지 않는다 |
| `importance` | 0~1. 검색 가중치 |
| `confidence` | 0~1. 규칙 추출은 0.5, LLM 요약은 0.75~0.8 |
| `repeatCount` | 같은 문장이 다시 등장한 횟수 |
| `createdAt` / `expiresAt` | ISO 문자열. TTL 기본 30일 |
| `embedding` | 1536차원 실수 배열(`text-embedding-3-small`). 없을 수 있다 |

### 하이브리드 검색

`search()`는 임베딩 유무에 따라 두 갈래로 갈린다.

임베딩이 있으면:

```
score = cosineSimilarity(queryVector, record.embedding) + record.importance * 0.05
```

`minSimilarity`(기본 0.3) 미만을 버리고 점수 내림차순으로 `maxMemories`(기본 5)건을 취한다.

중요도 가중치가 0.05로 작은 것은 의도적이다. 코사인 유사도가 -1~1 범위이므로 0.05는 순위를 뒤집을 만한 크기가 아니다. **유사도가 비슷한 후보들 사이에서만 중요한 기억이 앞서게 하는 타이브레이커**로 설계했다. 중요도를 크게 반영하면 질문과 무관한 "중요한" 기억이 항상 상위에 오게 된다.

`minSimilarity`를 0.3으로 낮게 잡은 것도 의도다. 관련 기억을 놓치는 쪽보다 조금 넉넉히 넣는 쪽이 낫다고 판단했다. **최종적으로 어떤 기억을 실제로 쓸지는 답변 LLM이 프롬프트 안에서 판단한다.** 검색은 후보를 좁히는 역할까지만 한다.

### 우아한 성능 저하

임베딩은 외부 API 호출이므로 실패할 수 있고, API 키가 없을 수도 있다. 이 시스템은 그때 예외를 던지지 않는다.

- **검색 시**: 임베딩 제공자가 없거나 `embed()`가 실패하면 `queryVector`가 `null`이 되고, 중요도 내림차순 → 생성 시각 내림차순 정렬로 자동 전환된다. 점수는 0으로 채워진다. 기억 기능은 품질이 떨어진 채로 계속 동작한다.
- **저장 시**: 임베딩 호출이 실패해도 `catch`가 비어 있고 저장은 그대로 진행된다. 임베딩이 없는 레코드가 만들어질 뿐이다.
- **호출부**: `apps/server/src/index.ts`의 `currentEmbedding()`은 기억이 꺼져 있거나, 키가 없거나, 프로바이더가 OpenAI가 아니면 `null`을 반환한다. Anthropic을 쓰면 임베딩 없이 동작한다.
- **서버 쪽**: `makeResponse()`에서 `search()` 호출을 `try/catch`로 감싸 검색 실패가 답변 생성을 막지 못하게 한다.

임베딩이 없는 레코드는 점수 계산에서 0을 받아 `minSimilarity` 필터에 걸려 탈락한다. 즉 임베딩 성공 레코드와 실패 레코드가 섞이면 실패한 쪽은 검색에 잡히지 않는다. 저장은 되었지만 사실상 조회되지 않는 기억이 생길 수 있다는 뜻이고, 이 경우를 복구하는 재계산 절차는 없다.

### 추출과 차단 2단계

기억은 방송 종료 시 `persistSessionMemories()`에서 한 번에 정리된다.

**1단계 — 규칙 추출** (`extractMemoryCandidates`)
시청자 발언만 대상으로 한다. 6자 미만, 위험·개인정보 패턴, 단순 인사 패턴을 제외한 뒤, 취향 패턴("좋아해", "즐겨", "최애", "덕질" 등) 또는 경험 패턴("퇴근", "시험", "여행", "합격" 등)에 걸리는 것만 후보가 된다. 취향은 `importance` 0.6, 경험은 0.45를 받는다. 규칙 단계이므로 `confidence`는 0.5로 낮게 둔다.

**2단계 — 저장 직전 차단** (`isStorableMemory`)
후보 목록과 LLM 요약 결과 **양쪽 모두** 저장 직전에 다시 검사한다. 규칙으로 뽑은 후보는 이미 같은 패턴을 통과했지만, LLM 요약은 새로 생성된 문장이므로 이 검사가 유일한 방어선이다. 요약 프롬프트에도 "정치·의료·법률·투자·개인정보는 절대 넣지 않는다", "시청자 닉네임이나 실명은 넣지 않는다"가 들어 있지만, 프롬프트는 지시일 뿐이고 코드가 실제 차단이다.

방송 요약은 `summarizeBroadcast()`가 담당한다. 같은 `LlmAdapter` 인터페이스에 `overrideSystemPrompt`·`overrideUserPrompt`·`overrideSchema`를 갈아 끼워 재사용하는 구조라, 어댑터를 하나 더 만들 필요가 없다. 요약이 실패해도 규칙으로 뽑은 후보는 그대로 저장된다.

### 중복 병합과 TTL

`add()`는 `text`·`kind`·`viewerId`가 모두 같은 레코드를 찾아 이미 있으면 새로 만들지 않는다.

```
existing.repeatCount += 1;
existing.importance = Math.min(1, existing.importance + 0.1);
existing.expiresAt = expiresAt;   // 수명 연장
```

반복해서 나온 이야기는 중요해지고 오래 남는다. 한 번 나온 이야기는 30일 뒤 만료된다. `purgeExpired()`는 `load()` 시점에 한 번 실행되며, 별도의 주기적 청소 작업은 없다. 서버를 재시작하지 않고 오래 켜 두면 만료된 기억이 배열에 남아 검색 대상에 포함된다.

병합 판정은 문자열 완전 일치다. 표현이 다른 같은 뜻의 문장은 별개 레코드가 되고, **서로 모순되는 취향은 판단하지 않고 둘 다 저장된다.** 임베딩이 있으므로 유사도 기반 병합이 기술적으로 불가능하지는 않지만 구현하지 않았다.

### 한계

- **검색에 `viewerId` 필터가 없다.** 저장은 시청자별로 되지만 검색은 전체 레코드를 대상으로 한다. 여러 사람이 채팅하면 다른 시청자의 기억이 답변 문맥에 섞일 수 있다. 개인정보 관점의 결함이다.
- **전체 로드·전체 저장 방식이다.** 레코드가 늘면 시작 시간과 저장 시간이 선형으로 증가한다.
- **동시 쓰기 안전성이 없다.** 단일 프로세스만 접근한다는 전제에 의존한다.

### 문맥 계층 — 무엇을 검색하고 무엇을 검색하지 않는가

프롬프트에 들어가는 정보는 성격이 다섯 가지이고, 각각 다른 경로로 들어온다. 전부 벡터 검색에 밀어 넣지 않는 것이 요점이다.

| 계층 | 경로 | 검색되나 | 왕복 | 소유 |
|---|---|---|---|---|
| 페르소나·출력 규칙·모션 목록 | `buildSystemPrompt` | 아니오, 매 턴 그대로 | 없음 | `packages/llm/prompt.ts` |
| 방송 상황(경과 시간·답변 수) | `broadcastStatusLines()` | 아니오, 서버가 계산 | 없음 | 서버 |
| 누적 요약 | `sessionSummary` | 아니오, 매 턴 그대로 | 주기마다 1회(비동기) | 서버 |
| 키워드 매크로 | `activateMacros()` | 키워드 일치 | 없음 | `data/macros.json` |
| 장기 기억 | `memoryStore.search()` | 코사인 유사도 | 답변마다 1회 | `data/memories.json` |

**왜 매크로와 기억을 나누는가.** "아디나 카운터 뭐임"처럼 고유명사가 그대로 나오는 채팅은 키워드 매칭이 벡터 검색보다 정확하고, 임베딩 왕복이 없어 그만큼 빠르다. 반대로 "그 얼음 쓰는 애 뭐가 좋아요"는 키워드가 없으므로 매크로가 잡지 못하고 기억 검색이 맡아야 한다. 둘은 대체 관계가 아니라 서로 못 잡는 것을 메우는 관계다.

매크로는 항목당 키워드 5개까지 쓰이고, 동시에 5개까지만 켜진다. 넘치면 `priority`가 큰 것부터 남는다. 켜진 매크로는 답변이 나갈 때마다 남은 턴이 줄어들고 0이 되면 떨어진다. 같은 키워드가 다시 나오면 남은 턴이 다시 채워지므로, 화제가 이어지는 동안에는 계속 붙어 있는다.

**기억 검색이 0건일 때 섹션을 지우지 않는 이유.** 섹션을 통째로 빼면 모델은 "기억이 없다"와 "기억을 찾아보지 않았다"를 구분할 수 없다. 지난 대화를 묻는 채팅은 규칙을 건너뛰고 LLM으로 넘어가므로(§4 분기 2), 이 상태에서 모델이 아는 척 지어낼 여지가 생긴다. 그래서 `[기억]` 섹션은 항상 남기고, 비었으면 비었다는 사실을 문장으로 적는다.

**모델에게 세라고 시키지 않는다.** 경과 시간이나 답변 수를 프롬프트로 "세어라"라고 지시하면 맞지 않는다. 모델이 보는 것은 대화 텍스트뿐이고 매 호출은 독립적이기 때문이다. 서버는 이미 `sessionStartedAt`과 `answeredCount`를 알고 있으므로, 세라고 시키는 대신 계산한 값을 문장으로 넘긴다.

### 누적 요약 — 창 밖으로 밀려난 흐름

`recentTurns`는 발언 10개(채팅 5건)만 유지한다. 그보다 앞선 이야기는 창에서 밀려나 사라진다. 방송 종료 시 만드는 요약(`summarizeBroadcast`)은 다음 방송용이라 진행 중에는 도움이 되지 않는다.

`summarizeSessionProgress`가 그 사이를 메운다. `rollingSummaryTurns` 발언마다 한 번, 이전 요약과 아직 접히지 않은 대화를 함께 넘겨 갱신된 요약 하나를 받는다. 요약을 목록으로 쌓지 않고 매번 하나로 접기 때문에 방송이 길어져도 문맥 길이가 일정하다.

세 가지 안전장치가 붙어 있다.

- **답변 경로를 막지 않는다.** 호출은 `recordTurn`에서 비동기로 띄우고 결과를 기다리지 않는다. 늦게 도착하면 그다음 답변부터 반영된다.
- **세대를 본다.** 요약을 기다리는 사이 방송을 다시 시작했으면 결과를 버린다.
- **실패해도 진도가 나가지 않는다.** 성공했을 때만 `summarizedTurnCount`를 올리므로, 접지 못한 대화는 다음 시도에 그대로 다시 넘어간다.

회로가 열려 있거나 이미 요약이 진행 중이면 시도하지 않는다. 답변용 호출이 연달아 실패하는 상황에서 요약까지 밀어붙일 이유가 없다.

---

## 8. Live2D 렌더링 통합

### React UI 레이어와 WebGL 캔버스

Cubism SDK for Web의 샘플 델리게이트는 자신의 캔버스를 `document.body`에 직접 붙인다. React가 관리하는 DOM 트리 밖이다. 이 상태로는 채팅 패널·말풍선·헤더가 캔버스와 어떤 순서로 겹칠지 통제할 수 없다.

`apps/broadcast/src/main.tsx`는 초기화 직후 캔버스를 옮겨 심는다.

```
const canvas = document.querySelector("body > canvas");
if (canvas && live2dLayer.current) live2dLayer.current.appendChild(canvas);
```

`.live2d-layer`는 React가 렌더링하는 요소이고, 그 위에 헤더·채팅 패널·말풍선·상태 바가 얹힌다. 이후 React는 캔버스 내부를 건드리지 않고 레이어의 위치와 크기만 관리한다. **소유권 분리다** — 캔버스 내부는 SDK가, 배치는 React가 담당한다.

초기화 순서에도 제약이 있다. Cubism Core는 전역 스크립트로 먼저 로드되어야 하고, 그다음에 SDK 샘플 모듈을 import해야 한다. 둘을 병렬로 실행하면 순서가 보장되지 않는다.

```
loadCore()                              // <script> 동적 삽입 + onload Promise
  .then(() => import("@sdk-sample/lappdelegate"))
  .then(({ LAppDelegate }) => { ... })
```

여기에 React StrictMode 문제가 겹친다. 개발 모드에서 StrictMode는 effect를 두 번 실행하는데, `LAppDelegate`는 전역 싱글톤이라 두 번 초기화하면 캔버스가 두 개 생기고 내부 배열이 어긋난다. 동적 import 콜백에서 `cancelled` 플래그를 확인해 취소된 실행은 초기화하지 않도록 막았다.

### SDK 샘플 패치 2곳

방송 로직이 모델을 조작하려면 샘플이 제공하지 않는 두 가지 진입점이 필요했다. SDK 샘플 코드에 직접 메서드를 추가했다.

**`lappdelegate.ts` — `lookAt(x, y)`**

```
public lookAt(x: number, y: number): void {
  this._subdelegates?.[0]?.getLive2DManager()?.onDrag(x, y);
}
```

샘플은 시선을 포인터 이벤트(`onPointerMoved`)로만 조작한다. 방송 화면에는 포인터가 없다. 내부의 `onDrag`는 목표점을 받아 모델이 관성을 두고 따라가게 만드는 기존 경로이므로, 이것을 공개 메서드로 노출하는 것이 가장 적은 변경이다. 화면 중앙이 (0, 0), 오른쪽이 +x, 위가 +y인 -1~1 좌표계를 그대로 쓴다.

**`lappmodel.ts` — `setManualLipSync(value)`**

이쪽은 삽입 위치가 핵심이다. 파라미터를 아무 데서나 써도 되는 것이 아니다.

```
this._model.saveParameters();
this._updateScheduler.onLateUpdate(this._model, deltaTimeSeconds);   // ← 스케줄러가 입 파라미터를 씀

// 삽입 지점
if (this._manualLipSync != null) {
  for (let i = 0; i < this._lipSyncIds.length; i += 1) {
    this._model.setParameterValueById(this._lipSyncIds[i], this._manualLipSync, 1.0);
  }
}

this._model.update();
```

SDK의 `UpdateScheduler`는 `onLateUpdate`에서 립싱크를 포함한 효과 파라미터를 일괄 갱신한다. 그보다 앞에서 값을 쓰면 스케줄러가 덮어써서 화면에 반영되지 않는다. `_model.update()` 뒤에 쓰면 그 프레임에는 반영되지 않는다. **`onLateUpdate` 직후, `_model.update()` 직전**이라는 좁은 구간에만 값이 남는다. SDK 내부 실행 순서를 파악해야 찾을 수 있는 지점이다.

`null`을 넣으면 SDK 기본 동작으로 되돌아간다. 립싱크를 강제로 끄는 것이 아니라 개입을 중단하는 방식이라, 발화가 끝난 뒤 상태 복구가 한 줄로 끝난다.

### 립싱크 2종 전환

방송 화면은 음성 유무에 따라 서로 다른 립싱크를 쓴다. 두 effect가 상호 배타적으로 동작한다.

**음성이 있을 때 — 파형 기반**
`state.currentAudioId`가 생기면 `Audio` 요소를 만들고 `AudioContext` → `createMediaElementSource` → `AnalyserNode` → `destination`으로 연결한다. `fftSize`는 256이다.

```
rms    = sqrt(Σ((sample - 128) / 128)² / N)
target = min(1, rms * 16)
opening += (target - opening) * 0.45
model.setManualLipSync(opening)
```

`audioGain`이 16인 이유는 합성 음성의 실효값이 0.1 안팎이라 그대로 쓰면 입이 거의 벌어지지 않기 때문이다. `audioSmoothing` 0.45는 프레임 간 값의 급변을 눌러 입이 떨리는 것을 막는다. `ended` 이벤트와 cleanup 양쪽에서 `setManualLipSync(null)`을 호출해 어떤 경로로 끝나도 SDK 기본 동작으로 복귀한다.

브라우저 자동 재생 차단도 처리한다. `context.resume().then(() => audio.play())`가 실패하면 `audioBlocked` 상태를 켜서 "소리 켜기" 버튼을 노출한다. OBS Browser Source에서는 차단되지 않으므로 이 경로는 브라우저로 직접 열었을 때의 안전장치다.

**음성이 없을 때 — 사인파 기반**
`currentAudioId`가 없고 `reply`만 있으면 글자수 기반으로 흉내를 낸다. 지속 시간은 `글자수 × 78ms`를 900~9000ms로 제한한 값이다. 78ms는 한국어 발화 속도에 맞춘 값이다.

```
wave   = (sin((elapsed / 190) * 2π) + 1) / 2
jitter = 0.75 + random() * 0.25
open   = 0.12 + wave * jitter * (0.95 - 0.12)
```

`jitter`가 없으면 완전히 같은 폭으로 반복되어 기계적으로 보인다.

**한계** — 파형 립싱크는 소리 크기에는 맞지만 모음별 입 모양을 구분하지 않는다. 이 모델은 `ParamMouthOpenY` 하나만 립싱크 대상으로 등록되어 있어 입의 가로 변형을 표현할 파라미터 자체가 없다.

### 프레임레이트 독립 시선 보간

시선은 목표점(`gazeTargetRef`)과 현재 위치(`gazeCurrentRef`)를 분리하고, `requestAnimationFrame` 루프에서 현재 위치를 목표로 수렴시킨다.

```
deltaSeconds = min(0.2, (now - previous) / 1000)
ratio        = 1 - exp(-2.5 * deltaSeconds)
current.x   += (target.x - current.x) * ratio
current.y   += (target.y - current.y) * ratio
delegate.lookAt(current.x, current.y)
```

`current += (target - current) * 고정비율` 형태로 쓰면 프레임 수에 비례해 속도가 달라진다. 144Hz 모니터에서는 60Hz보다 2.4배 빨리 고개가 돌아간다. `1 - exp(-k * dt)`는 지수 감쇠의 이산 근사이므로 프레임 간격이 어떻든 같은 실시간 속도를 만든다. `k = 2.5`에서 목표까지 약 0.9초가 걸린다.

`deltaSeconds`를 0.2로 제한하는 것은 탭이 백그라운드에 있다가 돌아왔을 때 한 프레임에 목표까지 순간 이동하는 것을 막기 위해서다.

그 위에 연출 레이어를 얹었다.

- **idle** — 1.1~3.2초마다 x ∈ [-0.28, 0.28], y ∈ [-0.15, 0.2] 범위의 새 목표를 잡는다. 모델이 목표에 닿으면 멈추므로 간격이 길면 한곳을 오래 응시하는 것처럼 보인다.
- **새 채팅** — `Math.random() > 0.6`이면 아무것도 하지 않는다. 40%는 못 본 척한다. 매번 쳐다보면 오히려 어색하기 때문이다. 쳐다볼 때는 x ∈ [0.45, 0.9]로 크게 돌아본다.
- **응시 시간** — 2.6~4.2초. 고개가 0.9초에 걸쳐 돌아가므로 이보다 짧으면 다 돌아보기 전에 시선이 되돌아온다.
- **복귀** — 채팅을 본 뒤 정면(0, 0)이 아니라 idle 범위의 무작위 지점으로 돌아간다. 정면 복귀는 전환이 끊겨 보인다.
- **발화 중** — x ∈ [-0.12, 0.12]로 시청자 쪽을 보되 완전히 고정하지 않는다.

### 표정과 모션의 짝 구조

이 모델은 **표정 파일이 효과를 켜는 스위치이고 모션 파일이 그 효과의 애니메이션을 돌리는** 구조다. 예를 들어 `shengqi` 표정이 Param66을 켜고 `shengqi` 모션이 Param68을 진동시킨다. 표정 없이 모션만 실행하면 화면에 아무 변화가 없다.

따라서 방송 화면은 모션이 있으면 반드시 짝 표정을 함께 켠다.

```
const motion = resolveMotion(response.actions, response.emotion.primary);
const expression = motion ? motionPairedExpression(motion.group)
                          : resolveExpression(response.emotion.primary);
if (expression) model.setExpression(expression); else model.clearExpression();
```

관리자 모션 테스트 경로에도 같은 처리가 들어 있다. `packages/live2d`의 `motionPairedExpression()`이 이 규칙을 코드로 표현한 지점이고, 현재 이 모델은 네 모션 모두 같은 이름의 표정과 짝을 이루므로 항등 함수다. 다른 모델로 교체하면 이 함수만 바꾸면 된다.

표정은 `emotion.durationSeconds` 뒤에 `clearExpression()`으로 해제된다. 감정에 매핑된 표정이 없으면(`calm`, `curious`) 표정을 해제해 기본 얼굴을 유지한다. 이 모델에는 중립 표정 파일이 없어서 "아무 표정도 켜지 않은 상태"가 곧 기본 얼굴이다.

같은 모션이 재생 중이면 `playingMotionRef`로 판단해 건너뛴다. 다른 모션이면 SDK의 우선순위 규칙에 맡긴다.

---

## 9. 비공개 자산 처리

이 프로젝트는 저장소를 공개하지만 두 가지를 공개할 수 없다.

- 구매한 상용 Live2D 모델 (13.4MB) — 재배포 금지
- Cubism SDK for Web 5-r.5 (24.9MB) — Live2D Proprietary Software License. 재배포가 허용되는 파일은 `live2dcubismcore.{d.ts, js, min.js}` 뿐이다

구매 모델 디렉터리와 `private-assets/`는 둘 다 `.gitignore` 대상이다. 문제는 애플리케이션이 이 자산을 **런타임에 URL로 로드해야 한다**는 것이다. Vite는 프로젝트 루트 밖의 파일을 기본적으로 서빙하지 않는다.

흔한 우회는 빌드 전에 `public/`으로 복사하는 스크립트다. 그러면 작업 디렉터리에 라이선스 위반 소지가 있는 사본이 생기고, `.gitignore`에 예외를 추가해야 하며, 실수로 커밋될 여지가 생긴다. **라이선스 제약을 빌드 파이프라인 안에서 해결하는 편이 안전하다.**

`apps/broadcast/vite.config.ts`의 `privateAssets()` 플러그인이 이 역할을 한다.

### 라우팅 테이블

URL 접두사와 실제 폴더의 대응을 한 곳에 정의한다.

| URL 접두사 | 실제 위치 | 내보내는 파일 |
|---|---|---|
| `/private-model/<모델 디렉터리>/` | 구매 모델 디렉터리 | 전체 |
| `/private-core/` | `Core/` | `live2dcubismcore.js`, `LICENSE.md` |
| `/private-framework/Shaders/WebGL/` | `Framework/Shaders/WebGL/` | 전체 |

이 URL들은 SDK 샘플의 `lappdefine.ts`에 있는 `ResourcesPath`·`ShaderPath`와 맞춰야 한다.

### dev와 build가 같은 URL 구조를 공유한다

**`configureServer`** — dev 서버에 미들웨어를 등록해 접두사에 맞는 요청을 저장소 밖 파일에서 읽어 응답한다. 확장자에 따라 Content-Type을 붙이고(`.moc3`는 `application/octet-stream`), 없는 파일은 404를 반환한다. **파일을 프로젝트 안으로 복사하지 않는다.**

**`closeBundle`** — 빌드가 끝난 뒤 같은 라우팅 테이블을 돌며 `dist/` 아래에 동일한 URL 구조로 복사한다.

핵심은 두 경로가 **같은 상수를 공유한다**는 점이다. dev에서 동작하는 URL이 빌드 산출물에서도 그대로 동작하고, 애플리케이션 코드는 dev인지 빌드인지 알 필요가 없다. 빌드 산출물 `dist/`에는 구매 자산이 포함되므로 배포·공개 대상이 아니다. `.gitignore`가 `dist/`를 제외한다.

### path traversal 차단

```
const filePath = resolve(route.root, url.slice(route.prefix.length));
if (!filePath.startsWith(route.root)) { response.statusCode = 403; response.end(); return; }
```

`resolve()`로 정규화한 절대 경로가 라우트 루트로 시작하지 않으면 거부한다. `/private-model/<모델 디렉터리>/../../../etc/passwd` 같은 요청이 여기서 걸린다. dev 서버는 127.0.0.1에 바인딩되지만, 시청자 채팅 화면을 휴대폰에서 열기 위해 LAN에 노출하는 사용 방식이 있으므로 필요한 방어다.

### 재배포 허용 파일만 화이트리스트

`/private-core/`는 `include: ["live2dcubismcore.js", "LICENSE.md"]`로 제한한다. Core 디렉터리에는 소스맵과 문서도 들어 있지만 라이선스가 재배포를 허용하는 것은 런타임 스크립트뿐이다. `LICENSE.md`를 함께 내보내는 것은 라이선스 고지 의무 때문이다. **디렉터리 전체 복사가 아니라 명시된 파일만 복사한다는 것이 이 설정의 요점이다.**

모델과 셰이더 라우트는 `include`가 없어 전체를 복사한다. 이 둘은 애초에 배포 대상이 아니라 로컬 실행에만 쓰이므로 제한할 이유가 없다.

### SDK 소스 참조

TypeScript 소스는 URL이 아니라 Vite 별칭으로 해석한다.

```
"@framework":  private-assets/.../Framework/src
"@sdk-sample": private-assets/.../Samples/TypeScript/Demo/src
```

별칭으로 두면 dev와 빌드 모두 같은 경로로 해석되고, 번들러가 실제로 쓰이는 모듈만 포함한다. URL 기반 동적 import를 쓰면 빌드에 포함되지 않으므로 이 구분이 필요하다.

---

## 10. 보안 경계

로컬 실행 시스템이지만 신뢰 경계는 명확히 나눠 두었다.

```
┌─ 신뢰 ────────────────────────────────────────────────┐
│  apps/server 프로세스                                  │
│  · API 키 평문(메모리)                                  │
│  · data/ 아래 암호화된 설정 파일                         │
│  · 기억 원문                                            │
└───────────┬───────────────────────────────────────────┘
            │ 나가는 것: hasApiKey 불리언, 검증된 응답, mp3 바이너리
            │ 나가지 않는 것: API 키, 시청자 닉네임(방송 화면 기준)
┌───────────┴──────────┐  ┌──────────────────────────────┐
│ apps/admin (준신뢰)   │  │ apps/broadcast (비신뢰 입력원) │
│ · 설정·키 입력        │  │ · 시청자 채팅 입력             │
│ · 기억 원문 열람      │  │ · 방송 화면 표시               │
└──────────────────────┘  └──────────────────────────────┘

┌─ 비신뢰 ──────────────────────────────────────────────┐
│  LLM 응답 · 시청자 채팅 내용 · HTTP 요청 본문           │
└───────────────────────────────────────────────────────┘
```

### API 키는 서버 밖으로 나가지 않는다

- 어떤 GET 응답에도 키가 포함되지 않는다. `LlmStatus`는 `hasApiKey: boolean`만 담는다. TTS 설정 응답도 `hasApiKey`·`hasElevenLabsKey` 불리언만 내보낸다.
- 파일 저장 시 `AES-256-GCM`으로 암호화한다(`apps/server/src/secret-store.ts`). 키는 `scryptSync("<사용자명>@<호스트명>:bori-ai-vtuber", salt, 32)`로 파생하므로 설정 파일만 다른 컴퓨터로 옮겨도 풀리지 않는다.
- `enc.v1:` 접두사로 버전을 표시한다. 접두사가 없으면 이전 버전이 남긴 평문으로 간주해 그대로 읽고 **즉시 암호문으로 재저장한다.** 무중단 마이그레이션이다.
- 복호화 실패는 예외로 터뜨리지 않고 빈 문자열을 반환한다. 다른 머신에서 만든 파일이면 "키가 없는 상태"로 동작한다.
- **위협 모델의 한계**: 같은 머신에서 이 코드를 실행할 수 있으면 복호화도 가능하다. 파일 유출과 실수로 인한 공유를 막는 수준이고 로컬 권한 침해까지 막지 못한다. 이 한계는 코드 주석에도 적혀 있다.
- OBS 비밀번호는 파일에 저장하지 않고 `OBS_PASSWORD` 환경변수로만 받는다.
- API 오류 응답 본문은 `.slice(0, 200)`으로 잘라서 예외 메시지에 넣는다. 응답에 요청 헤더가 반사되는 경우에도 키가 로그로 흘러나가지 않게 하려는 처리다.

### LLM 출력은 신뢰하지 않는다

5절에서 다룬 6단계 검증과 이중 방어가 그대로 이 경계다. 요약하면 구조화 출력은 형식만 보장하고, 값의 유효성은 `packages/live2d`가 소유한 allowlist가 결정하며, 검증에 실패하면 규칙 문장으로 대체된다.

### 관리자 입력은 방송 응답으로 직접 전달되지 않는다

`POST /api/live2d/test`는 상태의 `lastTestAction` 필드만 바꾸고, 그 값은 allowlist 검사를 통과한 이름이다. 관리자가 임의 문자열을 방송 화면에 표시시킬 수 있는 경로는 없다. 관리자의 테스트 채팅도 일반 채팅과 같은 `POST /api/chat` 경로를 거쳐 동일한 정규화·차단·큐 처리를 받는다.

### 시청자 닉네임은 방송 화면에 표시되지 않는다

`POST /api/chat` 핸들러가 방송 화면용 사본에서 `viewerNickname`을 제거한 뒤 `visibleChats`에 넣는다. 닉네임은 `local:<정규화값>` 형태의 내부 `viewerId`로만 남는다.
LLM 프롬프트에도 닉네임이 들어가지 않는다(`LlmRequest.content`는 채팅 내용만 받는다). 시스템 프롬프트에 "시청자 닉네임은 절대 부르지 않는다"가 있지만, 실제 방어는 닉네임을 애초에 넘기지 않는 데이터 흐름 쪽이다.
기억 저장 시에도 닉네임 원문이 아니라 `viewerId`만 기록되고, 요약 프롬프트에서도 닉네임·실명 기재를 금지한다.

### 위험 주제는 LLM 호출 전에 차단한다

4절의 분기 1이 이 경계다. `unsafePattern`이 `evaluateByRule()`의 첫 줄에 있고 LLM 호출은 그 이후에 일어난다. 프롬프트 인젝션 시도가 모델에 도달하지 않는다.
기억 쪽에도 같은 정책이 두 번 적용된다. 추출 단계에서 위험·개인정보 패턴을 제외하고, 저장 직전 `isStorableMemory()`로 다시 검사한다. LLM이 생성한 요약 문장은 이 두 번째 검사만 거치므로 그것이 유일한 방어선이다.

### 남아 있는 한계

- **API에 인증이 없다.** 서버는 127.0.0.1에만 바인딩하지만 CORS는 `Access-Control-Allow-Origin: *`이다. 로컬 실행 전제에 의존한다.
- **시청자 채팅 화면을 LAN에 노출하면 인증 없이 접근 가능하다.** 신뢰할 수 있는 네트워크에서만 사용해야 한다.
- **원문 채팅 로그를 파일로 남기지 않는다.** 메모리에만 존재하므로 서버를 재시작하면 사라진다. 감사 추적이 없다는 뜻이기도 하고, 기획서의 "원문 로그 수동 삭제" 정책을 적용하려면 저장부터 필요하다는 뜻이기도 하다.
- **차단 패턴이 정규식 기반이다.** 우회 표현을 막지 못한다.
