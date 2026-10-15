/**
 * 치지직 방송 진행기(W1~W4)용 OBS 장면 4개와 브라우저 소스 7개를 만든다. 이미 있으면 소스 설정만 맞춘다.
 * 서버가 장면 이름(보리-대기·보리-메인·보리-전적·보리-엔딩)으로 자동 전환하므로 이름을 바꾸지 않는다.
 * 다른 장면·소스는 건드리지 않고 지우지도 않는다. 이미 있는 장면 항목의 순서·위치도 그대로 두고, 새로 넣는 항목만 정해진 층에 끼운다.
 *
 *   npm run obs:setup
 *
 * 비밀번호는 루트 .env의 OBS_WEBSOCKET_PASSWORD(셸 환경변수가 있으면 그것)에서 읽고 출력하지 않는다.
 * 소스 주소는 보리 서버(BORI_SERVER_PORT, 기본 4310)를 가리킨다. 서버가 꺼져 있어도 장면은 만들어진다.
 */
try { process.loadEnvFile(".env"); } catch { /* .env가 없으면 셸 환경변수만 쓴다 */ }
process.env.OBS_PASSWORD ??= process.env.OBS_WEBSOCKET_PASSWORD ?? "";
process.env.OBS_URL ??= process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455";
const { connect } = await import("./client.mjs");

const WIDTH = 1920;
const HEIGHT = 1080;
const BASE = `http://127.0.0.1:${process.env.BORI_SERVER_PORT || 4310}/obs`;

// 페이지별 소스 이름. 캐릭터만 소리를 내므로 OBS 오디오로 받고 60fps로 그린다.
const SOURCES = {
  character: { name: "보리 캐릭터", extra: { reroute_audio: true, fps_custom: true, fps: 60 } },
  dashboard: { name: "보리 대시보드" },
  caption: { name: "보리 자막" },
  chat: { name: "보리 채팅" },
  waiting: { name: "보리 대기 화면" },
  ending: { name: "보리 엔딩 화면" },
  background: { name: "보리 배경" },
};

// 아래에서 위 순서. 메인·전적은 같은 소스를 공유해 장면이 바뀌어도 캐릭터가 다시 불러와지지 않는다.
// 배경이 없으면 투명 페이지만 남아 송출 화면이 검은 바탕이 된다.
const SCENES = {
  "보리-대기": ["waiting"],
  "보리-메인": ["background", "dashboard", "character", "chat", "caption"],
  "보리-전적": ["background", "dashboard", "character", "chat", "caption"],
  "보리-엔딩": ["ending"],
};

const settingsFor = page => ({
  url: `${BASE}/${page}.html`,
  width: WIDTH,
  height: HEIGHT,
  // 방송 중에 보이지 않는 장면으로 가도 페이지를 끄지 않는다(대사·상태 유지).
  shutdown: false,
  restart_when_active: false,
  reroute_audio: false,
  ...SOURCES[page].extra,
});

const obs = await connect();

const video = await obs.call("GetVideoSettings");
if (video.baseWidth !== WIDTH || video.baseHeight !== HEIGHT) {
  console.log(`주의: OBS 캔버스가 ${video.baseWidth}x${video.baseHeight}이다. 설정 → 비디오에서 1920x1080으로 맞춰야 화면이 맞는다.`);
}

const existingScenes = new Set((await obs.call("GetSceneList")).scenes.map(scene => scene.sceneName));
const existingInputs = new Set((await obs.call("GetInputList")).inputs.map(input => input.inputName));

for (const [sceneName, pages] of Object.entries(SCENES)) {
  if (!existingScenes.has(sceneName)) {
    await obs.call("CreateScene", { sceneName });
    console.log(`장면 생성: ${sceneName}`);
  }
  const items = new Set((await obs.call("GetSceneItemList", { sceneName })).sceneItems.map(item => item.sourceName));
  for (const [layer, page] of pages.entries()) {
    const inputName = SOURCES[page].name;
    if (items.has(inputName)) continue;
    let sceneItemId;
    if (existingInputs.has(inputName)) {
      ({ sceneItemId } = await obs.call("CreateSceneItem", { sceneName, sourceName: inputName }));
    } else {
      ({ sceneItemId } = await obs.call("CreateInput", { sceneName, inputName, inputKind: "browser_source", inputSettings: settingsFor(page) }));
      existingInputs.add(inputName);
      console.log(`소스 생성: ${inputName}`);
    }
    // 새 항목은 맨 위에 붙는다. 정해진 아래층 항목 바로 위로 내린다.
    const below = pages.slice(0, layer).filter(other => items.has(SOURCES[other].name)).length;
    await obs.call("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: below });
    items.add(inputName);
    await obs.call("SetSceneItemTransform", {
      sceneName,
      sceneItemId,
      sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 },
    });
    console.log(`  ${sceneName} ← ${inputName}`);
  }
}

// 이미 있던 소스도 주소·크기를 맞춘다(서버 포트를 바꾼 경우 등).
for (const page of Object.keys(SOURCES)) {
  await obs.call("SetInputSettings", { inputName: SOURCES[page].name, inputSettings: settingsFor(page), overlay: true });
}

// 기본 전환은 페이드 0.3초(설계 9절). 페이드 전환이 없으면 그대로 둔다.
const { transitions } = await obs.call("GetSceneTransitionList");
const fade = transitions.find(transition => transition.transitionKind === "fade_transition");
if (fade) {
  await obs.call("SetCurrentSceneTransition", { transitionName: fade.transitionName });
  await obs.call("SetCurrentSceneTransitionDuration", { transitionDuration: 300 });
  console.log(`전환: ${fade.transitionName} 0.3초`);
}

console.log(`준비 완료. 소스 주소 ${BASE}/*.html`);
obs.close();
