# Y3 검사 하네스·CI·문서 구현 계획

**Goal:** C3-1~5와 C1-4 문서 지적을 지정 경계 안에서 수정한다.
**Architecture:** 포트 사전 바인딩과 실행별 nonce로 소유 서버를 확인하고 모든 공용 HTTP 읽기에 전체 deadline을 적용한다. 기존 dev:mock과 Chromium으로 공개 자산만 사용하는 UI smoke를 만든다.
**Tech Stack:** Node test, fetch AbortSignal, Vite mock, Playwright Chromium.

## 1. 하네스 회귀 검사와 구현
- [ ] tools/test/harness.test.mjs에 점유 포트의 가짜 HTTP 서버를 만들고 run.mjs를 실행하여 실패 코드와 PATCH 0건을 확인한다.
- [ ] 같은 파일에서 헤더 무응답·본문 미완료 서버를 두고 waitForHttp와 createBoriClient가 150ms deadline 후 실패하는지 확인한다. 외부 2초 제한으로 옛 구현 실패를 관찰한다.
- [ ] `node --test tools/test/harness.test.mjs`로 RED를 확인한다.
- [ ] tools/test/harness.mjs에 빈 포트 할당, nonce 확인, 자식 종료/오류 감시, 본문까지 timeout을 구현한다. run.mjs는 서버 준비 전에 포트를 검사하고 nonce를 전달한다. apps/server/src/index.ts의 health 응답만 최소 수정한다.
- [ ] dashboard.mjs는 dashboard 요청에 남은 deadline을 전달하는 부분만 수정한다.
- [ ] 동일 검사 GREEN 후 지정 파일만 add하여 한국어 커밋한다.

## 2. 공개 자산 UI smoke
- [ ] tools/test/dashboard-smoke.mjs에서 기존 dev:mock Vite를 실행하고 표, 두 번째 조합 상세 선택, replay POST, 키 없음 안내와 비활성 갱신 버튼을 검증한다.
- [ ] 루트 package.json에 test:dashboard-smoke와 test:harness를 추가하고 Playwright devDependency를 lock과 함께 설치한다.
- [ ] `npm run test:dashboard-smoke`를 실행하고 실패 원인을 확인하여 smoke를 완성한다. companion 소스는 변경하지 않는다.
- [ ] .github/workflows/ci.yml에 하네스 회귀와 Chromium 설치·smoke 단계를 추가하고 커밋한다.

## 3. 문서와 주석
- [ ] README.md, docs/index.html, docs/architecture.md에서 서버 사실 문장 조립과 LLM의 사실 선택·짧은 감상 역할을 설명한다. 감상은 숫자·한글 수·이름·영문·효과/빌드/패치류 단어를 금지하지만 내용 정확성은 보장하지 않는다고 명시한다.
- [ ] docs/decisions.md ADR-028에 과거 결과를 남긴 채 PR #50~#56 및 이번 라운드 후 갱신을 덧붙인다.
- [ ] docs/security-review.md와 secret-store.ts 주석에 공개 사용자명·호스트명으로 다른 환경에서도 복호화될 수 있음과 DPAPI/safeStorage 이전 후속 과제를 적는다. 키 파생 문자열과 코드 동작은 유지한다.
- [ ] README 검사 표에 새 검사 명령을 추가하고 문서 커밋한다.

## 4. 완료 검증과 전달
- [ ] npm run typecheck, npm run test:unit, npm test, npm run test:harness, npm run test:dashboard-smoke 실행 결과를 기록한다.
- [ ] git diff --check와 파일 경계를 확인하고 push, base feature/er-meta-dashboard PR을 만든다.
- [ ] gh pr checks로 CI의 새 smoke 포함 통과를 확인한다. 병합하지 않는다.
- [ ] 세 문장 worker_done에 PR·커밋·검사 숫자·계획 차이·남은 한계를 보고한다.

직접 실행 지시를 우선하여 스킬의 별도 위임/실행 선택 질문은 생략한다. 실제 Live2D와 이번 Y2 구현 확인은 통합 담당자가 맡는다.
