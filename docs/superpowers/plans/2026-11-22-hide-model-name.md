# Live2D 모델 이름 비공개화 계획

1. 추적 파일 전체 검색과 SDK 텍스트 읽기로 경로 조합을 확인한다.
2. 가짜 모델 기반 검사를 먼저 바꾸고 실패를 확인한다. 기본 경로, 환경변수 상대·절대 경로, 유일한 manifest 검증, dev·빌드 URL, SDK 상수 주입을 검사한다.
3. 기본 위치는 `private-assets/live2d-model/`, 환경변수는 `BORI_LIVE2D_MODEL_DIR`로 정한다. 공개 manifest URL은 `/private-model/model/model.model3.json`으로 매핑한다. SDK 파일은 수정하지 않고 Vite transform에서 경로 상수를 주입한다.
4. 루트의 미등록 폴더를 기본 무시하고 기존 소스 폴더만 허용하여 이전 위치의 모델 전체를 보호한다. 문서의 상품명은 일반 예제로 치환하고 설치 안내를 고친다.
5. typecheck, test:unit, test, test:harness, test:dashboard-smoke를 실행하고 PR 및 CI를 확인한다. 실제 자산 이동과 렌더링 검증은 병합 후 코디네이터가 한다.

## 확인
SDK는 ModelDir의 폴더명과 manifest 기본 이름을 동일하게 조합한다. 따라서 일반 manifest 별칭을 서빙하면 SDK 관리 코드를 수정할 필요가 없다. 서버는 이미 `/private-model/` 전체를 companion dist에 연결하므로 변경하지 않는다.
