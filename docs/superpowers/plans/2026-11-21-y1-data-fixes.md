# Y1 데이터·서버 수정 TDD 계획

superpowers 스킬이 제공되지 않아 같은 TDD 절차를 직접 따른다. 기준 35c3348, 작업 브랜치 feature/dash-fix-y1-data. 코디네이터가 이 계획 파일만 docs 경계 예외로 허용했다.

1. C1-1: 중단되지 않는 헤더/본문과 재시도 본문 취소 검사를 먼저 실패시킨다. 요청별 timeoutMs(기본 15000), 동일 AbortController와 전체 deadline으로 큐를 해제한다. 서버 갱신·전적 상태 회귀 검사를 추가한다.
2. C1-2: 사전+메타를 er-snapshot.json 한 파일에 원자적으로 저장한다. 기존 두 파일은 새 스냅샷이 없을 때만 읽는다. 저장 실패 및 커밋 직전 남은 임시 파일, 재시작, 이전 형식 마이그레이션을 검사한다. 단일 파일로 두 번째 데이터 쓰기 자체를 제거한다.
3. C1-3: 보고서의 60명/30명 합성 입력, 전 행 손상, 빈 집계, 잘못된 개수/빈도/합계를 먼저 실패시킨다. 전체 스냅샷을 거부하고 history는 오래된 정상 항목으로 폴백한다. missing 자동 갱신을 확인한다.
4. 각 구현 단위마다 관련 node:test를 실행하고 작은 한국어 커밋을 만든다. 최종 npm run typecheck, npm run test:unit, npm test를 실행한다. push 후 통합 브랜치 대상으로 한국어 PR을 만들고 gh pr checks --watch를 실행한다. 병합하지 않는다.

경계: packages/er, 서버 er 및 관련 검사. shared, narration, UI, tools/test, 비밀 파일은 수정하지 않는다. 모든 데이터 검사는 임시 폴더에서 실행한다.
