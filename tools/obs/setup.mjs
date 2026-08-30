/**
 * OBS에 보리 방송용 씬과 브라우저 소스를 만든다. 이미 있으면 설정만 갱신한다.
 * 캔버스와 브라우저 소스를 1920x1080으로 맞춘다.
 *
 * 실행 전 OBS에서 도구 > WebSocket 서버 설정을 켜야 한다.
 *
 *   $env:OBS_PASSWORD='...'; node tools/obs/setup.mjs
 *
 * 비밀번호는 환경변수로만 받는다. 코드나 설정 파일에 적지 않는다.
 */
import { connect } from "./client.mjs";

const SCENE = process.env.BORI_OBS_SCENE ?? "보리 방송";
const SOURCE = process.env.BORI_OBS_SOURCE ?? "보리 방송 화면";
// 송출 화면에는 채팅 입력창을 띄우지 않는다.
const URL_ = process.env.BORI_URL ?? "http://127.0.0.1:4174/?input=0";
const WIDTH = Number(process.env.BORI_WIDTH ?? 1920);
const HEIGHT = Number(process.env.BORI_HEIGHT ?? 1080);

const obs = await connect();

const before = await obs.call("GetVideoSettings");
if (before.baseWidth !== WIDTH || before.baseHeight !== HEIGHT) {
  await obs.call("SetVideoSettings", { baseWidth: WIDTH, baseHeight: HEIGHT, outputWidth: WIDTH, outputHeight: HEIGHT });
  console.log(`캔버스 변경: ${before.baseWidth}x${before.baseHeight} -> ${WIDTH}x${HEIGHT}`);
} else {
  console.log(`캔버스 유지: ${WIDTH}x${HEIGHT}`);
}

const scenes = await obs.call("GetSceneList");
if (!scenes.scenes.some(scene => scene.sceneName === SCENE)) {
  await obs.call("CreateScene", { sceneName: SCENE });
  console.log(`씬 생성: ${SCENE}`);
}

const settings = {
  url: URL_,
  width: WIDTH,
  height: HEIGHT,
  // 방송 중 소스가 꺼지면 곤란하므로 보이지 않을 때 종료하지 않는다.
  shutdown: false,
  restart_when_active: true,
  reroute_audio: true,
};

const inputs = await obs.call("GetInputList");
if (inputs.inputs.some(input => input.inputName === SOURCE)) {
  await obs.call("SetInputSettings", { inputName: SOURCE, inputSettings: settings, overlay: true });
  console.log(`소스 설정 갱신: ${SOURCE}`);
} else {
  await obs.call("CreateInput", { sceneName: SCENE, inputName: SOURCE, inputKind: "browser_source", inputSettings: settings });
  console.log(`소스 생성: ${SOURCE}`);
}

await obs.call("SetCurrentProgramScene", { sceneName: SCENE });

// 이전 캔버스 기준으로 남아 있던 변환을 초기화해 소스를 캔버스에 정확히 맞춘다.
const items = await obs.call("GetSceneItemList", { sceneName: SCENE });
const item = items.sceneItems.find(entry => entry.sourceName === SOURCE);
if (item) {
  await obs.call("SetSceneItemTransform", {
    sceneName: SCENE,
    sceneItemId: item.sceneItemId,
    sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 },
  });
}

console.log(`준비 완료. 씬 "${SCENE}", 소스 "${SOURCE}", URL ${URL_}`);
obs.close();
