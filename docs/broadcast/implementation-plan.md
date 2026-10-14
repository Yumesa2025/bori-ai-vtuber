# 보리 치지직 방송 시스템 구현 계획

> **작업자에게:** 이 계획은 작업 묶음(W1~W6)마다 워커 한 명이 맡는다. 각 묶음은 단독으로 테스트할 수 있는 결과를 낸다. 단계는 체크박스(`- [ ]`)로 추적한다. 테스트를 먼저 쓰고(실패 확인) 구현하고(통과 확인) 자주 커밋한다.

**목표:** [설계 문서](./design-spec.md)대로 보리를 OBS 브라우저 소스로 치지직에 송출하고, 이터널리턴 데이터로 진행하는 3~5분 참여형 방송을 운영할 수 있게 한다.

**구조:** 기존 서버(`apps/server`)에 방송 진행기·OBS 제어·치지직 채팅을 더하고, 이터널리턴 API는 새 패키지(`packages/er`)로 분리한다. OBS 페이지는 기존 방송 화면 앱(`apps/broadcast`)의 새 진입점으로 만들고, 운영 화면은 기존 관리자 Electron 앱(`apps/admin`)을 "보리 스튜디오"로 확장한다. 모든 화면은 서버의 `/api/state`를 읽어 그리기만 한다.

**기술:** Node 22 `node:http`, TypeScript, React 19 + Vite 6, Live2D Cubism Web SDK, Electron 44, `node:test` + `tsx`. 새 런타임 의존성은 두 개다: `socket.io-client@2.0.3`(치지직 공식 지원 버전), `obs-websocket-js@5`(OBS WebSocket v5).

---

## 0. 설계 문서와 다르게 정한 것

| 설계 | 계획 | 이유 |
|---|---|---|
| OBS 페이지 새 앱 `apps/overlay` | 기존 `apps/broadcast`에 진입점 추가 | Live2D 렌더링·음성 재생·투명 배경(`?transparent=1`)이 이미 여기 있다. 같은 코드를 옮기면 중복이 생긴다 |
| 스튜디오 새 앱 `apps/studio` | 기존 `apps/admin`을 "보리 스튜디오"로 확장 | Electron 보안 정책(sandbox, CSP, 이동 차단)과 설정 화면이 이미 있다. 폴더 이름은 유지하고 창 제목·문서만 바꾼다 |
| 1:1 화면을 스튜디오 탭으로 이동 | 스튜디오의 "1:1 대화" 탭이 서버가 제공하는 1:1 앱 빌드(`/companion/`)를 iframe으로 띄운다 | 1:1 앱 코드를 옮기지 않고 재사용한다 |
| 옛 앱 삭제 여부 미정 | 지우지 않는다. 옛 방송 화면(`index.html`)과 `chat.html`은 개발·테스트용으로 남긴다 | 기존 통합 검사가 쓰고 있다 |

## 1. 공통 계약 (모든 묶음이 이 형식을 따른다)

### 1.1 공유 타입 — `packages/shared/src/index.ts`에 추가 (W1이 추가, 나머지는 읽기만)

```ts
// ── 방송 진행(쇼) ─────────────────────────────────
export type ShowStage = "idle" | "opening" | "briefing" | "qna" | "diagnosis" | "ending";
export const showStages: readonly ShowStage[] = ["idle", "opening", "briefing", "qna", "diagnosis", "ending"];

/** OBS 장면 이름. OBS에서 이 이름 그대로 장면을 만든다. */
export type ObsSceneName = "보리-대기" | "보리-메인" | "보리-전적" | "보리-엔딩";

/** 이터널리턴 캐릭터 하나의 집계값. 픽률·평균 순위는 표본 기준이다. */
export type ErCharacterStat = {
  code: number;
  name: string;          // 한국어 이름
  picks: number;         // 표본 안에서 고른 횟수
  pickRate: number;      // 0~1
  avgRank: number;       // 평균 순위(1이 1등)
  top1Rate: number;      // 0~1
  mainWeapon: string;    // 가장 많이 쓴 무기 한국어 이름, 모르면 ""
};

/** 메타 집계의 기준. 화면과 보리 대사에 그대로 밝힌다. */
export type ErMetaBasis = {
  seasonName: string;    // 예: "시즌 21"
  sampleGames: number;   // 집계에 쓴 캐릭터-경기 수
  collectedAt: string;   // ISO 시각
  description: string;   // 예: "최근 7일 상위 랭커 7,200판 기준"
};

export type ErPlayerReport = {
  maskedNickname: string;   // 예: "보리팬**"
  seasonName: string;
  games: number;
  avgRank: number;
  top1Rate: number;
  recentRanks: number[];    // 최근 경기 순위, 최신이 앞, 최대 10개
  mainCharacters: Array<{ name: string; games: number; avgRank: number }>; // 최대 3개
};

export type DashboardView =
  | { kind: "season"; basis: ErMetaBasis | null }
  | { kind: "top5"; items: ErCharacterStat[]; revealed: number; basis: ErMetaBasis | null }
  | { kind: "character"; query: string; stat: ErCharacterStat | null; suggestions: string[]; basis: ErMetaBasis | null }
  | { kind: "player"; status: "waiting" | "loading" | "ready" | "not-found" | "error"; report: ErPlayerReport | null }
  | { kind: "summary"; characters: string[] };

export type ShowConnections = {
  chzzk: "off" | "connecting" | "connected" | "error";
  obs: "off" | "connecting" | "connected" | "error";
  er: "ready" | "stale" | "missing" | "refreshing";
};

export type ShowState = {
  stage: ShowStage;
  scene: ObsSceneName;
  dashboard: DashboardView;
  /** 자막. 보리의 현재 답 문장과 같지만 OBS 자막 페이지가 따로 읽는다. */
  caption: string;
  connections: ShowConnections;
  /** ER 데이터 갱신 진행률 0~1, 갱신 중이 아니면 null. */
  erRefreshProgress: number | null;
};
```

`BroadcastState`에 선택 필드 `show?: ShowState`를 더한다. 방송 진행기가 꺼져 있으면 비어 있다. OBS 페이지는 기존처럼 `/api/state`를 폴링한다.

### 1.2 서버 API (W4가 구현, W1·W5는 이 형식으로 호출)

| 메서드·경로 | 본문 | 응답 | 하는 일 |
|---|---|---|---|
| `GET /api/show` | - | `ShowState` | 현재 진행 상태 |
| `POST /api/show/next` | `{}` | `ShowState` | 다음 단계. `idle`이면 방송 세션을 시작하고 `opening`으로 |
| `POST /api/show/prev` | `{}` | `ShowState` | 이전 단계(보리는 다시 말하지 않는다) |
| `POST /api/show/reset` | `{}` | `ShowState` | `idle`로, 방송 세션 종료 |
| `POST /api/er/refresh` | `{}` | `{ started: boolean }` | ER 메타 집계 시작(이미 도는 중이면 false) |
| `GET /api/er/status` | - | `{ basis: ErMetaBasis \| null; refreshing: boolean; progress: number \| null; lastError: string \| null }` | |
| `GET /api/chzzk/login` | - | 302 → 치지직 인증 페이지 | 브라우저에서 연다 |
| `GET /api/chzzk/callback?code&state` | - | HTML "연결했습니다. 이 창을 닫아도 됩니다" | 토큰 교환 후 채팅 연결 |
| `GET /api/chzzk/status` | - | `{ state: ShowConnections["chzzk"]; channelName: string \| null; lastError: string \| null }` | |
| `POST /api/chzzk/disconnect` | `{}` | `{ ok: true }` | |
| `GET /api/obs/status` | - | `{ state: ShowConnections["obs"]; currentScene: string \| null; lastError: string \| null }` | |

정적 파일(W1이 구현): `GET /obs/*` → `apps/broadcast/dist`, `GET /companion/*` → `apps/companion/dist`, `GET /studio/*` → `apps/admin/dist`. 정적 경로는 API 가드의 Content-Type 검사를 받지 않지만 Host loopback 검사는 받는다.

치지직 Redirect URL은 `http://localhost:4310/api/chzzk/callback`이다(사용자가 개발자 센터에 등록한 값).

### 1.3 환경 변수 (루트 `.env`)

| 이름 | 쓰는 곳 |
|---|---|
| `OPENAI_API_KEY` | 기존 |
| `ER_API_KEY` | W2 |
| `CHZZK_CLIENT_ID`, `CHZZK_CLIENT_SECRET` | W3 |
| `OBS_WEBSOCKET_URL`(기본 `ws://127.0.0.1:4455`), `OBS_WEBSOCKET_PASSWORD` | W4 |

서버가 `.env`를 읽는 방식은 점검 후속 F7에서 정한다. F7이 아직 병합되지 않았으면 테스트는 환경 변수를 직접 넘긴다. 키 값은 출력·로그·커밋하지 않는다.

### 1.4 OBS 페이지 주소 (W1)

배포 경로(서버가 제공)는 `http://127.0.0.1:4310/obs/<이름>.html`이고, 개발 경로(Vite)는 `http://127.0.0.1:4173/obs/<이름>.html`이다.

| 이름 | 크기 | 소리 |
|---|---|---|
| `character` | 1920×1080, 보리는 왼쪽 1/3 | 있음(TTS) |
| `dashboard` | 1920×1080, 오른쪽 큰 패널 | 없음 |
| `caption` | 1920×1080, 하단 중앙 자막 | 없음 |
| `chat` | 1920×1080, 오른쪽 아래 띠 | 없음 |
| `waiting` | 1920×1080, 불투명 배경 | 없음 |
| `ending` | 1920×1080, 불투명 배경 | 없음 |

모든 페이지는 `?demo=1`이면 서버 없이 고정 예시 상태로 그린다. 디자인 확인과 스크린샷용이다.

---

## 2. 작업 묶음과 순서

| 묶음 | 내용 | 선행 | 동시 진행 |
|---|---|---|---|
| W1 | OBS 페이지 6종 + 공유 타입 + 정적 파일 제공 | 점검 1차 병합 | W2, W3 |
| W2 | `packages/er` 이터널리턴 클라이언트·집계·사전·전적 | 없음 | W1, W3 |
| W3 | 치지직 OAuth·토큰 저장·채팅 소켓 모듈 | 없음 | W1, W2 |
| W4 | OBS 제어 + 방송 진행기 + 서버 연결(채팅 수신·게임 데이터 프롬프트·`!전적`) | W1~W3, 점검 F2·F4 병합 | - |
| W5 | 보리 스튜디오(운영 탭, 서버 자동 실행, 1:1 탭, 설정 탭) | W1, W4의 API | - |
| W6 | 제출 문서 6종 + 리허설 점검 | W4, W5 | - |

모든 묶음은 `fix/audit-followup`(통합 브랜치)에서 갈라지고 PR도 그쪽으로 낸다. 기준선 검사(typecheck, test:unit, test, eval:test, eval:typecheck, eval:static)는 매 묶음 끝에 다시 통과해야 한다.

---

## W1. OBS 페이지와 정적 파일 제공

**파일:**
- 수정: `packages/shared/src/index.ts` (1.1의 타입, `BroadcastState.show?`)
- 생성: `apps/broadcast/obs/{character,dashboard,caption,chat,waiting,ending}.html`
- 생성: `apps/broadcast/src/obs/{character.tsx,dashboard.tsx,caption.tsx,chat.tsx,waiting.tsx,ending.tsx}`
- 생성: `apps/broadcast/src/obs/state.ts` (폴링 훅 `useBroadcastState`, `?demo=1` 예시 상태 `demoState`)
- 생성: `apps/broadcast/src/obs/obs.css` (C안 디자인 공통 스타일)
- 생성: `apps/broadcast/src/live2d/stage.ts` (기존 `main.tsx`의 Live2D 초기화·표정·모션·음성 재생을 함수로 분리, `main.tsx`와 `obs/character.tsx`가 함께 씀)
- 수정: `apps/broadcast/src/main.tsx` (분리한 함수 사용, 동작 변화 없음)
- 수정: `apps/broadcast/vite.config.ts` (`build.rollupOptions.input`에 6개 페이지 추가)
- 생성: `apps/server/src/http/static.ts` (`serveStatic(request, response, routes)`: 경로 탈출 방지, MIME, 캐시 없음)
- 수정: `apps/server/src/index.ts` (가드 다음, API 라우트 앞에서 정적 경로 처리)
- 테스트: `apps/broadcast/test/obs-view.test.ts`, `apps/server/test/static.test.ts`, `tools/test/obs-pages.mjs`(통합)

### 단계
- [ ] **1. 공유 타입 추가.** 1.1 블록을 그대로 `packages/shared/src/index.ts` 끝에 넣고 `BroadcastState`에 `show?: ShowState;`를 더한다. `npm run typecheck`가 통과하는지 확인하고 커밋한다.
- [ ] **2. 정적 파일 제공 테스트를 먼저 쓴다.** `apps/server/test/static.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStaticPath, contentTypeFor } from "../src/http/static.ts";

const root = "C:/bori/apps/broadcast/dist";
test("접두사 아래 파일을 루트 안 경로로 푼다", () => {
  assert.equal(resolveStaticPath("/obs/character.html", "/obs/", root)?.replaceAll("\\", "/"), `${root}/obs/character.html`);
});
test("상위 경로 탈출은 거부한다", () => {
  for (const url of ["/obs/../secret.json", "/obs/%2e%2e/secret.json", "/obs/..\\secret.json", "/obs/C:/Windows/win.ini"]) {
    assert.equal(resolveStaticPath(url, "/obs/", root), null, url);
  }
});
test("쿼리스트링은 경로에서 뺀다", () => {
  assert.equal(resolveStaticPath("/obs/chat.html?demo=1", "/obs/", root)?.replaceAll("\\", "/"), `${root}/obs/chat.html`);
});
test("MIME", () => {
  assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("a.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("a.moc3"), "application/octet-stream");
});
```

  `npm run test:unit`으로 실패를 확인한다.
- [ ] **3. `static.ts` 구현.** `resolveStaticPath(url, prefix, root)`는 `decodeURIComponent` 뒤 `path.resolve` + `path.relative`로 루트 밖이면 `null`이다(`tools/vite/private-assets.ts`의 `allowedFilePath`와 같은 방식). `serveStatic`은 파일이 없으면 404 JSON, 디렉터리면 `index.html`이다. `contentTypeFor`는 html, js, css, json, png, moc3, wav, mp3, frag/vert(text/plain)를 다룬다. 테스트 통과를 확인하고 커밋한다.
- [ ] **4. 서버 연결.** `index.ts`의 요청 처리기에서 가드 직후에 `GET`·`HEAD`이면서 경로가 `/obs/`, `/companion/`, `/studio/`로 시작하면 `serveStatic`으로 처리한다. 정적 응답은 JSON Content-Type 헤더를 덮어쓴다. dist가 없으면 503 `{ error: "화면을 먼저 빌드하세요: npm run build:broadcast" }`이다. companion·admin 빌드의 `base`를 `/companion/`, `/studio/`로 바꾸는 것은 W5에서 한다(여기서는 경로만 연다).
- [ ] **5. Live2D 분리.** `main.tsx`의 Core 로드, 모델 초기화, 표정·모션 적용, 음성 재생·립싱크를 `src/live2d/stage.ts`로 옮긴다. 외부 인터페이스는 다음과 같다.

```ts
export type Live2DStage = {
  status(): ModelStatus;
  applyResponse(response: CharacterResponse, audioUrl?: string): Promise<void>;
  applyTestAction(action: TestAction): void;
  unlockAudio(): void;
  dispose(): void;
};
export function createLive2DStage(container: HTMLElement, options: { transparent: boolean }): Promise<Live2DStage>;
```

  기존 방송 화면 테스트(`apps/broadcast/test`)와 Playwright 수동 확인으로 동작이 같음을 확인한다. 이 단계는 동작 변화가 없어야 한다.
- [ ] **6. 뷰 계산 테스트를 먼저 쓴다.** 그리기와 계산을 나누려고, `obs/view.ts`에 순수 함수를 두고 테스트한다.

```ts
// apps/broadcast/test/obs-view.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPercent, formatRank, visibleTop5, chatStripLines } from "../src/obs/view.ts";

test("픽률은 소수 한 자리 퍼센트", () => assert.equal(formatPercent(0.0812), "8.1%"));
test("평균 순위", () => assert.equal(formatRank(3.42), "3.4위"));
test("TOP5는 revealed만큼만 보인다", () => {
  const items = [1, 2, 3, 4, 5].map(i => ({ code: i, name: `c${i}`, picks: 1, pickRate: 0.1, avgRank: 3, top1Rate: 0.1, mainWeapon: "" }));
  assert.deepEqual(visibleTop5(items, 2).map(x => x.name), ["c1", "c2"]);
  assert.equal(visibleTop5(items, 9).length, 5);
});
test("채팅 띠는 최근 4줄, 명령은 강조 표시", () => {
  const chats = ["a", "b", "!전적 보리팬", "c", "d"].map((content, i) => ({ id: String(i), content, receivedAt: "", category: "normal" as const }));
  const lines = chatStripLines(chats);
  assert.equal(lines.length, 4);
  assert.equal(lines.find(l => l.text.startsWith("!전적"))?.command, true);
});
```

- [ ] **7. `view.ts` 구현 후 테스트 통과, 커밋.**
- [ ] **8. 페이지 6종 구현.** 공통으로 `useBroadcastState()`가 250ms마다 `/api/state`를 읽고, `?demo=1`이면 `demoState`를 쓴다.
  - `character`: `createLive2DStage(container, { transparent: true })`, 보리는 화면 왼쪽 1/3 하단, 배경 투명. `currentResponse`가 바뀌면 `applyResponse`.
  - `dashboard`: `show.dashboard.kind`별 카드. 오른쪽 60% 패널, 반투명 남색 배경, 금빛 제목(메인 장면 시안 C). `top5`는 한 줄씩 나타나는 애니메이션, `player`의 `waiting`은 "채팅에 !전적 닉네임을 적어 주세요", `loading`은 "찾아보는 중…", `not-found`는 "닉네임을 찾지 못했어요". 항상 아래쪽에 `basis.description`을 작게 쓴다.
  - `caption`: 하단 중앙 흰 말풍선, `show.caption`(없으면 `currentResponse.reply`), 두 줄 넘으면 줄임.
  - `chat`: 오른쪽 아래 띠, `visibleChats` 최근 4줄, 닉네임은 표시하지 않는다(기존 규칙).
  - `waiting`: "곧 시작합니다" + 방송 제목 + 시즌 이름, 은은한 배경 애니메이션.
  - `ending`: "오늘 나온 캐릭터" 목록(`summary`) + 인사.
- [ ] **9. Vite 입력 추가, `npm run build:broadcast` 통과(비공개 자산 정션 필요), 커밋.**
- [ ] **10. 통합 검사 `tools/test/obs-pages.mjs`.** 서버를 띄우고 6개 페이지가 200과 `text/html`로 오는지, `/obs/../package.json`이 404인지 확인한다. `tools/test/run.mjs`에 등록한다.
- [ ] **11. 화면 확인.** Playwright로 각 페이지 `?demo=1`을 1920×1080으로 열어 스크린샷을 `AUDIT`가 아닌 OS 임시 폴더에 남기고 PR에 설명만 적는다(스크린샷 커밋 금지).
- [ ] **12. 문서.** `README.md` 실행 절에 OBS 페이지 주소 표를 넣는다. 커밋, PR.

**완료 기준:** 6개 페이지가 demo 상태로 그려진다. `character`는 실제 Live2D가 투명 배경으로 뜬다. 서버가 `/obs/*`를 제공한다. 기존 방송 화면 동작은 바뀌지 않는다.

---

## W2. 이터널리턴 패키지 `packages/er`

**파일:**
- 생성: `packages/er/package.json`(`@bori/er`), `tsconfig.json`, `src/index.ts`
- 생성: `src/client.ts`(요청·속도 제한·오류), `src/meta.ts`(메타 집계), `src/dictionary.ts`(캐릭터 사전·이름 찾기), `src/player.ts`(전적 진단), `src/mask.ts`(닉네임 가림)
- 생성: `test/{client,meta,dictionary,player,mask}.test.ts`, `test/fixtures/*.json`(가짜 응답)
- 수정: 루트 `package.json`(typecheck 스크립트에 er 추가)

### 인터페이스

```ts
export type ErClientOptions = { apiKey: string; baseUrl?: string; minIntervalMs?: number; fetch?: typeof fetch; now?: () => number };
export type ErClient = { get<T>(path: string): Promise<T> };   // 큐로 직렬화, minIntervalMs(기본 1100) 간격 보장
export class ErApiError extends Error { constructor(readonly status: number, readonly code: number | null, message: string) }

export function createErClient(options: ErClientOptions): ErClient;

export type ErDictionary = { characters: Array<{ code: number; name: string; weapons: string[] }>; weaponNames: Record<number, string>; seasonId: number; seasonName: string };
export function loadDictionary(client: ErClient): Promise<ErDictionary>;
/** 채팅에서 캐릭터 이름을 찾는다. 공백·대소문자 무시, 별칭 표 포함. 못 찾으면 비슷한 이름 최대 3개. */
export function findCharacter(text: string, dict: ErDictionary): { match: ErDictionary["characters"][number] | null; suggestions: string[] };

export type MetaProgress = (done: number, total: number) => void;
export function collectMeta(client: ErClient, dict: ErDictionary, options: { rankers: number; gamesPerRanker: number; onProgress?: MetaProgress }): Promise<{ stats: ErCharacterStat[]; basis: ErMetaBasis }>;

export function lookupPlayer(client: ErClient, dict: ErDictionary, nickname: string): Promise<ErPlayerReport | null>; // 없으면 null
export function maskNickname(nickname: string): string;
```

`ErCharacterStat`, `ErMetaBasis`, `ErPlayerReport`는 `@bori/shared`에서 가져온다(W1이 추가). W1보다 먼저 시작하면 같은 정의를 `packages/shared`에 넣고, W1과 겹치면 병합 때 하나로 맞춘다.

### 단계
- [ ] **1. 닉네임 가림 테스트 → 구현.** 규칙: 2자 이하는 첫 글자 + `*`, 3~4자는 앞 2자 + 나머지 `*`, 5자 이상은 앞 3자 + `**`. 코드포인트 단위(이모지·한글 안전).

```ts
assert.equal(maskNickname("보리"), "보*");
assert.equal(maskNickname("보리팬"), "보리*");
assert.equal(maskNickname("보리팬클럽"), "보리팬**");
assert.equal(maskNickname("ab😀cd"), "ab😀**");
```

- [ ] **2. 클라이언트 테스트 → 구현.** 가짜 `fetch`로 확인할 것:
  - `x-api-key` 헤더
  - 호출 간격 ≥ `minIntervalMs`(가짜 `now`)
  - HTTP 200이어도 본문 `code`가 200이 아니면 `ErApiError`
  - 429·403이면 한 번 기다렸다 재시도
  - 키가 오류 메시지에 들어가지 않음
- [ ] **3. 사전 테스트 → 구현.** 가짜 응답:
  - `/v1/l10n/Korean` → `{ data: { l10Path: "https://.../ko.txt" } }`. 문서에 `l10Path`·`l10nPath` 두 표기가 있으니 둘 다 받는다.
  - l10n 텍스트: `Character/Name/1┃재키` 같은 줄, 구분자는 `┃`.
  - `/v2/data/Character`, `/v2/data/CharacterMastery`
  - `/v2/data/Season`: `isCurrent == 1`인 행

  `findCharacter("재키 요즘 어때?")` → 재키, `findCharacter("재 키")` → 재키, `findCharacter("잭키")` → null + suggestions에 "재키"(편집 거리 1). 별칭 표는 `src/aliases.ts`에 빈 객체로 시작하고 테스트용 한 건만 넣는다.
- [ ] **4. 메타 집계 테스트 → 구현.** 수집 순서:
  1. `/v1/rank/top/{seasonId}/3`
  2. 상위 `rankers`명 각각 `/v1/user/nickname?query=`로 uid 조회
  3. `/v1/user/games/uid/{uid}`(첫 페이지 10경기)에서 `gamesPerRanker`개 경기의 `gameId`를 고른다
  4. 중복을 뺀 `gameId`마다 `/v1/games/{gameId}`

  집계: 모든 참가자의 `characterNum`별 픽 수, `gameRank` 평균, 1등 비율, 가장 많은 `bestWeapon`.
  - `pickRate = picks / 전체 참가자 수`
  - `basis.description = "최근 상위 랭커 {N}판 기준"`(N은 참가자 수, 천 단위 쉼표)

  가짜 응답 픽스처 2경기 × 4명으로 수치를 손으로 계산해 맞춘다. 상위 5개 정렬은 `picks` 내림차순, 같으면 `avgRank` 오름차순.
- [ ] **5. 전적 테스트 → 구현.**
  1. 닉네임 → uid
  2. `/v2/user/stats/uid/{uid}/{seasonId}/3`(랭크)
  3. 비어 있으면 `/v2/user/stats/uid/{uid}/0/2`(일반)
  4. `/v1/user/games/uid/{uid}`로 최근 순위 10개
  - `mainCharacters`는 `characterStats`의 상위 3개를 사전 이름으로 바꾼다.
  - 닉네임이 없으면(`code` 404 또는 `user` 없음) `null`을 돌려준다.
- [ ] **6. 실제 API 확인(키 사용, 1회).** `.env`의 `ER_API_KEY`로 `loadDictionary`, `collectMeta({ rankers: 5, gamesPerRanker: 2 })`, 공개 랭커 1명 `lookupPlayer`를 실행하는 스크립트를 OS 임시 폴더에 두고 돌린다. 걸린 시간과 결과 개수만 PR에 적는다(닉네임·키 기록 금지). 전체 규모(`rankers: 100, gamesPerRanker: 3`)의 예상 시간을 계산해 적는다.
- [ ] **7. 루트 typecheck에 추가, 기준선 검사, 커밋, PR.**

**완료 기준:** 단위 테스트가 실제 네트워크 없이 통과한다. 실제 API로 사전·소규모 집계·전적 1건이 동작한다.

---

## W3. 치지직 채팅 모듈 `apps/server/src/chzzk/`

**파일:**
- 생성: `apps/server/src/chzzk/oauth.ts`(인증 URL, 토큰 교환·갱신), `token-store.ts`(암호화 저장, 기존 `secret-store.ts` 사용), `session.ts`(세션 URL 받기, 소켓 연결, 구독, 재연결), `types.ts`
- 생성: `apps/server/test/chzzk-oauth.test.ts`, `chzzk-session.test.ts`, `tools/test/fixtures/fake-chzzk.mjs`(가짜 OpenAPI + Socket.IO 2.x 서버)
- 수정: `apps/server/package.json`(`socket.io-client` `2.0.3` 고정). 가짜 서버용 `socket.io@2.x`는 devDependency(루트)로 둔다.

### 인터페이스

```ts
export type ChzzkChat = { senderChannelId: string; nickname: string; content: string; receivedAt: string; role: "streamer" | "common_user" | "streaming_channel_manager" | "streaming_chat_manager" | string };

export function buildAuthorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string;
export function exchangeCode(options: { clientId: string; clientSecret: string; code: string; state: string; fetch?: typeof fetch; baseUrl?: string }): Promise<ChzzkTokens>;
export function refreshTokens(options: { clientId: string; clientSecret: string; refreshToken: string; fetch?: typeof fetch; baseUrl?: string }): Promise<ChzzkTokens>;
export type ChzzkTokens = { accessToken: string; refreshToken: string; expiresAt: number };

export type ChzzkChatConnection = {
  status(): "off" | "connecting" | "connected" | "error";
  lastError(): string | null;
  stop(): void;
};
export function connectChzzkChat(options: {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;   // 만료 1시간 전이면 갱신해서 준다. forceRefresh면 API 401 뒤 강제 갱신
  onChat: (chat: ChzzkChat) => void;
  onStatus?: (status: string) => void;
  baseUrl?: string;                        // 기본 https://openapi.chzzk.naver.com
  io?: typeof import("socket.io-client");  // 테스트용 주입
  reconnectDelaysMs?: number[];            // 기본 [1000, 2000, 5000, 10000, 30000]
}): ChzzkChatConnection;
```

### 단계
- [ ] **1. 공식 문서 대조.** https://chzzk.gitbook.io/chzzk 의 Authorization, Session, Chat 페이지를 다시 읽는다. `docs/chzzk-integration-review.md`의 "확인 필요" 항목(세션 URL 유효 시간, `sessionKey` 전달 형식, 토큰 교환 본문 형식)을 문서로 확정하고 PR에 적는다. 확정 못 한 것은 가짜 서버가 두 형식을 다 받게 한다.
- [ ] **2. `socket.io-client@2.0.3` 보안 확인.** `npm audit`와 GitHub Advisory에서 해당 버전대 공지를 찾아 PR에 적는다. 심각한 공지가 있으면 ask로 코디네이터에게 알린다.
- [ ] **3. OAuth 테스트 → 구현.** 인증 URL은 `https://chzzk.naver.com/account-interlock?clientId=..&redirectUri=..&state=..`이다. 토큰 교환은 `POST {base}/auth/v1/token`이고 본문은 `grantType: "authorization_code"`, 갱신은 `grantType: "refresh_token"`이다. 응답의 `content.accessToken`·`refreshToken`·`expiresIn`을 읽는다. 오류 메시지에 secret·토큰이 없어야 한다.
- [ ] **4. 토큰 저장 테스트 → 구현.** `data/chzzk-token.json`에 `secret-store`로 암호화해 원자적으로 쓴다(점검 F1의 공용 쓰기 함수 사용). 풀지 못하면 지우지 않고 "다시 연결 필요" 상태로 둔다.
- [ ] **5. 세션 테스트(가짜 서버) → 구현.**
  1. `GET /open/v1/sessions/auth`로 URL을 받는다.
  2. `io.connect(url, { reconnection: false, "force new connection": true, transports: ["websocket"], timeout: 3000 })`로 연결한다.
  3. `SYSTEM` `connected`에서 `sessionKey`를 받는다.
  4. `POST /open/v1/sessions/events/subscribe/chat`로 구독한다.
  5. `CHAT` 이벤트를 `ChzzkChat`으로 바꿔 `onChat`을 부른다.

  끊기면 `reconnectDelaysMs` 순서로 새 세션 URL부터 다시 받는다. `stop()` 뒤에는 재연결하지 않는다. 테스트 항목은 다음과 같다.
  - 채팅 수신
  - 문자열 JSON·객체 둘 다 처리(문서상 형식이 불분명)
  - 끊김 후 재연결
  - 토큰 만료 시 갱신 후 재시도
  - `stop`
- [ ] **6. 실제 연결 확인은 W4에서 한다**(서버 라우트가 필요). 여기서는 PR에 "실제 치지직 미검증"으로 적는다.
- [ ] **7. 기준선 검사, 커밋, PR.**

**완료 기준:** 가짜 치지직 서버로 로그인 → 토큰 → 소켓 → 채팅 수신 → 재연결이 테스트로 통과한다.

---

## W4. OBS 제어 + 방송 진행기 + 서버 연결

선행: W1~W3, 점검 F2(채팅 정리·위기)·F4(큐·세션 멱등)가 통합 브랜치에 병합된 뒤 시작한다.

**파일:**
- 생성: `apps/server/src/obs/controller.ts`(`obs-websocket-js` 래퍼), `apps/server/src/show/stages.ts`(단계 정의), `show/controller.ts`(상태 머신), `show/game-data.ts`(채팅 → 게임 데이터 섹션), `show/commands.ts`(`!전적`)
- 생성: `apps/server/src/chat/ingest.ts` — `/api/chat`의 본문을 함수 `ingestChat({ content, nickname, source })`로 옮긴다. 치지직·테스트 채팅·`/api/chat`이 같은 함수를 쓴다.
- 수정: `apps/server/src/index.ts`(라우트 1.2, 진행기 생성, 치지직·OBS 연결, `state.show`)
- 수정: `packages/llm/src/prompt.ts`(선택 섹션 `[게임 데이터]`, `[방송 단계]`)
- 수정: `apps/server/package.json`(`obs-websocket-js` 고정 버전)
- 생성: `tools/test/fixtures/fake-obs.mjs`(가짜 OBS WebSocket v5), `tools/test/show.mjs`(5단계 전체 통합)
- 테스트: `apps/server/test/show-controller.test.ts`, `game-data.test.ts`, `commands.test.ts`, `obs-controller.test.ts`

### 단계 정의 (`stages.ts`)

```ts
export const stageConfig: Record<ShowStage, { scene: ObsSceneName; dashboard: (ctx: StageContext) => DashboardView; directive: string; fallbackLines: string[] }> = {
  idle:      { scene: "보리-대기", dashboard: ctx => ({ kind: "season", basis: ctx.basis }), directive: "", fallbackLines: [] },
  opening:   { scene: "보리-메인", dashboard: ctx => ({ kind: "season", basis: ctx.basis }),
               directive: "방송을 시작하는 인사를 한다. 오늘은 이터널리턴 랭커 데이터로 메타를 살펴보고, 채팅으로 캐릭터 질문을 받고, 마지막에 전적을 봐 준다고 소개한다. 2문장.",
               fallbackLines: ["안녕하세요, 보리예요! 오늘은 이터널리턴 랭커 데이터로 요즘 메타를 같이 살펴봐요."] },
  briefing:  { scene: "보리-메인", dashboard: ctx => ({ kind: "top5", items: ctx.top5, revealed: 0, basis: ctx.basis }),
               directive: "[게임 데이터]의 TOP 5를 1위부터 짧게 소개한다. 1위에는 놀란다. 수치는 주어진 것만 쓴다. 3문장 이내.",
               fallbackLines: ["이번 랭커 데이터 TOP 5를 볼게요! 화면을 같이 봐 주세요."] },
  qna:       { scene: "보리-메인", dashboard: ctx => ({ kind: "season", basis: ctx.basis }),
               directive: "이제 채팅으로 궁금한 캐릭터를 물어봐 달라고 한다. 예: '재키 어때?'. 1~2문장.",
               fallbackLines: ["궁금한 캐릭터를 채팅으로 물어봐 주세요! 예를 들면 '재키 어때?'처럼요."] },
  diagnosis: { scene: "보리-전적", dashboard: () => ({ kind: "player", status: "waiting", report: null }),
               directive: "채팅에 '!전적 닉네임'을 치면 최근 전적을 봐 준다고 안내한다. 1~2문장.",
               fallbackLines: ["이제 전적 진단 시간이에요! 채팅에 '!전적 닉네임'을 적어 주세요."] },
  ending:    { scene: "보리-엔딩", dashboard: ctx => ({ kind: "summary", characters: ctx.mentioned }),
               directive: "오늘 이야기한 캐릭터를 짧게 돌아보고 마무리 인사를 한다. 2문장.",
               fallbackLines: ["오늘 같이 메타 살펴봐 줘서 고마워요. 다음에 또 만나요!"] },
};
```

`briefing` 단계에서는 보리 답이 나간 뒤 1.2초 간격으로 `revealed`를 1→5로 올린다. diagnosis 단계의 대시보드는 `!전적` 전까지 `waiting`("채팅에 !전적 닉네임을 적어 주세요" 안내 카드)이다.

### 단계
- [ ] **1. 상태 머신 테스트 → 구현.** `createShowController({ obs, speak, er, now })`를 만들고 다음을 확인한다.
  - `next()`는 idle → opening → … → ending, ending에서 `next`는 그대로.
  - `prev()`는 한 단계 뒤로 가고 말하지 않는다.
  - `reset()`은 idle로 간다.
  - 단계에 들어갈 때 `obs.setScene(stage.scene)`(실패해도 진행)과 `speak(directive, gameData)`를 부르고, 실패하면 `fallbackLines[0]`.
  - 같은 단계에서 `next`를 두 번 빠르게 누르면 한 번만 진행한다(진행 중 잠금).
- [ ] **2. OBS 제어 테스트(가짜 OBS) → 구현.**
  - `connect()`, `setScene(name)`, `status()`
  - 끊기면 5초마다 재연결
  - 비밀번호가 틀리면 `error` + 메시지
  - 장면이 없으면 오류를 기록하고 throw하지 않는다
- [ ] **3. `ingestChat` 추출.** `/api/chat`의 처리(점검 F2·F4가 바꾼 정리·길이 상한·viewerId·큐·만료 포함)를 함수로 옮기고, 라우트는 그 함수를 부른다. 기존 통합 검사가 그대로 통과해야 한다(동작 변화 없음). 커밋.
- [ ] **4. 게임 데이터 테스트 → 구현.** `buildGameData(chatContent, ctx)`의 동작:
  - `findCharacter`로 캐릭터를 찾는다.
  - 찾으면 `["캐릭터: 재키", "랭커 픽률: 8.1%", "평균 순위: 3.4위", "1등 비율: 12.0%", "주 무기: 쌍검", "기준: 최근 상위 랭커 7,200판"]` 같은 줄과 대시보드 `character` 뷰를 돌려준다.
  - 못 찾았는데 캐릭터 질문처럼 보이면(어때/세/좋아/추천) `suggestions`를 담은 `character` 뷰(`stat: null`)를 돌려준다.
  - 나머지는 `null`이다.
- [ ] **5. 프롬프트 섹션.** `packages/llm/src/prompt.ts`의 방송 프롬프트에 선택 섹션 두 개를 넣는다.
  - `[방송 단계]`: directive
  - `[게임 데이터]`: 줄 목록 + "이 수치 밖의 숫자는 말하지 않는다. 없으면 모른다고 한다"

  `tools/eval`의 정적 평가에 게임 데이터 시나리오 B-30(수치 그대로 인용)·B-31(데이터 없음 → 모른다)을 추가한다.
- [ ] **6. `!전적` 테스트 → 구현.**
  - `diagnosis` 단계에서만 조회한다. 닉네임 없음, 한 번에 하나만(진행 중이면 "잠깐만요, 지금 보고 있어요"), API 실패, 결과 없음을 다룬다.
  - 결과가 오면 대시보드 `player` `ready`로 바꾸고 `speak("이 전적을 분석하고 조언 한마디. 닉네임은 말하지 않는다.", 리포트 줄)`을 부른다.
  - 리포트는 메모리에만 두고 다음 `!전적`이나 단계 이동 때 버린다.
  - 다른 단계에서 `!전적`이 오면 "전적 진단 때 봐 드릴게요"라고 안내한다.
- [ ] **7. 서버 연결.**
  - 1.2의 API를 연결한다.
  - 치지직 `onChat` → `ingestChat({ source: "chzzk", nickname, content })`
  - `state.show`를 갱신한다(자막은 보리 답과 같이).
  - ER 사전은 서버 시작 때 `data/er-dictionary.json`이 있으면 읽고, 없으면 `missing`이다.
  - 메타 집계는 `/api/er/refresh`로 백그라운드에서 돌려 `data/er-meta.json`에 원자적으로 쓴다.
  - 치지직 토큰이 있으면 시작 때 자동 연결한다.
  - OBS는 `OBS_WEBSOCKET_PASSWORD`가 있으면 자동 연결한다.
- [ ] **8. 통합 `tools/test/show.mjs`.** mock LLM + 가짜 OBS + 가짜 치지직 + 가짜 ER 서버로 다음 흐름을 확인하고 `run.mjs`에 등록한다.
  1. `next`×5로 장면 전환 순서가 대기→메인→메인→메인→전적→엔딩인지 확인한다.
  2. 치지직 채팅 "재키 어때?" → 대시보드 `character`, LLM 요청 본문에 `[게임 데이터]`와 "8.1%"가 들어 있는지 확인한다.
  3. `!전적 테스트닉` → 대시보드 `player` `ready`, 화면 상태에 원래 닉네임이 없고 가린 닉네임만 있는지 확인한다.
  4. OBS를 끊어도 진행되는지 확인한다.
- [ ] **9. 실제 확인(사용자 환경).** 사용자의 치지직 앱 키로 `/api/chzzk/login` → 콜백 → 실제 채팅 1건 수신을 확인한다. 사용자가 브라우저 로그인을 해야 하므로 코디네이터에게 ask로 요청한다. 결과를 PR에 적는다.
- [ ] **10. 기준선 검사, 문서(`docs/progress.md` 10절 "치지직 방송 시스템", ADR-026 방송 진행기와 외부 연동), 커밋, PR.**

**완료 기준:** 가짜 외부 서비스로 5단계 방송 전체가 자동 검사로 돈다. 실제 치지직 채팅 1건이 들어오는 것을 확인한다(또는 미검증 사유).

---

## W5. 보리 스튜디오

**파일:**
- 수정: `apps/admin/electron/main.cjs`
  - 서버 자식 프로세스 실행·종료. 이미 4310에 서버가 있으면 그것을 쓴다.
  - 창 제목 "보리 스튜디오"
  - 기본 URL `http://127.0.0.1:4310/studio/`
- 생성: `apps/admin/electron/server-process.cjs`(서버 실행, 루트 `.env` 전달, 로그 파일, 종료 시 정리)
- 수정: `apps/admin/vite.config.ts`(`base: "/studio/"`), `apps/companion/vite.config.ts`(`base: "/companion/"`)
- 생성: `apps/admin/src/studio/{App.tsx,OperateTab.tsx,CompanionTab.tsx,SettingsTab.tsx,api.ts}` — 기존 `main.tsx`의 관리 화면은 `SettingsTab`으로 옮긴다
- 수정: `apps/admin/index.html` CSP(`frame-src http://127.0.0.1:4310`)
- 수정: 루트 `package.json`(`"studio": "npm run build:broadcast && npm run build:companion && npm run build:admin && npm --workspace apps/admin run start"`)
- 테스트: `apps/admin/test/server-process.test.ts`, `apps/admin/test/operate.test.ts`

### 단계
- [ ] **1. 서버 실행 테스트 → 구현.**
  - `findRunningServer(port)`는 `/api/health`가 200이면 true다.
  - `startServer({ cwd, env, logPath })`는 `node --import tsx apps/server/src/index.ts`를 띄우고 `/api/health`가 될 때까지 최대 20초 기다린다.
  - 앱을 끌 때 자식만 종료한다(외부 서버는 건드리지 않음).
  - `.env`는 `process.loadEnvFile` 또는 F7이 정한 방식으로 읽는다.
- [ ] **2. 운영 탭 순수 함수 테스트 → 구현.** 다음을 `operate.ts`에 두고 테스트한다.
  - `stageLabel(stage)`: "① 오프닝" 등
  - `nextLabel(stage)`: "메타 브리핑 시작" 등, ending이면 "끝"
  - `connectionBadge(conn)`: 색·문구
  - `obsUrls(base)`: 6개 주소
- [ ] **3. 운영 탭 화면.**
  - 위쪽: 현재 단계 큰 글씨, "다음 단계"(Space 단축키), "이전", "처음으로"(확인창)
  - 가운데: 연결 상태 5개(치지직·OBS·LLM·ER·TTS), "치지직 연결"(기본 브라우저로 `/api/chzzk/login`), "데이터 갱신"(진행률·마지막 갱신 시각·기준 문구)
  - 아래: 테스트 채팅 입력(IME 가드 재사용), 최근 채팅·보리 답 로그 10줄, OBS 주소 복사 버튼 6개
  - 폴링은 기존 `poll.ts`(겹침 방지) 1초
- [ ] **4. 1:1 탭.** `<iframe src="/companion/">`. 1:1 앱이 `/companion/` 아래에서 동작하는지 확인한다(API 경로는 절대 경로 `/api/...`라 그대로 된다).
- [ ] **5. 설정 탭.** 기존 관리 화면을 그대로 옮긴다. 치지직 연결 해제 버튼과 OBS 연결 상태를 추가한다.
- [ ] **6. 실행 확인.** `npm run studio`로 앱이 서버를 띄우고, 세 탭이 뜨고, 앱을 끄면 서버가 꺼지는지 확인한다. Electron 창 확인 결과를 PR에 적는다.
- [ ] **7. 기준선 검사, README 실행 절("보리 스튜디오로 실행"), 커밋, PR.**

**완료 기준:** `npm run studio` 하나로 방송 운영이 된다. 브라우저를 열 필요가 없다(치지직 로그인 한 번 제외).

---

## W6. 제출 문서와 리허설

**파일:** `docs/broadcast/{plan,structure,direction,cue-sheet,obs-setup,rehearsal-checklist}.md`, 그림은 `docs/broadcast/assets/`(구매 모델이 보이지 않는 와이어프레임 SVG만. 실제 화면 캡처는 사용자 확인 전 커밋 금지).

### 단계
- [ ] **1. 기획서 `plan.md`.**
  - 콘셉트: "AI 버튜버 보리가 실제 이터널리턴 데이터로 진행하는 메타 브리핑"
  - 주요 시청자: 이터널리턴 입문·중수 플레이어, AI 버튜버에 관심 있는 시청자
  - 참여 방식: 채팅 질문, `!전적`
  - 재미 요소: 실시간 데이터, AI의 즉석 반응·표정, 내 전적 진단
  - AI 버튜버만의 차별점과 한계(표본 기준, AI 발언 책임)
- [ ] **2. 구성안 `structure.md`.** 5단계별 목표, 시청자가 할 일, 보리가 할 일, 성공 기준.
- [ ] **3. 연출 `direction.md`.**
  - OBS 장면 4개의 소스 목록과 배치 그림(SVG 와이어프레임)
  - 전환(페이드 300ms, 스팅어는 선택)
  - 상황별 보리 감정·모션 표(데이터 좋음 → happy, 1위 발표 → surprised, 성적 나쁨 → sad, 데이터 없음 → awkward 등, `boriEmotionMap` 기준)
  - 채팅 반응 규칙
- [ ] **4. 큐시트 `cue-sheet.md`.**
  - 표 열: 시각 | 길이 | 순서 | OBS 장면 | 화면(대시보드) | 보리 대사 방향 | 진행자 동작 | 비고
  - 0:00~4:30
  - 아래에 돌발 상황 대응표(설계 10절)
- [ ] **5. OBS 설정 안내서 `obs-setup.md`.**
  - OBS 설치·버전
  - WebSocket 서버 켜기·비밀번호 → `.env`
  - 장면 4개와 소스 추가(브라우저 소스 URL, 1920×1080, "Control audio via OBS"는 character만, 오디오 모니터링)
  - 전환 설정
  - 치지직 송출 설정(서비스 CHZZK 또는 사용자 지정 서버 `rtmp://global-rtmp.lip2.navercorp.com:8080/relay`, 스트림 키는 치지직 스튜디오에서, 1080p·8000kbps CBR·키프레임 1초·하드웨어 인코더)
  - 녹화 설정(MKV 녹화 후 MP4로 리먹스)
- [ ] **6. 리허설 체크리스트 `rehearsal-checklist.md`.**
  - 방송 전 D-1: 데이터 갱신, 치지직 연결
  - 30분 전: OBS 장면 확인, 소리 확인, 테스트 녹화 30초
  - 직전: 채팅 계정 로그인, 스튜디오 "처음으로"
  - 방송 중: 큐시트 따라가기
  - 끝난 뒤: 녹화 파일 확인, 다시보기 링크
- [ ] **7. 리허설 1회(코디네이터와 사용자).** 실제 OBS·치지직 비공개 테스트 방송으로 큐시트를 따라가 보고, 걸린 시간과 문제를 문서에 반영한다.
- [ ] **8. 커밋, PR.**

**완료 기준:** 문서 6종이 실제 구현(주소, 버튼 이름, 장면 이름)과 일치한다. 리허설에서 나온 문제가 반영돼 있다.

---

## 3. 점검 후속 수정과의 관계

| 점검 묶음 | 처리 |
|---|---|
| F2 위기·주입 | W4 전에 병합. `ingestChat` 추출은 F2가 바꾼 `/api/chat`을 기준으로 한다 |
| F3 기억 정확도 | 그대로 진행(W와 겹치는 파일 적음) |
| F4 출력 검증·방송 운영 | 옛 방송 화면 음성 수정(`apps/broadcast/src/main.tsx` 재생 부분)과 관리자 상태 표시 부분은 뺀다. 출력 검증·요약·세션 멱등·큐 만료·라우팅·`/voices` 캐시는 그대로 |
| F7 빌드·문서 | 그대로 진행. `.env` 로드 방식을 여기서 정하고 W5가 따른다 |
