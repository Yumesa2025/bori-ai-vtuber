/**
 * OpenAI 대신 응답하는 가짜 API 서버.
 *
 * 지연을 고정값으로 흉내 내므로 체감 지연을 재현 가능하게 측정할 수 있고,
 * 실제 API 키도 비용도 필요 없다. 답변 생성·음성 합성 두 경로를 받는다.
 * 2026-11-21 방송·1:1 대화를 지우면서 요약·기억 정리·임베딩 경로를 지웠다.
 *
 * 보리 서버는 BORI_OPENAI_BASE_URL로 이 주소를 가리키게 한다.
 *
 *   node tools/test/mock-openai.mjs
 *
 * 검사용 엔드포인트
 *   GET /__calls               지금까지 받은 요청 목록(프롬프트 본문 포함)
 *   GET /__reset               요청 목록과 남은 실패 주입 비우기
 *   GET /__timing?llm=&tts=   응답 지연 변경(ms). 다른 값은 무시한다
 *   GET /__fail?on=1           답변 생성 요청을 500으로 실패시키기
 *   GET /__inject?target=llm|tts&mode=500|delay|badjson&count=N&ms=&match=
 *                              지정 횟수만큼만 실패 주입(match가 있으면 본문에 그 문자열이 든 요청만). clear=1이면 모두 지움
 *                              tts에는 mode=empty(200·0바이트), garbage(200·mp3 아님), long(ms 길이의 mp3)도 있다.
 *   GET /v1/voices             ElevenLabs 목소리 목록 흉내. 받은 횟수를 calls에 voices로 남긴다
 *
 * 보리 대사(스키마에 lines가 있는 요청)는 사실 목록(fN: …) 앞 4개를 줄마다 하나씩 고르고({ factId, emotion, comment }) 짧은 감상을 붙인다.
 * 첫 줄 감상은 숫자를 지어낸다(가짜 ER 집계는 사실이 하나뿐일 수 있다). 서버가 그 감상만 버리고 서버 문장을 남기는지 NARRATION_FABRICATED_MARK로 확인한다.
 *
 * 답변 생성 응답에는 고정 토큰 사용량(usage)을 붙인다. 사용량 집계를 확인할 때 쓴다.
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 4390);

const timing = {
  llm: Number(process.env.MOCK_LLM_MS ?? 2000),
  tts: Number(process.env.MOCK_TTS_MS ?? 1500),
};

/** 받은 요청 기록. 어떤 프롬프트가 언제 갔는지 검사에서 확인한다. */
const calls = [];
/** 실패 주입 스위치. 회로 차단기 동작을 확인할 때 켠다. */
let failLlm = false;
/** 횟수가 정해진 실패 주입. 오류 뒤 복구를 확인할 때 쓴다. */
const injections = [];

/** 이 요청에 걸리는 주입을 하나 꺼내고 남은 횟수를 줄인다. */
function takeInjection(target, text = "") {
  const found = injections.find(entry => entry.target === target && entry.remaining > 0 && (!entry.match || text.includes(entry.match)));
  if (!found) return null;
  found.remaining -= 1;
  return found;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sendJson = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

/** 답변 생성 응답에 붙이는 토큰 사용량. 값은 usage.mjs와 맞춘다. */
const MOCK_USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

/**
 * 보리 대사 응답에서 숫자를 지어낸 감상의 표식. 이 감상은 사실 목록에 없는 숫자(987.6)를 말한다.
 * 이 파일은 불러오면 서버가 뜨므로 dashboard.mjs는 import하지 않고 같은 값을 따로 둔다.
 */
const NARRATION_FABRICATED_MARK = "지어낸 수치";
/** 규칙에 맞는 감상. dashboard.mjs가 같은 값으로 끝나는지 본다. */
const NARRATION_GOOD_COMMENT = "좋아 보여요.";
/**
 * 둘째 줄부터 붙이는 감상. 서버는 같은 대사에서 되풀이한 감상을 버리므로(repeated) 줄마다 다르게 하되,
 * 모두 NARRATION_GOOD_COMMENT로 끝나게 한다. 서버 예시 묶음(narration/examples.ts)의 문장은 쓰지 않는다(copied로 버려진다).
 */
const NARRATION_GOOD_COMMENTS = [NARRATION_GOOD_COMMENT, `꽤 ${NARRATION_GOOD_COMMENT}`, `정말 ${NARRATION_GOOD_COMMENT}`];
/** 고르는 사실 수. 서버의 3~5줄 안에 들어가게 한다. */
const NARRATION_PICK_LIMIT = 4;

/** user 프롬프트의 "[사실 목록]" 아래 "f1: 문장" 줄들. */
function narrationFacts(user) {
  return user.split("\n").flatMap(line => {
    const match = /^(f\d+): (.+)$/.exec(line);
    return match ? [{ id: match[1], text: match[2] }] : [];
  });
}

/**
 * 보리 대사 요청은 스키마 모양(lines)으로 구분한다. 그 밖의 요청에는 고정 답을 준다.
 */
function replyFor(schema, user = "") {
  const properties = schema?.properties ?? {};
  if ("lines" in properties) {
    const facts = narrationFacts(user);
    const lines = facts.slice(0, NARRATION_PICK_LIMIT).map((fact, index) => ({
      factId: fact.id,
      emotion: index === 0 ? "happy" : "calm",
      comment: index === 0 ? `${NARRATION_FABRICATED_MARK} 987.6이 보여요` : NARRATION_GOOD_COMMENTS[(index - 1) % NARRATION_GOOD_COMMENTS.length],
    }));
    return JSON.stringify({ lines });
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
  // 남은 실패 주입도 함께 지운다. 소비되지 않은 주입이 다음 시나리오로 넘어가지 않게 한다.
  if (url.pathname === "/__reset") { calls.length = 0; injections.length = 0; sendJson(response, 200, { ok: true }); return; }

  if (url.pathname === "/__timing") {
    for (const key of ["llm", "tts"]) {
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

  if (url.pathname === "/__inject") {
    if (url.searchParams.get("clear") === "1") injections.length = 0;
    else {
      injections.push({
        target: url.searchParams.get("target") ?? "llm",
        mode: url.searchParams.get("mode") ?? "500",
        remaining: Number(url.searchParams.get("count") ?? 1),
        ms: Number(url.searchParams.get("ms") ?? 0),
        match: url.searchParams.get("match") ?? "",
      });
    }
    sendJson(response, 200, injections);
    return;
  }

  if (url.pathname.endsWith("/chat/completions")) {
    const parsed = JSON.parse(body);
    const record = { at, system: parsed.messages[0].content, user: parsed.messages[1].content };
    const injected = takeInjection("llm", `${record.system}\n${record.user}`);
    if (injected?.mode === "500") {
      calls.push({ kind: "llm-failed", ...record });
      sendJson(response, 500, { error: { message: "테스트용 주입 실패" } });
      return;
    }
    if (injected?.mode === "badjson") {
      calls.push({ kind: "llm", ...record });
      sendJson(response, 200, { choices: [{ message: { content: "{\"reply\": \"깨진" } }] });
      return;
    }
    // delay는 정상 응답을 늦게 준다. 서버 타임아웃보다 길면 서버 쪽에서 실패가 된다.
    if (injected?.mode === "delay") await sleep(injected.ms);

    if (failLlm) {
      calls.push({ kind: "llm-failed", ...record });
      await sleep(200);
      sendJson(response, 500, { error: { message: "테스트용 실패" } });
      return;
    }

    calls.push({ kind: "llm", ...record });
    await sleep(timing.llm);
    sendJson(response, 200, { choices: [{ message: { content: replyFor(parsed.response_format?.json_schema?.schema, record.user) } }], usage: MOCK_USAGE });
    return;
  }

  // ElevenLabs 목소리 목록. 서버가 목록을 캐시하는지 횟수로 본다.
  if (url.pathname.endsWith("/voices")) {
    calls.push({ kind: "voices", at });
    sendJson(response, 200, { voices: [{ voice_id: "mockvoice", name: "가짜 목소리" }] });
    return;
  }

  if (url.pathname.endsWith("/audio/speech")) {
    const injected = takeInjection("tts", body);
    if (injected?.mode === "500") {
      calls.push({ kind: "tts-failed", at });
      sendJson(response, 500, { error: { message: "테스트용 주입 실패" } });
      return;
    }
    // 업체가 200으로 빈 본문이나 mp3가 아닌 데이터를 주는 경우. 서버가 실패로 봐야 한다.
    if (injected?.mode === "empty" || injected?.mode === "garbage") {
      calls.push({ kind: "tts", at });
      response.writeHead(200, { "Content-Type": "audio/mpeg" });
      response.end(injected.mode === "empty" ? undefined : Buffer.from("<html>not audio</html>"));
      return;
    }
    // ms 길이의 mp3. 128kbps 44.1kHz 프레임(417바이트, 약 26.1ms)을 이어 붙인다.
    if (injected?.mode === "long") {
      calls.push({ kind: "tts", at });
      const frame = Buffer.alloc(417);
      frame.set([0xff, 0xfb, 0x90, 0x00]);
      response.writeHead(200, { "Content-Type": "audio/mpeg" });
      response.end(Buffer.concat(Array.from({ length: Math.ceil(injected.ms / (1152 / 44.1)) }, () => frame)));
      return;
    }
    if (injected?.mode === "delay") await sleep(injected.ms);
    calls.push({ kind: "tts", at });
    await sleep(timing.tts);
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    // 대시보드가 재생을 시도할 수 있도록 mp3 프레임 헤더 흉내만 낸다.
    response.end(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${port}`);
});
