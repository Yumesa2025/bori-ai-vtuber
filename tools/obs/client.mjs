// obs-websocket v5 클라이언트. 비밀번호는 OBS_PASSWORD 환경변수로만 받는다.
import { createHash } from "node:crypto";

const URL_ = process.env.OBS_URL ?? "ws://127.0.0.1:4455";
const PASSWORD = process.env.OBS_PASSWORD ?? "";

const sha256b64 = (value) => createHash("sha256").update(value).digest("base64");

export function connect() {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(URL_);
    const pending = new Map();
    let nextId = 1;

    const call = (requestType, requestData = {}) =>
      new Promise((res, rej) => {
        const requestId = String(nextId++);
        pending.set(requestId, { res, rej });
        socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      });

    socket.onerror = (event) => rejectPromise(new Error(`websocket error: ${event.message ?? "unknown"}`));
    socket.onclose = () => { for (const { rej } of pending.values()) rej(new Error("closed")); pending.clear(); };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.op === 0) {
        const identify = { rpcVersion: 1 };
        const auth = message.d.authentication;
        if (auth) {
          const secret = sha256b64(PASSWORD + auth.salt);
          identify.authentication = sha256b64(secret + auth.challenge);
        }
        socket.send(JSON.stringify({ op: 1, d: identify }));
        return;
      }

      if (message.op === 2) { resolvePromise({ call, close: () => socket.close() }); return; }

      if (message.op === 7) {
        const entry = pending.get(message.d.requestId);
        if (!entry) return;
        pending.delete(message.d.requestId);
        if (message.d.requestStatus.result) entry.res(message.d.responseData ?? {});
        else entry.rej(new Error(`${message.d.requestType}: ${message.d.requestStatus.code} ${message.d.requestStatus.comment ?? ""}`));
      }
    };
  });
}
