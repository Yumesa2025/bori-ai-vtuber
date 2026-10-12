/**
 * 체감 지연 검사.
 *
 * 답변 전 5~10초 랜덤 지연은 연출이지 계산 시간이 아니다.
 * 대기가 끝난 뒤에 LLM과 TTS를 부르면 둘이 그대로 더해지고,
 * 나란히 돌리면 둘 중 늦은 쪽만 걸린다. 그 차이를 실제로 잰다.
 *
 * 가짜 API 지연을 임베딩 0.3초 + LLM 2초 + TTS 1.5초 = 3.8초로 고정해 두므로
 * 기대값을 미리 계산할 수 있다.
 */
import { baseQueueSettings } from "./harness.mjs";

const EMBED_MS = 300;
const LLM_MS = 2000;
const TTS_MS = 1500;
const WORK_MS = EMBED_MS + LLM_MS + TTS_MS;

export const meta = {
  name: "지연",
  timing: { llm: LLM_MS, tts: TTS_MS, embed: EMBED_MS },
};

export async function run({ bori, mock, report }) {
  await bori.patchSettings({ ...baseQueueSettings, responseDelayMinSeconds: 6, responseDelayMaxSeconds: 6 });
  await bori.startSession();

  const info = await bori.llm();
  report.check("매크로 파일 로드 (키워드 없는 항목은 버려짐)", info.macro.loaded === 2, `loaded=${info.macro.loaded}`);
  report.check("시스템 프롬프트 크기 노출", typeof info.systemPromptChars === "number" && info.systemPromptChars > 0, `${info.systemPromptChars}자`);

  // ── 대기 6초 vs 작업 3.8초 ─────────────────────────────────
  {
    const serialMs = 6000 + WORK_MS;
    await bori.chat("아디나 카운터가 뭔가요");
    const { ms, response, audioId } = await bori.waitForReply();

    report.check(`대기와 생성이 겹친다 (기대 ~6.0초, 직렬이면 ~${(serialMs / 1000).toFixed(1)}초)`, ms >= 5500 && ms <= 7200, `${ms}ms`);
    report.check("답변이 LLM에서 왔다", response?.source === "llm", `source=${response?.source}`);
    report.check("음성이 붙었다", typeof audioId === "string" && audioId.length > 0, audioId ? "있음" : "없음");
  }

  // ── 프롬프트에 무엇이 들어갔는지 ───────────────────────────
  {
    const answers = await mock.answerCalls();
    const last = answers.at(-1);

    report.check("매크로 텍스트가 프롬프트에 주입됨", last.user.includes("아디나는 얼음 속성"), last.user.includes("[참고 정보]") ? "[참고 정보] 있음" : "[참고 정보] 없음");
    report.check("키워드가 맞지 않는 매크로는 주입되지 않음", !last.user.includes("보리의 생일은"));
    report.check("방송 상황 숫자가 들어감", last.user.includes("[방송 상황]"), last.user.split("\n").find(line => line.startsWith("- 방송")) ?? "");
    report.check("기억이 들어감", last.user.includes("잔잔한 인디 음악"));

    const order = (await mock.calls()).filter(entry => ["embed", "llm", "tts"].includes(entry.kind)).map(entry => entry.kind);
    report.check("호출 순서: 임베딩 → LLM → TTS", order.slice(0, 3).join(">") === "embed>llm>tts", order.join(" > "));
  }

  await bori.waitForIdle();

  // ── 중복 채팅 창 ───────────────────────────────────────────
  {
    const first = await bori.chat("중복 테스트 문장입니다");
    const second = await bori.chat("중복 테스트 문장입니다");
    report.check("같은 문장은 창 안에서 거부됨", first.status === 200 && second.status === 400, `${first.status} / ${second.status}`);

    // 창을 0으로 줄이면 같은 문장이 다시 들어가야 한다. 예전에는 Set이라 세션 내내 막혔다.
    await bori.patchSettings({ duplicateWindowMinutes: 0 });
    const third = await bori.chat("중복 테스트 문장입니다");
    report.check("창이 지나면 같은 문장이 다시 들어감", third.status === 200, `status=${third.status}`);
    await bori.patchSettings({ duplicateWindowMinutes: 1 });
  }

  await bori.waitForIdle();
  await bori.waitForIdle();

  // ── 대기를 1초로 줄이면 작업 시간이 지배한다 ────────────────
  {
    await bori.startSession();
    await bori.patchSettings({ ...baseQueueSettings, responseDelayMinSeconds: 1, responseDelayMaxSeconds: 1 });

    await bori.chat("얼음캐 픽률 어떤가요");
    const { ms } = await bori.waitForReply();

    report.check(`대기가 짧으면 생성 시간이 지배 (기대 ~${(WORK_MS / 1000).toFixed(1)}초)`, ms >= WORK_MS - 500 && ms <= WORK_MS + 700, `${ms}ms`);
    report.note(`직렬 구조였다면 약 ${1000 + WORK_MS}ms가 나왔을 값이다.`);
  }

  // ── 누적 요약 ──────────────────────────────────────────────
  {
    await bori.waitForIdle();
    // 고정 자료의 주기가 4턴이므로 채팅 2건이면 한 번 돈다.
    await bori.askAndSettle("첫 번째 추가 채팅");
    await bori.askAndSettle("두 번째 추가 채팅");
    // 요약은 답변 경로를 막지 않고 뒤따라 도착한다.
    await new Promise(resolve => setTimeout(resolve, 3000));

    const summaries = await mock.summaryCalls();
    report.check("누적 요약이 주기마다 돈다", summaries.length >= 1, `요약 호출 ${summaries.length}회`);
    if (summaries.length > 0) {
      report.check("요약 프롬프트에 이전 요약 자리가 있다", summaries[0].user.includes("[이전 요약]"));
    }

    const withSummary = (await mock.answerCalls()).filter(entry => entry.user.includes("[지금까지의 방송]"));
    report.check("갱신된 요약이 이후 답변 프롬프트에 붙는다", withSummary.length >= 1, `${withSummary.length}건`);
  }

  await bori.endSession();
}
