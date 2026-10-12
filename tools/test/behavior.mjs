/**
 * 동작 검사.
 *
 * 지연이 아니라 "그래서 제대로 도느냐"를 본다.
 * 매크로 수명, LLM이 죽었을 때 방송이 이어지는지, 회로 차단기, 혼잣말 기록,
 * 세션을 다시 시작했을 때 이전 세션 타이머가 새 답변을 건드리지 않는지.
 *
 * 가짜 API 지연을 짧게 두어 검사 시간을 줄인다. 여기서는 시간을 재지 않는다.
 */
import { baseQueueSettings } from "./harness.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const meta = {
  name: "동작",
  timing: { llm: 300, tts: 200, embed: 100 },
};

export async function run({ bori, mock, report }) {
  await bori.patchSettings(baseQueueSettings);
  await bori.patchLlm({ failureThreshold: 2, cooldownSeconds: 30 });
  await bori.startSession();

  // ── 매크로 다시 읽기 ───────────────────────────────────────
  {
    const reloaded = await bori.reloadMacros();
    report.check("매크로 다시 읽기 엔드포인트", reloaded.status === 200 && reloaded.body.loaded === 2, `loaded=${reloaded.body?.loaded}`);
  }

  // ── 매크로 수명 (고정 자료의 adina는 2턴) ───────────────────
  {
    await mock.reset();
    await bori.askAndSettle("아디나 어때요");
    const active = (await bori.llm()).macro.active;
    report.check("키워드가 나오면 매크로가 켜진다", active.some(entry => entry.id === "adina"), `남은 턴=${active.find(entry => entry.id === "adina")?.remainingTurns}`);

    await bori.askAndSettle("그렇군요 더 알려주세요");
    const stillOn = (await mock.answerCalls()).at(-1);
    report.check("키워드가 없는 다음 턴에도 매크로가 유지된다", stillOn.user.includes("아디나는 얼음 속성"));

    await bori.askAndSettle("이제 다른 이야기 할까요");
    const droppedPrompt = (await mock.answerCalls()).at(-1);
    const remaining = (await bori.llm()).macro.active;
    report.check(
      "지속 턴이 다하면 매크로가 떨어진다",
      !droppedPrompt.user.includes("아디나는 얼음 속성") && !remaining.some(entry => entry.id === "adina"),
      `active=${JSON.stringify(remaining)}`,
    );
  }

  // ── LLM이 죽어도 방송은 이어진다 ───────────────────────────
  {
    await mock.fail(true);

    const first = await bori.askAndSettle("실패 테스트 첫 번째");
    report.check("LLM이 실패해도 답변이 나간다", first.response !== null, `source=${first.response?.source}`);
    report.check("실패 시 규칙 폴백 문장이 나간다", first.response?.source === "rule", first.response?.reply?.slice(0, 20));

    // 말풍선이 내려가기를 기다리면 쿨다운이 그 사이에 지날 수 있다. 답변 직후에 본다.
    await bori.chat("실패 테스트 두 번째");
    const second = await bori.waitForReply();
    report.check("연속 실패해도 방송이 멈추지 않는다", second.response !== null);

    const opened = (await bori.llm()).status;
    report.check("연속 실패로 회로가 열린다", opened.circuitOpen === true, `consecutiveFailures=${opened.consecutiveFailures}`);
    await bori.waitForIdle();

    await mock.reset();
    const third = await bori.askAndSettle("회로 열린 상태 테스트");
    const attempted = (await mock.calls()).filter(entry => entry.kind === "llm" || entry.kind === "llm-failed");
    report.check("회로가 열린 동안 LLM을 부르지 않는다", attempted.length === 0, `호출 ${attempted.length}회`);
    report.check("회로가 열려도 답변은 나간다", third.response !== null);

    await mock.fail(false);
    // 설정을 바꾸면 통계와 회로가 초기화된다. 쿨다운을 기다리는 대신 이 경로를 확인한다.
    await bori.patchLlm({ cooldownSeconds: 30 });
    report.check("설정을 바꾸면 회로가 닫힌다", (await bori.llm()).status.circuitOpen === false);
  }

  // ── 혼잣말이 대화 기록에 남는지 ────────────────────────────
  {
    await bori.startSession();
    await bori.patchSettings({ ...baseQueueSettings, monologueEnabled: true, monologueMinSeconds: 2, monologueMaxSeconds: 2 });
    await mock.reset();

    const spoken = await bori.waitForReply(15_000);
    report.check("혼잣말이 나온다", spoken.response?.source === "monologue", `source=${spoken.response?.source}`);
    await bori.waitForIdle();

    await bori.patchSettings({ ...baseQueueSettings, monologueEnabled: false });
    await bori.askAndSettle("방금 뭐라고 하셨어요");
    const last = (await mock.answerCalls()).at(-1);
    report.check("혼잣말이 최근 대화에 기록된다", last.user.includes(spoken.response.reply), `"${spoken.response?.reply?.slice(0, 15)}..."`);
  }

  // ── 세션을 다시 시작해도 이전 타이머가 새 답변을 지우지 않는다 ──
  {
    await bori.startSession();
    await bori.patchSettings({ ...baseQueueSettings, monologueEnabled: false });

    await bori.chat("재시작 테스트 첫 번째");
    const first = await bori.waitForReply();
    report.check("재시작 전 답변이 나온다", first.response !== null);

    // 말풍선 표시가 끝나기 전에 다시 시작한다. 이전 세션 타이머는 약 5초 뒤에 터진다.
    const restartedAt = Date.now();
    await bori.startSession();
    await bori.patchSettings({ ...baseQueueSettings, monologueEnabled: false });
    await bori.chat("재시작 테스트 두 번째");
    const second = await bori.waitForReply();
    report.check("재시작 후 새 답변이 나온다", second.response !== null, `${Date.now() - restartedAt}ms 만에`);

    // 이전 타이머가 터질 시각(재시작 +5초)을 지난 뒤에도 새 답변이 살아 있어야 한다.
    await sleep(Math.max(0, 5400 - (Date.now() - restartedAt)));
    const state = await bori.state();
    report.check("이전 세션 타이머가 새 답변을 지우지 않는다", Boolean(state.currentResponse), state.currentResponse ? "말풍선 유지" : "말풍선 사라짐");
  }

  await bori.endSession();
}
