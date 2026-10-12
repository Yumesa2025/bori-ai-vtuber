/**
 * OpenAI 대신 응답하는 가짜 API 서버.
 *
 * 지연을 고정값으로 흉내 내므로 체감 지연을 재현 가능하게 측정할 수 있고,
 * 실제 API 키도 비용도 필요 없다. 답변 생성·임베딩·음성 합성 세 경로를 모두 받는다.
 *
 * 보리 서버는 BORI_OPENAI_BASE_URL로 이 주소를 가리키게 한다.
 *
 *   node tools/test/mock-openai.mjs
 *
 * 검사용 엔드포인트
 *   GET /__calls               지금까지 받은 요청 목록(프롬프트 본문 포함)
 *   GET /__reset               요청 목록 비우기
 *   GET /__timing?llm=&tts=&embed=   응답 지연 변경(ms)
 *   GET /__fail?on=1           답변 생성 요청을 500으로 실패시키기
 *
 * 답변 생성 응답에는 고정 토큰 사용량(usage)을 붙인다. 사용량 집계를 확인할 때 쓴다.
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 4390);

const timing = {
  llm: Number(process.env.MOCK_LLM_MS ?? 2000),
  tts: Number(process.env.MOCK_TTS_MS ?? 1500),
  embed: Number(process.env.MOCK_EMBED_MS ?? 300),
};

/** 받은 요청 기록. 어떤 프롬프트가 언제 갔는지 검사에서 확인한다. */
const calls = [];
/** 실패 주입 스위치. 회로 차단기 동작을 확인할 때 켠다. */
let failLlm = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sendJson = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

/** 답변 생성 응답에 붙이는 토큰 사용량. 값은 usage.mjs와 맞춘다. */
const MOCK_USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

/** 1:1 누적 요약 응답. 방송 요약과 구분해 지난 대화 요약·재시작 복원을 확인한다. */
const MOCK_COMPANION_SUMMARY = "가짜 1:1 요약";
/** 1:1 개인 기억 정리 응답. 두 번째 문장은 민감 정보라 서버가 저장 직전에 걸러야 한다. */
const MOCK_DIGEST_MEMORIES = ["상대는 정리표시 연주곡을 즐겨 듣는다.", "상대의 집 주소는 정리표시동이다."];

/**
 * 답변 생성과 요약·기억 정리 요청은 스키마 모양으로 구분한다.
 * 보리는 같은 어댑터에 스키마만 갈아 끼워 모두 부른다. 1:1 요약은 지시문으로 방송 요약과 구분한다.
 */
function replyFor(schema, system) {
  const properties = schema?.properties ?? {};
  if ("memories" in properties) {
    return JSON.stringify({ memories: MOCK_DIGEST_MEMORIES });
  }
  if ("summary" in properties && !("reply" in properties)) {
    return JSON.stringify({ summary: system.includes("1:1 대화의 흐름") ? MOCK_COMPANION_SUMMARY : "가짜 누적 요약" });
  }
  return JSON.stringify({
    reply: "가짜 답변입니다. 잘 들리시나요.",
    emotion: { primary: "calm", intensity: 0.4, durationSeconds: 6 },
    actions: [],
  });
}

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const at = Date.now();
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (url.pathname === "/__calls") { sendJson(response, 200, calls); return; }
  if (url.pathname === "/__reset") { calls.length = 0; sendJson(response, 200, { ok: true }); return; }

  if (url.pathname === "/__timing") {
    for (const key of ["llm", "tts", "embed"]) {
      const value = url.searchParams.get(key);
      if (value !== null) timing[key] = Number(value);
    }
    sendJson(response, 200, timing);
    return;
  }

  if (url.pathname === "/__fail") {
    failLlm = url.searchParams.get("on") === "1";
    sendJson(response, 200, { failLlm });
    return;
  }

  if (url.pathname.endsWith("/chat/completions")) {
    const parsed = JSON.parse(body);
    const record = { at, system: parsed.messages[0].content, user: parsed.messages[1].content };

    if (failLlm) {
      calls.push({ kind: "llm-failed", ...record });
      await sleep(200);
      sendJson(response, 500, { error: { message: "테스트용 실패" } });
      return;
    }

    calls.push({ kind: "llm", ...record });
    await sleep(timing.llm);
    sendJson(response, 200, { choices: [{ message: { content: replyFor(parsed.response_format?.json_schema?.schema, record.system) } }], usage: MOCK_USAGE });
    return;
  }

  if (url.pathname.endsWith("/audio/speech")) {
    calls.push({ kind: "tts", at });
    await sleep(timing.tts);
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    // 방송 화면이 재생을 시도할 수 있도록 mp3 프레임 헤더 흉내만 낸다.
    response.end(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
    return;
  }

  if (url.pathname.endsWith("/embeddings")) {
    const parsed = JSON.parse(body);
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    calls.push({ kind: "embed", at, count: inputs.length });
    await sleep(timing.embed);
    // 모든 벡터를 같은 값으로 준다. 유사도가 1이 되어 기억이 항상 검색된다.
    sendJson(response, 200, { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${port}`);
});
