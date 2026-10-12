# 보리 (Bori) — 로컬 실행형 AI 버추얼 스트리머

Live2D 캐릭터가 시청자 채팅에 LLM으로 답하고, 음성·표정·모션·시선·립싱크로 반응하며, OBS로 송출되는 방송 시스템이다.

## 개요

보리는 한 대의 로컬 머신에서 전부 돌아가는 AI 버추얼 스트리머다. 서버, 방송 화면, 관리자 앱이 모두 `127.0.0.1`에서 동작하며 외부 호스팅이나 클라우드 인프라를 쓰지 않는다. 시청자 채팅이 들어오면 위험 주제 차단 → 규칙 응답 → LLM 응답 → 폴백 문장의 3단 파이프라인을 거쳐 답변을 만들고, TTS로 음성을 합성한 뒤 Live2D 모델의 표정·모션·립싱크를 함께 실행한다. 방송 화면은 브라우저 페이지이므로 OBS Browser Source로 그대로 송출된다.

개인 프로젝트다. 기간은 2026.06부터 진행 중이며, 전체 소스는 약 3,259줄의 npm workspaces 모노레포다.

## 실행 전 반드시 알아둘 것

**이 저장소를 clone해도 그대로 실행되지 않는다.** 방송 화면이 렌더링하는 Live2D 모델은 구매한 상용 모델이고, 렌더링 런타임은 Live2D Cubism SDK for Web이다. 둘 다 재배포가 금지되어 있어 저장소에서 제외했다. 두 자산이 없으면 API 서버와 관리자 앱은 뜨지만 방송 화면의 캐릭터는 표시되지 않는다.

동작시키려면 다음 두 가지를 clone한 디렉터리 안에 직접 배치한다.

| 필요한 것 | 배치 위치 | 비고 |
|---|---|---|
| Cubism SDK for Web 5-r.5 | `private-assets/cubism-sdk/CubismSdkForWeb-5-r.5/` | Live2D 공식 배포본을 내려받아 압축 해제한다 |
| 구매한 상용 Live2D 모델 | 저장소 루트의 모델 디렉터리 | `.model3.json`, `.moc3`, 텍스처, `biaoqing/` 표정 파일이 포함된 원본 구조 그대로 둔다 |

모델 디렉터리 이름은 세 곳에서 참조된다. 다른 모델을 쓰거나 디렉터리 이름이 다르면 아래 세 지점을 실제 이름에 맞춘다.

- `apps/broadcast/vite.config.ts` — `privateModelRoot`, `assetRoutes`의 `/private-model/...` 접두사
- `packages/live2d/src/index.ts` — 모델·표정·모션 파일 경로
- `<Cubism SDK 샘플>/src/lappdefine.ts` — `ResourcesPath`와 모델 디렉터리 목록

표정·모션 식별자와 파라미터 번호는 `packages/live2d`에 allowlist로 하드코딩되어 있다. 다른 모델을 붙이려면 이 매핑을 교체해야 한다.

## 주요 기능

- **시청자 채팅에 캐릭터가 직접 답한다.** 채팅이 들어오면 5~10초 사이 랜덤 지연 후 답변하며, 질문 채팅을 우선 고른다. 지연을 기다리는 동안 LLM과 TTS를 미리 돌려 두므로 생성 시간이 지연에 더해지지 않는다. 같은 문장이 반복되면 정해진 시간 안에서 중복으로 걸러진다.
- **말하면서 표정과 모션이 바뀐다.** LLM이 답변과 함께 감정·모션을 고르고, 화이트리스트를 통과한 것만 화면에서 실행된다.
- **목소리가 나온다.** 답변 문장을 TTS로 합성해 재생하고, 음성 파형에 맞춰 입이 움직인다.
- **시선이 살아 있다.** 평소에는 1.1~3.2초마다 주위를 둘러보고, 새 채팅이 들어오면 60% 확률로 그쪽을 쳐다본다.
- **시청자를 기억한다.** 대화에서 취향·경험을 뽑아 장기 기억으로 저장하고, 이후 관련 질문이 오면 그 기억을 참고해 답한다. 보관 기간이 지나면 자동으로 만료된다.
- **긴 방송에서도 앞 이야기를 놓치지 않는다.** 보리가 그대로 기억하는 것은 최근 채팅 5건뿐이다. 그 앞의 흐름은 일정 턴마다 한 문단으로 접어 문맥에 계속 넣는다. 방송이 길어져도 문맥 길이는 늘지 않는다.
- **고유명사는 키워드로 바로 붙인다.** 게임 이름이나 캐릭터명처럼 철자가 정해진 대상은 `data/macros.json`에 적어 두면 채팅에 나오는 즉시 설명이 문맥에 들어간다. 임베딩 검색을 거치지 않아 정확하고 빠르다. 예시는 [docs/macros.example.json](docs/macros.example.json)에 있다.
- **휴대폰으로 채팅을 넣을 수 있다.** 별도 채팅 화면(`chat.html`)을 다른 창이나 휴대폰에서 열어 시청자 입장으로 채팅한다.
- **관리자 앱에서 방송을 통제한다.** 세션 시작·종료, LLM/TTS/기억 설정, 표정·모션 즉시 테스트, LLM 호출 통계와 실패 내역을 한 화면에서 다룬다.
- **OBS 설정이 자동화되어 있다.** 스크립트 한 번으로 씬·브라우저 소스 생성, 캔버스 1920x1080 설정, 트랜스폼 초기화까지 끝난다.

## 기술적 특징

상세한 설계 근거와 코드 위치는 [docs/architecture.md](docs/architecture.md)에 있다.

**세션 세대 기반 비동기 경합 제어**
LLM(8초)과 TTS(15초)는 비동기라 응답이 도착하기 전에 방송이 종료되거나 재시작될 수 있다. `status` 값만으로는 "종료 후 재시작"을 구분할 수 없으므로, 호출 시점의 `sessionGeneration` 정수를 캡처해 두고 콜백에서 세대가 다르면 결과를 폐기한다. 발화권 뮤텍스와 조합해 답변과 혼잣말이 겹치지 않도록 보장한다.

**사람처럼 보이려는 대기와 실제 생성을 겹친다**
답변 전 5~10초 랜덤 지연은 연출이지 계산 시간이 아니다. 예전에는 이 타이머가 끝난 뒤에야 LLM과 TTS를 불러 둘이 그대로 더해졌고, 체감 지연이 10초를 넘겼다. 지금은 채팅을 미리 고르고 대기와 생성을 나란히 돌린 뒤 `Promise.all`로 합류한다. 걸리는 시간은 둘 중 늦은 쪽뿐이다. 가짜 API를 붙여 잰 값으로 9.8초가 6.0초가 됐고, 생성이 대기보다 빠른 한 지연은 0이 된다. 대신 대기 중에 들어온 채팅이 이번 차례의 후보에서 빠지는 것이 이 구조의 비용이다.

**3단 폴백 응답 파이프라인 + 회로 차단기**
규칙 → LLM → 폴백의 3단 구조에서 "질문은 LLM이 더 잘하므로 규칙이 양보", "위험 주제는 LLM 호출 전에 차단", "기억 질문은 규칙을 건너뛰고 LLM으로"를 각각 다른 분기로 처리한다. LLM이 연속 실패하면 회로를 열어 호출을 끊고, 방송은 폴백 문장으로 끊김 없이 이어진다. 실패는 관리자 화면에만 노출된다.

**오디오 파형 실시간 립싱크와 SDK 내부 파이프라인 개입**
`AnalyserNode`로 RMS를 계산해 입 벌림에 매핑하고 지수 평활로 떨림을 제거한다. 파라미터를 그냥 설정하면 SDK의 UpdateScheduler가 덮어쓰므로, `onLateUpdate` 직후이자 `_model.update()` 직전이라는 정확한 지점에 주입 코드를 삽입했다. SDK 실행 순서를 파악해야 가능한 수정이다.

**LLM 출력 화이트리스트 검증과 프로바이더 무관 구조화 출력**
동일한 JSON Schema 하나를 OpenAI는 `response_format.json_schema(strict)`로, Anthropic은 `tool_choice` 강제 도구 호출로 감싼다. 어댑터가 달라도 검증 코드는 하나다. 모델이 무엇을 반환하든 감정·모션 이름은 `packages/live2d`가 소유한 allowlist를 통과해야만 실행되고, 실패하면 규칙 문장이 나간다. 서버는 같은 allowlist를 API 경계에서도 강제한다.

**Vite 커스텀 플러그인으로 라이선스 문제를 빌드 파이프라인에서 해결**
구매 모델과 Cubism SDK를 저장소 밖에 두고, dev에서는 미들웨어로 URL 서빙하며(상위 경로 탈출 요청 차단 포함), 빌드 시에는 `closeBundle`에서 동일한 URL 구조로 복사한다. Cubism Core는 재배포가 허용된 파일만 화이트리스트로 내보낸다.

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 서버 | TypeScript, Node 내장 `node:http`, `tsx` |
| 방송 화면 | React 19, Vite 6, WebGL(Cubism SDK), WebAudio |
| 관리자 앱 | Electron 34 + React 19 |
| LLM | OpenAI Chat Completions(Structured Outputs), Anthropic Messages API — 모두 `fetch` 직접 호출 |
| TTS | OpenAI `/audio/speech`, ElevenLabs `/text-to-speech` — mp3로 통일 |
| 장기 기억 | JSON 파일 저장 + 코사인 유사도 직접 구현, OpenAI 임베딩 1536차원 |
| 송출 연동 | OBS WebSocket v5 클라이언트 직접 구현 (`.mjs`, 의존성 0) |
| 패키지 관리 | npm workspaces 모노레포 |

**외부 런타임 의존성이 사실상 없다.** Express도 `ws`도 Prisma도 벡터DB도 LLM SDK도 쓰지 않는다. 서버는 `node:http`의 `createServer` 하나에 if 체인 수동 라우팅이고, 모든 외부 API 호출은 Node 내장 `fetch`와 `AbortController`다. OBS WebSocket v5의 salt/challenge SHA256 인증 핸드셰이크도 직접 구현했다. `devDependencies`를 제외하면 런타임에 설치되는 서드파티 코드는 React와 Electron뿐이다.

## 저장소 구조

```
.
├── apps/
│   ├── server/          상태머신 + REST API (node:http 직접 사용)
│   ├── broadcast/       방송 송출 화면 + 시청자 채팅 화면 (React 19, Vite 6)
│   └── admin/           Electron 관리자 앱
├── packages/
│   ├── shared/          공용 타입 전용 (런타임 코드 없음)
│   ├── llm/             LLM 어댑터·출력 검증·방송 요약·TTS
│   ├── memory/          장기 기억 저장·검색
│   └── live2d/          모델 카탈로그·감정 매핑 (순수 데이터)
├── tools/
│   ├── obs/             OBS WebSocket v5 자동 설정 스크립트
│   └── test/            통합 검사 (가짜 API에 실제 서버를 붙여 실행)
├── docs/                설계·운영·진행 문서
└── .env.example
```

`packages/*`는 빌드 산출물 없이 `main: "./src/index.ts"`로 TypeScript 원본을 직접 참조한다. `packages/shared`의 `build` 스크립트가 실제로는 `tsc --noEmit`인 것도 이 구조에서 의도된 것이다.

다음 디렉터리는 저장소에 포함되지 않는다.

| 디렉터리 | 제외 이유 |
|---|---|
| 구매 모델 디렉터리 | 구매한 상용 Live2D 모델. 재배포 금지 |
| `private-assets/cubism-sdk/` | Live2D Proprietary Software License. 재배포가 허용된 파일은 `live2dcubismcore.{d.ts,js,min.js}` 3개뿐이다 |
| `data/` | 기억 JSON, 암호화된 API 키를 포함한 LLM/TTS 설정, 렌더러 로그 |
| `_local/` | 공개하지 않는 사전 조사 자료 |

## 설치와 실행

Node 20 이상과 npm이 필요하다.

```bash
npm install
npm run dev
```

`npm run dev`는 API 서버, 방송 화면 dev 서버, 관리자 Electron 앱을 동시에 띄운다. 개별 실행은 다음과 같다.

```bash
npm run dev:server      # API 서버 (127.0.0.1:4310)
npm run dev:broadcast   # 방송 화면 (127.0.0.1:4173)
npm run dev:admin       # 관리자 Electron 앱 (렌더러 127.0.0.1:5174)
```

타입 검사, 통합 검사, 빌드는 다음과 같다.

```bash
npm run typecheck
npm run test
npm run build
```

`npm run test`는 실제 서버를 가짜 OpenAI API에 붙여 띄우고 방송을 짧게 돌려 32건을 확인한다. API 키도 요금도 필요 없고, `data/`도 건드리지 않는다. 답변 대기와 생성이 겹치는지, 세션을 다시 시작했을 때 이전 타이머가 새 답변을 건드리지 않는지처럼 시간 위에서 맞물리는 동작이 대상이다. 자세한 내용은 [tools/test/README.md](tools/test/README.md)에 있다.

루트 `typecheck`는 `shared`, `server`, `broadcast`, `admin` 4개만 실행한다. `live2d`, `llm`, `memory`는 개별 스크립트로 검사한다.

```bash
npm run typecheck:live2d
npm run typecheck:llm
npm run typecheck:memory
```

빌드 산출물로 방송 화면을 확인하려면 다음과 같이 실행한다.

```bash
npm run build:broadcast
npm --workspace apps/broadcast run preview   # 127.0.0.1:4174
```

`dist/`에는 구매 모델과 SDK가 복사되므로 외부에 배포하지 않는다. `.gitignore`에 등록되어 있다.

API 키는 관리자 앱 화면에서 입력하는 것을 권장한다. 화면으로 입력한 키는 AES-256-GCM으로 암호화되어 `data/` 아래에 저장된다. 환경변수로 넣으려면 `.env.example`을 `.env`로 복사해 값을 채운다. 환경변수는 저장된 키가 없을 때만 사용된다.

실제 운영 절차 — 포트, LLM·TTS·기억 설정, OBS 송출, 튜닝 파라미터 — 는 [docs/operations.md](docs/operations.md)에 정리되어 있다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 시스템 구조, 데이터 흐름, 설계 근거 |
| [docs/operations.md](docs/operations.md) | 실행·설정·송출·튜닝 파라미터 레퍼런스 |
| [docs/requirements.md](docs/requirements.md) | 기능 요구사항 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 구현 계획 |
| [docs/decisions.md](docs/decisions.md) | 설계 결정 기록 |
| [docs/progress.md](docs/progress.md) | 진행 상황, 완료 범위, 남은 작업 |
| [docs/verification-log.md](docs/verification-log.md) | 수동 검증 기록 |
| [tools/test/README.md](tools/test/README.md) | 통합 검사 구조와 실행 방법 |

## 현재 상태와 한계

MVP 범위에서 동작하는 상태이며 다음 한계가 있다.

- **치지직 실연동이 없다.** 방송 플랫폼 연동 코드는 존재하지 않으며 MVP 범위 밖이다. 채팅 입력 경로는 관리자 앱, 방송 화면 입력창, 별도 채팅 화면 3가지다.
- **자동화 테스트가 없다.** 테스트 파일과 CI 설정이 없고 검증 기록은 전부 수동 검증이다.
- **Electron 방송 창을 지원하지 않는다.** 방송 화면은 브라우저 전용이며 OBS Browser Source로 송출한다.
- **Anthropic 어댑터는 미검증이다.** OpenAI는 실 API 환경에서 검증했다.
- **기억 검색에 시청자 필터가 없다.** 저장은 시청자 식별자별로 되지만 검색은 전체를 대상으로 한다.
- **30분 이상 장시간 송출 안정성이 검증되지 않았다.**

전체 한계 목록과 남은 작업 우선순위는 [docs/progress.md](docs/progress.md)에 있다.

## 라이선스

이 저장소의 코드는 MIT License를 따른다.

다만 다음 자산은 저장소에 포함되지 않으며 각자의 라이선스를 따른다.

- **구매한 상용 Live2D 모델** — 판매처의 이용 약관을 따르며 재배포가 금지된다. 사용하려면 직접 구매해야 한다.
- **Live2D Cubism SDK for Web** — Live2D Proprietary Software License를 따른다. Live2D 공식 사이트에서 직접 내려받아야 하며, 재배포가 허용된 파일은 `live2dcubismcore` 관련 3개뿐이다.
