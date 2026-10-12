/**
 * 방송·1:1 동시 사용 검사.
 *
 * 방송 채팅 50건과 1:1 메시지 50건을 한꺼번에 섞어 보내도 프롬프트 맥락·기억·요약이 섞이지 않는지,
 * 한쪽 LLM 회로가 열려도 다른 쪽은 계속 LLM으로 답하는지 가짜 API가 받은 요청 본문으로 확인한다.
 */
import { baseQueueSettings } from "./harness.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 방송 채팅에만 넣는 표시. 1:1 요청에 나오면 섞인 것이다. */
const BROADCAST_MARK = "동시방송표시";
/** 1:1 메시지에만 넣는 표시. 방송 요청·상태에 나오면 섞인 것이다. */
const COMPANION_MARK = "동시일대일표시";
/** 1:1 관계 맥락 문장의 머리. 방송 요청에 나오면 새어 나간 것이다. 값은 companion.mjs와 맞춘다. */
const RELATIONSHIP_MARKS = ["이 사람과는", "지난 대화 요약:", "마지막 대화는"];
const MOCK_REPLY = "가짜 답변입니다. 잘 들리시나요.";
const CONVERSATIONS = 10;
const MESSAGES_PER_CONVERSATION = 5;
const BROADCAST_CHATS = 50;

export const meta = {
  name: "방송·1:1 동시 사용",
  timing: { llm: 200, tts: 100, embed: 50 },
};

export async function run({ bori, mock, report }) {
  const send = async (method, path, payload) => {
    const response = await fetch(`${bori.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const sendMessage = (id, content) => send("POST", `/api/conversations/${encodeURIComponent(id)}/messages`, { content });
  const llmCalls = async () => (await mock.calls()).filter(entry => entry.kind === "llm" || entry.kind === "llm-failed");

  await bori.patchSettings({ ...baseQueueSettings, responseDelayMinSeconds: 0, responseDelayMaxSeconds: 0 });
  await bori.startSession();
  await mock.reset();

  // ── 동시에 많이 보내도 섞이지 않는다 ──────────────────────────
  const conversations = [];
  for (let i = 0; i < CONVERSATIONS; i += 1) conversations.push((await send("POST", "/api/conversations", { title: `동시 ${i}` })).body?.conversation?.id);

  const broadcastSends = Promise.all(Array.from({ length: BROADCAST_CHATS }, (_, i) => bori.chat(`${BROADCAST_MARK} ${i}번 저녁 메뉴 이야기`, `viewer${i % 5}`)));
  // 같은 대화에 답변을 만드는 중이면 409이므로 대화 하나 안에서는 차례로 보내고 대화끼리는 동시에 보낸다.
  const companionSends = Promise.all(conversations.map(async (id, c) => {
    const statuses = [];
    for (let m = 0; m < MESSAGES_PER_CONVERSATION; m += 1) {
      statuses.push((await sendMessage(id, `${COMPANION_MARK} c${c}-m${m} 오늘 있었던 일`)).status);
    }
    return statuses;
  }));
  const [broadcastResults, companionResults] = await Promise.all([broadcastSends, companionSends]);

  const broadcastOk = broadcastResults.filter(result => result.status === 200).length;
  const companionOk = companionResults.flat().filter(status => status === 200).length;
  report.check(`방송 채팅 ${BROADCAST_CHATS}건을 모두 받는다`, broadcastOk === BROADCAST_CHATS, `${broadcastOk}/${BROADCAST_CHATS}`);
  report.check(`1:1 메시지 ${CONVERSATIONS * MESSAGES_PER_CONVERSATION}건이 모두 답을 받는다`, companionOk === CONVERSATIONS * MESSAGES_PER_CONVERSATION, `${companionOk}/${CONVERSATIONS * MESSAGES_PER_CONVERSATION}`);

  // 방송 답변 몇 건과 백그라운드 요약·기억 정리가 끝날 시간을 준다.
  await sleep(12_000);

  {
    const calls = await llmCalls();
    const broadcastAnswers = calls.filter(entry => entry.user.includes("[답변할 채팅]"));
    const companionAnswers = calls.filter(entry => entry.user.includes("[답변할 메시지]"));
    const broadcastSummaries = calls.filter(entry => entry.system.includes("진행 중인 방송의 흐름"));
    const companionBackground = calls.filter(entry => entry.system.includes("1:1 대화의 흐름") || entry.system.includes("오래 기억할 내용"));
    report.note(`방송 답변 요청 ${broadcastAnswers.length}건, 1:1 답변 요청 ${companionAnswers.length}건, 방송 요약 ${broadcastSummaries.length}건, 1:1 요약·기억 정리 ${companionBackground.length}건`);

    const broadcastSide = [...broadcastAnswers, ...broadcastSummaries];
    report.check(
      "방송 요청(답변·요약)에 1:1 메시지와 관계 문장이 없다",
      broadcastAnswers.length > 0 && broadcastSide.every(entry => !`${entry.system}${entry.user}`.includes(COMPANION_MARK) && !RELATIONSHIP_MARKS.some(mark => entry.user.includes(mark))),
    );
    const companionSide = [...companionAnswers, ...companionBackground];
    report.check(
      "1:1 요청(답변·요약·기억 정리)에 방송 채팅이 없다",
      companionAnswers.length === CONVERSATIONS * MESSAGES_PER_CONVERSATION && companionSide.every(entry => !`${entry.system}${entry.user}`.includes(BROADCAST_MARK)),
    );

    // 1:1 대화끼리도 섞이지 않는다. 각 대화의 요청에는 그 대화의 메시지만 들어간다.
    const crossed = companionAnswers.filter(entry => {
      const input = entry.user.slice(entry.user.indexOf("[답변할 메시지]")).split("\n\n")[0];
      const own = input.match(/c(\d+)-m\d+/)?.[1];
      return own === undefined || [...entry.user.matchAll(/c(\d+)-m\d+/g)].some(match => match[1] !== own);
    });
    report.check("1:1 대화끼리 최근 대화가 섞이지 않는다", crossed.length === 0, `섞인 요청 ${crossed.length}건`);

    const state = await bori.state();
    report.check("방송 상태에 1:1 메시지가 없다", !JSON.stringify(state).includes(COMPANION_MARK));

    const histories = await Promise.all(conversations.map(id => send("GET", `/api/conversations/${encodeURIComponent(id)}/messages`)));
    const historyOk = histories.every((history, c) => {
      const messages = history.body?.messages ?? [];
      return messages.length === MESSAGES_PER_CONVERSATION * 2 && messages.filter(message => message.role === "user").every(message => message.content.includes(` c${c}-m`));
    });
    report.check("각 1:1 대화 기록에는 그 대화의 메시지만 순서대로 남는다", historyOk);

    const mine = (await send("GET", "/api/me/memories")).body?.memories ?? [];
    report.check("1:1 개인 기억에 방송 채팅이 없다", !mine.some(memory => memory.text.includes(BROADCAST_MARK)), `개인 기억 ${mine.length}건`);
  }

  // ── 한쪽 회로가 열려도 다른 쪽은 동작한다 ──────────────────────
  await bori.endSession();
  await bori.patchLlm({ failureThreshold: 2, cooldownSeconds: 60 });
  await bori.startSession();
  await mock.reset();
  {
    const id = conversations[0];
    await mock.inject({ target: "llm", mode: "500", count: 2, match: "[답변할 메시지]" });
    await sendMessage(id, `${COMPANION_MARK} 회로 하나`);
    await sendMessage(id, `${COMPANION_MARK} 회로 둘`);
    const llm = await bori.llm();
    report.check("1:1 회로만 열리고 방송 회로는 닫혀 있다", llm.companionStatus.circuitOpen === true && llm.status.circuitOpen === false);

    await bori.chat(`${BROADCAST_MARK} 1:1 회로가 열린 동안`);
    const reply = await bori.waitForReply();
    const asked = (await llmCalls()).some(entry => entry.kind === "llm" && entry.user.includes("1:1 회로가 열린 동안"));
    report.check("1:1 회로가 열려도 방송은 LLM으로 답한다", asked && reply.response?.reply === MOCK_REPLY, reply.response?.reply ?? "없음");
    await bori.waitForIdle();
  }

  await bori.patchLlm({ failureThreshold: 2, cooldownSeconds: 60 });
  {
    await mock.inject({ target: "llm", mode: "500", count: 2, match: "[답변할 채팅]" });
    for (const text of ["방송 회로 하나", "방송 회로 둘"]) {
      await bori.chat(`${BROADCAST_MARK} ${text}`);
      await bori.waitForReply();
      await bori.waitForIdle();
    }
    const llm = await bori.llm();
    report.check("방송 회로만 열리고 1:1 회로는 닫혀 있다", llm.status.circuitOpen === true && llm.companionStatus.circuitOpen === false);

    const answer = await sendMessage(conversations[1], `${COMPANION_MARK} 방송 회로가 열린 동안`);
    report.check("방송 회로가 열려도 1:1은 LLM으로 답한다", answer.status === 200 && answer.body?.reply?.source === "llm", `source=${answer.body?.reply?.source}`);
  }

  await bori.patchLlm({ failureThreshold: 3, cooldownSeconds: 60 });
  await mock.clearInjections();
  await bori.endSession();
}
