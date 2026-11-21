# X3 캐릭터 설정·보안·찌꺼기·문서 보완 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 점검 V3 보고서(2026-11-21)의 남은 항목 가운데 X3 몫(캐릭터 설정, `/studio/` 클릭재킹, 죽은 코드, 의존 선언, 낡은 설명, 문서)을 고친다.

**Architecture:** 동작을 바꾸는 곳은 두 군데다. `packages/character`의 문장(메타 분석 진행자로)과 서버 정적 응답 헤더(`apps/server/src/http/static.ts`). 나머지는 쓰지 않는 코드 삭제와 문서·설명 정리다. 기준은 통합 브랜치 `feature/er-meta-dashboard` @ 95ef8ec, 작업 브랜치 `feature/dash-fix-x3-docs`.

**Tech Stack:** Node 22+, TypeScript, npm workspaces, `node:test` + `tsx`

---

## 범위 밖 (손대지 않는다)

- 보고서 1·7·9절과 대시보드 화면 CSP → X2. `packages/er`·`packages/shared` 옛 ER 타입, 닉네임 서버 정리(4절) → X1.
- 12절(로컬 잔여 폴더), 16절(모델 폴더 이름) → 코디네이터가 사용자에게 묻는다.
- `apps/admin`, `apps/companion`, `apps/server/src/{er,narration}`, `apps/server/src/index.ts`, `packages/llm`, `tools/test`의 mock-openai·README 밖 파일. 11절 표에서 이 경로에 있는 주석(admin·companion·retention·usage store·llm retry·shared:211)은 PR "남은 문제"에 적는다.
- `apps/server/src/secret-store.ts`의 `":bori-ai-vtuber"` 키 파생 재료.

## 고정 조건

- `@bori/character`의 export 네 개 `boriName`(string), `boriProfileLines`·`boriPersonaLines`·`boriScopeLines`(`readonly string[]`)는 이름·타입을 그대로 둔다. X2가 `writer.ts`에서 import한다. 다른 export는 원래 없다.
- `apps/server/package.json`의 `@bori/character` 의존은 X2가 쓰게 되므로 **남긴다**(보고서 10절과 다르게 한다).

## 파일 구조

| 파일 | 바뀌는 것 |
|---|---|
| `packages/character/src/index.ts` | 문장·주석을 메타 분석 진행자로 |
| `packages/character/test/character.test.ts` | 새 문장 기준으로 다시 씀 |
| `apps/server/src/http/static.ts` | 모든 정적 응답에 `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` |
| `apps/server/test/static.test.ts` | 헤더 검사, 고정 자료 이름(채팅·1:1) 정리 |
| `apps/server/test/guard-path.test.ts` | 지운 `/api/memory/:id` 예시 정리 |
| `packages/live2d/src/index.ts` | `boriExpressionLabels`·`boriMotionLabels`·`boriMotionDescriptions` 삭제, 틀린 주석 고침 |
| `tools/test/mock-openai.mjs` | 요약·기억 정리·임베딩 경로 삭제(narration 경로는 그대로) |
| `apps/admin/package.json`, `apps/companion/package.json`, `package-lock.json` | admin→live2d 삭제, companion→shared 추가, lock 맞춤 |
| `.gitignore`, `.env.example`, `tools/test/README.md` | 낡은 설명 |
| `docs/macros.example.json` | 삭제 |
| `docs/content/character-bible.md` | 메타 진행자 기준으로 다시 쓰고 예전 설정은 "기록" 절로 |
| `docs/content/persona-guidelines.md`, `docs/content/evaluation.md` | 맨 위에 기록 문서 표시 |
| `README.md`, `docs/index.html`, `docs/operations.md`, `docs/architecture.md` | `/api/er/status` 정리, "구현 중" → 실제 상태, 의존 그림 |
| `docs/verification-log.md` | 지금 기준 자동 검사 절 추가(예전 0절은 기록으로) |
| `docs/progress.md` | 맨 위 문서 지도, 11절 상태 갱신 |
| `docs/superpowers/specs/…design.md:95`, `plans/…dashboard.md:199,323` | 감정 이름 출처 오기(`packages/character` → `packages/live2d`) |

---

### Task 1: 캐릭터 설정을 메타 분석 진행자로

**Files:** Modify `packages/character/src/index.ts`, Test `packages/character/test/character.test.ts`

- [x] **Step 1: 실패하는 검사로 바꾼다**

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boriName, boriPersonaLines, boriProfileLines, boriScopeLines } from "../src/index.js";

/** 2026-11-21 방송·1:1 대화를 지우고 보리를 이터널리턴 메타 분석을 읽어 주는 진행자로 바꿨다. */
const all = [...boriPersonaLines, ...boriScopeLines].join("\n");

test("이름과 정체성은 메타 분석을 읽어 주는 AI 캐릭터다", () => {
  assert.equal(boriName, "보리");
  assert.ok(boriPersonaLines.includes("- 이름: 보리"));
  assert.ok(boriPersonaLines.includes("- 정체성: 이터널리턴 메타 분석을 읽어 주는 AI 캐릭터. 필요할 때만 그렇게 소개하고 시스템 용어를 늘어놓지 않는다."));
});

test("방송·채팅·1:1 대화 시절 낱말이 남지 않는다", () => {
  for (const word of ["방송", "스트리머", "채팅", "시청자", "여러분", "닉네임", "1:1", "반말", "상대에게", "물으면", "고민", "화제"]) {
    assert.ok(!all.includes(word), word);
  }
});

describe("자기 설정 (ADR-025, 2026-11-21 진행자 기준으로 꼬리를 뗌)", () => {
  test("자기 설정은 페르소나에 모두 들어간다", () => {
    for (const line of boriProfileLines) assert.ok(boriPersonaLines.includes(line), line);
  });

  test("바꾼 문장", () => {
    for (const line of [
      "- 좋아하는 음악: 신나는 애니메이션 노래와 잔잔한 피아노 연주곡.",
      "- 사는 곳: 메타 대시보드 화면 속. 바깥 일은 화면에 들어온 데이터로만 안다.",
      "- 나이·생일: AI라 나이는 없다. 생일은 정해 본 적이 없다.",
      "- 가족: 없다.",
      "- 싫어하는 것: 데이터가 오래돼서 지난 메타를 말해야 하는 것",
      "- 주어진 수치에 없는 일(날씨·뉴스·패치 내용)은 말하지 않는다.",
    ]) assert.ok(boriProfileLines.includes(line), line);
  });

  test("그대로 둔 문장", () => {
    for (const fact of ["보리차와 보리빵", "이터널리턴. 리듬 게임도 좋아한다", "연한 금빛", "MBTI: 검사해 본 적이 없다"]) {
      assert.ok(boriProfileLines.join("\n").includes(fact), fact);
    }
  });
});

test("말투는 존댓말 한 줄만 둔다", () => {
  assert.equal(boriPersonaLines.filter(line => line.includes("존댓말")).length, 1);
  assert.ok(boriPersonaLines.includes("- 한국어 존댓말만 사용한다."));
});

test("범위는 주어진 수치만 말하고 수치에 없는 게임 내용은 말하지 않는다", () => {
  assert.deepEqual([...boriScopeLines], [
    "- 말하는 것: 주어진 이터널리턴 메타 수치와 내 전적 요약",
    "- 말하지 않는 것: 수치에 없는 무기 특성·스킬·빌드 효과·패치 내용·강해지고 약해진 이유",
  ]);
});
```

- [x] **Step 2: 실패 확인** — `node --import tsx --test packages/character/test/character.test.ts` → 정체성·낱말·바꾼 문장·범위 검사 실패
- [x] **Step 3: `index.ts` 문장 교체** — 보고서 2절 표와 과제 지시의 문장 그대로. 주석: 사람용 원본은 캐릭터 바이블만(페르소나 가이드라인은 기록), 이름 주석은 "대시보드 자막처럼", 정체성 출처 주석 "요구사항 2장, 2026-11-21 메타 분석 진행자로", 범위 주석에서 "서버가 위험 주제를 거른다" 삭제(지금은 그런 필터가 없다; 대사는 narration 숫자·이름 검사가 거른다). "위에 없는 자기 사실을 물으면" 줄은 질문 경로가 없어 지운다(날씨·뉴스 줄과 같이 한 줄로 합친다).
- [x] **Step 4: 통과 확인** — 같은 명령 → PASS
- [x] **Step 5: 커밋** `캐릭터: 보리 설정을 메타 분석 진행자 기준으로 바꾼다`

### Task 2: `/studio/` 클릭재킹 방지

**Files:** Modify `apps/server/src/http/static.ts`, Test `apps/server/test/static.test.ts`

- [x] **Step 1: 실패하는 검사** — `send()`가 `frameAncestors`(content-security-policy)·`frameOptions`·`nosniff` 헤더도 돌려주게 하고 다음을 더한다.

```ts
test("모든 정적 응답은 다른 출처의 iframe을 막고 MIME 추측을 끈다", async () => {
  for (const path of ["/private-model/page.html", "/companion/", "/private-model/none.html", "/studio/"]) {
    const result = await send(path);
    assert.equal(result.csp, "frame-ancestors 'self'", path);
    assert.equal(result.frameOptions, "SAMEORIGIN", path);
    assert.equal(result.nosniff, "nosniff", path);
  }
});
```

(같은 출처 iframe인 스튜디오 → `/companion/`은 `'self'`라 그대로 뜬다. 응답 헤더 CSP는 `frame-ancestors`만 담아 화면의 meta CSP를 넓히지 않는다.)

- [x] **Step 2: 실패 확인** — `node --import tsx --test apps/server/test/static.test.ts`
- [x] **Step 3: 구현**

```ts
/**
 * 정적 응답 보안 헤더. 스튜디오(/studio/)는 API 키를 다루므로 다른 웹사이트가 iframe으로 덮어 버튼을 누르게 하지 못하게 한다(클릭재킹).
 * frame-ancestors는 meta CSP로는 효과가 없어 응답 헤더로 준다. 스튜디오가 /companion/을 iframe으로 띄우는 것은 같은 출처라 그대로 된다.
 * X-Frame-Options는 frame-ancestors를 모르는 브라우저용이다.
 */
export const staticSecurityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
} as const;
```

`serveStatic`에서 접두사가 맞으면 맨 먼저 `for (const [name, value] of Object.entries(staticSecurityHeaders)) response.setHeader(name, value);` (503·404·200 모두에 붙는다).

- [x] **Step 4: 통과 확인**, 고정 자료 이름 `chat.html`→`page.html`, "채팅"·"1:1" 문구 정리. `guard-path.test.ts`의 `/api/memory/:id` 예시를 `/api/tts/:id`로.
- [x] **Step 5: 커밋** `보안: 정적 화면 응답에 frame-ancestors와 X-Frame-Options를 붙인다`

### Task 3: 죽은 코드

- [x] `git grep`으로 `boriExpressionLabels|boriMotionLabels|boriMotionDescriptions` 사용처가 `packages/live2d/src/index.ts` 밖에 없음을 확인하고 지운다. `boriEmotionMap`·`resolveMotion` 주석의 "서버 CharacterResponse·방송 로직"을 지금 쓰임(대사 줄의 감정 이름, 대시보드 reaction.ts)으로 고친다.
- [x] `tools/test/mock-openai.mjs`: `/__summary`, `MOCK_COMPANION_SUMMARY`·`broadcastSummary`, `MOCK_DIGEST_MEMORIES`·`DIGEST_ECHO_MARK`·`companionLines`, `replyFor`의 memories·highlights·summary 분기, `/embeddings`·`embeddingFor`·`createHash`, `timing.embed`·`MOCK_EMBED_MS`를 지운다. `/__timing`은 llm·tts만 바꾸고 다른 값(하네스가 보내는 embed)은 무시한다. 주석의 "방송 화면이 재생을 시도" → "대시보드가". `lines` 경로·`reply` 기본 응답은 그대로.
- [x] `docs/macros.example.json` 삭제. `docs/progress.md:186`(기록)의 링크는 "삭제된 파일, git 기록에 있음"으로.
- [x] `npm run test:unit`, `npm test` 통과 확인 후 커밋 `정리: 쓰지 않는 모션 설명·가짜 API 요약·임베딩 경로·매크로 예시를 지운다`

### Task 4: 의존 선언과 낡은 설명

- [x] `apps/admin/package.json`에서 `@bori/live2d` 삭제, `apps/companion/package.json`에 `"@bori/shared": "0.1.0"` 추가. `npm install`로 lock을 맞추고 `git diff package-lock.json`이 두 워크스페이스 의존 줄만 바꿨는지 본다.
- [x] `.gitignore` 설명: `data/` "기억 JSON" → "설정·암호화된 API 키·집계·사용량·로그", `obs-shot*.png` 설명은 "예전 OBS 송출 캡처. 구매 모델이 렌더링된 이미지라 패턴은 남긴다", `tools/eval/results/`·`soak*.json`은 "지운 도구가 로컬에 남겼을 수 있는 결과. 실수로 올리지 않게 패턴은 남긴다".
- [x] `.env.example` `BORI_ADMIN_URL`: "비우면 `npm run studio`는 `http://127.0.0.1:{BORI_SERVER_PORT}/studio/`, 개발(`npm run dev`, --dev)은 `http://127.0.0.1:5174`. 루프백 주소만 받는다". "관리자 앱" → "스튜디오".
- [x] `tools/test/README.md`: 포트 `4310, 4175, 4176, 5174`, mock-openai 설명 "답변·음성 경로", 실패 주입 target `llm|tts`.
- [x] `npm run typecheck`, `npm run test:unit` 후 커밋 `정리: 의존 선언을 실제 import에 맞추고 낡은 설명을 고친다`

### Task 5: 문서

- [x] 캐릭터 바이블: 1~5절을 진행자 기준(정체성·성격·말투·세계관·자기 설정·감정 표현·말하는 범위)으로 다시 쓰고, 예전 1~8절은 "부록: 방송·1:1 시절 설정 (기록)"으로 그대로 옮긴다. 5.1절 표는 Task 1 문장과 같아야 한다.
- [x] persona-guidelines·evaluation 맨 위에 "방송·1:1 시절 기록. 지금 설정은 캐릭터 바이블" 표시.
- [x] README: 상태 표를 #53 기준으로(`/api/dashboard`·자동 갱신·읽어 주기·닉네임 저장 라우트 연결됨, 대시보드 흐름 통합 검사), `/api/er/status` 줄 정리, "현재 한계"에서 "서버에 이어지지 않았다" 삭제하고 "실제 키·Live2D 화면으로 끝까지 확인하지 않았다"는 남긴다. 문서 표의 페르소나 가이드라인 설명과 맞춘다.
- [x] `docs/index.html`: meta description·notice·상태 목록을 같은 기준으로.
- [x] `docs/operations.md`: 맨 위 "구현 중" 안내 삭제, 4절 상태 줄 → `GET /api/dashboard`, 대시보드 라우트 표 추가(설계 4절의 라우트, 실제 `dashboard-routes.ts`와 대조).
- [x] `docs/architecture.md`: "(구현 중)" 표시 삭제, 의존 그림을 실제 import대로(er·llm → shared, character·live2d 의존 없음, server → shared·er·llm·live2d(+character 선언), companion → shared·live2d, admin → shared), 문장 정정. 보안 경계에 정적 응답 헤더 한 줄.
- [x] `docs/verification-log.md`: 맨 위에 "0. 자동 검사 (2026-11-21, 메타 대시보드)" 새 절 — 실제로 돌린 typecheck·test:unit·npm test 건수, 커밋, 단위 검사 파일 표. 예전 0절은 "0-기록. 자동 검사 (2026-10-12)"로 내린다. 머리말의 "CI 설정은 없어" 정정.
- [x] `docs/progress.md`: 문서 지도를 README 표와 같게(지난 문서는 "기록" 열), 11.1 마무리 상태와 11.5 남은 것 갱신, 11.6 점검 V3 정리 기록.
- [x] 설계·총괄 계획의 감정 이름 출처 오기 정정.
- [x] 커밋 `문서: …` 몇 개로 나눈다.

### Task 6: 검증과 PR

- [x] `npm run typecheck`, `npm run test:unit`, `npm test` 실제 실행, 건수 기록(verification-log 값과 같은지 확인)
- [x] push, `gh pr create --base feature/er-meta-dashboard`, 본문에 캐릭터 문장 전후 표와 export 목록
- [x] `gh pr checks --watch`로 CI 통과까지 확인
