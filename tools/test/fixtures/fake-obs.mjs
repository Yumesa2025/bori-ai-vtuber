/**
 * OBS WebSocket v5(obs-websocket 5.x) 서버를 흉내 내는 가짜 서버.
 *
 * 실제 OBS 없이 연결 → 인증 → 장면 바꾸기 → 끊김·재연결 흐름을 검사한다.
 * 형식은 obs-websocket 5.x 프로토콜 문서(github.com/obsproject/obs-websocket, docs/generated/protocol.md)를 따른다.
 * - 하위 프로토콜 obswebsocket.json만 받는다.
 * - Hello(op 0) → Identify(op 1) → Identified(op 2), 요청(op 6) → 응답(op 7), 이벤트(op 5).
 * - 비밀번호가 틀리면 4009(AuthenticationFailed)로 닫는다.
 * - 없는 장면이면 요청 상태 600(ResourceNotFound)으로 답한다.
 *
 * 검사 코드에서는 startFakeObs()로 띄우고, 단독으로는 다음처럼 띄운다.
 *
 *   FAKE_OBS_PORT=4842 FAKE_OBS_PASSWORD=pw node tools/test/fixtures/fake-obs.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const PROTOCOL = "obswebsocket.json";
const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 };
const AUTHENTICATION_FAILED = 4009;
const RESOURCE_NOT_FOUND = 600;
const SUCCESS = 100;

const sha256Base64 = text => createHash("sha256").update(text).digest("base64");

/**
 * 가짜 서버를 띄운다.
 * @param {{ port: number; host?: string; password?: string; scenes?: string[] }} options
 */
export async function startFakeObs({ port, host = "127.0.0.1", password = "", scenes = ["보리-대기", "보리-메인", "보리-전적", "보리-엔딩"] }) {
  /** 받은 요청 기록. 요청 이름과 장면 이름만 남긴다. */
  const requests = [];
  const sockets = new Set();
  const sceneList = [...scenes];
  let currentScene = sceneList[0] ?? "";
  let authFailures = 0;

  const server = createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  // ws 3.x~8.x 모두 Server를 내보낸다. 저장소의 ws는 socket.io가 끌어온 3.x다.
  const wss = new WebSocket.Server({
    server,
    handleProtocols: protocols => {
      const list = Array.isArray(protocols) ? protocols : [...protocols];
      return list.includes(PROTOCOL) ? PROTOCOL : false;
    },
  });

  const send = (socket, op, d) => socket.send(JSON.stringify({ op, d }));
  const broadcastEvent = (eventType, eventData) => {
    for (const socket of sockets) if (socket.identified) send(socket, OP.Event, { eventType, eventIntent: 4, eventData });
  };

  function respond(socket, d, result) {
    send(socket, OP.RequestResponse, {
      requestType: d.requestType,
      requestId: d.requestId,
      requestStatus: { result: result.ok, code: result.ok ? SUCCESS : result.code, ...(result.comment ? { comment: result.comment } : {}) },
      ...(result.data ? { responseData: result.data } : {}),
    });
  }

  function handleRequest(socket, d) {
    const sceneName = d.requestData?.sceneName;
    requests.push({ requestType: d.requestType, ...(typeof sceneName === "string" ? { sceneName } : {}) });
    switch (d.requestType) {
      case "GetCurrentProgramScene":
        return respond(socket, d, { ok: true, data: { currentProgramSceneName: currentScene, sceneName: currentScene } });
      case "GetSceneList":
        return respond(socket, d, { ok: true, data: { currentProgramSceneName: currentScene, scenes: sceneList.map((name, index) => ({ sceneName: name, sceneIndex: index })) } });
      case "SetCurrentProgramScene":
        if (!sceneList.includes(sceneName)) return respond(socket, d, { ok: false, code: RESOURCE_NOT_FOUND, comment: `No source was found by the name of \`${sceneName}\`.` });
        currentScene = sceneName;
        respond(socket, d, { ok: true });
        broadcastEvent("CurrentProgramSceneChanged", { sceneName });
        return;
      default:
        return respond(socket, d, { ok: false, code: 204, comment: "Unknown request type." });
    }
  }

  wss.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const challenge = randomBytes(16).toString("base64");
    const salt = randomBytes(16).toString("base64");
    send(socket, OP.Hello, {
      obsWebSocketVersion: "5.5.0",
      rpcVersion: 1,
      ...(password ? { authentication: { challenge, salt } } : {}),
    });
    socket.on("message", raw => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.op === OP.Identify) {
        if (password) {
          const expected = sha256Base64(sha256Base64(password + salt) + challenge);
          if (message.d?.authentication !== expected) {
            authFailures += 1;
            socket.close(AUTHENTICATION_FAILED, "Authentication failed.");
            return;
          }
        }
        socket.identified = true;
        send(socket, OP.Identified, { negotiatedRpcVersion: 1 });
        return;
      }
      if (message.op === OP.Request && socket.identified) handleRequest(socket, message.d ?? {});
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    requests,
    currentScene: () => currentScene,
    authFailures: () => authFailures,
    connectedSockets: () => [...sockets].filter(socket => socket.identified).length,
    /** 장면을 지운다. 없는 장면으로 바꾸는 경우를 검사할 때 쓴다. */
    removeScene(name) {
      const index = sceneList.indexOf(name);
      if (index >= 0) sceneList.splice(index, 1);
    },
    /** 연결된 소켓을 모두 끊는다. OBS를 끈 상황이다. 서버는 계속 받는다. */
    dropSockets() {
      for (const socket of sockets) socket.terminate();
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise(resolve => wss.close(() => resolve()));
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// 단독 실행
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_OBS_PORT ?? 4842);
  await startFakeObs({ port, password: process.env.FAKE_OBS_PASSWORD ?? "" });
  console.log(`[fake-obs] ws://127.0.0.1:${port}`);
}
