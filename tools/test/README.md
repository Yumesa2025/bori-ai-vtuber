# 통합 검사

실제 보리 서버를 가짜 OpenAI API에 붙여 띄우고, HTTP로 라우트를 두드려 보면서 결과를 확인한다.

```bash
npm run test
npm run test -- security secrets   # 시나리오 파일 이름으로 일부만
```

검사 건수와 걸린 시간은 끝 줄에 나온다(건수는 [docs/progress.md](../../docs/progress.md)에 적는다). 실패하면 종료 코드 1, 모르는 시나리오 이름이면 2다.

실행기는 처음에 포트·Node 버전·시나리오 수를 한 줄 찍는다. 검사 실패가 아닌 이유로 끝나면(시나리오 밖 예외, Ctrl+C) `[run] 종료 코드 …, 마지막 단계: …`를 남기고, 시나리오가 예외로 멈추면 그 서버의 출력(서버가 죽었으면 종료 코드도)을 붙인다. 이 줄도 없이 끝났다면 실행기 프로세스가 밖에서 강제 종료된 것이다(Windows의 `taskkill /F`·`Stop-Process`는 종료 코드 1만 남긴다).

순수 함수 수준의 단위 검사는 따로 `npm run test:unit`으로 돌린다(`packages/*/test/*.test.ts`와 `apps/*/test/*.test.ts`, Node 내장 `node:test` + `tsx`). 멈춘 검사가 CI를 붙잡지 않도록 검사 하나에 30초 상한(`--test-timeout`)을 둔다.

2026-11-21 방송·1:1 대화를 걷어낼 때 방송·대화 시나리오(지연, 동작, 기억 격리, 안정화, 1:1, 동시성, 개인정보, 안전, OBS 페이지, 운영, 진행기, 장시간)를 지웠다. 대시보드 흐름은 `dashboard.mjs`가 본다.

## 왜 이 형태인가

서버를 실제로 띄우고 API로 조작한다. 보안 경계(Origin·Host·본문), 키 저장, 파일 손상 대응처럼 프로세스·파일·HTTP가 함께 맞물리는 것은 함수 하나를 떼어 놓고는 볼 수 없다. 세 가지 전제를 지킨다.

- **비용이 들지 않는다.** `BORI_OPENAI_BASE_URL`로 가짜 API를 가리키므로 실제 키도 요금도 필요 없다.
- **실제 데이터를 건드리지 않는다.** `BORI_DATA_DIR`로 임시 디렉터리를 주고 끝나면 지운다. `data/`는 열지 않는다.
- **결과가 반복된다.** 가짜 API의 응답 지연이 고정값이다.

## 구성

| 파일 | 역할 |
|---|---|
| `run.mjs` | 실행기. 서버를 띄우고 시나리오를 돌린 뒤 정리한다. 인자로 시나리오 파일 이름을 주면 그것만 돈다 |
| `harness.mjs` | 프로세스 기동, 포트 대기, HTTP 클라이언트, 결과 보고. 띄운 서버가 루트 `.env`를 읽지 않게 `BORI_ENV_FILE=""`을 기본으로 준다 |
| `mock-openai.mjs` | 가짜 API 서버. 답변·임베딩·음성 경로와 검사용 엔드포인트. 보리 대사 요청(스키마에 `lines`)에는 사실 목록을 그대로 읊는 줄과 숫자를 지어낸 줄 하나를 돌려준다 |
| `security.mjs` | 요청 경계. 허용 밖 Origin·루프백 아닌 Host·깨진 경로 인코딩·JSON 아닌 본문·64KB 초과, 음성 설정 검증 |
| `secrets.mjs` | API 키 저장. 환경변수·`.env` 키는 `data/`에 쓰지 않고, 화면에서 넣은 키만 암호화해 저장하는지 |
| `durability.mjs` | 깨진·잘린 설정 파일, 풀지 못한 암호문 키, 설정 파일 쓰기 실패에도 데이터를 잃지 않고 서버가 사는지 |
| `dashboard.mjs` | 대시보드 흐름. 처음 열면 자동 갱신 → 조합 → 보리 대사(LLM, 숫자를 지어낸 줄은 빠짐) → 음성 id 200 → 닉네임 저장·전적(ready·not-found·unset) → 다시 듣기 → LLM 실패면 정해진 문장 → 재시작 뒤 마지막 대사, 로그에 닉네임 없음 |
| `usage.mjs` | 예전 방송·1:1 사용량 줄을 버리지 않고 읽는지, 사용량 응답에 숫자와 이름만 있는지, 재시작 뒤 유지, LLM 설정 검증 |
| `fixtures/` | 시나리오가 쓰는 설정 고정 자료와 가짜 이터널리턴 API(`fake-er.mjs`) |

시나리오는 `meta`와 `run`을 내보내는 모듈이다. `meta.timing`으로 가짜 API의 응답 지연을 정하고, `run({ bori, mock, report, dataDir, prepared })`에서 검사한다. 서버를 띄우기 전에 할 일(데이터 파일 깔기, 가짜 외부 서비스 띄우기)은 `prepare({ dataDir })`로 둔다. 실행기가 시나리오마다 서버를 새로 띄우고 임시 데이터 디렉터리를 새로 만든다.

```js
export const meta = { name: "보안 경계", timing: { llm: 300, tts: 200, embed: 100 } };
export async function run({ bori, report }) {
  const response = await fetch(`${bori.baseUrl}/api/llm`, { headers: { Origin: "https://evil.example" } });
  report.check("허용 밖 Origin의 GET은 403이다", response.status === 403);
}
```

## 포트

기본값은 가짜 API `4390`, 보리 서버 `4391`, 가짜 이터널리턴 API `4392`(대시보드 흐름)다. 실행 중인 개발 서버(`4310`, `4173`, `5174`)와 겹치지 않는다. 바꾸려면 `MOCK_PORT`, `BORI_TEST_PORT`, `BORI_TEST_ER_PORT`를 준다.

## 검사하지 않는 것

- **대시보드 화면과 Live2D.** 브라우저와 구매한 상용 Live2D 모델이 있어야 하므로 서버 동작만 본다. 화면 쪽은 [docs/verification-log.md](../../docs/verification-log.md)의 수동 검증 기록을 따른다.
- **실제 LLM 응답 품질.** 가짜 API는 고정 문장을 돌려준다.
- **실제 API의 지연.** 고정값이라 재현이 되는 것이지 실제 업체 응답 시간과는 다르다.

## 실패 주입

`mock-openai.mjs`의 `GET /__inject?target=llm|tts|embed&mode=500|delay|badjson&count=N&ms=&match=`는 정해진 횟수만큼만 실패시킨다. `match`를 주면 본문에 그 문자열이 든 요청만 고른다. `clear=1`이면 남은 주입을 지운다. 하네스에서는 `mock.inject({ target, mode, count, ms, match })`로 부른다. 음성(`tts`)에는 `empty`(200·0바이트), `garbage`(200·mp3 아님), `long`(`ms` 길이의 mp3)도 있다. `GET /v1/voices`는 ElevenLabs 목소리 목록을 흉내 내고 받은 횟수를 `/__calls`에 `voices`로 남긴다(실행기가 `BORI_ELEVENLABS_BASE_URL`을 가짜 API로 준다).
