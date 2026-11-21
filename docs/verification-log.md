# 검증 기록

최종 갱신: 2026-11-21 (자동 검사 0절. 0-기록절은 2026-10-12, 수동 검증 기록 1~12절은 2026-08-30 기준)

이 문서는 두 종류의 기록을 구분해 담는다.

- **자동 검사**(0절) — `npm run typecheck`, `npm run test:unit`(단위), `npm run test`(통합). 명령 하나로 다시 돌릴 수 있다. 가짜 API와 순수 함수를 대상으로 하므로 실제 LLM·TTS·이터널리턴 응답과 화면은 확인하지 않는다. GitHub Actions CI(`.github/workflows/ci.yml`)가 Ubuntu에서 타입·단위·통합 검사와 스튜디오 빌드를, Windows에서 단위·통합 검사를 돈다.
- **수동 검증**(1~12절) — 개발 중 브라우저 콘솔, 파라미터 측정, API 호출, 화면 확인으로 직접 관찰한 내용이다. 자동으로 다시 돌지 않는다. 2026-08-30까지의 기록이며 당시 그대로 둔다. 이후 코드가 바뀌어 지금과 맞지 않게 된 항목에는 해당 줄에 `현재:`로 덧붙였다.

영역별 요약과 현재 진행 상황은 [진행 현황](./progress.md)에 있다.

---

## 0. 자동 검사 (2026-11-21, 메타 대시보드)

2026-11-21, Node v24.12.0, Windows 11, 통합 브랜치 `feature/er-meta-dashboard`(`95ef8ec`, 마무리 연결 #53 병합 뒤) 위의 정리 브랜치 `feature/dash-fix-x3-docs`(`858a990`)에서 실행했다.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 종료 코드 0. 8개 워크스페이스(shared·server·admin·live2d·llm·character·companion·er) |
| `npm run test:unit` | 443건 중 443건 통과, 0건 실패(묶음 99개) |
| `npm test` | 66건 중 66건 통과, 0건 실패 (38.7초, 시나리오 5개) |

### 단위 검사 (`packages/*/test/*.test.ts`, `apps/*/test/*.test.ts`, `node:test` + `tsx`)

| 워크스페이스 | 파일 | 확인하는 것 |
|---|---|---|
| `packages/er` | client·dictionary·meta·player·mask | 가짜 fetch로 API 클라이언트(초당 1회·재시도), 사전(캐릭터·무기·장비·특성 이름, 시즌), 조합 집계(이번 시즌 랭크만, 경기 수·참가자 수, 특성·장비 빈도), 전적 요약, 닉네임 가림 |
| `packages/llm` | client·retry·tts·redact·redact-error·usage·validate | 구조화 출력 클라이언트(꺼짐·키·회로), 429 재시도와 회로 차단기, 음성 합성 업체별 요청·실패, 오류 본문 가리기, 토큰 사용량, 출력 글 다듬기 |
| `packages/character` | character | 메타 분석 진행자 문장, 방송·채팅·1:1 낱말 없음, 자기 설정, 존댓말 한 줄, 말하는 범위 |
| `apps/server` er | er-data·er-combos·er-history·er-auto-refresh·er-dashboard-settings·er-dashboard-state | 집계 저장, 원래 개수 → 비율·표본 기준, 갱신 기록 10개·직전 비교·패치 바뀜, 자동 갱신 판정(24시간·시즌·하루 한 번), 닉네임 설정 파일, 대시보드 상태 |
| `apps/server` narration | narration-facts·narration-format·narration-writer·narration-check·narration-template·narration-store·narration-narrator | 사실 목록 규칙, 화면과 같은 반올림, 대사 지시문·스키마, 숫자·이름 검사, 정해진 문장, `narration.json` 저장, 전체 흐름과 LLM 실패 |
| `apps/server` http·파일 | dashboard-routes·guard·guard-path·static·static-routes·settings-validation·llm-settings-validation·api-key-slot·secret-store·config-file·atomic-file·data-safety·retention·load-env·input-text·usage | 대시보드 라우트, 요청 경계(Host·Origin·Content-Type·본문 크기·경로 인코딩), 정적 화면(경로 탈출, iframe 제한 헤더), 설정 검증, 키 출처와 암호화, 원자적 쓰기·손상 파일 보존, 보관 기간, `.env` 읽기, 입력 글 정리, 사용량 |
| `apps/companion` | dashboard·format·narration-player·companion·ui·private-assets | 표 정렬·▲▼·배지, 숫자 모양, 대사 차례 재생, 화면 밖 규칙, 음성·모델 안내, 비공개 자산 Vite 설정 |
| `apps/admin` | status-view·form·poll·server-process·window-policy·log-file | 설정 탭 문구·판정, 폼, 폴링, 서버 자식 프로세스, Electron 창 정책, 로그 회전 |

### 통합 검사 (`tools/test`)

실제 서버를 가짜 OpenAI(`mock-openai.mjs`)와 가짜 이터널리턴 API(`fixtures/fake-er.mjs`)에 붙이고 임시 데이터 디렉터리로 띄워 HTTP로 조작한다. `data/`를 건드리지 않는다.

| 시나리오 | 건수 | 확인하는 것 |
|---|---|---|
| 보안 경계 | 14 | 허용 밖 Origin·루프백 아닌 Host·깨진 경로 인코딩·JSON 아닌 본문·64KB 초과, 음성 설정 검증 |
| API 키 저장 | 11 | 환경변수·`.env` 키는 `data/`에 쓰지 않고, 화면에서 넣은 키만 암호화해 저장 |
| 데이터 파일 손상·쓰기 실패 | 10 | 깨진·잘린 설정 파일, 풀지 못한 암호문 키, 쓰기 실패에도 데이터를 잃지 않고 서버가 산다 |
| API 사용량 | 9 | 예전 방송·1:1 사용량 줄 읽기, 응답에 숫자와 이름만, 재시작 뒤 유지, LLM 설정 검증 |
| 대시보드 흐름 | 22 | 처음 열면 자동 갱신 → 조합 → 보리 대사(지어낸 숫자 줄은 빠짐) → 음성 id 200 → 닉네임 저장·전적 → 다시 듣기 → LLM 실패면 정해진 문장 → 재시작 뒤 마지막 대사, 로그에 닉네임 없음 |

자동 검사가 다루지 않는 것: 실제 이터널리턴·LLM·TTS 응답과 지연, 대시보드·스튜디오 화면을 실제 브라우저로 띄운 모습, Live2D 렌더링과 립싱크. 이 셋은 실제 키와 비공개 Live2D 자산으로 따로 확인해야 하며, 2026-11-21 현재 아직 하지 않았다.

---

## 0-기록. 자동 검사 (2026-10-12, 방송·1:1 시절)

> 아래는 방송·1:1 대화 시절의 기록이다. 표에 나오는 `packages/memory`, `apps/broadcast`, 지연·동작·기억 격리 시나리오 등은 2026-11-21에 지웠다.

2026-10-12, Node v24.12.0, Windows 11, `main`(`4da0220`) 기준 브랜치에서 실행했다.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 종료 코드 0. 8개 워크스페이스(shared·server·broadcast·admin·live2d·llm·memory·character) |
| `npm run test:unit` | 83건 중 83건 통과, 0건 실패 |
| `MOCK_PORT=4470 BORI_TEST_PORT=4471 npm run test` | 46건 중 46건 통과, 0건 실패 (128.6초) |

### 단위 검사 (`packages/*/test/*.test.ts`, `node:test` + `tsx`)

| 파일 | 확인하는 것 |
|---|---|
| `packages/memory/test/access.test.ts` | 기억 접근 규칙표 전 칸, 규칙표 밖 조합과 알 수 없는 scope 제외 |
| `packages/memory/test/store.test.ts` | 두 검색 경로(임베딩·폴백)의 필터, v1 → v2 마이그레이션과 백업, 병합 키, 소유자별 삭제 |
| `packages/memory/test/extract.test.ts` | 기억 후보 추출, 익명 발언 제외 |
| `packages/llm/test/prompt.test.ts` | 프롬프트 7계층 순서와 system/user 배치, 방송 모드 기존 문장 보존, 1:1 정책 분리, 기억 없음 문장, 감정·모션 allowlist |
| `packages/character/test/character.test.ts` | 모드별 정책 구성, 공통 페르소나와 모드 전용 규칙 분리 |

### 통합 검사 (`tools/test`)

실제 서버를 가짜 OpenAI API(`tools/test/mock-openai.mjs`)에 붙이고 임시 데이터 디렉터리로 띄워 HTTP로 조작한다. `data/`를 건드리지 않는다.

| 시나리오 | 건수 | 확인하는 것 |
|---|---|---|
| 지연 | 16 | 매크로 로드, 대기·생성 병렬(직렬 약 9.8초 → 약 6.0초), 답변 출처와 음성 첨부, 매크로·방송 상황·기억 프롬프트 주입, 호출 순서 임베딩 → LLM → TTS, 중복 창 거부·만료 후 재허용, 누적 요약 주기와 반영 |
| 동작 | 16 | 매크로 다시 읽기·켜짐·유지·소멸, LLM 실패 시 폴백, 회로 열림·호출 차단·설정 변경 시 닫힘, 혼잣말, 세션 재시작 전후 답변과 이전 타이머 |
| 기억 격리 | 14 | v1 기억 파일 이전과 소유자 불명 기억 삭제·백업, `/api/memory`의 scope·ownerId, 시청자 A의 기억이 B·익명 채팅의 LLM 요청에 들어가지 않음, 방송 상태에 닉네임·`viewerId` 미노출, 방송 종료 시 이름 있는 시청자 소유로 저장·익명 발언 미저장 |

자동 검사가 다루지 않는 것: 실제 LLM·TTS 응답 품질과 지연, 위험 주제 차단, 출력 검증기, `/api/tts`·`/api/live2d/test` 엔드포인트, 방송 화면·관리자 화면, Live2D, OBS 송출.

---

## 1. 빌드와 타입 검사

- `packages/shared` TypeScript 검사 성공
- `packages/live2d` TypeScript 검사 성공
- `apps/server` TypeScript 검사 성공
- `apps/broadcast` TypeScript 검사 성공
- `apps/admin` TypeScript 검사 성공
- `packages/llm` TypeScript 검사 성공
- `packages/memory` TypeScript 검사 성공
- 방송 화면 프로덕션 빌드 성공
- 관리자 화면 프로덕션 빌드 성공
- 빌드 산출물에 SDK 샘플 청크가 포함되는 것 확인
- dev 서버에서 모델·Cubism Core·셰이더 경로 HTTP 200 확인
- 빌드 산출물에서 모델·Cubism Core·셰이더 경로 HTTP 200 확인
- 빌드 산출물에서 모델 렌더링과 채팅 표시 확인, 콘솔 에러 없음

워크스페이스 7개가 모두 타입 검사를 통과한다. 다만 루트 `typecheck` 스크립트는 shared·server·broadcast·admin 4개만 체인하므로, live2d·llm·memory 3개는 `typecheck:live2d`·`typecheck:llm`·`typecheck:memory`를 개별 실행해 확인했다. 한 번의 명령으로 전체를 검사하지는 못한다.

현재: 루트 `typecheck`가 character까지 8개를 한 번에 검사한다(0절).

## 2. 화면 렌더링

- 관리자 화면 브라우저 렌더링 확인
- 관리자 Electron 창 렌더링 확인, `react-dom` 로드 로그 확인
- 방송 화면 콘솔 에러 0개 확인
- 1920x1080 화면에서 모델·텍스처 표시 스크린샷 확인
- 채팅 8개 입력 후 화면 롤링 확인
- 규칙 기반 응답 말풍선 표시 확인
- 말풍선 중심과 캐릭터 컬럼 중심 일치 확인
- 말풍선과 채팅 패널 미겹침 확인
- 방송 화면 입력창으로 보낸 채팅이 목록에 표시되는 것 확인

## 3. Live2D 렌더링

- 모델 JSON 로컬 브리지 HTTP 200 확인
- Cubism Core 로컬 브리지 HTTP 200 확인
- Cubism 공식 샘플 모듈 Vite 변환 응답 확인
- WebGL2 컨텍스트 생성 확인, 컨텍스트 손실 없음
- 캔버스가 `.live2d-layer` 안에 삽입되는 것 확인
- 캔버스가 1개만 생성되는 것 확인 (StrictMode 이중 마운트 대응 후)

## 4. 표정과 모션

- `setExpression("xingxingyan")` 실제 호출 확인
- `startMotion("xingxingyan", 0, 2)` 실제 호출 확인
- 감정 지속 시간 8초 경과 후 기본 표정으로 복귀하는 것 확인. 당시 기본값은 `changfa`였고 이후 기본 상태를 표정 해제로 변경했다
- 방송 종료 시 기본 표정 복귀 확인
- 관리자 표정 버튼 클릭 시 `setExpression("shengqi")` 호출 확인
- 관리자 모션 버튼 클릭 시 `startMotion("kuqi", 0, 3)` 호출 확인
- `greeting` → `xingxingyan`, `gaming` → `shoushi`, `sad` → `shangxin` 실제 적용 확인
- `calm` 응답 후 표정 파라미터가 모두 0인 것 확인
- 폴링으로 같은 응답이 반복 들어와도 표정·모션이 한 번만 적용되는 것 확인

### 표정과 모션의 파라미터 차이 측정

`shengqi`로 파라미터 값을 0.5초 간격으로 측정한 결과다.

| 실행 내용 | Param66 (표정) | Param68 (모션) |
|---|---|---|
| 표정만 | 1 고정 | 0.204 고정 |
| 표정 + 모션 | 1 고정 | 0.589 → 0.238 → 0.898 → 0.600 → 0.287 → 0.953 |

표정은 효과를 켠 채로 멈춘 상태를 만들고 모션은 그 효과 안에서 값을 계속 흔든다. 정지 화면으로는 둘을 구분할 수 없으므로 스크린샷 비교로 판단하지 않고 시간축 파라미터 변화로 확인해야 한다.

## 5. 시선과 립싱크

- 마우스를 움직여도 `ParamEyeBallX`가 0으로 유지되는 것 확인
- `lookAt(0.75, -0.15)` 호출 시 `ParamEyeBallX` 0.746, `ParamBodyAngleX` 8.24로 이동 확인
- `lookAt(0, 0)` 호출 시 정면으로 복귀하는 것 확인
- 방송 화면에서 채팅 전송 시 시선이 채팅 쪽으로 이동했다가 복귀하는 것 확인
- 시선 목표가 채팅 쪽으로 잡히고 2.85초에 걸쳐 이동하는 것 확인
- 대기 중 시선이 계속 움직이는 것 확인. 같은 값이 이어지는 구간 최대 2초
- 채팅 10회 중 4회 응시하고 6회는 넘어가는 것 확인 (설정 확률 60%)
- 말하는 동안 `ParamMouthOpenY`가 0에서 0.82까지 9단계로 변하는 것 확인
- 말하기 전후로 입이 닫혀 있는 것 확인
- 음성 재생 중 파형 기반으로 입이 움직이고 재생이 끝나면 닫히는 것 확인
- 입 벌림 최대 0.618, 평균 0.328로 개선 확인. 조정 이전에는 최대 0.384였다

## 6. 채팅 큐와 응답

- Node Health API 응답 확인
- 세션 시작·종료 API 확인
- 여러 채팅이 큐에 쌓이는 것 확인
- 방송 시작 버튼 클릭 시 상태 `live` 전환 확인
- 규칙 7개가 각각 의도한 감정·모션으로 응답하는 것 확인
- 인사 채팅 6회에 문장 3개가 중복 없이 소진된 뒤 순환하는 것 확인
- 채팅 없이 혼잣말이 실행되는 것 확인
- 세션 시작 직후 채팅을 넣으면 혼잣말 대신 채팅 응답이 먼저 나오는 것 확인
- 관리자 혼잣말 토글에 따라 간격 입력이 활성·비활성되는 것 확인
- 세션 재시작 시 이전 세션의 LLM 응답이 새 세션에 나오지 않는 것 확인

## 7. 안전성과 보안

- allowlist 밖 이름과 경로 조작 문자열 400 거부 확인
- 표정 목록에만 있는 이름을 모션으로 요청 시 400 거부 확인
- 미지원 LLM 제공 업체 400 거부 확인
- 지원하지 않는 음성 업체 400 거부 확인
- 허용되지 않은 목소리 이름 400 거부 확인
  - 현재: `PATCH /api/tts`는 업체만 검사하고 `voice`는 검사 없이 저장한다(`apps/server/src/index.ts`). [아키텍처 v2](./architecture-v2.md) 8절 #12
- 위험 주제가 LLM 호출 전에 차단되고 무반응 처리되는 것 확인
- 서버 패턴에 없는 주제(주식)를 LLM이 거절하는 것 확인
- 서버 패턴에 없는 프롬프트 공격을 LLM이 거절하는 것 확인
- API 키가 서버 응답에 포함되지 않는 것 확인
- API 키가 `enc.v1:` 접두사로 암호화 저장되고 정상 동작하는 것 확인
- 평문으로 있던 기존 키가 불러오기 시 자동으로 암호화되는 것 확인
- 채팅 화면에서 입력한 닉네임이 방송 화면 채팅 목록에 포함되지 않는 것 확인
- 개인정보가 담긴 채팅이 기억으로 저장되지 않는 것 확인
- 서버 종료 시 관리자 화면에 끊김 배너가 표시되는 것 확인
- 서버 복구 시 배너가 사라지고 버튼이 다시 활성화되는 것 확인

## 8. LLM

### 출력 검증기

11개 경우를 확인했다. 정상 1개 통과, 나머지 10개 거부.

| 입력 | 기대 | 결과 |
|---|---|---|
| 정상 응답 | 통과 | 통과 |
| JSON 아님 | 거부 | 거부 |
| `reply` 없음 | 거부 | 거부 |
| `reply` 길이 초과 | 거부 | 거부 |
| 감정 allowlist 밖 | 거부 | 거부 |
| 보조 감정 allowlist 밖 | 거부 | 거부 |
| `intensity` 범위 밖 | 거부 | 거부 |
| `durationSeconds` 범위 밖 | 거부 | 거부 |
| 모션 이름에 경로 조작 문자열 | 거부 | 거부 |
| 잘못된 레이어 | 거부 | 거부 |
| `priority` 범위 밖 | 거부 | 거부 |

### 실 API 환경 동작

- 실 API 환경에서 응답 생성 확인. 한국어 존댓말과 `여러분` 호칭 유지
- 감정이 allowlist 안에서 오고 검증 실패 0회
- 평균 지연 약 1.5~2.5초
- 모션 설명 추가 후 LLM 응답 6건 모두 모션 포함. 이전에는 0건이었다
- 슬픈 이야기에 `kuqi`, 기쁜 이야기에 `xingxingyan`이 선택되는 것 확인
- OBS 송출 화면에서 LLM 응답 표시 확인

검증 대상은 OpenAI 어댑터다. Anthropic 어댑터는 실 API 환경에서 확인하지 않았다.

### 폴백과 회로 차단기

- 키 없이 LLM을 켜도 방송이 규칙 문장으로 이어지는 것 확인
- 연속 3회 실패 시 회로가 열리고 그동안 방송이 규칙 문장으로 이어지는 것 확인
- 회로가 열린 뒤 설정 원복으로 다시 닫히는 것 확인

## 9. 장기 기억

- 1차 방송 대화에서 기억 3건 저장, 임베딩 1536차원 생성 확인
- 2차 방송에서 이전 방송의 취향과 경험을 정확히 회수하는 것 확인
- 지난 대화를 묻는 채팅이 규칙 대신 LLM으로 전달되는 것 확인
- 관리자 기억 목록에 저장된 기억과 중요도·반복 횟수가 표시되는 것 확인
- 닉네임 기준 `viewerId`로 기억이 저장되는 것 확인. 검색 단계의 시청자 필터는 미구현이다
  - 현재: Phase 1에서 공개 범위·소유자 필터를 구현했다. 실 API로는 다시 확인하지 않았고 자동 검사(0절)로 확인한다
- 방송 종료 시 LLM 요약과 하이라이트가 `broadcast` 기억으로 저장되는 것 확인

## 10. 음성

- 실 API 환경에서 MP3 100KB 생성과 `audio/mpeg` 전달 확인
- 음성 업체 교체 구조로 변경한 뒤에도 OpenAI 합성이 동작하는 것 확인

ElevenLabs 어댑터는 실 키로 확인하지 않았다.

## 11. 채팅 화면

- 채팅 화면에서 닉네임 설정과 채팅 전송, 답변 표시 확인
- 방송 상태와 서버 연결 상태 표시 확인

## 12. OBS 송출

- OBS 브라우저 소스에서 모델·채팅·말풍선 표시 확인
- OBS 송출 화면에서 반짝이는 눈 이펙트 실행 확인
- OBS 캔버스 1920x1080 적용 확인

30분 이상 장시간 송출 안정성은 확인하지 않았다.

---

## 검증되지 않은 항목

아래는 이 문서의 어떤 항목으로도 뒷받침되지 않는다. 상세 사유는 [진행 현황](./progress.md) 2절에 있다.

- Anthropic LLM 어댑터의 실 API 환경 동작
- ElevenLabs TTS 어댑터의 실 키 동작
- `kuqi`·`shangxin`·`wuyu`·`chidai`·`xingxingyan`의 한국어 표시 이름이 실제 화면 동작과 일치하는지 여부
- 30분 이상 장시간 송출 안정성
- 2026-09-01 이후 기능(방송 중 누적 요약, 키워드 매크로, 대기·생성 병렬화, 방송 상황 문장, 기억 없음 명시)의 실 API 동작. 자동 검사로만 확인했다
- 기억 공개 범위·소유자 격리(Phase 1)와 프롬프트 7계층 분리(Phase 2) 이후의 실 API 동작. 자동 검사로만 확인했다
