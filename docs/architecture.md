# 아키텍처

이터널리턴 메타 대시보드와 Live2D 진행자 "보리"의 구조 문서다. 설계 결정의 배경과 트레이드오프는 [decisions.md](./decisions.md)에, 이번 구조의 설계는 [superpowers/specs/2026-11-21-er-meta-dashboard-design.md](./superpowers/specs/2026-11-21-er-meta-dashboard-design.md)에 있다.

> 2026-11-21 치지직 방송 시스템과 1:1 대화(대화 엔진·장기 기억)를 지우면서 이 문서를 새로 썼다(ADR-028). 방송 큐·세션 세대·발화권·3단 폴백·기억 검색을 다룬 예전 문서는 git 기록(이 문서의 이전 판)과 [architecture-v2.md](./architecture-v2.md)에 남아 있다.
> 아래에서 **(구현 중)**으로 표시한 연결은 모듈은 있지만 서버(`apps/server/src/index.ts`)에 아직 이어지지 않은 것이다.

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

```
                         packages/shared (타입만)
                                ▲
     ┌──────────────┬───────────┼─────────────┬──────────────┐
 packages/er   packages/llm  packages/character  packages/live2d
     ▲              ▲              ▲              ▲      ▲
     └──────────────┴──────┬───────┴──────────────┘      │
                     apps/server                         │
               (er/ · narration/ · http/ · usage/)       │
                           │ HTTP (폴링·명령)              │
              ┌────────────┴────────────┐                │
        apps/companion             apps/admin ───────────┘
     (대시보드 + Live2D) ─────────────────────────────────┘
              │ Cubism SDK for Web (private-assets/, 저장소 밖)
              ▼
          WebGL 캔버스
```

화살표는 컴파일타임 의존이다. 역방향 의존은 없다. 서버와 두 화면 사이는 HTTP뿐이고, 화면 쪽은 `packages/shared` 타입이나 자체 타입만 쓴다.

`packages/*`는 빌드 산출물을 만들지 않는다. `main`이 `./src/index.ts`를 직접 가리키고, 소비하는 쪽(`tsx`, Vite)이 TypeScript 원본을 그대로 읽는다.

---

## 2. 데이터 흐름

### 갱신

```
POST /api/er/refresh (또는 대시보드를 열 때 자동 갱신 판정 — 구현 중)
  → packages/er: 사전(l10n 캐릭터·무기·장비·특성 이름, 시즌) → 상위 랭커 → 랭커별 최근 랭크 경기 상세
  → 이번 시즌 랭크 경기만 (캐릭터, 무기) 조합별 원래 개수로 센다
  → apps/server/src/er/: data/er-meta.json(최신), data/er-history/(최근 10개)에 원자적으로 쓴다
  → onRefreshed 알림 (→ 보리 읽어 주기 — 구현 중)
```

개인 키는 초당 1회라 기본 규모(랭커 100명 × 3판)는 몇 분 걸린다. 경기 하나·랭커 하나의 실패는 건너뛴다. 갱신이 실패하면 지난 파일을 그대로 두고 마지막 오류만 남긴다.

### 대시보드 상태 (구현 중)

`createDashboardData`(`apps/server/src/er/dashboard-state.ts`)가 최신·직전 집계, 설정 파일의 게임 닉네임, 전적 조회 결과로 `DashboardState`(`packages/shared`)를 만든다. 비율·평균은 원래 개수에서 서버가 계산하고, 직전 갱신과 조합 키(캐릭터 코드 + 무기 코드)로 비교해 변화량과 `patchChanged`를 붙인다. 대시보드는 `GET /api/dashboard`를 갱신 중 2초, 평소 30초마다 폴링한다.

### 보리 읽어 주기 (구현 중)

`createNarrator`(`apps/server/src/narration/`)의 순서다.

1. **사실 목록**(정해진 규칙): 메타 TOP 3, 크게 오른 조합 2개, 크게 내린 조합 1개, 새로 TOP 10에 든 조합, 내 주캐릭터의 메타 위치, 패치 바뀜. 사실마다 화면과 같은 반올림의 숫자 문자열을 둔다. 표본 적은 조합은 넣지 않는다.
2. **대사 생성**: `packages/llm` 구조화 출력으로 `{ lines: [{ text, emotion, factIds }] }` 3~5줄.
3. **검사**: 줄의 숫자가 `factIds` 사실들의 숫자에 모두 있어야 하고, 캐릭터 이름은 사전에 있는 것만. 아니면 그 줄을 버린다. 남는 줄이 없거나 LLM이 꺼짐·실패면 정해진 문장 3줄.
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
- **키 저장**(`secret-store.ts`): 화면에서 넣은 키만 AES-256-GCM으로 암호화해 `data/`에 쓴다. 환경변수 키는 파일에 쓰지 않는다. 같은 머신에서 코드를 실행할 수 있는 주체는 복호화도 할 수 있다는 한계가 있다.
- **파일 쓰기**(`atomic-file.ts`, `config-file.ts`): 임시 파일에 쓰고 fsync 뒤 rename한다. 깨진 파일은 `*.unreadable-<시각>.json`으로 원본을 남기고 기본값으로 시작하며, 있는데 읽지 못한 파일은 덮어쓰지 않는다. 30일 지난 백업은 시작할 때 지운다(`retention.ts`).
- **사용자 인증이 없다.** 로컬 단일 사용자를 가정한다.

---

## 5. 비공개 자산 처리

구매한 상용 Live2D 모델과 Cubism SDK는 재배포가 금지되어 저장소 밖에 둔다. `tools/vite/private-assets.ts`가 dev에서는 미들웨어로 `/private-model/`·`/private-core/`·`/private-framework/`를 서빙하고(상위 경로 탈출 차단, Core는 `live2dcubismcore.js`·`LICENSE.md`만), 빌드 때는 같은 URL 구조로 `apps/companion/dist`에 복사한다. 서버는 그 경로를 `apps/companion/dist`에서 그대로 내준다(`apps/server/src/http/static-routes.ts`). 자산이 없으면 대시보드 빌드는 번들을 만들기 전에 없는 폴더를 알려 주고 멈춘다.

---

## 6. 상태 동기화

WebSocket 없이 폴링한다. 화면이 서버 상태를 주기적으로 받고, 서버가 바뀐 값을 그대로 돌려준다. 이벤트 순서·재연결을 다룰 필요가 없고, 서버를 다시 띄워도 화면이 다음 폴링에서 따라온다. 대가는 갱신이 폴링 간격만큼 늦게 보이는 것이다. 스튜디오 설정 탭은 LLM·이터널리턴 상태를 3초, 사용량·음성 설정을 30초마다 받는다.
