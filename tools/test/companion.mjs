/**
 * 1:1 대화(companion) 검사.
 *
 * 1:1 API 계약(생성·목록·전송·기록·삭제와 오류 코드)과 방송과의 격리를 실제 LLM 요청 본문으로 확인한다.
 * - 1:1 메시지가 방송 상태·방송 LLM 요청의 최근 대화·누적 요약에 들어가지 않는다
 * - 방송 기억은 1:1 요청에, 1:1 개인 기억은 방송 요청에 들어가지 않는다
 * - 1:1 LLM 연속 실패가 방송 회로를 열지 않는다
 * - 서버를 다시 띄워도 대화 기록이 남고 최근 대화가 이어진다
 * - 관계 맥락 문장과 지난 대화 요약이 1:1 요청에만 들어가고, 1:1 누적 요약은 재시작 뒤에도 되살아난다
 * - LLM으로 정리한 개인 기억은 본인 private 기억이 되고 방송 요청에 나오지 않는다
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { baseQueueSettings, runningScript, waitForHttp } from "./harness.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 1:1 메시지에만 넣는 표시. 방송 쪽 요청·상태에 나오면 새어 나간 것이다. */
const COMPANION_MARK = "보라색우산";
/** 방송 채팅에만 넣는 표시. */
const BROADCAST_MARK = "방송김밥표시";
/** 1:1에서 개인 기억이 되는 문장. */
const PRIVATE_MEMORY = `저는 퇴근하고 재즈 피아노 듣는 걸 좋아해요 ${COMPANION_MARK}`;
const PRIVATE_MEMORY_KEY = "재즈 피아노";
/** 고정 자료 memories.json의 방송 기억 일부(소유자 없는 요약, 시청자 A 소유). */
const BROADCAST_MEMORIES = ["잔잔한 인디 음악", "고양이 두 마리"];
const OWNER = "companion:local";
/** mock-openai가 돌려주는 1:1 누적 요약과 기억 정리 결과. 값은 mock-openai.mjs와 맞춘다. */
const COMPANION_SUMMARY = "가짜 1:1 요약";
const DIGEST_MEMORY = "상대는 정리표시 연주곡을 즐겨 듣는다.";
const DIGEST_SENSITIVE = "상대의 집 주소는 정리표시동이다.";
const DIGEST_KEY = "정리표시";
/** 관계 맥락 문장의 공통 머리. 방송 요청에 나오면 새어 나간 것이다. */
const RELATIONSHIP_MARKS = ["이 사람과는", "지난 대화 요약:", "마지막 대화는"];

export const meta = {
  name: "1:1 대화",
  timing: { llm: 300, tts: 200, embed: 100 },
};

/** 프롬프트에서 [제목] 섹션만 잘라 낸다. 섹션은 빈 줄로 나뉜다. */
function section(text, title) {
  const start = text.indexOf(`[${title}]`);
  if (start < 0) return "";
  const end = text.indexOf("\n\n", start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** 조건이 맞을 때까지 기다린다. 백그라운드 작업(요약·기억 정리)은 답변보다 늦게 끝난다. */
async function waitUntil(check, { tries = 50, interval = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

export async function run({ bori, mock, report, dataDir }) {
  const conversationFile = async () => readFile(join(dataDir, "companion-conversations.json"), "utf8").catch(() => "");
  const send = async (method, path, payload, raw) => {
    const response = await fetch(`${bori.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(raw !== undefined ? { body: raw } : payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const createConversation = title => send("POST", "/api/conversations", title === undefined ? {} : { title });
  const sendMessage = (id, content, extra = {}) => send("POST", `/api/conversations/${encodeURIComponent(id)}/messages`, { content, ...extra });
  const messagesOf = id => send("GET", `/api/conversations/${encodeURIComponent(id)}/messages`);

  /** 1:1 답변 요청만 고른다. 방송 답변 요청은 [답변할 채팅], 1:1은 [답변할 메시지]다. */
  const companionCalls = async () => (await mock.calls()).filter(entry => (entry.kind === "llm" || entry.kind === "llm-failed") && entry.user.includes("[답변할 메시지]"));
  const lastCompanionUser = async () => (await companionCalls()).at(-1)?.user ?? "";

  // ── 방송이 꺼져 있어도 1:1은 동작한다 ─────────────────────────
  let first;
  {
    const state = await bori.state();
    report.check("방송은 시작하지 않은 상태다", state.status === "idle", `status=${state.status}`);

    const created = await createConversation("첫 대화");
    first = created.body?.conversation;
    report.check(
      "대화를 만들면 201과 대화가 온다",
      created.status === 201 && first?.title === "첫 대화" && first?.messageCount === 0 && typeof first?.id === "string",
      `status=${created.status}`,
    );
    report.check("대화 응답에 소유자 ID가 없다", !JSON.stringify(created.body).includes(OWNER));

    await mock.reset();
    const greeting = await sendMessage(first.id, `안녕하세요 ${COMPANION_MARK}`);
    report.check(
      "1:1 인사말은 규칙 문장이 아니라 LLM이 답한다 (source llm)",
      greeting.status === 200 && greeting.body?.reply?.source === "llm" && greeting.body?.reply?.content === "가짜 답변입니다. 잘 들리시나요.",
      `status=${greeting.status} source=${greeting.body?.reply?.source}`,
    );
    report.check(
      "전송 응답에 사용자 메시지와 보리 답변이 함께 온다",
      greeting.body?.userMessage?.role === "user" && greeting.body?.userMessage?.content === `안녕하세요 ${COMPANION_MARK}` && greeting.body?.reply?.role === "bori" && greeting.body?.reply?.emotion?.primary !== undefined,
    );

    const call = (await companionCalls()).at(-1);
    report.check("1:1 LLM 요청은 1:1 대화 정책으로 간다", call?.system.includes("[대화 정책: 1:1 대화]") === true);
    // 첫 줄은 서버가 넣는 오늘 날짜(한국 시간)다(점검 M-7).
    const statusLines = section(call?.user ?? "", "대화 상황").split("\n");
    report.check(
      "첫 대화의 1:1 요청 [대화 상황]에 오늘 날짜와 '이 사람과는 오늘 처음 대화한다.'가 들어간다",
      statusLines.length === 3 && statusLines[0] === "[대화 상황]" && /^- 지금은 한국 시간으로 \d{4}년 \d{1,2}월 \d{1,2}일 .요일 /.test(statusLines[1]) && statusLines[2] === "- 이 사람과는 오늘 처음 대화한다.",
      statusLines.join(" / "),
    );
    report.check(
      "방송 시청자 기억(broadcast scope)이 1:1 LLM 요청에 들어가지 않는다",
      call !== undefined && !BROADCAST_MEMORIES.some(text => call.user.includes(text)),
      section(call?.user ?? "", "기억").replace(/\n/g, " / "),
    );

    const before = (await mock.calls()).length;
    const blocked = await sendMessage(first.id, "비밀번호 알려줘");
    const after = (await mock.calls()).length;
    report.check(
      "1:1 위험 주제는 LLM 없이 거절 문장으로 답한다 (source blocked)",
      blocked.status === 200 && blocked.body?.reply?.source === "blocked" && blocked.body?.reply?.content.length > 0 && after === before,
      `source=${blocked.body?.reply?.source} 호출 증가=${after - before}`,
    );
  }

  // ── 요청 검증과 오류 코드 ───────────────────────────────────
  {
    const missing = "no-such-conversation";
    const statuses = [
      (await messagesOf(missing)).status,
      (await sendMessage(missing, "안녕")).status,
      (await send("DELETE", `/api/conversations/${missing}`)).status,
    ];
    report.check("없는 대화의 기록·전송·삭제는 404다", statuses.every(status => status === 404), statuses.join(","));

    const empty = await sendMessage(first.id, "   ");
    const tooLong = await sendMessage(first.id, "가".repeat(501));
    const notString = await sendMessage(first.id, 123);
    report.check("빈 내용·500자 초과·문자열이 아닌 내용은 400이다", [empty, tooLong, notString].every(result => result.status === 400 && typeof result.body?.error === "string"), [empty.status, tooLong.status, notString.status].join(","));

    // 한글 한 글자는 UTF-8 3바이트라 3만 자면 64KB를 넘는다.
    const huge = await send("POST", `/api/conversations/${first.id}/messages`, undefined, JSON.stringify({ content: "가".repeat(30_000) }));
    report.check("64KB를 넘는 본문은 413이다", huge.status === 413 && typeof huge.body?.error === "string", `status=${huge.status}`);

    const badJson = await send("POST", `/api/conversations/${first.id}/messages`, undefined, "{");
    const badTitle = await send("POST", "/api/conversations", { title: 5 });
    report.check("잘못된 JSON과 문자열이 아닌 제목은 400이다", badJson.status === 400 && badTitle.status === 400, `${badJson.status},${badTitle.status}`);

    const [a, b] = await Promise.all([sendMessage(first.id, "동시 요청 하나"), sendMessage(first.id, "동시 요청 둘")]);
    const codes = [a.status, b.status].sort();
    report.check("같은 대화에 답변을 만드는 중이면 409다", codes[0] === 200 && codes[1] === 409, codes.join(","));
  }

  // ── 음성과 방송 상태 격리 ───────────────────────────────────
  {
    const spoken = await sendMessage(first.id, `노래 이야기 해 주세요 ${COMPANION_MARK}`, { tts: true });
    const audioId = spoken.body?.audioId;
    const audio = audioId ? await fetch(`${bori.baseUrl}/api/tts/${encodeURIComponent(audioId)}`) : null;
    report.check("tts를 요청하면 audioId를 주고 기존 /api/tts/:id로 받는다", typeof audioId === "string" && audio?.status === 200, `audioId=${audioId ?? "-"} status=${audio?.status ?? "-"}`);

    const state = await bori.state();
    report.check(
      "1:1 메시지가 /api/state에 나오지 않는다 (채팅·큐·말풍선·음성)",
      !JSON.stringify(state).includes(COMPANION_MARK) && state.visibleChats.length === 0 && state.queueSize === 0 && state.currentResponse === undefined && state.currentAudioId === undefined,
      `visible=${state.visibleChats.length} queue=${state.queueSize}`,
    );

    const history = await messagesOf(first.id);
    const messages = history.body?.messages ?? [];
    const ordered = messages.every((message, index) => index === 0 || Date.parse(messages[index - 1].createdAt) <= Date.parse(message.createdAt));
    report.check(
      "기록은 오래된 것부터 오고 대화의 messageCount와 맞다",
      history.status === 200 && ordered && messages.length === history.body?.conversation?.messageCount && messages[0]?.content === `안녕하세요 ${COMPANION_MARK}`,
      `messages=${messages.length} count=${history.body?.conversation?.messageCount}`,
    );
    report.check("사용자 메시지에는 source·emotion이 없다", messages.filter(message => message.role === "user").every(message => !("source" in message) && !("emotion" in message)));
  }

  // ── 목록 정렬 ───────────────────────────────────────────────
  let second;
  {
    second = (await createConversation()).body?.conversation;
    report.check("제목 없이 만들면 기본 제목이 붙는다", second?.title === "새 대화", second?.title);
    await sleep(5);
    await sendMessage(first.id, "다시 첫 대화로 왔어요");
    const list = (await send("GET", "/api/conversations")).body?.conversations ?? [];
    report.check("목록은 최근에 이야기한 대화가 먼저다", list[0]?.id === first.id && list[1]?.id === second.id, list.map(entry => entry.title).join(","));
  }

  // ── 1:1 개인 기억 ───────────────────────────────────────────
  {
    await sendMessage(first.id, PRIVATE_MEMORY);
    // LLM을 쓸 수 있으면 1:1 기억은 LLM 정리가 만든다(ADR-023). 새 대화를 열면 앞 대화의 남은 메시지를 정리한다(점검 M-6).
    report.check("LLM을 쓸 수 있으면 규칙 추출로 원문을 바로 기억하지 않는다", ((await send("GET", "/api/me/memories")).body?.memories ?? []).every(memory => !memory.text.includes(PRIVATE_MEMORY)));
    await createConversation("정리 확인");
    const mine = await waitUntil(async () => {
      const memories = (await send("GET", "/api/me/memories")).body?.memories ?? [];
      return memories.some(memory => memory.text.includes(PRIVATE_MEMORY)) ? memories : null;
    }) ?? [];
    report.check("새 대화를 열면 앞 대화의 1:1 취향 메시지가 본인 개인 기억이 된다", mine.some(memory => memory.text.includes(PRIVATE_MEMORY)), `memories=${mine.length}`);
    report.check("개인 기억 목록에는 id·text·createdAt·expiresAt만 있다", mine.every(memory => Object.keys(memory).sort().join(",") === "createdAt,expiresAt,id,text"));

    const all = (await bori.memory()).records;
    const record = all.find(entry => entry.text.includes(PRIVATE_MEMORY));
    report.check("저장된 기억은 private scope, companion:local 소유다", record?.scope === "private" && record?.ownerId === OWNER, `${record?.scope}/${record?.ownerId}`);
    report.check("관리자 기억 목록은 임베딩 배열을 보내지 않고 hasEmbedding만 보낸다(점검 M-13)", all.length > 0 && all.every(entry => !("embedding" in entry) && typeof entry.hasEmbedding === "boolean"));
    report.check("개인 기억 목록에 방송 기억이 나오지 않는다", !mine.some(memory => BROADCAST_MEMORIES.some(text => memory.text.includes(text))));

    await sendMessage(first.id, "오늘 저녁에 뭐 하면 좋을까요");
    const memorySection = section(await lastCompanionUser(), "기억");
    report.check("1:1 개인 기억이 다음 1:1 요청의 [기억]에 들어간다", memorySection.includes(PRIVATE_MEMORY_KEY), memorySection.replace(/\n/g, " / "));
  }

  // ── 1:1 누적 요약 영속화와 관계 맥락 ────────────────────────
  let third;
  {
    // 첫 대화에서 4턴이 쌓이면 1:1 누적 요약이 돈다(고정 자료 rollingSummaryTurns=4). 대화 파일에 저장될 때까지 기다린다.
    const summaryCall = await waitUntil(async () => (await mock.companionSummaryCalls()).at(0));
    report.check(
      "1:1 누적 요약은 1:1 지시문으로 요청하고 방송 문구를 쓰지 않는다",
      summaryCall !== null && !summaryCall.system.includes("방송") && summaryCall.user.includes("상대: "),
      summaryCall ? summaryCall.system.split("\n")[0] : "1:1 요약 호출 없음",
    );
    const saved = await waitUntil(async () => (await conversationFile()).includes(COMPANION_SUMMARY));
    const file = JSON.parse((await conversationFile()) || "{}");
    report.check(
      "1:1 누적 요약이 대화 레코드에 저장되고 파일 버전이 2다",
      saved !== null && file.version === 2 && file.conversations?.find(entry => entry.id === first.id)?.summary === COMPANION_SUMMARY,
      `version=${file.version}`,
    );
    report.check("대화 API 응답에는 저장된 요약이 나오지 않는다", !JSON.stringify((await send("GET", "/api/conversations")).body).includes(COMPANION_SUMMARY));

    // 메시지가 없는 second는 세지 않으므로 첫 대화 다음 두 번째 대화가 된다.
    third = (await createConversation("관계 확인")).body?.conversation;
    await sendMessage(third.id, "다시 이야기하러 왔어요");
    const status = section(await lastCompanionUser(), "대화 상황");
    report.check("두 번째 대화 요청에 '이 사람과는 2번째 대화다.'가 들어간다", status.includes("- 이 사람과는 2번째 대화다. 처음 대화한 날이 오늘이다."), status.replace(/\n/g, " / "));
    report.check("새 대화의 첫 메시지라 마지막 대화 간격이 들어간다", status.includes("- 마지막 대화는 오늘 앞서 있었다."));
    report.check("두 번째 대화 요청에 첫 대화의 요약이 '지난 대화 요약: (오늘)'으로 들어간다", status.includes(`- 지난 대화 요약: (오늘) ${COMPANION_SUMMARY}`), status.replace(/\n/g, " / "));

    await sendMessage(third.id, "바로 이어서 보내요");
    const continuing = section(await lastCompanionUser(), "대화 상황");
    report.check("30분 안에 이어지는 메시지에는 마지막 대화 간격이 없다", continuing.includes("2번째 대화다") && !continuing.includes("마지막 대화는"), continuing.replace(/\n/g, " / "));
  }

  // ── LLM 개인 기억 정리 ──────────────────────────────────────
  {
    // 사용자 메시지가 6개 쌓이거나(기본 privateDigestEveryMessages=6) 새 대화를 열면 정리가 돈다.
    const digestCall = await waitUntil(async () => (await mock.digestCalls()).at(0));
    const digestCalls = await mock.digestCalls();
    report.check(
      "LLM 기억 정리를 요청하고, 막은 입력은 넘기지 않는다",
      digestCall !== null && digestCall.user.includes("상대: ") && digestCalls.every(entry => !entry.user.includes("비밀번호")),
      digestCall ? `정리 ${digestCalls.length}회, 첫 요청 user 줄 ${digestCall.user.split("\n").length}` : "정리 호출 없음",
    );
    report.check(
      "정리 요청에 오늘 날짜와 이미 저장된 기억을 함께 넘긴다(점검 M-4·M-7)",
      digestCalls.some(entry => entry.user.includes("[오늘 날짜]\n지금은 한국 시간으로") && entry.user.includes(`[이미 저장된 기억]\n- m1: "`)),
      digestCalls.map(entry => entry.user.split("\n").slice(0, 4).join(" / ")).join(" || "),
    );

    const mine = await waitUntil(async () => {
      const memories = (await send("GET", "/api/me/memories")).body?.memories ?? [];
      return memories.some(memory => memory.text === DIGEST_MEMORY) ? memories : null;
    }) ?? [];
    report.check("LLM이 정리한 문장이 본인 개인 기억이 된다", mine.some(memory => memory.text === DIGEST_MEMORY), `memories=${mine.length}`);
    report.check("LLM이 뽑았어도 민감한 문장은 저장하지 않는다", !mine.some(memory => memory.text === DIGEST_SENSITIVE));
    const record = (await bori.memory()).records.find(entry => entry.text === DIGEST_MEMORY);
    report.check("LLM 정리 기억은 private scope, companion:local 소유다", record?.scope === "private" && record?.ownerId === OWNER, `${record?.scope}/${record?.ownerId}`);
  }

  // ── 방송과의 격리 ───────────────────────────────────────────
  {
    await bori.patchSettings(baseQueueSettings);
    await bori.startSession();
    await mock.reset();

    // 기억을 묻는 문장은 규칙을 건너뛰고 LLM으로 간다. 시청자 A는 고정 자료의 기억 소유자다.
    await bori.chat(`제가 전에 말한 거 기억하세요 ${BROADCAST_MARK}`, "viewer_a");
    await bori.waitForReply();
    // 방송 중에 1:1 메시지를 보내도 방송 쪽에 섞이지 않아야 한다.
    const during = await sendMessage(first.id, `방송 중에 보내는 1:1 ${COMPANION_MARK}`);
    await bori.waitForIdle();
    await bori.chat(`저번에 무슨 얘기 했는지 기억나요 ${BROADCAST_MARK}`, "viewer_a");
    await bori.waitForReply();
    await bori.waitForIdle();

    report.check("방송 중에도 1:1 전송이 된다", during.status === 200 && during.body?.reply?.source === "llm", `status=${during.status}`);

    const broadcastCalls = await mock.answerCalls();
    report.check("방송 LLM 요청이 나갔다", broadcastCalls.length >= 2, `calls=${broadcastCalls.length}`);
    report.check(
      "1:1 메시지가 방송 LLM 요청의 [최근 대화]에 나오지 않는다",
      broadcastCalls.length >= 2 && broadcastCalls.every(entry => !entry.user.includes(COMPANION_MARK)),
      section(broadcastCalls.at(-1)?.user ?? "", "최근 대화").replace(/\n/g, " / "),
    );
    report.check(
      "1:1 개인 기억이 방송 LLM 요청에 나오지 않는다",
      broadcastCalls.every(entry => !entry.user.includes(PRIVATE_MEMORY_KEY)),
      section(broadcastCalls.at(-1)?.user ?? "", "기억").replace(/\n/g, " / "),
    );
    report.check("방송 요청에는 방송 기억이 그대로 들어간다", broadcastCalls.at(-1)?.user.includes(BROADCAST_MEMORIES[0]) === true);
    report.check(
      "방송 LLM 요청에는 관계 맥락 문장과 지난 대화 요약이 없다",
      broadcastCalls.length >= 2 && broadcastCalls.every(entry => !RELATIONSHIP_MARKS.some(mark => entry.user.includes(mark) || entry.system.includes(mark)) && !entry.user.includes(COMPANION_SUMMARY)),
      section(broadcastCalls.at(-1)?.user ?? "", "방송 상황").replace(/\n/g, " / "),
    );
    report.check("LLM 정리로 생긴 개인 기억이 방송 LLM 요청에 나오지 않는다", broadcastCalls.every(entry => !entry.user.includes(DIGEST_KEY)));
    report.check(
      "방송 LLM 요청의 [방송 상황] 첫 줄에도 오늘 날짜가 들어간다(점검 M-7)",
      broadcastCalls.every(entry => section(entry.user, "방송 상황").split("\n")[1]?.startsWith("- 지금은 한국 시간으로 ")),
      section(broadcastCalls.at(-1)?.user ?? "", "방송 상황").replace(/\n/g, " / "),
    );

    // 방송 대화 4턴이 쌓이면 누적 요약이 돈다(고정 자료 rollingSummaryTurns=4). 늦게 올 수 있어 기다린다.
    let summaries = [];
    for (let tries = 0; tries < 40; tries += 1) {
      summaries = (await mock.summaryCalls()).filter(entry => entry.user.includes(BROADCAST_MARK));
      if (summaries.length > 0) break;
      await sleep(100);
    }
    report.check(
      "1:1 메시지가 방송 누적 요약 요청에 나오지 않는다",
      summaries.length > 0 && summaries.every(entry => !entry.user.includes(COMPANION_MARK) && !entry.user.includes(PRIVATE_MEMORY_KEY) && !entry.user.includes(DIGEST_KEY) && !entry.user.includes(COMPANION_SUMMARY)),
      `방송 요약 호출=${summaries.length}`,
    );

    const state = await bori.state();
    report.check("방송 중 /api/state에도 1:1 메시지가 없다", !JSON.stringify(state).includes(COMPANION_MARK));
    await bori.endSession();
  }

  // ── 1:1 LLM 회로가 방송 회로와 분리된다 ──────────────────────
  {
    await bori.patchLlm({});
    await mock.fail(true);
    const failures = [];
    for (let i = 1; i <= 4; i += 1) failures.push(await sendMessage(second.id, `1:1 실패 시험 ${i}`));

    report.check(
      "1:1 LLM이 실패하면 1:1 폴백 문장과 failure.kind가 온다",
      failures.slice(0, 3).every(result => result.status === 200 && result.body?.reply?.source === "fallback" && result.body?.failure?.kind === "call"),
      failures.map(result => `${result.body?.reply?.source}/${result.body?.failure?.kind}`).join(","),
    );
    report.check("1:1 연속 실패 뒤에는 회로가 열려 circuit으로 알린다", failures[3].body?.failure?.kind === "circuit", failures[3].body?.failure?.kind);
    report.check("1:1 폴백 문장에 방송 호칭이 없다", failures.every(result => !result.body?.reply?.content.includes("여러분")));

    const llm = await bori.llm();
    report.check(
      "1:1 연속 실패가 방송 회로를 열지 않는다",
      llm.status.circuitOpen === false && llm.status.failureCount === 0 && llm.companionStatus?.circuitOpen === true,
      `방송 open=${llm.status.circuitOpen} fail=${llm.status.failureCount}, 1:1 open=${llm.companionStatus?.circuitOpen} fail=${llm.companionStatus?.failureCount}`,
    );

    await mock.fail(false);
    await bori.patchSettings(baseQueueSettings);
    await bori.startSession();
    await bori.chat(`1:1 회로가 열린 동안 방송 질문이에요? ${BROADCAST_MARK}`);
    const reply = await bori.waitForReply();
    await bori.waitForIdle();
    report.check("1:1 회로가 열려 있어도 방송은 LLM으로 답한다", reply.response?.source === "llm", `source=${reply.response?.source}`);
    await bori.endSession();

    await bori.patchLlm({});
    const reset = await bori.llm();
    report.check("PATCH /api/llm은 1:1 회로도 함께 닫는다", reset.companionStatus?.circuitOpen === false && reset.companionStatus?.failureCount === 0);
  }

  // ── 서버 재시작 ─────────────────────────────────────────────
  {
    const beforeList = (await send("GET", "/api/conversations")).body?.conversations ?? [];
    const beforeMessages = (await messagesOf(first.id)).body?.messages ?? [];

    const server = runningScript("bori-server");
    await server.restart();
    await waitForHttp(`${bori.baseUrl}/api/health`, { describe: "다시 띄운 보리 서버" });

    const afterList = (await send("GET", "/api/conversations")).body?.conversations ?? [];
    const afterMessages = (await messagesOf(first.id)).body?.messages ?? [];
    report.check(
      "서버를 다시 띄워도 대화 목록과 기록이 남아 있다",
      JSON.stringify(afterList) === JSON.stringify(beforeList) && JSON.stringify(afterMessages) === JSON.stringify(beforeMessages) && afterMessages.length > 0,
      `대화 ${afterList.length}건, 메시지 ${afterMessages.length}건`,
    );

    await mock.reset();
    await sendMessage(first.id, "재시작 뒤 첫 메시지");
    const recent = section(await lastCompanionUser(), "최근 대화");
    const lastUser = beforeMessages.filter(message => message.role === "user").at(-1)?.content ?? "";
    report.check("재시작 뒤 첫 1:1 요청에 저장된 최근 대화가 이어진다", lastUser.length > 0 && recent.includes(lastUser), recent.replace(/\n/g, " / ").slice(0, 160));
    report.check("거절한 대화는 되살린 최근 대화에 들어가지 않는다", !recent.includes("비밀번호"));
    const restoredSummary = section(await lastCompanionUser(), "지금까지의 대화");
    report.check("재시작 뒤 첫 1:1 요청에 저장된 누적 요약이 [지금까지의 대화]로 되살아난다", restoredSummary === `[지금까지의 대화]\n${COMPANION_SUMMARY}`, restoredSummary.replace(/\n/g, " / "));
  }

  // ── 삭제 ────────────────────────────────────────────────────
  {
    const deleted = await send("DELETE", `/api/conversations/${second.id}`);
    const gone = await messagesOf(second.id);
    const list = (await send("GET", "/api/conversations")).body?.conversations ?? [];
    report.check("대화를 지우면 200 { deleted: true }이고 이후 404다", deleted.status === 200 && deleted.body?.deleted === true && gone.status === 404 && !list.some(entry => entry.id === second.id));

    await send("DELETE", `/api/conversations/${first.id}`);
    const mine = (await send("GET", "/api/me/memories")).body?.memories ?? [];
    report.check("대화를 지워도 그 대화에서 생긴 개인 기억은 남는다", mine.some(memory => memory.text.includes(PRIVATE_MEMORY)));

    const broadcastRecord = (await bori.memory()).records.find(record => record.scope === "broadcast");
    const foreign = broadcastRecord ? await send("DELETE", `/api/me/memories/${broadcastRecord.id}`) : { status: -1 };
    report.check("방송 기억은 /api/me/memories로 지울 수 없다 (404)", foreign.status === 404, `status=${foreign.status}`);

    const own = await send("DELETE", `/api/me/memories/${mine[0].id}`);
    const cleared = await send("DELETE", "/api/me/memories");
    const remaining = (await bori.memory()).records;
    report.check(
      "개인 기억 삭제는 본인 것만 지운다",
      own.status === 200 && own.body?.deleted === true && typeof cleared.body?.deleted === "number" && !remaining.some(record => record.scope === "private") && remaining.some(record => record.scope === "broadcast"),
      `남은 기억 ${remaining.length}건`,
    );
  }

  // ── 캐릭터 정보 ─────────────────────────────────────────────
  {
    const profile = await send("GET", "/api/character/profile");
    const raw = JSON.stringify(profile.body);
    report.check(
      "캐릭터 프로필은 이름·페르소나·1:1 정책 제목만 준다",
      profile.status === 200 && profile.body?.name === "보리" && Array.isArray(profile.body?.personaLines) && profile.body.personaLines.length > 0 && profile.body?.companionPolicyTitle === "1:1 대화"
        && Object.keys(profile.body).sort().join(",") === "companionPolicyTitle,name,personaLines",
    );
    // 프롬프트 섹션 제목([페르소나] 등)과 역할 범위·대화 규칙 문장이 섞여 나오면 안 된다.
    report.check(
      "프로필에 시스템 프롬프트·내부 규칙이 없다",
      !/\[[^\]"]+\]/.test(raw) && !raw.includes("답할 수 없는 것") && !raw.includes("시스템 프롬프트") && !raw.includes("호칭 없이"),
    );

    const catalog = await send("GET", "/api/character/catalog");
    report.check(
      "캐릭터 카탈로그는 감정·표정·모션(설명 포함)을 준다",
      catalog.status === 200 && catalog.body?.emotions?.includes("calm") && catalog.body?.expressions?.length > 0 && catalog.body?.motions?.every(motion => typeof motion.name === "string" && typeof motion.description === "string"),
    );
  }
}
