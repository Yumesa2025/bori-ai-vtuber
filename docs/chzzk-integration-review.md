# 치지직 실제 채팅 연동 검토

상태: **검토(구현 아님)** · 작성일: 2026-10-12 · 기준 브랜치: `feature/audit-ci` (`29ca722`)

이 문서는 치지직(CHZZK) Open API로 실제 방송 채팅을 받아 기존 채팅 파이프라인(`POST /api/chat`과 같은 큐)에 넣는 방법을 검토한다. 코드는 바꾸지 않았다. 결정은 8절에 모았고, 채택하면 [decisions.md](./decisions.md)에 ADR로 옮긴다. 범위 결정의 배경은 ADR-011, 단계 계획은 [implementation-plan.md](./implementation-plan.md) 12단계다.

근거 수준 표기

- **[공식]**: 치지직 공식 개발 문서(`chzzk.gitbook.io/chzzk`)나 개발자 센터 이용약관에서 직접 읽은 내용이다. 문서 머리에 "API 명세와 인증 플로우는 이후 개발 상황에 따라 변경될 수 있다"고 적혀 있으므로 구현 시점에 다시 대조한다.
- **[코드]**: 이 저장소 코드에서 확인한 내용이다. `파일:줄`은 기준 브랜치의 줄 번호다.
- **[제안]**: 이 문서가 제안하는 설계다. 숫자가 붙어 있으면 공식 수치가 아니라 제안값이다.
- **확인 필요**: 공식 문서에서 찾지 못했거나 문서만으로 판단할 수 없는 것이다. 추측으로 채우지 않았다.

---

## 1. 채팅 수신 방식 (Session API)

### 1.1 흐름

1. 세션 생성 API로 소켓 연결 URL을 받는다. [공식]
2. 그 URL로 Socket.IO 연결을 연다. 연결되면 `SYSTEM` 이벤트로 `type: "connected"`와 `data.sessionKey`가 온다. [공식]
3. `sessionKey`를 넣어 이벤트 구독 API(채팅·후원·구독)를 호출한다. 성공하면 `SYSTEM` `subscribed` 메시지가 온다. [공식]
4. 이후 채팅은 `CHAT` 이벤트로 들어온다. [공식]

### 1.2 엔드포인트

Open API 도메인은 `https://openapi.chzzk.naver.com`이다. [공식]

| 용도 | 요청 | 인증 | 비고 |
|---|---|---|---|
| 세션 생성(클라이언트) | `GET /open/v1/sessions/auth/client` | Client 인증 | 최대 10개 연결 유지 [공식] |
| 세션 생성(유저) | `GET /open/v1/sessions/auth` | Access Token | 유저별 최대 3개 연결. 세션 생성에 쓴 토큰과 같은 유저의 이벤트만 구독 가능 [공식] |
| 세션 목록(클라이언트/유저) | `GET /open/v1/sessions/client`, `GET /open/v1/sessions` | Client / Access Token | `size` 1~50(기본 20), `page` 0부터. 끊긴 세션은 90일 동안만 조회 [공식] |
| 채팅 구독 / 취소 | `POST /open/v1/sessions/events/subscribe/chat`, `.../unsubscribe/chat` | Access Token (Scope `채팅 메시지 조회`) | 요청 파라미터는 `sessionKey` 하나 [공식] |
| 후원 구독 / 취소 | `POST .../subscribe/donation`, `.../unsubscribe/donation` | Access Token (Scope `후원 조회`) | [공식] |
| 구독 이벤트 구독 / 취소 | `POST .../subscribe/subscription`, `.../unsubscribe/subscription` | Access Token (Scope `구독 조회`) | [공식] |

- 생성된 URL은 "일정 시간 동안만 유효"하다. [공식] 유효 시간 수치는 **확인 필요**. 연결 직전에 URL을 새로 받는다. [제안]
- 세션당 최대 30개 이벤트(채팅·후원·구독 합산)를 구독할 수 있다. [공식]
- 구독 API에 `channelId` 파라미터가 없다. 구독 대상은 토큰 주인의 채널로 읽힌다. [공식 문서의 요청 명세에서 추론] 클라이언트 세션에 유저 토큰으로 구독하는 조합이 되는지는 **확인 필요**. 보리는 스트리머 한 명의 채널만 보므로 **유저 세션**을 쓴다. [제안]
- `sessionKey`를 쿼리 파라미터로 보내는지 본문으로 보내는지는 표에 "Request Param"으로만 적혀 있다. 실제 호출 형식은 **확인 필요**.

### 1.3 Socket.IO 클라이언트 제약

- 지원 버전: **Socket.IO-client 1.0.0 이상 2.0.3까지**. [공식] 현재 3.x·4.x 클라이언트는 프로토콜이 달라 붙지 않는 것으로 보이며, 실제 동작은 **확인 필요**.
- 공식 예시 옵션: `reconnection: false`, `'force new connection': true`, `'connect timeout': 3000`, `transports: ['websocket']`. [공식] 라이브러리 자동 재연결을 끄는 예시이므로 재연결은 우리가 직접 한다(7절).
- 이 저장소는 외부 런타임 의존성을 거의 두지 않는다(ADR-004 내장 `http`, ADR-005 `fetch` 직접 호출). 구버전 `socket.io-client@2.x`를 서버 의존성으로 새로 들여야 한다. 해당 버전대의 보안 공지 여부는 **확인 필요**. [제안] 의존성은 `apps/server`에만 두고, 버전을 정확히 고정한다.

### 1.4 메시지 형식 (`CHAT`)

| 필드 | 타입 | 내용 | 보리에서 쓸지 [제안] |
|---|---|---|---|
| `channelId` | String | 이벤트 채널 ID | 연결한 채널과 같은지 검사에만 |
| `senderChannelId` | String | 작성자 채널 ID | 내부 화자 식별(6절) |
| `chatChannelId` | String | 채팅 채널 ID(임시제한·메시지 숨기기에 사용, 2026.03 추가) | 메모리에서만. 저장 안 함 |
| `profile.nickname` | String | 닉네임 | 저장 안 함(6절) |
| `profile.badges`, `profile.verifiedMark` | Object[], boolean | 배지, 인증 여부 | 쓰지 않음 |
| `userRoleCode` | String | `streamer` / `common_user` / `streaming_channel_manager` / `streaming_chat_manager` | 필터 판단(5.4절) |
| `content` | String | 채팅 내용 | 사용 |
| `emojis` | Map | 이모티콘 식별자 → URL | 쓰지 않음 |
| `messageTime` | Int64 | 메시지 시간(ms) | 오래된 채팅 버리기(7절) |

[공식] 필드 목록 출처는 Session 문서의 "채팅 이벤트 메시지"다.

- `content` 안에서 이모티콘이 어떤 표기로 들어오는지는 **확인 필요**. 이모티콘만 있는 채팅을 걸러야 할 수 있다.
- 받는 채팅의 최대 길이는 문서에 없다(**확인 필요**). 보내는 채팅은 최대 100자다. [공식]
- `DONATION`은 `donationType`(CHAT/VIDEO), `donatorChannelId`, `donatorNickname`, `payAmount`, `donationText` 등을 준다. [공식] 1차 범위 밖이다(implementation-plan 12단계 "1차는 일반 채팅만").
- 같은 메시지가 두 번 오는지, 메시지 ID가 있는지는 문서에 없다. 표에 메시지 ID 필드는 없다. **확인 필요**.

### 1.5 시스템 메시지 (`SYSTEM`)

| `type` | 의미 | 대응 [제안] |
|---|---|---|
| `connected` | 연결 완료, `data.sessionKey` 전달 | 채팅 구독 호출 |
| `subscribed` | 구독 완료, `data.eventType`, `data.channelId` | 상태를 "수신 중"으로 |
| `unsubscribed` | 구독 취소 | 우리가 취소한 게 아니면 재구독 시도 |
| `revoked` | 사용자의 동의 철회·스코프 변경 등 **권한 회수**로 구독 취소 | 재연결 중단, 관리자에게 재로그인 요청 |

[공식] `type` 네 가지와 의미.

---

## 2. 인증

### 2.1 두 가지 인증

| 방식 | 헤더 | 쓰는 곳 |
|---|---|---|
| Client 인증 | `Client-Id`, `Client-Secret`, `Content-Type: application/json` | 세션 생성(클라이언트), 세션 목록(클라이언트), 채널 정보 조회, 라이브 목록 조회 등 |
| Access Token 인증 | `Authorization: Bearer <token>` (Bearer와 토큰 사이 공백 필수) | 세션 생성(유저), 이벤트 구독, 유저 정보 조회, 채팅 전송·설정, 활동 제한 등 |

[공식] 출처: 참고사항, Session, User, Chat, Restriction 문서.

**보리 채팅 수신에는 Access Token(유저 인증)이 반드시 필요하다.** 채팅 구독 Scope `채팅 메시지 조회`가 Access Token을 요구하기 때문이다. [공식] Client Secret은 토큰 발급·갱신에 들어가므로 이것도 서버가 갖고 있어야 한다.

### 2.2 OAuth 2.0 Authorization Code 흐름

1. 브라우저로 `GET https://chzzk.naver.com/account-interlock?clientId=…&redirectUri=…&state=…`를 연다. 이 도메인은 Open API와 다른 별도 도메인이다. [공식]
2. 사용자가 동의하면 `redirectUri`로 `code`와 `state`가 전달된다. `redirectUri`는 애플리케이션 등록 때 입력한 **로그인 리디렉션 URL과 일치**해야 한다. [공식]
3. `POST /auth/v1/token`에 `grantType: "authorization_code"`, `clientId`, `clientSecret`, `code`, `state`를 보내 `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `expiresIn`을 받는다. [공식]

- 문서 예시의 `redirectUri`가 `http://localhost:8080/api/path`다. 로컬 주소를 리디렉션 URL로 등록할 수 있다는 근거로 보이지만, 실제 등록 허용 여부(`127.0.0.1`·포트 지정 포함)는 **확인 필요**.
- `/auth/v1/token`은 경로만 적혀 있다. Open API 도메인에서 호출하는 것으로 읽히나 명시는 없다. **확인 필요**.
- 인증 요청에 Scope 파라미터가 없다. Scope는 애플리케이션 등록·신청 단계에서 정해지는 것으로 보이며 **확인 필요**.
- `state`는 응답에 그대로 돌아온다. [공식] 검증 규칙은 문서에 없으므로 서버가 직접 만들고 확인한다. [제안]

### 2.3 토큰 수명과 갱신

| 항목 | 내용 |
|---|---|
| Access Token 수명 | 1일. 응답 `expiresIn` 예시 `86400`(문자열 타입) [공식] |
| Refresh Token 수명 | 30일 [공식] |
| 갱신 | `POST /auth/v1/token`에 `grantType: "refresh_token"`, `refreshToken`, `clientId`, `clientSecret` [공식] |
| Refresh Token 재사용 | **일회용**. 갱신 응답에 새 `refreshToken`이 온다 [공식] |
| 만료 시 응답 | 401 `INVALID_TOKEN` (만료·삭제·존재하지 않는 토큰) [공식] |
| Refresh Token도 만료되면 | 인증 코드 과정을 처음부터 다시 [공식] |
| 폐기 | `POST /auth/v1/token/revoke` (`clientId`, `clientSecret`, `token`, `tokenTypeHint`). 같은 clientId·유저의 모든 토큰이 제거된다 [공식] |

- 갱신할 때 Refresh Token 만료일(30일)이 새로 시작되는지는 **확인 필요**. 30일 넘게 방송을 쉬면 재로그인이 필요하다고 보고 설계한다. [제안]
- Access Token이 만료돼도 **이미 연결된 소켓 세션이 계속 유지되는지**는 **확인 필요**. 7절은 끊긴다고 가정하고 대비한다.

---

## 3. 권한(Scope)과 애플리케이션 등록

### 3.1 필요한 Scope [제안]

| Scope | 필요 여부 | 이유 |
|---|---|---|
| `채팅 메시지 조회` | **필수** | 채팅 구독 [공식] |
| `유저 정보 조회` | 권장 | `GET /open/v1/users/me`로 로그인한 계정의 `channelId`·`channelName`을 받아, 연결한 채널이 보리 방송 채널인지 확인 [공식 API, 용도는 제안] |
| `후원 조회`, `구독 조회` | 1차 불필요 | 후원·구독은 별도 단계 |
| `채팅 메시지 쓰기` | 불필요 | 보리는 음성·화면으로 답하고 채팅을 보내지 않는다. 메시지 숨기기도 이 Scope다 [공식] |
| `활동제한 쓰기`·`조회`, `채팅 설정 변경`, `방송 설정 변경`, `방송 스트림키 조회` 등 | 불필요 | 자동 제재·설정 변경은 범위 밖. 스트림키 조회는 특히 받지 않는다 |

최소 Scope만 신청한다. 토큰이 새도 피해 범위가 "채팅 읽기"에 머문다.

### 3.2 등록·심사 절차

| 항목 | 내용 | 근거 |
|---|---|---|
| 등록 위치 | 치지직 개발자 센터 `https://developers.chzzk.naver.com` → Application | [공식] |
| 계약 성립 | 약관 동의 후 애플리케이션을 등록하면 Client ID가 **즉시 발급**된다. 발급일로부터 1년 유효, 1년 단위 자동 갱신 | [공식] 이용약관 제5조 |
| API 사용 신청 | Client ID 발급 후 신청하고, 회사가 입력 정보를 **검토해 승인 여부를 결정**한다. 승인 후 전체 기능 사용 | [공식] 이용약관 제5조 |
| 심사 기간·기준·필요 서류 | 문서에 없음 | **확인 필요** |
| Scope 신청 | 2025.07 "API Scope 신청 절차 간소화" 공지만 있고 절차 설명은 없음 | [공식] Updates, 세부는 **확인 필요** |
| 이름 제한 | 애플리케이션 ID·이름에 'chzzk', '치지직', 'naver', '네이버' 등 공식 서비스명 불가. 부적절한 단어는 정지 사유 | [공식] 참고사항 |
| 미사용 삭제 | 최근 90일간 API Scope 사용량이 0이면 애플리케이션 삭제(참고사항). 약관 제11조는 3개월 미사용 시 이메일 확인 후 14일 무응답이면 해지 | [공식] |
| 한 앱 한 Client ID | 하나의 애플리케이션에는 하나의 Client ID만 발급. 다수 Client ID로 허용량을 늘리는 행위 금지 | [공식] 약관 제5조·제7조 |
| 비밀 유지 | Client ID·Access Token을 제3자에게 공유·공개 금지 | [공식] 약관 제7조 제2항 11호, 제3항 |
| API 사용 표시 | 산출물에 "회사가 지정하는 방식"으로 치지직 API 사용을 표시해야 함 | [공식] 약관 제7조 제4항. 지정 방식은 **확인 필요**(Brand Guides 확인 대상) |

저장소가 공개 대상이므로 Client ID·Secret·토큰은 코드·문서·검사 결과·로그 어디에도 남기지 않는다. 약관상 의무이기도 하다.

---

## 4. 호출 제한

| 항목 | 내용 |
|---|---|
| REST 호출 수 제한 수치 | 문서에 없음. **확인 필요** |
| 초과 시 응답 | 429 `TOO_MANY_REQUESTS` ("Quota 제한 초과") [공식] |
| `Retry-After` 헤더 제공 여부 | **확인 필요** |
| 이용 가능 횟수 지정 | 회사가 정해 개발자 센터에 공지할 수 있고, 과도한 사용은 제한될 수 있음 [공식] 약관 제4조 |
| 동시 연결 | 클라이언트 세션 최대 10, 유저 세션 유저별 최대 3 [공식] |
| 세션당 구독 | 최대 30개 이벤트 [공식] |
| 수신 채팅 속도 상한 | 플랫폼 쪽 상한은 문서에 없음. 채널 설정 `chatSlowModeSec`(0·3·5·10·30·60·120·300초)로 시청자 전송 간격을 둘 수 있음 [공식] |

보리 수신기는 REST를 연결·재연결·토큰 갱신 때만 부르므로 평소 호출량은 작다. 위험은 재연결 루프가 세션 생성·구독을 연타하는 경우다. 7절의 백오프와 동시 연결 1개 유지가 이를 막는다. [제안]

---

## 5. 기존 파이프라인에 붙이는 설계안

### 5.1 지금 구조 [코드]

`POST /api/chat` 처리(`apps/server/src/index.ts:768-801`)가 한 덩어리에서 다음을 모두 한다.

| 단계 | 위치 | 내용 |
|---|---|---|
| 입력 검사 | `:771-775` | 빈 내용, 방송 중(`live`)이 아님, 중복 창(`isDuplicateChat`, `:335`)이면 400 |
| 화자 식별 | `:778-781` | 닉네임 20자 자르기 → `viewerId = local:<정규화 닉네임>`, 없으면 `virtual-viewer` |
| 공개 필드 최소화 | `:788-791` | `VisibleChat`은 `id`·`content`·`receivedAt`·`category`만. `viewerId`는 닉네임에서 나오므로 함께 뺀다(`packages/shared/src/index.ts:35-39`) |
| 큐 | `:794-795` | 메모리 배열. `maxQueueSize`(기본 100)를 넘으면 가장 오래된 것 버림 |
| 답변 | `scheduleNext` `:498-566` | 질문 우선 선택, `engine.respond`. 위험 입력은 `blocked`로 무반응. 익명이면 화자 없음으로 넘겨 기억을 꺼내지 않음 |

- `ChatSource`에 `"chzzk"` 자리가 이미 있다(`packages/shared/src/index.ts:9`). 생성 값은 항상 `"manual"`이다.
- `viewerNickname`은 `ChatMessage`에 담기지만 서버 어디에서도 읽지 않는다. LLM 프롬프트에도 들어가지 않는다. `viewerId`는 기억 소유자 판정(`packages/memory/src/access.ts`)과 방송 기억 추출(`packages/memory/src/extract.ts:45-67`)에만 쓰인다.
- 모든 라우트는 `guardRequest`(Host·Origin·Content-Type·64KB, ADR-015)를 거친다. `tools/test/security.mjs`가 이를 실제 서버로 검사한다.

### 5.2 제안 구조 [제안]

```
apps/server/src/
  chat-intake.ts          ← /api/chat 본문에서 뽑아낸 공통 접수 함수
  chzzk/
    config.ts             ← data/chzzk-config.json 읽기·쓰기 (secret-store 사용, 원자적 쓰기)
    auth.ts               ← 인증 URL 생성, code 교환, 갱신(단일 비행), 폐기
    receiver.ts           ← 세션 URL 받기, socket.io v2 연결, 구독, 재연결 상태 기계
    map.ts                ← CHAT 페이로드 → 접수 입력 (순수 함수)
    routes.ts             ← /api/chzzk/* 관리자 라우트
```

**공통 접수 함수**

```ts
// 의사 코드. 구현 아님.
type ChatIntakeInput = { content: string; viewerId: string; source: ChatSource; receivedAt?: string };
type ChatIntakeResult = { kind: "accepted" } | { kind: "rejected"; reason: "empty" | "not-live" | "duplicate" | "too-long" };
function intakeChat(input: ChatIntakeInput): ChatIntakeResult
```

- `/api/chat`은 닉네임 → `local:` ID 변환까지만 하고 `intakeChat`을 부른다. 동작은 그대로여야 하며 통합 검사가 고정한다.
- 치지직 수신기는 `map.ts`로 변환한 뒤 같은 `intakeChat`을 부른다.
- 중복 창, `VisibleChat` 최소화, 큐 상한, `cancelMonologue`·`scheduleNext` 호출이 한 곳에 남는다.

**HTTP 자기 호출을 쓰지 않는 이유**

- 같은 프로세스 안에서 자기 서버로 요청을 보내면 가드(Origin·Content-Type·본문 크기)를 통과시키기 위한 헤더를 꾸며야 하고, 그 자체가 가드를 우회하는 경로처럼 보인다.
- `/api/chat` 입력은 `nickname`이고 서버가 `local:` ID를 만든다. 치지직 화자 ID(`senderChannelId`)를 넘길 필드가 없다. 넘길 수 있게 열면 **외부 클라이언트가 임의 `viewerId`를 주장하는 경로**가 생긴다(남의 방송 기억을 꺼낼 수 있음). 화자 ID는 서버 내부 입력원만 정할 수 있어야 한다.
- 실패 이유를 HTTP 400 하나로 뭉개지 않고 결과 타입으로 받아 수신기 통계에 쓸 수 있다.

**`ChatMessage` 만들기**

| 필드 | 값 |
|---|---|
| `id` | `randomUUID()` (치지직 메시지 ID가 문서에 없음) |
| `viewerId` | `chzzk:<senderChannelId>` (6절에서 가명화 여부 결정) |
| `viewerNickname` | **넣지 않는다** |
| `content` | `content` 앞뒤 공백 제거, 길이 상한 적용 |
| `receivedAt` | 서버 수신 시각. `messageTime`은 오래된 채팅 판정에만 |
| `source` | `"chzzk"` |

`memory` 패키지 검사에 이미 `viewerId: "chzzk:123"` 예시가 있다(`packages/memory/test/store.test.ts:161`).

### 5.3 토큰 저장: `secret-store.ts` 적합성

**동작** [코드] `apps/server/src/secret-store.ts`, ADR-009

- `AES-256-GCM`. 키는 `사용자명@호스트명:bori-ai-vtuber`에서 `scrypt`로 파생한다. 저장 형식은 `enc.v1:<iv>:<tag>:<암호문>`.
- 접두사가 없으면 이전 평문으로 보고 그대로 돌려준다. 복호화 실패는 빈 문자열이다(예외 없음).
- 지금 `data/llm-config.json`의 API 키와 `data/tts-config.json`의 ElevenLabs 키가 이 방식으로 저장된다. `data/`는 `.gitignore` 대상이다.

**판단: 맞는다. 조건 세 가지를 붙인다.** [제안]

| 항목 | 판단 |
|---|---|
| 위협 모델 | ADR-009와 같다. 설정 파일 유출·실수 공유를 막고 로컬 권한 침해는 막지 않는다. Client Secret·Refresh Token도 같은 수준으로 충분하다고 본다. Refresh Token은 30일짜리라 LLM 키보다 피해 기간이 짧다 |
| 저장 대상 | `clientSecret`, `accessToken`, `refreshToken`은 암호화. `clientId`, `accessTokenExpiresAt`, 연결 채널 ID(6절 결정에 따름)는 평문 |
| 조건 1: 원자적 쓰기 | Refresh Token이 **일회용**이다. 갱신 성공 후 파일 쓰기가 실패하거나 도중에 꺼지면, 디스크에 남은 옛 Refresh Token은 이미 무효라 재시작 후 재로그인이 필요하다. 1:1 저장소처럼 임시 파일 → `fsync` → `rename`으로 쓰고, 쓰기 성공 뒤에만 메모리 토큰을 바꾼다. 지금 `saveLlmConfig`는 덮어쓰기라 그대로 따라 하면 안 된다 |
| 조건 2: 단일 비행 갱신 | 동시에 두 곳에서 갱신하면 하나가 일회용 토큰을 먼저 써서 다른 하나가 `INVALID_TOKEN`을 받는다. 갱신은 진행 중인 Promise 하나를 공유한다 |
| 조건 3: 복호화 실패 처리 | 빈 문자열이 돌아오면 "연결 안 됨, 재로그인 필요"로 표시한다. 다른 컴퓨터로 옮긴 경우와 사용자명·호스트명 변경이 여기에 해당한다 |
| 환경변수 | LLM 키처럼 `BORI_CHZZK_CLIENT_ID`·`BORI_CHZZK_CLIENT_SECRET`을 저장값이 없을 때만 쓰게 할 수 있다(이름은 제안). 토큰은 환경변수로 받지 않는다 |
| 응답·로그 | `GET /api/chzzk/status`는 연결 여부, 구독 상태, 만료 시각, 마지막 오류만 준다. 토큰·Secret은 어떤 응답·`lastError`·콘솔 로그에도 넣지 않는다. 치지직 오류 본문을 그대로 로그에 찍지 않는다 |

### 5.4 필터·차단 규칙 [제안]

| 규칙 | 처리 |
|---|---|
| 다른 채널 이벤트 | `channelId`가 연결한 채널 ID와 다르면 버린다 |
| 스트리머 본인 채팅(`userRoleCode: streamer`) | 기본은 받지 않는다(8절 결정). 운영자 지시용 별도 경로가 생기면 그때 다룬다 |
| 매니저(`streaming_channel_manager`, `streaming_chat_manager`) | 일반 시청자와 같이 받는다 |
| 빈 내용·이모티콘만 | 버린다(이모티콘 표기 **확인 필요**) |
| 길이 | 상한을 둔다(값은 8절). 넘으면 자르지 않고 버린다. 잘린 문장이 다른 뜻이 되는 것을 피한다 |
| 오래된 채팅 | `messageTime`이 수신 시각보다 일정 시간 이상 오래되면 버린다(값은 8절) |
| 같은 시청자 연타 | `viewerId`별 최소 간격을 둔다(값은 8절). 지금 중복 창은 내용 기준이라 같은 사람이 문장만 바꿔 도배하면 못 막는다 |
| 위험 내용 | 지금처럼 엔진 규칙(`isUnsafeContent` → `blocked` → 무반응)에 맡긴다. 수신기가 따로 판정하지 않는다 |
| 방송 상태 | `live`가 아니면 `intakeChat`이 거절한다. 수신기는 방송 시작에 연결, 종료에 해제하는 것을 기본으로 한다(8절) |

### 5.5 1:1 개인 기억과의 분리

1:1 개인 기억은 어떤 경로로도 치지직 채팅과 섞이지 않아야 한다.

- 치지직 채팅은 `intakeChat` → 방송 큐 → `broadcastSession`으로만 간다. `chzzk/` 모듈은 companion 저장소·서비스·`createPrivateMemoryDigest`를 import하지 않는다. ADR-016의 "넘기지 않은 것에는 닿을 수 없다"를 따른다.
- 방송 기억은 `scope: "broadcast"`, `ownerId: chzzk:…`로만 생긴다. 접근 표(`canAccessMemory`)상 방송 모드에서 `private` 기억은 꺼낼 수 없다. [코드]
- **어떤 치지직 화자도 `companion:local`로 매핑하지 않는다.** 스트리머 본인 계정도 마찬가지다. 같은 사람이라도 방송 발언과 1:1 대화는 다른 소유자로 둔다.
- 치지직 연동 설정 파일과 1:1 대화 파일(`companion-conversations.json`)은 별개 파일이다.
- 검사로 고정한다: (1) `map.ts` 결과의 `viewerId`가 `chzzk:` 접두사만 갖는다, (2) 치지직 화자 발언 후 방송 답변 문맥에 `private` 기억이 들어가지 않는다, (3) `chzzk/` 아래에서 `companion/`을 import하지 않는다(정적 검사).

### 5.6 관리자 라우트 [제안]

| 라우트 | 용도 |
|---|---|
| `GET /api/chzzk/status` | 연결 상태, 구독 여부, 토큰 만료 시각, 재연결 횟수, 수신·거절 건수, 마지막 오류. 비밀값 없음 |
| `PUT /api/chzzk/credentials` | Client ID·Secret 저장. 응답은 설정 여부만 |
| `POST /api/chzzk/login` | `state`를 만들어 메모리에 두고(만료 시각 포함) 인증 URL을 돌려준다. 관리자 앱이 외부 브라우저로 연다 |
| `GET /api/chzzk/callback` | 리디렉션 착지점. `state` 일치·미만료·1회용 확인 후 code 교환. 응답은 짧은 HTML 안내(토큰을 화면에 내지 않음) |
| `POST /api/chzzk/connect`, `/disconnect` | 수동 연결·해제(implementation-plan의 "관리자 수동 재연결") |
| `POST /api/chzzk/logout` | 토큰 폐기 API 호출 후 저장값 삭제 |

- 모든 라우트가 기존 `guardRequest`를 거친다. 콜백은 브라우저 최상위 이동 GET이라 보통 Origin이 붙지 않고 Host가 `127.0.0.1`·`localhost`이므로 통과한다. 리디렉션 URL을 서버 포트 `4310`으로 등록할 수 있는지는 2.2절의 **확인 필요**와 같이 확인한다.
- 지금 서버는 모든 응답에 `Content-Type: application/json`을 먼저 붙인다(`index.ts:572`). 콜백은 HTML로 덮어써야 한다.
- 지금 라우트는 `request.url`을 쿼리까지 포함한 문자열로 정확히 비교한다(예: `request.url === "/api/chat"`). 콜백은 쿼리(`code`, `state`)를 쓰는 첫 라우트가 되므로 경로와 쿼리를 나눠 판정한다. `code`·`state` 값은 로그에 남기지 않는다.
- 검사 추가안(`tools/test/security.mjs`): 허용 밖 Origin의 `/api/chzzk/*` 403, `state` 불일치 콜백 거부, `status` 응답에 저장한 가짜 Secret 문자열이 없음, 치지직 경로로 들어간 채팅의 `visibleChats`에 닉네임·채널 ID가 없음. 실제 치지직에는 붙지 않으므로 가짜 이벤트는 단위 검사에서 `map.ts`·`intakeChat`에 직접 넣는다. **이벤트 주입용 HTTP 라우트는 만들지 않는다**(그 자체가 임의 `viewerId` 주입 경로가 된다).

---

## 6. 개인정보

### 6.1 무엇이 들어오나 [공식]

`CHAT` 한 건에 작성자 채널 ID, 채팅 채널 ID, 닉네임, 배지, 인증 여부, 채널 권한, 내용, 이모티콘 URL, 시각이 온다. 채널 ID는 "유저의 고유 식별자로 사용할 수 있다"고 문서가 밝힌다. 즉 `senderChannelId`는 **사람을 가리키는 영구 식별자**다.

### 6.2 저장 범위 [제안]

| 데이터 | 메모리(방송 중) | 디스크 | 방송 화면(`/api/state`) | LLM 프롬프트 |
|---|---|---|---|---|
| `content` | O | 방송 기억 후보·요약으로만(기존 규칙) | O (`VisibleChat`) | O |
| `senderChannelId` | O (`viewerId`) | 방송 기억 `ownerId`로 남음 → **8절 결정** | X | X |
| `profile.nickname` | **X** | X | X | X |
| `chatChannelId` | X | X | X | X |
| 배지·인증·이모티콘 URL | X | X | X | X |
| `userRoleCode` | 필터 판단 후 버림 | X | X | X |
| 연결한 스트리머 채널 ID | O | 설정 파일(평문) | X | X |
| 토큰·Secret | O | 암호화(5.3절) | X | X |

- 닉네임을 쓰지 않는 이유: 지금도 서버는 수동 입력의 닉네임을 `local:` ID를 만드는 데만 쓰고, `viewerNickname` 필드는 어디에서도 읽지 않는다. 바뀔 수 있는 값이라 식별자로 부적합하고, 화면에 띄우면 ADR과 `VisibleChat` 원칙을 깬다. 보리가 시청자 이름을 불러 주는 기능은 이 범위가 아니다.
- 원문 채팅 로그 파일은 만들지 않는다. 지금도 방송 대화는 메모리 세션에만 있고 기억 후보만 저장된다. [코드]
- 오류 로그에 채팅 내용·채널 ID를 찍지 않는다.
- 방송 기억에 `chzzk:<채널 ID>`가 남으면 `memories.json`이 "어떤 치지직 계정이 무슨 말을 했는지"를 영구 보관한다. 선택지는 8절에 있다. 기존 `retentionDays` 보존 기간과 관리자 수동 삭제가 적용된다.
- 약관은 "API 데이터를 추출 또는 저장하는 등의 목적으로 … 다수의 클라이언트 아이디를 사용"하는 행위와 "개인정보보호법 등에 반하여 타인의 개인정보 또는 사생활을 침해하는 내용"을 금지한다. [공식] 약관 제7조 제2항 10·12호. 시청자 기억 저장이 허용 범위인지에 대한 공식 해석은 **확인 필요**. 시청자 고지 방식도 정해야 한다.

---

## 7. 장애 시 동작 [제안]

수신기 상태: `off` → `authorizing` → `connecting` → `subscribing` → `receiving` → (`backoff` | `needs-login` | `off`)

| 상황 | 감지 | 동작 |
|---|---|---|
| 소켓 끊김 | `disconnect`·`error`·연결 시간 초과 | 큐는 그대로 두고 수신만 멈춘다. `backoff`로 가서 **세션 URL부터 새로 받는다**(URL 유효 시간 제한). 새 `connected`의 `sessionKey`로 다시 구독한다 |
| 재연결 백오프 | — | 지수 백오프 + 지터. 제안값 1초 시작, 2배, 최대 60초. 연속 실패가 일정 횟수(제안 10회)를 넘으면 `off`로 두고 관리자에게 알린다. 공식 권장값은 없다(**확인 필요**) |
| 끊긴 동안 채팅 | — | 다시 받을 수 있다는 문서가 없다. **유실로 본다**. 재연결 후 새 채팅부터 받는다(implementation-plan 12단계와 같음). 재연결 직후 `messageTime`이 오래된 채팅은 버린다 |
| 동시 연결 초과 | 세션 생성 실패(오류 코드 **확인 필요**) | 새 소켓을 열기 전에 이전 소켓을 반드시 닫는다. 수신기는 소켓을 하나만 갖는다. 유저 세션 상한이 3이라 재연결이 겹치면 금방 찬다 |
| Access Token 만료 | 만료 시각 접근, REST 401 `INVALID_TOKEN` | 만료 전에 미리 갱신(제안: 남은 시간 1시간 이하). 401이면 단일 비행 갱신 1회 후 재시도. 다시 401이면 `needs-login` |
| Refresh Token 만료·무효 | 갱신 401 `INVALID_TOKEN` | `needs-login`. 재연결을 멈추고 관리자 화면에 재로그인 안내. 방송은 수동 입력 경로로 계속된다 |
| 토큰 만료가 열린 소켓에 미치는 영향 | **확인 필요** | 끊기면 위 소켓 끊김 경로로 처리된다 |
| `revoked` 메시지 | `SYSTEM` `revoked` | 재연결하지 않고 `needs-login`. 사용자가 동의를 철회했을 수 있으므로 자동 재시도는 하지 않는다 |
| `unsubscribed`(우리가 요청 안 함) | `SYSTEM` | 한 번 재구독. 실패하면 소켓 재연결 경로 |
| 429 | REST 응답 | 백오프 단계를 한 단계 올린다. `Retry-After` 제공 여부 **확인 필요** |
| 403 `FORBIDDEN` | REST 응답 | Scope 미승인으로 보고 재시도하지 않는다. 관리자에게 Scope 확인 안내 |
| 5xx·네트워크 오류 | REST 응답 | 백오프 재시도 |
| 큐 과부하 | `queue.length >= maxQueueSize` | 지금 규칙(가장 오래된 것 버림)을 유지하고 버린 수를 상태에 센다. 실제 부하에서 질문 우선 선택이 앞쪽만 보는 문제(ADR-011 결과)는 별도 과제다. 수신기 단에서 시청자별 간격·길이 상한으로 유입을 먼저 줄인다 |
| 방송 종료 | `/api/session/end` | 큐는 지금처럼 비운다. 수신기 해제 여부는 8절 |
| 서버 재시작 | — | 저장된 토큰으로 상태만 복원하고, 연결은 방송 시작 때(또는 수동) 한다 |
| 설정 파일 복호화 실패 | 빈 문자열 | `needs-login`. 파일을 지우지 않는다 |

모든 경우에 **방송은 멈추지 않는다.** 수신기 장애는 `lastError`와 `/api/chzzk/status`로만 알리고, 수동 입력(`/api/chat`)과 혼잣말은 그대로 동작한다. LLM 회로 차단기와도 무관하다.

---

## 8. 남은 결정 사항

사용자가 정해야 한다.

1. **애플리케이션 등록 계정과 이름**: 보리 방송 채널 계정으로 등록할지. 이름에 '치지직'·'네이버'를 쓸 수 없다.
2. **리디렉션 URL**: 서버(`http://127.0.0.1:4310/api/chzzk/callback`)로 직접 받을지, 관리자 앱이 받을지. 로컬 주소 등록 가능 여부를 먼저 확인한다.
3. **Scope**: `채팅 메시지 조회`만 받을지, `유저 정보 조회`를 더할지(채널 확인용, 권장).
4. **시청자 기억**: 치지직 시청자별 방송 기억을 (a) `chzzk:<채널 ID>`로 저장, (b) 로컬 비밀값으로 가명화한 ID로 저장, (c) 저장하지 않음(익명 취급, 방송 요약만) 중 무엇으로 할지. (c)는 시청자별 기억 기능을 끈다. (b)는 파일 유출 시 식별을 어렵게 하지만 비밀값을 잃으면 기억이 끊긴다.
5. **시청자 고지**: 채팅이 AI 응답과 기억에 쓰인다는 사실을 방송 화면·채널 소개 중 어디에 어떻게 알릴지. 약관의 API 사용 표시 방식과 함께 정한다.
6. **스트리머 본인 채팅**: 받지 않을지, 일반 채팅처럼 받을지.
7. **연결 시점**: 방송 시작·종료에 맞춰 자동 연결·해제할지, 관리자가 수동으로만 연결할지.
8. **수치 제안값**: 채팅 길이 상한, 오래된 채팅 기준(초), 시청자별 최소 간격(초), 백오프 시작·최대·포기 횟수, 미리 갱신 시점.
9. **수동 입력 병행**: 치지직 연결 중에도 `/api/chat`(방송 화면 입력창, `chat.html`)을 열어 둘지. 열어 두면 로컬 닉네임과 치지직 시청자가 같은 큐를 공유한다.
10. **의존성**: 구버전 `socket.io-client@2.x`를 들이는 것을 받아들일지(ADR-004·005의 최소 의존 원칙과 충돌).
11. **후원·구독 이벤트**: 2차 범위로 둘지, 범위에서 뺄지.

---

## 9. 출처

이 문서를 쓰며 실제로 열어 본 주소만 적는다. 열람일 2026-10-12.

공식 문서

- https://chzzk.gitbook.io/chzzk (문서 첫 화면)
- https://chzzk.gitbook.io/chzzk/llms.txt (문서 목차)
- https://chzzk.gitbook.io/chzzk/introduction/about.md
- https://chzzk.gitbook.io/chzzk/introduction/updates.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/authorization.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/tips.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/session.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/user.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/chat.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/channel.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/live.md
- https://chzzk.gitbook.io/chzzk/chzzk-api/restriction.md
- https://chzzk.gitbook.io/chzzk/drops/guide.md (애플리케이션 등록 위치 확인용)
- https://developers.chzzk.naver.com/ (개발자 센터 첫 화면)
- https://developers.chzzk.naver.com/termsDetail (치지직 개발자 센터 이용약관, 2024-12-19 시행)

참고하지 않은 것: 검색 결과에 나온 비공식 SDK(파이썬·자바·Go·Rust·npm 패키지)의 설명은 근거로 쓰지 않았다.

저장소

- `apps/server/src/index.ts`, `apps/server/src/secret-store.ts`, `packages/shared/src/index.ts`, `packages/memory/src/access.ts`, `packages/memory/src/extract.ts`, `tools/test/security.mjs`
- [decisions.md](./decisions.md) ADR-004·005·009·011·013·015·016, [architecture-v2.md](./architecture-v2.md), [implementation-plan.md](./implementation-plan.md) 12단계
