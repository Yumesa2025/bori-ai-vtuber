/**
 * 대시보드 화면 문구 중 React·DOM에 묶이지 않는 부분. 화면 밖 단위 검사(test/ui.test.ts)에서 그대로 부른다.
 */

/** 정해진 문장 대사 안내. LLM을 못 쓴 경우와 검사로 줄이 다 버려진 경우 모두라 이유는 말하지 않는다(점검 V2 21번). */
export const TEMPLATE_NARRATION_HINT = "정해진 문장으로 읽어 드려요";

/** 읽기 결과별 안내. 자동 재생 차단만 화면을 눌러 풀 수 있다. */
export function speechNotice(outcome: "audio" | "text" | "audioBlocked" | "audioFailed" | "done" | "cancelled"): string | null {
  if (outcome === "audioBlocked") return "브라우저가 소리 재생을 막았어요. 화면을 한 번 누른 뒤 '다시 듣기'를 눌러 주세요.";
  if (outcome === "audioFailed") return "음성을 재생하지 못한 줄은 자막으로만 보여 드렸어요.";
  return null;
}
