# 아키텍처

이터널리턴 메타 대시보드와 Live2D 진행자 "보리"의 구조 문서다. 설계 결정의 배경과 트레이드오프는 [decisions.md](./decisions.md)에, 이번 구조의 설계는 [superpowers/specs/2026-11-21-er-meta-dashboard-design.md](./superpowers/specs/2026-11-21-er-meta-dashboard-design.md)에 있다.

> 2026-11-21 치지직 방송 시스템과 1:1 대화(대화 엔진·장기 기억)를 지우면서 이 문서를 새로 썼다(ADR-028). 방송 큐·세션 세대·발화권·3단 폴백·기억 검색을 다룬 예전 문서는 git 기록(이 문서의 이전 판)과 [architecture-v2.md](./architecture-v2.md)에 남아 있다.
> 대시보드 상태·자동 갱신·보리 읽어 주기·닉네임 저장은 서버(`apps/server/src/index.ts`, `http/dashboard-routes.ts`)에 이어져 있다(2026-11-21 마무리 연결). 실제 키와 Live2D가 뜬 실제 화면으로는 아직 확인하지 않았다.

---

## 1. 전체 구조

npm workspaces 모노레포다. 애플리케이션 3개, 패키지 5개, 도구 2개로 이루어진다.

| 디렉터리 | 소유하는 것 | 스택 |
|---|---|---|
| `apps/server` | REST API, 설정·키·사용량 파일, 이터널리턴 집계 저장·비교(`er/`), 보리 읽어 주기(`narration/`), 빌드한 화면 서빙 | TypeScript + `node:http` |
| `apps/companion` | 이터널리턴 메타 대시보드 화면과 보리 Live2D(서버 경로 `/companion/`) | React 19 + Vite 6 + Cubism SDK |
| `apps/admin` | 보리 스튜디오: 대시보드 탭(위 화면 iframe)과 설정 탭 | Electron 44 + React 19 |
| `packages/shared` | 프로세스 경계를 넘는 타입(대시보드·ER·LLM·TTS·사용량) | TypeScript (런타임 코드 없음) |
| `packages/er` | 이터널리턴 Open API 클라이언트(초당 1회), 사전, 조합 집계, 전적 | TypeScript + `fetch` |
| `packages/llm` | LLM 어댑터(구조화 출력), 회로 차단 클라이언트, TTS | TypeScript + `fetch` |
| `packages/character` | 보리 이름·자기 설정·말투 문장 | TypeScript (순수 데이터) |
| `packages/live2d` | 표정·모션 allowlist, 감정 이름과 설명, 감정 → 표정 매핑 | TypeScript (순수 데이터) |
| `tools/test` | 가짜 OpenAI·가짜 ER 서버에 실제 서버를 붙이는 통합 검사 | Node ESM |
| `tools/vite` | 비공개 Live2D 자산 서빙·복사 Vite 플러그인 | TypeScript |

### 의존 방향

워크스페이스 사이의 컴파일타임 의존이다. 2026-11-21에 `package.json` 선언과 소스의 `import`를 대조했다. 선언만 있고 import가 아직 없는 것은 `apps/server` → `character` 하나다.

| 워크스페이스 | 의존하는 패키지 |
|---|---|
| `apps/server` | `shared`, `er`, `llm`, `live2d`(감정 이름·설명), `character`(선언. 보리 대사 지시문이 프로필·말투 문장을 쓰도록 잇는 작업이 진행 중이다) |
| `apps/companion` | `shared`(대시보드 타입), `live2d`(감정 → 표정·모션) |
| `apps/admin` | `shared` |
| `packages/er`, `packages/llm` | `shared` |
| `packages/shared`, `packages/character`, `packages/live2d` | 없음 |

실행할 때의 연결은 다음과 같다.

```
 apps/admin (스튜디오) ──iframe /companion/──▶ apps/companion (대시보드 + Live2D)
        │ HTTP(설정·상태)                          │ HTTP(폴링·명령)       │ Cubism SDK for Web
        └───────────────▶ apps/server ◀────────────┘                       │ (private-assets/, 저장소 밖)
                   (er/ · narration/ · http/ · usage/)                     ▼
                          │ fetch                                     WebGL 캔버스
                          ▼
      이터널리턴 Open API · LLM(OpenAI·Anthropic) · TTS(Fish·ElevenLabs·OpenAI)
```

역방향 의존은 없다. 서버와 두 화면 사이는 HTTP뿐이다. 화면은 서버 코드를 import하지 않고 `packages/shared` 타입과, 대시보드의 경우 `packages/live2d`의 감정 매핑 함수만 쓴다.

`packages/*`는 빌드 산출물을 만들지 않는다. `main`이 `./src/index.ts`를 직접 가리키고, 소비하는 쪽(`tsx`, Vite)이 TypeScript 원본을 그대로 읽는다.

---

## 2. 데이터 흐름

### 갱신

```
POST /api/er/refresh (또는 GET /api/dashboard 때 자동 갱신 판정)
  → packages/er: 사전(l10n 캐릭터·무기·장비·특성 이름, 시즌) → 상위 랭커 → 랭커별 최근 랭크 경기 상세
  → 이번 시즌 랭크 경기만 (캐릭터, 무기) 조합별 원래 개수로 센다
  → apps/server/src/er/: data/er-snapshot.json에 사전·최신 메타를 한 파일로 원자 저장하고, data/er-history/(최근 10개)에 비교용 기록을 남긴다
  → onRefreshed 알림 → 보리 읽어 주기
```

개인 키는 초당 1회라 기본 규모(랭커 100명 × 3판)는 몇 분 걸린다. 경기 하나·랭커 하나의 실패는 건너뛴다. 갱신이 실패하면 지난 파일을 그대로 두고 마지막 오류만 남긴다.

### 대시보드 상태

`createDashboardData`(`apps/server/src/er/dashboard-state.ts`)가 최신·직전 집계, 설정 파일의 게임 닉네임, 전적 조회 결과로 `DashboardState`(`packages/shared`)를 만든다. 비율·평균은 원래 개수에서 서버가 계산하고, 직전 갱신과 조합 키(캐릭터 코드 + 무기 코드)로 비교해 변화량과 `patchChanged`를 붙인다. 직전·이번 중 하나라도 표본이 적은(참가자 30명 미만) 조합은 변화량을 붙이지 않는다. 대시보드는 `GET /api/dashboard`를 갱신 중 2초, 평소 30초마다 폴링한다.

### 보리 읽어 주기

`createNarrator`(`apps/server/src/narration/`)의 순서다.

1. **사실 목록**(정해진 규칙): 메타 TOP 3, 크게 오른 조합 2개, 크게 내린 조합 1개, 새로 TOP 10에 든 조합, 내 주캐릭터의 메타 위치, 패치 바뀜. 사실마다 화면과 같은 반올림의 숫자 문자열을 둔다. 표본 적은 조합은 넣지 않는다.
2. **사실 선택과 문장 조립**: 수치·캐릭터·무기 이름이 들어간 문장은 서버가 사실 목록에서 직접 만든다. LLM은 어떤 사실을 말할지와 수치·이름 없는 짧은 감상 한마디만 고른다. 감상에는 숫자·한글 수·이름·영문·효과/빌드/패치류 낱말을 금지하지만, 감상 내용의 정확성은 보장하지 않는다. LLM을 못 쓰거나 유효한 선택이 없으면 정해진 문장을 읽는다.
3. **검사와 대체**: 허용된 사실 선택과 감상 한마디 규칙을 검사한다. 유효한 선택이 없거나 LLM이 꺼짐·실패면 서버의 정해진 문장을 쓴다. 감상의 의미 전체를 검증하는 장치는 아니다.
4. **음성**: 서버의 `prepareAudio`(TTS 캐시) → 줄마다 `audioId`. 실패한 줄은 자막만.
5. `data/narration.json`에 원자적으로 저장. 대시보드는 새 `narration.id`를 한 번 자동으로 읽고, 줄마다 감정을 Live2D 표정으로 보낸다.

---

## 3. LLM 호출 경계

- 어댑터는 `LlmRequest`(`overrideSystemPrompt`·`overrideUserPrompt`·`overrideSchema`·`timeoutMs`·`maxOutputTokens?`)만 받는다. 같은 스키마를 OpenAI는 `response_format.json_schema(strict)`로, Anthropic은 강제 도구 호출로 감싼다.
- `createLlmClient().complete<T>(settings, apiKey, request, parse)`가 꺼짐·키·회로를 먼저 보고, 업체를 한 번 부른 뒤 `parse`로 값을 만든다. `parse`가 거부하거나 던지면 검증 실패다. 호출 실패와 검증 실패가 연속 `failureThreshold`번이면 `cooldownSeconds` 동안 부르지 않는다. 429는 연속 실패로 세지 않는다.
- 구조화 출력은 형식만 보장한다. 값(숫자·이름·감정)의 유효성은 narration의 검사와 `packages/live2d` allowlist가 정한다.
- 업체를 부를 때마다 사용량에 `mode: "narration"`으로 숫자만 기록한다(대사 내용 없음).

---

## 4. 보안 경계

```
┌─ 신뢰 ─────────────────────────────────────────────┐
│  apps/server 프로세스                               │
│  · API 키 평문(메모리), data/ 아래 암호화된 설정      │
│  · 게임 닉네임(설정 파일)                            │
└──────────┬─────────────────────────────────────────┘
           │ 나가는 것: hasApiKey 불리언, 대시보드 상태, mp3
           │ 나가지 않는 것: API 키. 닉네임은 화면에만, 로그·LLM에는 넣지 않는다
┌──────────┴─────────┐   ┌─ 비신뢰 ────────────────────────────┐
│ apps/companion     │   │ LLM 응답 · ER API 응답 · HTTP 요청 본문 │
│ apps/admin         │   └────────────────────────────────────┘
└────────────────────┘
```

- **요청 경계**(`apps/server/src/http/guard.ts`): 모든 요청이 라우트 전에 Host(루프백만, 421)·Origin(허용 목록만, 403)·Content-Type(JSON만, 415)·본문 크기(64KB, 413)·경로 인코딩(400) 검사를 거친다.
- **화면 iframe 제한**(`apps/server/src/http/static.ts`): 서버가 내주는 화면(`/studio/`·`/companion/`·`/private-*`)에 `Content-Security-Policy: frame-ancestors 'self'`·`X-Frame-Options: SAMEORIGIN`·`X-Content-Type-Options: nosniff`를 붙인다. 다른 웹사이트가 API 키 화면을 투명 iframe으로 덮어 버튼을 누르게 하는 것(클릭재킹)을 막고, 스튜디오 → `/companion/` iframe은 같은 출처라 그대로 된다.
- **키 저장**(`secret-store.ts`): 화면에서 넣은 키만 AES-256-GCM으로 암호화해 `data/`에 쓴다. 환경변수 키는 파일에 쓰지 않는다. 키 파생 재료인 사용자 이름·컴퓨터 이름을 알면 다른 머신에서도 복호화할 수 있다. 설정 파일 유출을 방어하는 비밀 키 저장소가 아니며 Windows DPAPI/Electron safeStorage 이전이 후속 과제다.
- **파일 쓰기**(`atomic-file.ts`, `config-file.ts`): 임시 파일에 쓰고 fsync 뒤 rename한다. 깨진 파일은 `*.unreadable-<시각>.json`으로 원본을 남기고 기본값으로 시작하며, 있는데 읽지 못한 파일은 덮어쓰지 않는다. 30일 지난 백업은 시작할 때 지운다(`retention.ts`).
- **사용자 인증이 없다.** 로컬 단일 사용자를 가정한다.

---

## 5. 비공개 자산 처리

구매한 상용 Live2D 모델과 Cubism SDK는 재배포가 금지되어 저장소 밖에 둔다. `tools/vite/private-assets.ts`가 dev에서는 미들웨어로 `/private-model/`·`/private-core/`·`/private-framework/`를 서빙하고(상위 경로 탈출 차단, Core는 `live2dcubismcore.js`·`LICENSE.md`만), 빌드 때는 같은 URL 구조로 `apps/companion/dist`에 복사한다. 서버는 그 경로를 `apps/companion/dist`에서 그대로 내준다(`apps/server/src/http/static-routes.ts`). 자산이 없으면 대시보드 빌드는 번들을 만들기 전에 없는 폴더를 알려 주고 멈춘다.

---

## 6. 상태 동기화

WebSocket 없이 폴링한다. 화면이 서버 상태를 주기적으로 받고, 서버가 바뀐 값을 그대로 돌려준다. 이벤트 순서·재연결을 다룰 필요가 없고, 서버를 다시 띄워도 화면이 다음 폴링에서 따라온다. 대가는 갱신이 폴링 간격만큼 늦게 보이는 것이다. 스튜디오 설정 탭은 LLM과 이터널리턴 상태(`GET /api/dashboard/status`: 연결·갱신·기준만, 자동 갱신 판정과 조합 계산 없음)를 3초, 사용량·음성 설정을 30초마다 받는다.


### 2026-11-21 데이터 안정성 보강 (PR #57)

사전과 메타는 `data/er-snapshot.json` 한 파일로 원자 저장하므로 저장 실패 시 서로 다른 세대가 섞이지 않는다. 스냅샷이 없을 때만 예전 `er-dictionary.json`·`er-meta.json`을 읽고 다음 정상 갱신부터 스냅샷을 쓴다. 필수 집계 행·참가자 합계 등이 손상되면 전체 집계를 무효로 보고, 비교용 history는 손상된 항목을 건너뛰어 더 오래된 정상 기록을 직전으로 쓴다. history 저장 실패는 이미 커밋한 최신 스냅샷을 되돌리지 않는다.

ER 요청은 헤더부터 본문 소비까지 기본 15초 상한을 적용하며, 시간 초과 후에도 공유 요청 큐가 다음 작업을 처리한다.
