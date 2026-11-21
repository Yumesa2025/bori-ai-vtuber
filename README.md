# 보리 (Bori) — 이터널리턴 메타 대시보드와 Live2D 진행자

이터널리턴 Open API로 상위 랭커 경기를 모아 캐릭터·무기 조합의 메타를 대시보드로 보여 주고, 옆에 있는 Live2D 캐릭터 보리가 그 결과를 수치만 근거로 한 짧은 대사로 목소리를 내어 읽어 주는 로컬 앱이다.

> **방향 전환(2026-11-21).** 이 저장소는 원래 치지직 방송용 AI 버추얼 스트리머와 1:1 대화 앱이었다. 방송 시스템과 1:1 대화(대화 엔진·장기 기억 포함)는 모두 지웠고, 보리는 대화 상대가 아니라 "오늘의 메타 분석"을 알려 주는 진행자가 됐다. 경위와 이유는 [docs/decisions.md](docs/decisions.md)의 ADR-028, 지운 범위는 [docs/progress.md](docs/progress.md)에 있다. 예전 구조는 git 기록과 지난 문서에 남아 있다.

## 개요

서버, 대시보드 화면, 스튜디오(Electron) 앱이 모두 `127.0.0.1`에서 동작하며 외부 호스팅을 쓰지 않는다. 흐름은 다음과 같다.

1. 이터널리턴 Open API에서 상위 랭커의 최근 랭크 경기를 받아 (캐릭터, 무기) 조합별로 센다. 이번 시즌 랭크 경기만 센다.
2. 직전 갱신과 비교해 평균 순위·1등 비율·픽률·평균 MMR 증감의 변화량을 낸다.
3. 정해진 규칙으로 "사실 목록"(메타 TOP 3, 크게 오르고 내린 조합 등)을 만들고, LLM이 그 사실만 써서 3~5줄 대사를 쓴다. 대사의 숫자가 사실 목록에 없으면 그 줄을 버리고, 남는 줄이 없거나 LLM을 못 쓰면 정해진 문장을 읽는다.
4. 대사를 TTS로 합성하고, 대시보드의 보리가 줄마다 표정을 바꾸며 읽는다.

개인 프로젝트다. 기간은 2026.06부터 진행 중이며, npm workspaces 모노레포다. `apps`·`packages`의 TypeScript 소스는 테스트와 개발용 가짜 API를 빼고 약 7,300줄, 테스트를 넣으면 약 13,100줄이다(`git ls-files`로 센 `.ts/.tsx/.cjs`, 2026-11-21 기준).

## 지금 되는 것과 아직 확인하지 않은 것 (2026-11-21)

| 기능 | 상태 |
|---|---|
| 이터널리턴 조합 집계(이번 시즌 랭크, 경기 수·참가자 수 분리, 표본 적음 표시, 장비·특성 빈도) | 구현됨(`packages/er`, 단위 검사) |
| 갱신 기록(최근 10개)과 직전 갱신 비교, 패치 바뀜 표시 | 구현됨(`apps/server/src/er/`, 단위·통합 검사) |
| 자동 갱신 판정(데이터 없음·24시간 지남·시즌 바뀜, 하루 한 번) | 서버에 연결됨. 대시보드가 `GET /api/dashboard`를 부를 때 판정한다 |
| 대시보드 화면(메타 TOP 표·오르고 내린 조합·캐릭터 상세·내 전적·보리) | 구현됨. `GET /api/dashboard`를 폴링한다. 화면은 가짜 API로만 확인했다 |
| 보리가 읽어 주기(사실 목록 → LLM 대사 → 숫자 검사 → 정해진 문장 대체 → 음성) | 서버에 연결됨. 갱신이 끝나면 대사를 만들고, 다시 듣기는 `POST /api/narration/replay` |
| 내 전적(게임 닉네임 저장, MMR·최근 10판·주캐릭터의 메타 위치) | 서버에 연결됨(`GET/PUT /api/dashboard/settings`) |
| 스튜디오: 대시보드 / 설정 두 탭(LLM·음성·게임 닉네임·이터널리턴 데이터·사용량) | 구현됨 |
| 수동 갱신 `POST /api/er/refresh`, 갱신 상태·진행률은 `GET /api/dashboard` | 동작함 |
| LLM·음성(Fish·ElevenLabs·OpenAI) 설정과 키 암호화 저장, API 사용량·추정 비용 | 동작함 |

서버 연결은 가짜 이터널리턴·가짜 OpenAI 서버에 실제 서버를 붙이는 통합 검사(`tools/test/dashboard.mjs`)로 "대시보드 열기 → 자동 갱신 → 조합 → 대사 → 음성 id → 닉네임·전적 → 다시 듣기"까지 확인했다. 실제 키로 끝까지 돌린 확인과, Live2D가 뜬 실제 대시보드 화면 확인은 아직 하지 않았다.

## 실행 전 반드시 알아둘 것

**이 저장소를 clone해도 그대로 실행되지 않는다.** 대시보드의 보리는 구매한 상용 Live2D 모델이고, 렌더링 런타임은 Live2D Cubism SDK for Web이다. 둘 다 재배포가 금지되어 있어 저장소에서 제외했다. 두 자산이 없으면 API 서버와 스튜디오 설정 화면은 뜨지만 대시보드 화면은 빌드되지 않는다.

동작시키려면 다음 두 가지를 clone한 디렉터리 안에 직접 배치한다.

| 필요한 것 | 배치 위치 | 비고 |
|---|---|---|
| Cubism SDK for Web 5-r.5 | `private-assets/cubism-sdk/CubismSdkForWeb-5-r.5/` | Live2D 공식 배포본을 내려받아 압축 해제한다 |
| 구매한 상용 Live2D 모델 | 저장소 루트의 모델 디렉터리 | `.model3.json`, `.moc3`, 텍스처, 표정 파일이 포함된 원본 구조 그대로 둔다 |

모델 디렉터리 이름은 `tools/vite/private-assets.ts`의 `assetRoutesFor`와 Cubism SDK 샘플의 `lappdefine.ts`(`ResourcesPath`)에서 참조한다. 다른 모델을 쓰면 두 곳을 실제 이름에 맞춘다. 표정·모션 식별자와 감정 표는 `packages/live2d`에 allowlist로 들어 있다.

이터널리턴 데이터를 받으려면 이터널리턴 Open API 키가 필요하다(`.env`의 `ER_API_KEY`). 대사 생성(LLM)과 음성(TTS) 키는 없어도 되며, 없으면 대사는 정해진 문장으로, 음성 없이 자막만 나온다.

## 기술적 특징

**대사는 수치에서만 나온다.** LLM에게 넘기는 것은 화면과 같은 반올림으로 만든 사실 목록뿐이고, 받은 대사의 숫자(`\d+(\.\d+)?`)가 그 줄이 가리키는 사실의 숫자 안에 모두 있어야 한다. 캐릭터 이름도 사전에 있는 이름만 받는다. 걸리면 그 줄을 버리고, 다 버려지면 정해진 문장으로 읽는다. 무기 특성이나 빌드 효과를 지어내지 않게 하는 장치다.

**API 호출을 늘리지 않고 더 센다.** 원래 받던 경기 상세(1판 24행)에서 조합별 참가자·순위·1등·MMR 증감·킬·딜량·코어 특성·부위별 장비를 함께 센다. 개인 키는 초당 1회라 갱신 한 번(랭커 100명 × 3판)이 몇 분 걸리므로, 호출 수는 그대로 두고 한 번 받은 응답에서 최대한 꺼낸다.

**프로바이더 무관 구조화 출력과 회로 차단기.** 같은 JSON Schema 하나를 OpenAI는 `response_format.json_schema(strict)`로, Anthropic은 강제 도구 호출로 감싼다. `createLlmClient().complete<T>(settings, apiKey, request, parse)`가 꺼짐·키·회로를 먼저 보고, 업체 호출 실패나 `parse` 거부가 연속으로 쌓이면 잠시 부르지 않는다(429는 세지 않는다).

**오디오 파형 실시간 립싱크와 SDK 내부 파이프라인 개입.** `AnalyserNode`로 RMS를 계산해 입 벌림에 매핑하고 지수 평활로 떨림을 없앤다. 파라미터를 그냥 넣으면 SDK의 UpdateScheduler가 덮어쓰므로 `onLateUpdate` 직후, `_model.update()` 직전에 주입한다.

**Vite 플러그인으로 라이선스 문제를 빌드에서 해결.** 구매 모델과 Cubism SDK를 저장소 밖에 두고, dev에서는 미들웨어로 서빙하며(상위 경로 탈출 차단), 빌드 때는 같은 URL 구조로 `dist`에 복사한다. Cubism Core는 `live2dcubismcore.js`와 `LICENSE.md`만 내보낸다. 자산이 없으면 번들을 만들기 전에 없는 폴더를 알려 주고 멈춘다.

**로컬 API 보안 경계와 데이터 파일 안전 저장.** 모든 요청이 라우트에 닿기 전에 Host(루프백만, 421)·Origin(허용 목록만, 403)·Content-Type(JSON만, 415)·본문 크기(64KB, 413)를 검사한다. 서버가 내주는 화면은 다른 출처가 iframe으로 띄우지 못하게 한다(`frame-ancestors 'self'`, 클릭재킹 방지). 설정·사용량·집계 파일은 임시 파일에 쓰고 디스크에 내린 뒤 rename으로 바꾸며, 깨진 파일은 원본을 남기고 기본값으로 시작한다. 화면에서 넣은 API 키는 AES-256-GCM으로 암호화해 저장한다.

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 서버 | TypeScript, Node 내장 `node:http`, `tsx` |
| 대시보드 화면 | React 19, Vite 6, WebGL(Cubism SDK), WebAudio |
| 스튜디오 | Electron 44 + React 19 |
| 게임 데이터 | 이터널리턴 Open API(`fetch` 직접 호출, 초당 1회 제한 준수) |
| LLM | OpenAI Chat Completions(Structured Outputs), Anthropic Messages API — 모두 `fetch` 직접 호출 |
| TTS | Fish Audio, ElevenLabs, OpenAI `/audio/speech` 중 선택 — mp3로 통일. 설계상 기본 목소리는 Fish Audio "보리 목소리"이나 코드 기본값은 아직 OpenAI(꺼짐)다 |
| 패키지 관리 | npm workspaces 모노레포 |
| 검사 | `node:test` + `tsx`, 가짜 OpenAI 서버 통합 검사, GitHub Actions CI |

워크스페이스 `dependencies`에 든 서드파티 패키지는 React와 Electron뿐이다. 서버는 `node:http`의 `createServer` 하나에 수동 라우팅이고, 외부 API 호출은 모두 Node 내장 `fetch`와 `AbortController`다.

## 저장소 구조

```
.
├── apps/
│   ├── server/          REST API (node:http 직접 사용)
│   │                    er/ 이터널리턴 집계 저장·비교·자동 갱신 판정, narration/ 보리 읽어 주기,
│   │                    http/ 요청 경계(가드·설정 검증·정적 화면), usage/ 사용량 기록
│   ├── companion/       이터널리턴 메타 대시보드 화면 + 보리 Live2D (React 19, Vite 6, 서버 경로 /companion/)
│   └── admin/           보리 스튜디오 Electron 앱 (대시보드 / 설정)
├── packages/
│   ├── shared/          공용 타입 전용 (런타임 코드 없음)
│   ├── er/              이터널리턴 Open API 클라이언트·사전·조합 집계·전적
│   ├── llm/             LLM 어댑터(구조화 출력)·회로 차단기·TTS
│   ├── character/       보리 이름·자기 설정·말투 (데이터)
│   └── live2d/          모델 카탈로그·감정 매핑 (데이터)
│                        각 패키지의 test/ 에 단위 검사 (node:test)
├── tools/
│   ├── test/            통합 검사 (가짜 API에 실제 서버를 붙여 실행)
│   └── vite/            비공개 Live2D 자산 서빙·복사 플러그인
├── .github/workflows/   CI
├── docs/                설계·운영·진행 문서
└── .env.example
```

`packages/*`는 빌드 산출물 없이 `main: "./src/index.ts"`로 TypeScript 원본을 직접 참조하고, 서버도 `tsx`로 소스를 바로 실행한다. 빌드하는 것은 화면 둘(스튜디오·대시보드)뿐이다.

다음 디렉터리는 저장소에 포함되지 않는다.

| 디렉터리 | 제외 이유 |
|---|---|
| 구매 모델 디렉터리 | 구매한 상용 Live2D 모델. 재배포 금지 |
| `private-assets/cubism-sdk/` | Live2D Proprietary Software License. 재배포가 허용된 파일은 `live2dcubismcore.{d.ts,js,min.js}` 3개뿐이다 |
| `data/` | 암호화된 API 키를 포함한 설정, 이터널리턴 집계, 사용량, 로그 |
| `_local/` | 공개하지 않는 사전 조사 자료 |

예전 버전이 만든 `data/` 파일(장기 기억 `memories.json`, 1:1 대화 기록 등)은 지금 코드가 읽지 않지만 지우지도 않는다. 사용량 기록의 예전 방송·1:1 줄은 스튜디오 사용량 표에 "이전 방송"·"이전 1:1"로 보인다.

## 설치와 실행

Node 22 이상과 npm이 필요하다(`package.json`의 `engines`). 개발과 CI는 Node 24를 쓴다.

```bash
npm install
npm run studio    # 대시보드·스튜디오를 빌드하고(비공개 자산 필요) 스튜디오를 띄운다
```

스튜디오는 `http://127.0.0.1:4310/api/health`에 서버가 없으면 서버를 자식 프로세스로 띄우고, 서버가 내주는 `http://127.0.0.1:4310/studio/`를 연다. 첫 탭은 대시보드(`/companion/`), 둘째 탭은 설정이다. 창을 닫으면 스튜디오가 띄운 서버도 끈다. 서버 출력은 데이터 폴더(`BORI_DATA_DIR`, 기본 `data/`)의 `studio-server.log`에 쓴다.

개발할 때는 다음을 쓴다.

```bash
npm run dev               # 서버 + 스튜디오(개발) + 대시보드 dev 서버
npm run dev:server        # API 서버 (127.0.0.1:4310)
npm run dev:companion     # 대시보드 화면 (127.0.0.1:4175/companion/)
npm --workspace apps/companion run dev:mock   # 서버 없이 가짜 API로 대시보드만 보기
```

검사와 빌드는 다음과 같다.

```bash
npm run typecheck   # 8개 워크스페이스
npm run test:unit   # packages/*/test, apps/*/test
npm run test        # 실제 서버를 가짜 OpenAI에 붙여 띄우는 통합 검사
npm run build       # 스튜디오 → 대시보드. 대시보드는 비공개 자산이 있어야 한다
```

자산 없이 되는 빌드는 `npm run build:admin`뿐이다. CI는 Ubuntu에서 타입 검사·단위 검사·통합 검사·스튜디오 빌드를, Windows에서 단위·통합 검사를 돈다. 자세한 검사 구성은 [tools/test/README.md](tools/test/README.md)에 있다.

API 키는 스튜디오 설정 탭에서 넣는 것을 권장한다. 화면으로 넣은 키는 암호화되어 `data/` 아래에 저장된다. 환경변수로 넣으려면 `.env.example`을 루트의 `.env`로 복사해 채운다. 서버는 시작할 때 `.env`를 읽되 이미 설정된 환경변수를 덮지 않는다. 이터널리턴 키(`ER_API_KEY`)와 Fish Audio 키(`FISH_API_KEY`)는 `.env`로만 받는다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/superpowers/specs/2026-11-21-er-meta-dashboard-design.md](docs/superpowers/specs/2026-11-21-er-meta-dashboard-design.md) | 이터널리턴 메타 대시보드 설계 |
| [docs/superpowers/plans/2026-11-21-er-meta-dashboard.md](docs/superpowers/plans/2026-11-21-er-meta-dashboard.md) | 구현 계획(작업 나눔·병합 순서) |
| [docs/architecture.md](docs/architecture.md) | 시스템 구조와 데이터 흐름 |
| [docs/operations.md](docs/operations.md) | 실행·설정·튜닝 파라미터 |
| [docs/decisions.md](docs/decisions.md) | 설계 결정 기록(방향 전환은 ADR-028) |
| [docs/progress.md](docs/progress.md) | 진행 상황 |
| [docs/verification-log.md](docs/verification-log.md) | 자동 검사 현황과 수동 검증 기록 |
| [docs/security-review.md](docs/security-review.md) | 보안·개인정보 점검 결과(방송·1:1 시절 기준) |
| [docs/content/character-bible.md](docs/content/character-bible.md) | 캐릭터 설정(메타 분석 진행자. 방송·1:1 시절 설정은 부록에 기록) |
| [tools/test/README.md](tools/test/README.md) | 통합 검사 구조와 실행 방법 |

`docs/architecture-v2.md`, `docs/requirements.md`, `docs/implementation-plan.md`, `docs/content/persona-guidelines.md`, `docs/content/evaluation.md`는 방송·1:1 대화 시절의 문서라 기록으로만 남겨 두었다.

## 현재 한계

- **실제 키와 실제 화면으로 끝까지 확인하지 않았다.** 집계·비교·대사 검사와 서버 연결은 고정 자료와 가짜 API(통합 검사)로 확인했다. Live2D가 뜬 대시보드는 아직 실제로 띄워 보지 않았다.
- **표본은 상위 랭커 경기다.** 기본 랭커 100명 × 최근 3판이라 전체 이용자 메타와 다를 수 있고, 참가자 30명 미만 조합은 흐리게 보이며 대사에는 넣지 않는다.
- **사용자 인증이 없다.** 로컬 단일 사용자를 가정한다. 서버는 `127.0.0.1`에만 열리고 위 보안 경계로 막지만, 외부에 공개하는 서버로는 쓸 수 없다.
- **Anthropic 어댑터는 실제 키로 확인하지 않았다.**

## 라이선스

이 저장소의 코드는 MIT License를 따른다.

다만 다음 자산은 저장소에 포함되지 않으며 각자의 라이선스를 따른다.

- **구매한 상용 Live2D 모델** — 판매처의 이용 약관을 따르며 재배포가 금지된다. 사용하려면 직접 구매해야 한다.
- **Live2D Cubism SDK for Web** — Live2D Proprietary Software License를 따른다. Live2D 공식 사이트에서 직접 내려받아야 하며, 재배포가 허용된 파일은 `live2dcubismcore` 관련 3개뿐이다.
