# 보안·개인정보 점검

상태: 점검 완료(Phase 8-C), 후속 수정(Phase 8-D, 8절) · 작성일: 2026-10-12 · 기준: main `29ca722` + `feature/audit-ci`. 8절은 `feature/security-hardening`(`integration/wave5` `4ff467c` 기반)

1~7절은 점검 당시 기록이다. 줄 번호와 "범위 밖" 표시는 그때 기준이고, 이후 고친 항목은 요약 표와 8절에 적었다.

코드를 읽고 실제로 확인한 것만 적는다. 확인 방법을 항목마다 표시한다.

- **[코드]**: 코드를 읽어 확인했다. `파일:줄`은 기준 커밋의 줄 번호다.
- **[재현]**: 임시 `BORI_DATA_DIR`로 서버를 띄워 실제 요청으로 확인했다. 실제 `data/`는 건드리지 않았다.
- **확인 필요**: 이 점검에서 확인하지 못했다. 추측으로 채우지 않았다.

전제는 ADR-015와 같다. 서버는 로컬 단일 사용자용이고 `127.0.0.1`에만 바인딩하며, 인증 없이 Origin·Host·Content-Type·본문 크기로 경계를 세운다.

## 요약

| # | 항목 | 결과 | 조치 |
|---|---|---|---|
| 1 | 깨진 퍼센트 인코딩 경로 하나로 서버 프로세스가 종료됨 | 문제 [재현] | **이 브랜치에서 고침** (`guard.ts`) |
| 2 | 비밀값 복호화가 4바이트까지 잘린 GCM 인증 태그를 받아 줌 | 문제 [재현] | **이 브랜치에서 고침** (`secret-store.ts`) |
| 3 | 환경변수로 넣은 API 키가 설정을 한 번 바꾸면 `data/`에 저장됨 | 문제 [재현] | **고침 (`feature/security-hardening`, 8절)** |
| 4 | `/api/me/memories` 전체 삭제가 대화 기록·대화 요약·진행 중인 기억 정리는 지우지 않음 | 한계 [코드] | **고침 (`feature/security-hardening`, 8절)** |
| 5 | 백업 파일(`*.v1-backup-*`, `*.unreadable-*`)과 관리자 렌더러 로그를 지우는 경로가 없음 | 한계 [코드] | **고침 (`feature/security-hardening`, 8절)** |
| 6 | Vite dev 비공개 자산 미들웨어의 경로 검사가 접두사 비교라 형제 폴더로 빠져나갈 수 있음 | 문제 [코드] | **고침 (`feature/security-hardening`, 8절)** |
| 7 | 외부 API 오류 본문 200자가 로그와 관리자 API로 나감 | 한계 [코드] | **고침 (`feature/security-hardening`, 8절)** (키 모양 문자열 가림) |
| 8 | 비밀값 암호화 키가 사용자 이름·호스트 이름에서 나옴 | 알려진 한계 [코드] | 문서화 |
| 9 | 인증이 없음. Origin 없는 로컬 요청은 모든 API를 부를 수 있음 | 알려진 한계 (ADR-015) | 문서화 |
| 10 | `npm audit` 11건 (critical 2, high 5, moderate 4). 서버 런타임 의존성에는 없음 | 확인 | **고침 (`feature/security-hardening`, 8절)** (0건) |
| 11 | 초기 커밋 작성자 이메일이 개인 주소 | 알려진 문제 | **사용자 결정 대기** |
| 12 | 허용 Origin이 모든 라우트를 똑같이 부름. OBS로 송출되는 방송 화면 출처(4173·4174)도 1:1 대화·개인 기억을 읽고 지울 수 있음 (점검 X-1) | 문제 [재현] | **고침 (점검 후속 9.7)** (`guard.ts`, 1.5절) |

서버 코드가 채팅 원문·닉네임·1:1 대화·개인 기억·API 키를 직접 로그에 찍는 곳은 찾지 못했다(2절).

## 1. 요청 경계

### 1.1 모든 라우트가 가드 아래인가 [코드]

- 서버는 `createServer` 하나뿐이고, 핸들러 첫 줄이 `guardRequest`다(`apps/server/src/index.ts:574`). 방송 라우트(`:575-802`)와 1:1 라우트(`handleCompanionRoute`, `:803`)가 모두 그 뒤에 있다. 가드를 거치지 않는 경로는 없다.
- 본문을 읽는 라우트는 모두 `readBody`(64KB 상한)를 쓴다. 1:1 라우트도 `readBodyText`가 같은 `readBody`를 감싼다(`apps/server/src/companion/body.ts`).
- 1:1 라우트의 사용자는 클라이언트가 정하지 않고 서버가 `companion:local`로 고정한다(`apps/server/src/companion/index.ts:15,30`).

### 1.2 고친 것: 깨진 경로 인코딩으로 서버 종료 [재현]

`GET /api/tts/:id`(`index.ts:675`)와 `DELETE /api/memory/:id`(`index.ts:703`)는 경로 조각을 `decodeURIComponent`로 바로 푼다. `%E0%A4%A`처럼 깨진 값이면 `URIError`가 나는데, 요청 처리기 안의 동기 예외라 잡히지 않고 **서버 프로세스가 그대로 종료됐다**. Origin 없는 요청은 가드를 통과하므로 로컬의 어떤 프로그램이든 요청 한 번으로 방송을 멈출 수 있었다.

- 재현: `curl "http://127.0.0.1:<port>/api/tts/%E0%A4%A"` 뒤 `/api/health`가 응답하지 않고, 서버 로그에 `URIError: URI malformed`가 남았다.
- 수정: `guardRequest`가 라우트로 넘기기 전에 경로(쿼리 제외)를 한 번 풀어 보고, 실패하면 400으로 답한다. Origin 검사 뒤, 본문 검사 앞이다. 라우트 코드는 바꾸지 않았다.
- 검사: `apps/server/test/guard-path.test.ts` 4건(깨진 인코딩 400 후 서버 생존, 한글 ID 통과, 쿼리는 보지 않음, 허용 밖 Origin은 403이 먼저), `tools/test/security.mjs` 1건(실제 서버에서 400 후 `/api/health` 200).
- 1:1 라우트는 이미 `decodeId`가 예외를 잡고 있었다(`companion/routes.ts:55-62`). 이제는 가드가 먼저 400으로 답한다.

### 1.3 경로 탈출 [코드]

- **서버**: 정적 파일을 서빙하는 라우트가 없다. TTS 오디오는 메모리의 `Map`에서 ID로 찾고(`index.ts:128,675`), 파일 경로를 만들지 않는다. 1:1 대화·기억 ID도 저장소에서 같은 값을 찾을 뿐이다. 경로 탈출 가능성은 없다.
- **Vite dev 비공개 자산 미들웨어**(`tools/vite/private-assets.ts:55-60`): `resolve(route.root, url…)`의 결과를 `filePath.startsWith(route.root)`로 검사한다. 구분자 없는 접두사 비교라 `/private-model/maolili/../maolili-x/a.json`은 `<프로젝트>/maolili-x/a.json`으로 풀리고 검사를 통과한다(`path.resolve`로 확인, dev 서버로 재현하지는 않음). 빠져나갈 수 있는 곳은 이름이 `maolili`·`Core`·`WebGL`로 시작하는 형제 폴더뿐이고 dev 서버는 `127.0.0.1`에 뜬다. 같은 미들웨어는 dev에서 `/private-core/`의 `include` 목록(스크립트·라이선스만)을 적용하지 않아 Core 폴더의 모든 파일을 내준다.
  - 제안(범위 밖): `const rel = relative(route.root, filePath); if (rel.startsWith("..") || isAbsolute(rel)) → 403`, dev에서도 `include`를 적용.

### 1.4 네트워크 노출 [코드]

- 서버는 `server.listen(port, "127.0.0.1")`로만 뜬다(`index.ts:827`, 재시도 `:824`). IPv6 `::1`에는 바인딩하지 않는다.
- Vite dev·preview도 모두 `127.0.0.1`이다(방송 dev 스크립트 `--host 127.0.0.1`, 방송 preview·1:1 dev·preview `host: "127.0.0.1"`, 관리자 dev 스크립트 `--host 127.0.0.1`).
- 누가 Vite를 `--host 0.0.0.0`으로 띄워도, Vite 프록시는 Host 헤더를 바꾸지 않으므로(`changeOrigin` 미설정) LAN 주소 Host는 서버 가드가 421로 막는다고 판단한다. 실제로 띄워 확인하지는 않았다(**확인 필요**).

### 1.5 인증이 없다는 한계 (ADR-015)

- Origin 헤더가 없는 요청은 통과한다. 같은 컴퓨터의 다른 프로그램, 다른 OS 사용자 계정은 1:1 대화 전체(`GET /api/conversations/...`), 개인 기억(`GET /api/me/memories`), 관리자 기억 목록(`GET /api/memory`, 개인 기억 원문과 `ownerId` 포함)을 읽고 지울 수 있다.
- ~~허용 Origin 10개는 모든 라우트를 똑같이 부를 수 있다. 방송 화면 출처(4173)도 1:1 API를 부를 수 있다.~~ 고침(점검 X-1, progress 9.7): 방송 화면 출처(`127.0.0.1`·`localhost`의 4173·4174)는 `/api/conversations*`·`/api/me*`·`/api/memory*`(관리자 기억 목록도 개인 기억 원문을 섞어 돌려준다)에서 403이다. 사전 요청도 같다. 방송 화면이 쓰는 `/api/state`·`/api/chat`·`/api/tts/*`는 그대로다. 1:1 화면(4175·4176)·관리자(5174)·`BORI_ALLOWED_ORIGINS`로 더한 출처는 지금처럼 모든 라우트를 부른다. 검사: `apps/server/test/guard.test.ts` 5건, `tools/test/security.mjs` 1건.
- **한계: 같은 Origin은 경로로 나눌 수 없다.** 서버가 `/obs/*`(OBS 페이지)·`/companion/*`(1:1)·`/studio/*`(스튜디오)를 직접 내주므로(방송 시스템 W1) 이 페이지들은 모두 서버 자신의 Origin(`http://127.0.0.1:4310`·`http://localhost:4310`)으로 API를 부른다. 그래서 그 Origin에는 X-1 경로 제한을 두지 않았고, 서버가 내준 OBS 페이지도 Origin만으로는 1:1 대화·기억 API를 부를 수 있다. 막으려면 화면마다 다른 포트로 내주거나 1:1·스튜디오 요청에 따로 표시(토큰)를 붙여야 한다. OBS 페이지가 시청자 채팅 같은 외부 입력을 그리다 XSS가 생기면 이 한계가 실제 위험이 된다(OBS 페이지의 XSS 여부는 확인하지 않았다).
- 브라우저의 다른 웹사이트는 Origin 검사와 DNS rebinding 방지(Host 검사)로 막힌다. 상태를 바꾸는 GET 라우트는 없다.

## 2. 서버 로그 [코드]

`apps/server/src`, `packages/*/src`의 `console.*`를 모두 읽었다.

| 위치 | 출력 | 개인정보·비밀값 |
|---|---|---|
| `index.ts:94,97,100,198,263,402,411,417` | 키 암호화 안내, 불러온 건수, 요약 하이라이트 건수, 저장 건수 | 없음 |
| `index.ts:112,153,206` | 설정 파일 저장 실패(fs 오류, 경로 포함) | 없음 |
| `index.ts:178` | 음성 합성 실패 이유 | 업체 오류 본문 최대 200자 (아래) |
| `index.ts:266` | 매크로 파일 파싱 오류 | 없음 |
| `index.ts:405,419,481,559` | 방송 요약·기억 저장·혼잣말·답변 처리 실패의 오류 객체 | 업체 오류 본문 최대 200자 (아래) |
| `index.ts:817-823`, `guard.ts:51` | 포트 사용 중, 무시한 `BORI_ALLOWED_ORIGINS` 항목 | 없음 |
| `conversation/engine.ts:110,174,218,223,226` | 기억 검색 실패, LLM 실패 종류와 이유, 누적 요약 갱신 턴 수 | 이유에 업체 오류 본문 또는 검증 실패 이유(허용되지 않은 감정 이름 등) |
| `companion/index.ts:27`, `companion/service.ts:107,109,134,136`, `companion/routes.ts:169`, `companion/store.ts` 로그 | 건수, 저장·정리 실패 오류, 예상 못 한 요청 오류 | 없음 |
| `packages/memory/src/store.ts:20` | 마이그레이션 건수와 백업 파일 이름 | 없음 |

- 채팅 원문, 닉네임, `viewerId`, 1:1 메시지, 개인 기억 문장, API 키를 찍는 줄은 없다. 방송 원문 채팅 로그 파일도 없다(채팅은 메모리의 큐와 세션에만 있다).
- **업체 오류 본문**: `packages/llm`의 OpenAI·Anthropic·TTS 어댑터는 실패 응답 본문 앞 200자를 오류 메시지에 넣는다(`openai.ts:47-48`, `anthropic.ts:46-47`, `tts.ts:64,84`). 이 문자열은 위 로그와 관리자 API의 `lastError`(`GET /api/llm`)·`ttsLastError`(`GET /api/tts`)로 나간다. 키가 틀렸을 때의 OpenAI 오류 문구에 키 일부가 가려진 형태로 들어간다고 알려져 있으나, 실제 API로 확인하지 않았다(**확인 필요**). 우리 코드는 키 원문을 오류에 넣지 않는다.
  - 제안(범위 밖, `packages/llm`): 오류 본문에서 `sk-`로 시작하는 토큰 같은 키 모양 문자열을 가린 뒤 메시지에 넣는다.
  - 임베딩 오류(`packages/memory/src/embedding.ts:31-32`)도 본문 200자를 넣지만, 저장소가 조용히 삼키므로(`store.ts` 저장·검색) 로그로 나가지 않는다.
- **관리자 Electron 로그**: `apps/admin/electron/main.cjs:9-11,18`이 렌더러의 모든 `console` 메시지를 `data/admin-renderer.log`에 이어 쓴다. 지금 관리자 렌더러에는 직접 `console.*` 호출이 없지만, 렌더러 오류는 그대로 남고 파일은 회전·삭제되지 않는다.
- 클라이언트 쪽 `console.info`(방송·1:1 Live2D 감정 이름, 오디오 ID)는 dev에서만 찍히거나 답변 원문을 담지 않는다.

## 3. `data/` 파일별 개인정보와 삭제 경로 [코드]

`data/`는 `.gitignore` 대상이다. `BORI_DATA_DIR`로 옮길 수 있다(`index.ts:56`).

| 파일 | 만드는 곳 | 담기는 것 | 개인정보 | 지우는 경로 |
|---|---|---|---|---|
| `llm-config.json` | `index.ts:57,110` | LLM 설정, 암호화한 API 키 | 키 | 관리자에서 키를 빈 값으로 저장 |
| `tts-config.json` | `index.ts:122,151` | 음성 설정, 암호화한 ElevenLabs 키 | 키 | 같음 |
| `memory-config.json` | `index.ts:188,204` | 기억 설정 | 없음 | — |
| `memories.json` | `index.ts:186`, `memory/store.ts:70` | 모든 기억(방송 요약·하이라이트, 시청자별 방송 기억, 1:1 개인 기억)과 임베딩 벡터 | 시청자 기억의 `ownerId`가 `local:<소문자·공백 제거 닉네임>`이라 **닉네임이 사실상 평문으로 남는다**. 1:1 개인 기억은 사용자가 한 말을 담는다. 방송 요약은 LLM이 만든 문장이라 시청자 발언이 섞일 수 있다 | 관리자 `DELETE /api/memory/:id`·`/api/memory/all`(1:1 개인 기억 포함 전부), 1:1 `DELETE /api/me/memories`·`/:id`(개인 기억만), 보존 기간(`retentionDays`, 기본 30일) 만료 — 만료 정리는 서버 시작 시 `load()`에서만 돈다 |
| `memories.v1-backup-*.json` | `memory/store.ts:56-66` | 버전 1 → 2 마이그레이션 직전 원본 전체 | 마이그레이션 때 "소유자 불명"으로 지운 기억도 여기에는 남는다 | **없음** (수동 삭제) |
| `companion-conversations.json` | `index.ts:302`, `companion/store.ts` | 1:1 대화 제목, 사용자·보리 메시지 전체, 대화별 누적 요약(LLM 생성) | 1:1 대화 원문 | `DELETE /api/conversations/:id`(대화·메시지·요약). 전체 삭제 API는 없다 |
| `companion-conversations.unreadable-*.json` | `companion/store.ts:110-119` | 읽지 못한 대화 파일 원본 | 1:1 대화 원문 | **없음** (수동 삭제) |
| `macros.json` | 사용자가 직접 편집 | 키워드와 프롬프트 | 설계상 없음 | 수동 |
| `admin-renderer.log` | `apps/admin/electron/main.cjs:9-11` | 관리자 렌더러 콘솔 출력 | 2절 참고 | **없음** (수동 삭제) |

### 3.1 `/api/me/memories` 전체 삭제가 지우는 범위

- 지우는 것: 소유자가 `companion:local`인 기억 레코드(`companion/service.ts:243-245` → `memoryStore.removeByOwner`). 방송 기억은 소유자 접두사가 달라 남는다.
- **지우지 않는 것** [코드]:
  1. 1:1 대화와 메시지 원문, 대화별 누적 요약. 다음 답변의 `[대화 상황]`에 "지난 대화 요약"(ADR-017)으로 계속 들어가므로, 지운 기억과 같은 사실이 요약을 통해 다시 프롬프트에 실릴 수 있다.
  2. 메모리에 떠 있는 세션(`service.ts`의 `sessions`)의 최근 대화와 누적 요약. 서버를 다시 띄우거나 그 대화를 지울 때까지 남는다.
  3. 진행 중인 LLM 기억 정리(`service.ts:117-138`). 삭제 요청과 상관없이 끝나면 저장하므로, 삭제 직후 개인 기억이 다시 생길 수 있다. 실행해 재현하지는 않았다.
  4. 3절 표의 백업 파일.
- 제안(범위 밖, `companion/**`·Companion 앱): 화면 문구에 "대화 기록은 남는다"를 밝히고, 대화·요약·세션·개인 기억을 한 번에 지우는 "1:1 기록 모두 지우기"를 두고, 기억 정리 작업에 세대 번호를 붙여 삭제 이후 결과를 버린다.

## 4. 비밀값 저장 (`apps/server/src/secret-store.ts`) [코드]

- 방식: AES-256-GCM, 요청마다 무작위 12바이트 IV, 저장 형식 `enc.v1:<iv>:<tag>:<본문>`(모두 base64). 키는 `scrypt("<OS 사용자 이름>@<호스트 이름>:bori-ai-vtuber", 고정 salt)`로 매번 만든다.
- **고친 것** [재현]: 복호화에 태그 길이를 지정하지 않아, 정상 태그의 앞 4바이트만 남긴 암호문도 풀렸다(Node가 `DEP0182` 경고만 냄). 위조 시도가 2^32번이면 통과하는 수준으로 약해진다. 암호화·복호화 모두 `authTagLength: 16`으로 고정했다. 기존에 저장된 값은 16바이트 태그라 그대로 풀린다. 검사: `apps/server/test/secret-store.test.ts` 8건(왕복, 무작위 IV, 빈 값, 이전 평문, 태그 16바이트, 본문 변조, 잘린 태그, 형식 깨짐).
- **한계** (고치지 않음):
  - 키 재료가 비밀이 아니다. 파일과 함께 OS 사용자 이름·호스트 이름을 아는 사람은 풀 수 있다. 두 값은 경로·스크린샷·로그에 흔히 드러난다. 파일만 실수로 공유되는 경우를 막는 수준이고, 같은 컴퓨터에서 `data/`를 읽을 수 있는 프로세스는 언제든 풀 수 있다. 소스에도 같은 한계가 적혀 있다.
  - 사용자 이름이나 호스트 이름이 바뀌면 저장된 키를 잃는다(빈 키로 본다).
  - 접두사 없는 값은 이전 버전의 평문으로 보고 그대로 쓴다. LLM 키는 읽을 때 바로 암호문으로 다시 쓰지만(`index.ts:92-95`), ElevenLabs 키는 다음 저장 때까지 평문으로 남는다(`index.ts:136-141`).
  - 제안: Windows DPAPI나 OS 키체인(Electron `safeStorage`는 서버가 별도 프로세스라 바로 못 씀) 또는 `data/` 밖 무작위 키 파일. 키 파일은 같은 디렉터리에 두면 의미가 없다.
- **환경변수 키가 디스크에 저장됨** [재현, 범위 밖]: `OPENAI_API_KEY`로만 키를 넣고 서버를 띄운 뒤 `PATCH /api/llm`(`{"enabled":false}`)을 한 번 보내자, 비어 있던 데이터 디렉터리에 `llm-config.json`이 생기고 그 키가 암호화되어 저장됐다. `saveLlmConfig`가 현재 키(`llmApiKey`, 환경변수 값)를 그대로 쓰기 때문이다(`index.ts:72,110,613`). `PATCH /api/tts`와 `ELEVENLABS_API_KEY`도 같은 구조다(`index.ts:121,151,656`). 그 뒤로는 저장된 키가 이기므로 환경변수를 바꿔도 반영되지 않는다. README의 "환경변수 키는 저장된 키가 없을 때만 사용된다"와 어긋난다.
  - 제안(범위 밖, `index.ts` LLM 설정 부분): 키의 출처를 기억해 두고, 화면에서 입력한 키만 저장한다.
- API 응답에는 키가 나가지 않는다. `GET /api/llm`의 `status`는 `hasApiKey`만 담고(`packages/llm/src/index.ts:93-106`), `GET /api/tts`도 `hasApiKey`·`hasElevenLabsKey`만 담는다(`index.ts:629-630`).

## 5. 의존성 취약점 (`npm audit`)

2026-10-12, npm 11.6.2, `package-lock.json` 기준.

| 패키지 | 심각도 | 직접 의존 | 들어오는 경로 | 런타임 여부 | 고치는 길 |
|---|---|---|---|---|---|
| `concurrently` 9.2.4 | critical | 예(루트 dev) | — | 개발 도구(`npm run dev`) | `npm audit fix` |
| `shell-quote` 1.9.0 | critical | 아니오 | `concurrently` | 개발 도구 | `npm audit fix` |
| `electron` 34.5.8 | high | 예(`apps/admin` dependencies, 루트 dev) | — | **관리자 앱 런타임** | 44.x로 메이저 업그레이드 |
| `extract-zip` | high | 아니오 | `electron` 설치 스크립트 | 설치 시 | 위와 같음 |
| `http-cache-semantics` 4.2.0 | high | 아니오 | `electron` → `@electron/get` → `got` | 설치 시 | `npm audit fix` |
| `joi` 18.2.5 | high | 아니오 | `wait-on`(dev) | 개발 도구 | `npm audit fix` |
| `source-map-js` 1.2.1 | high | 아니오 | `vite` → `postcss` | 빌드 도구 | `npm audit fix` |
| `@electron/get`, `global-agent`, `roarr`, `sprintf-js` | moderate | 아니오 | `electron` 설치 스크립트 | 설치 시 | electron 업그레이드 |

- 합계 11건(critical 2, high 5, moderate 4). `npm audit --omit=dev`는 8건(high 4, moderate 4)이고 모두 `electron`과 그 설치 경로다.
- **서버(`apps/server`)와 `packages/*`의 런타임 의존성은 `@bori/*`뿐**이라 해당 없음. 방송·1:1 화면 번들은 React뿐이고 해당 항목이 없다.
- `electron` 권고 중 이 앱의 사용 방식(원격 콘텐츠 없이 `127.0.0.1:5174`만 연다, `contextIsolation: true`, `nodeIntegration: false`, `apps/admin/electron/main.cjs:14`)에 실제로 해당하는 것이 있는지는 항목별로 보지 않았다(**확인 필요**). `sandbox: false`로 되어 있다.
- 이 브랜치에서는 고치지 않았다. 의존성 변경은 다른 작업과 충돌하기 쉬워 별도 PR로 제안한다: (1) `npm audit fix`(메이저 변경 없음), (2) Electron 메이저 업그레이드는 관리자 앱 수동 확인과 함께.

## 6. git 이력의 개인정보

- **알려진 문제, 사용자 결정 대기.** main의 초기 커밋(`4dbe780`) 작성자 이메일이 GitHub noreply가 아닌 개인 주소다. 이후 커밋은 noreply 주소다. 주소는 이 문서에 적지 않는다.
- 이력 재작성은 하지 않았다. 고치려면 force push가 필요하고 공개된 포크·클론에는 남으므로, 사용자가 결정한다.

## 7. 정리

### 이 브랜치에서 고친 것

| 파일 | 내용 | 검사 |
|---|---|---|
| `apps/server/src/http/guard.ts` | 깨진 경로 인코딩을 400으로 거른다 | `apps/server/test/guard-path.test.ts` 4건, `tools/test/security.mjs` 1건 |
| `apps/server/src/secret-store.ts` | GCM 인증 태그 길이를 16바이트로 강제 | `apps/server/test/secret-store.test.ts` 8건 |

### 범위 밖 제안 (이 브랜치에서 고치지 않음. git 이력을 빼고 8절에서 고침)

| 위치 | 제안 |
|---|---|
| `apps/server/src/index.ts` LLM·TTS 설정 저장 | 환경변수 키를 디스크에 쓰지 않는다 (4절) |
| `apps/server/src/companion/service.ts`, Companion 앱 | 1:1 기록 전체 삭제, 삭제 후 기억 정리 결과 버리기, 화면 문구 (3.1절) |
| `packages/memory/src/store.ts` 백업, `companion/store.ts` 백업, `apps/admin/electron/main.cjs` 로그 | 보존 기간 또는 삭제 경로 (3절) |
| `tools/vite/private-assets.ts` | 경로 검사를 `relative` 기반으로, dev에서도 `include` 적용 (1.3절) |
| `packages/llm` 어댑터 오류 | 키 모양 문자열 가리기 (2절) |
| 의존성 | `npm audit fix`, Electron 메이저 업그레이드 검토 (5절) |
| git 이력 | 초기 커밋 이메일 처리 여부 결정 (6절) |

## 8. 후속 수정 (`feature/security-hardening`, Phase 8-D)

7절의 범위 밖 제안을 처리했다. 항목마다 재현 검사를 먼저 쓰고, 수정 전 코드(`integration/wave5` `daefac9`)에서 실패하는 것을 확인한 뒤 고쳤다. git 이력(11번)은 사용자 결정 대기 그대로다. 8번(키 재료)·9번(인증 없음)은 알려진 한계 그대로다.

| # | 고친 내용 | 수정 전 재현 | 검사 |
|---|---|---|---|
| 3 | 키 출처(환경변수/화면 입력)를 기억하는 `createApiKeySlot`(`secret-store.ts`). 화면(PATCH)에서 넣은 키만 `llm-config.json`·`tts-config.json`에 암호화해 저장하고, 환경변수 키로 동작 중에 설정만 바꾸면 키 필드를 쓰지 않는다. 화면에서 키를 지우면 환경변수 키로 돌아간다(재시작했을 때와 같다). 저장된 키 우선·평문 키 암호화는 유지하고, ElevenLabs 평문 키도 시작할 때 바로 암호문으로 바꾼다 | 통합 4건 실패: LLM·TTS 설정만 바꿔도 키 저장, 키를 지워도 빈 값이 남고 환경변수로 안 돌아감, ElevenLabs 평문 유지 | `tools/test/secrets.mjs` 8건, `apps/server/test/api-key-slot.test.ts` 7건 |
| 4 | `DELETE /api/me/data`: 소유자의 1:1 대화·메시지·대화별 누적 요약·메모리 세션·private 기억을 한 번에 지우고 지운 개수(`conversations`, `messages`, `memories`)를 돌려준다. `DELETE /api/me/memories`는 지금처럼 기억만 지운다. 두 삭제 모두 소유자별 세대 번호를 올리고, 그 전에 시작한 기억 저장·LLM 기억 정리는 결과를 버린다. 임베딩을 기다리는 사이 지운 경우는 `memoryStore.add`의 선택 인자 `isStale`로 막는다. Companion "내 기억"에 "대화 기록은 남는다" 안내와 확인 대화상자가 있는 "1:1 기록 모두 지우기"를 더했다 | 통합 3건(라우트 404), 단위: 기억만 지운 뒤에도 진행 중이던 정리 결과가 저장됨(기존 버그), 임베딩 대기 중 삭제 뒤 저장됨 | `tools/test/privacy.mjs` 6건(방송 기억 유지 포함), `apps/server/test/companion-clear.test.ts` 8건, `packages/memory/test/store-stale.test.ts` 4건, Companion 가짜 API 1건 |
| 5 | 서버 시작 시 데이터 디렉터리 바로 아래의 `*.v1-backup-<시각>.json`, `*.unreadable-<시각>.json`, `admin-renderer.previous.log` 중 마지막 수정이 30일(`BACKUP_RETENTION_DAYS`) 지난 것만 지운다(`apps/server/src/retention.ts`). 이름 형식이 정확히 맞는 파일만 대상이고 하위 디렉터리는 보지 않으며 사용자 데이터 원본은 지우지 않는다. 관리자 앱은 실행할 때마다 지난 로그를 `admin-renderer.previous.log`로 넘기고 새로 써서 로그가 두 실행분을 넘지 않는다(`apps/admin/electron/log-file.cjs`). 관리자 로그도 `BORI_DATA_DIR`를 따른다 | 통합 1건: 40일 지난 백업·이전 로그가 남음 | `tools/test/privacy.mjs` 2건, `apps/server/test/retention.test.ts` 6건, `apps/admin/test/log-file.test.ts` 2건 |
| 6 | `tools/vite/private-assets.ts` dev 미들웨어가 `relative()`로 폴더 밖·다른 드라이브를 거르고, dev에서도 `/private-core/`의 `include`(스크립트·라이선스)만 내준다. 빌드 복사는 그대로다 | 단위 2건: `/private-model/maolili/../maolili-x/…`, `/private-core/../CoreExtra/…`가 200, Core 소스맵·README가 200 | `apps/companion/test/private-assets.test.ts` 7건(빌드 복사 파일 목록 포함). 방송·1:1 `npm run build`로 산출물 자산 목록도 확인 |
| 7 | `packages/llm/src/redact.ts`의 `redactSecrets`. OpenAI·Anthropic 어댑터와 OpenAI·ElevenLabs 음성 합성이 실패 본문을 메시지에 넣기 전에 `sk-` 키(OpenAI가 일부를 `*`로 가린 표기 포함), `Bearer` 토큰, 32자 이상 토큰, 호출에 쓴 키 값을 `[가림]`으로 바꾼다. 200자로 자르기 전에 가린다 | 단위 4건: 오류 메시지에 키 원문이 남음, 200자 경계에서 잘린 키 조각이 남음 | `packages/llm/test/redact.test.ts` 7건 |
| 10 | (a) `npm audit fix`(메이저 변경 없음): concurrently 9.2.5, shell-quote 1.12.0, joi 18.2.9, http-cache-semantics 4.3.0, source-map-js 1.2.2. 11건 → 6건(high 2, moderate 4, 모두 electron 경로). (b) Electron 34.5.8 → 44.7.0(별도 커밋). `console-message`의 deprecated 위치 인자를 이벤트 객체 값으로 바꿨다. 6건 → **0건**(`--omit=dev`도 0건) | — | `build:admin` 통과. 검사용 서버와 빌드한 관리자 화면에 붙여 Electron 44를 실제로 띄워 창 생성·화면 로드·서버 설정 표시를 확인했고, 렌더러 로그에는 로드 1줄과 개발 모드 CSP 보안 경고 1줄만 있었다 |

추가로, 방송 안정화 작업(PR #16)이 범위 밖으로 남긴 문제를 같이 고쳤다. `packages/memory` OpenAI 임베딩 fetch에 타임아웃이 없어 업체가 응답하지 않으면 1:1 기억 저장이 끝없이 기다렸다(수정 전 코드로 15초 동안 끝나지 않음을 확인). `AbortSignal.timeout`으로 `EMBEDDING_TIMEOUT_MS`(10초) 상한을 두고, 끊기면 다른 임베딩 실패와 같이 저장은 임베딩 없이, 검색은 최신·중요도 순으로 떨어진다. 검사: `packages/memory/test/embedding-timeout.test.ts` 5건.

### 남은 한계

- 실제 업체 API의 오류 본문 형식은 확인하지 않았다(**미검증**). 가리기 규칙은 알려진 키 형식과 호출한 키 값 기준이다. 32자 이상 토큰 규칙 때문에 요청 ID 같은 긴 값도 함께 가려진다.
- 임베딩 오류 본문(`packages/memory/src/embedding.ts`)은 가리지 않았다. 저장소가 이 오류를 삼켜 로그·API로 나가지 않기 때문이다(2절).
- 환경변수 키가 수정 전 버전에서 이미 `llm-config.json`·`tts-config.json`에 저장됐다면, 파일만 보고는 화면 입력 키와 구분할 수 없어 저장된 키로 계속 쓴다. 관리자 화면에서 키를 빈 값으로 저장하면 파일에서 빠지고 환경변수 키로 돌아간다.
- 보관 정리는 서버를 시작할 때만 돈다. 30일은 설정이 아니라 코드 상수다. 관리자 로그는 한 실행 안에서는 크기 제한 없이 이어 쓴다.
- 1:1 기록 전체 삭제는 백업 파일(`*.v1-backup-*`, `*.unreadable-*`)을 지우지 않는다. 백업은 30일 보관 정리로만 지워진다.
- Electron 44에서 `sandbox: false`는 그대로다. 관리자 앱은 Electron 창으로 12초 띄워 확인했고, 화면 조작 전체를 Electron에서 다시 해 보지는 않았다.

