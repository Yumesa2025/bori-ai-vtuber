import { OBSWebSocket, OBSWebSocketError } from "obs-websocket-js/json";
import type { ObsSceneName, ShowConnections } from "@bori/shared";

/**
 * OBS WebSocket v5 제어(obs-websocket-js 5).
 * - JSON 하위 프로토콜(obs-websocket-js/json)을 쓴다. 기본 진입점은 msgpack이라 의존성이 하나 더 붙는다.
 * - 끊기면 reconnectDelayMs(기본 5초)마다 다시 연결한다. 비밀번호가 틀리면(4009) 다시 시도해도 소용없어 멈춘다.
 * - 장면 전환은 실패해도 throw하지 않는다. 방송 진행이 OBS 때문에 멈추지 않게 이유만 lastError에 남긴다.
 * - 비밀번호는 오류 메시지·로그에 넣지 않는다.
 */

type ObsState = ShowConnections["obs"];

export type ObsStatus = { state: ObsState; currentScene: string | null; lastError: string | null };

/** obs-websocket WebSocketCloseCode.AuthenticationFailed */
const AUTHENTICATION_FAILED = 4009;
/** obs-websocket RequestStatus.ResourceNotFound */
const RESOURCE_NOT_FOUND = 600;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
/** 요청 하나의 상한. OBS가 멈춰 응답이 없으면 진행기가 장면 전환을 계속 기다리지 않게 끊는다. */
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OBS 응답 시간 초과")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createObsController(options: { url: string; password: string; reconnectDelayMs?: number; requestTimeoutMs?: number }) {
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let state: ObsState = "off";
  let currentScene: string | null = null;
  let lastError: string | null = null;
  let client: OBSWebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  /** 시도 번호. 끝난 시도의 늦은 이벤트가 지금 상태를 바꾸지 못하게 한다. */
  let attempt = 0;

  /** 잠시 뒤 다시 연결한다. */
  function retryLater(message: string) {
    if (stopped) return;
    client = null;
    lastError = message;
    state = "error";
    timer = setTimeout(() => {
      timer = undefined;
      void open();
    }, reconnectDelayMs);
  }

  /** 다시 시도해도 소용없는 실패. 설정을 고치고 서버를 다시 켜야 한다. */
  function giveUp(message: string) {
    client = null;
    lastError = message;
    state = "error";
  }

  async function open() {
    const current = ++attempt;
    const isCurrent = () => !stopped && current === attempt;
    state = "connecting";
    const obs = new OBSWebSocket();
    client = obs;
    /** 인증까지 마쳤는지. 연결 중 실패는 아래 catch가 처리하므로 끊김 처리기는 그 뒤만 본다. */
    let identified = false;
    obs.on("ConnectionClosed", error => {
      if (!isCurrent() || client !== obs || !identified) return;
      if (error.code === AUTHENTICATION_FAILED) giveUp("OBS WebSocket 비밀번호가 틀렸습니다.");
      else retryLater(`OBS 연결이 끊겨 ${Math.round(reconnectDelayMs / 1000)}초 뒤 다시 연결합니다.`);
    });
    obs.on("CurrentProgramSceneChanged", data => {
      if (isCurrent()) currentScene = data.sceneName;
    });

    try {
      await obs.connect(options.url, options.password.length > 0 ? options.password : undefined);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof OBSWebSocketError && error.code === AUTHENTICATION_FAILED) giveUp("OBS WebSocket 비밀번호가 틀렸습니다. OBS 도구 > WebSocket 서버 설정의 비밀번호를 확인해 주세요.");
      else retryLater(`OBS에 연결하지 못했습니다. OBS가 켜져 있고 WebSocket 서버가 켜져 있는지 확인해 주세요. ${Math.round(reconnectDelayMs / 1000)}초 뒤 다시 시도합니다.`);
      return;
    }
    if (!isCurrent()) {
      void obs.disconnect().catch(() => undefined);
      return;
    }
    identified = true;
    try {
      const scene = await withTimeout(obs.call("GetCurrentProgramScene"), requestTimeoutMs);
      if (isCurrent()) currentScene = scene.currentProgramSceneName;
    } catch {
      // 지금 장면을 몰라도 전환은 할 수 있다.
    }
    // 장면을 묻는 사이 끊겼으면 끊김 처리기가 이미 재연결을 잡았다.
    if (!isCurrent() || client !== obs) return;
    state = "connected";
    lastError = null;
  }

  return {
    /** 연결을 시작한다. 이미 시작했으면 아무것도 하지 않는다. */
    connect() {
      if (!stopped) return;
      stopped = false;
      void open();
    },

    /** 장면을 바꾼다. 연결되지 않았거나 실패해도 throw하지 않는다. */
    async setScene(name: ObsSceneName): Promise<void> {
      const obs = client;
      if (!obs || state !== "connected") return;
      try {
        await withTimeout(obs.call("SetCurrentProgramScene", { sceneName: name }), requestTimeoutMs);
        currentScene = name;
        lastError = null;
      } catch (error) {
        lastError = error instanceof OBSWebSocketError && error.code === RESOURCE_NOT_FOUND
          ? `OBS에 '${name}' 장면이 없습니다. 같은 이름으로 장면을 만들어 주세요.`
          : `OBS 장면을 '${name}'(으)로 바꾸지 못했습니다.`;
      }
    },

    /**
     * 미디어 소스(배경음악·대기 영상)를 처음부터 틀거나 멈춘다. 그 소스가 OBS에 없으면(영상·음악을 넣지 않은 경우) 조용히 넘어간다.
     * 연결되지 않았거나 실패해도 throw하지 않는다.
     */
    async media(inputName: string, action: "restart" | "stop"): Promise<void> {
      const obs = client;
      if (!obs || state !== "connected") return;
      const mediaAction = action === "restart" ? "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART" : "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP";
      try {
        await withTimeout(obs.call("TriggerMediaInputAction", { inputName, mediaAction }), requestTimeoutMs);
      } catch (error) {
        if (error instanceof OBSWebSocketError && error.code === RESOURCE_NOT_FOUND) return;
        lastError = `OBS 미디어 '${inputName}'을(를) ${action === "restart" ? "재생하지" : "멈추지"} 못했습니다.`;
      }
    },

    /** 입력 소스 볼륨(dB). 연결되지 않았거나 소스가 없으면 null. */
    async volume(inputName: string): Promise<number | null> {
      const obs = client;
      if (!obs || state !== "connected") return null;
      try {
        const result = await withTimeout(obs.call("GetInputVolume", { inputName }), requestTimeoutMs);
        return result.inputVolumeDb;
      } catch {
        return null;
      }
    },

    /** 입력 소스 볼륨(dB)을 바꾼다. 연결되지 않았거나 실패해도 throw하지 않는다. */
    async setVolume(inputName: string, inputVolumeDb: number): Promise<void> {
      const obs = client;
      if (!obs || state !== "connected") return;
      try {
        await withTimeout(obs.call("SetInputVolume", { inputName, inputVolumeDb }), requestTimeoutMs);
      } catch {
        // 배경음악이 없는 OBS도 있다. 볼륨 조절 실패는 진행을 막지 않는다.
      }
    },

    status: (): ObsStatus => ({ state, currentScene, lastError }),

    /** 연결을 끊고 다시 연결하지 않는다. */
    async stop() {
      stopped = true;
      attempt += 1;
      if (timer) clearTimeout(timer);
      timer = undefined;
      const obs = client;
      client = null;
      state = "off";
      currentScene = null;
      if (obs) await obs.disconnect().catch(() => undefined);
    },
  };
}

export type ObsController = ReturnType<typeof createObsController>;
