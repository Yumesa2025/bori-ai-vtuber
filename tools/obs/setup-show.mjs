/**
 * 치지직 방송 진행기(W1~W4)용 OBS 장면 4개와 브라우저 소스 7개(배경 영상이 있으면 미디어 소스 3개 더)를 만들고 장면 전환을 정한다. 이미 있으면 소스 설정만 맞춘다.
 * 서버가 장면 이름(보리-대기·보리-메인·보리-전적·보리-엔딩)으로 자동 전환하므로 이름을 바꾸지 않는다.
 * 다른 장면·소스는 건드리지 않고 지우지도 않는다. 이미 있는 장면 항목의 순서·위치도 그대로 두고, 새로 넣는 항목만 정해진 층에 끼운다.
 *
 *   npm run obs:setup
 *
 * 배경 영상이 private-assets/obs/에 있으면(저장소에 올리지 않는 사용자 자산) 반복 재생 미디어 소스로 넣고, 그 자리의 페이지 항목은 숨긴다(지우지 않음).
 *   waiting-loop.mp4 → 보리-대기 화면 전체, main-loop.mp4 → 보리-메인·전적 맨 아래층, ending-loop.mp4 → 보리-엔딩 화면 전체. 영상을 빼고 다시 돌리면 페이지 배경으로 돌아간다.
 *
 * 장면 전환 영상(private-assets/obs/transition.webm·mov·mp4)이 있으면 스팅어 전환 "보리 전환"에 넣고 현재 전환으로 정한다.
 * obs-websocket에는 전환을 새로 만드는 요청이 없어, OBS 장면 전환 칸의 + → 스팅어로 "보리 전환"을 한 번 만들어 두어야 한다.
 * 전환 시점(영상이 화면을 다 덮는 때)은 BORI_OBS_TRANSITION_POINT_MS(밀리초), 없으면 ffprobe로 잰 영상 길이의 절반이다.
 * 영상이나 "보리 전환"이 없으면 페이드 0.3초를 쓴다.
 *
 * 비밀번호는 루트 .env의 OBS_WEBSOCKET_PASSWORD(셸 환경변수가 있으면 그것)에서 읽고 출력하지 않는다.
 * 소스 주소는 보리 서버(BORI_SERVER_PORT, 기본 4310)를 가리킨다. 서버가 꺼져 있어도 장면은 만들어진다.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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

// 배경 영상과 영상이 없을 때 쓰는 페이지(replaces). 영상은 소리가 없어 음소거로 넣는다.
const VIDEOS = {
  waitingVideo: { name: "보리 대기 영상", file: resolve("private-assets/obs/waiting-loop.mp4"), replaces: "waiting" },
  mainVideo: { name: "보리 배경 영상", file: resolve("private-assets/obs/main-loop.mp4"), replaces: "background" },
  endingVideo: { name: "보리 엔딩 영상", file: resolve("private-assets/obs/ending-loop.mp4"), replaces: "ending" },
};
const hasVideo = key => existsSync(VIDEOS[key].file);
const pick = key => (hasVideo(key) ? key : VIDEOS[key].replaces);
const nameOf = key => (VIDEOS[key] ?? SOURCES[key]).name;
// 장면 전환 영상. 알파 채널이 있는 webm·mov를 먼저 찾는다.
const TRANSITION_NAME = "보리 전환";
const transitionFile = ["webm", "mov", "mp4"].map(ext => resolve(`private-assets/obs/transition.${ext}`)).find(file => existsSync(file));

/** 스팅어가 아래 장면을 바꾸는 시점(밀리초). 정할 수 없으면 null(OBS에 저장된 값을 그대로 둔다). */
function transitionPointMs(file) {
  const fromEnv = Number.parseInt(process.env.BORI_OBS_TRANSITION_POINT_MS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  const seconds = Number.parseFloat(probe.stdout ?? "");
  return probe.status === 0 && Number.isFinite(seconds) ? Math.round((seconds * 1000) / 2) : null;
}

// 메인 배경 영상의 금테 틀에 얹히는 패널 페이지. 패널 자체 테두리·바탕을 지우게 주소에 ?frame=video를 붙인다.
const FRAMED_PAGES = new Set(["dashboard", "chat"]);

// 아래에서 위 순서. 메인·전적은 같은 소스를 공유해 장면이 바뀌어도 캐릭터가 다시 불러와지지 않는다.
// 배경이 없으면 투명 페이지만 남아 송출 화면이 검은 바탕이 된다.
const SCENES = {
  "보리-대기": [pick("waitingVideo")],
  "보리-메인": [pick("mainVideo"), "dashboard", "character", "chat", "caption"],
  "보리-전적": [pick("mainVideo"), "dashboard", "character", "chat", "caption"],
  "보리-엔딩": [pick("endingVideo")],
};

const pageSettings = page => ({
  url: `${BASE}/${page}.html${hasVideo("mainVideo") && FRAMED_PAGES.has(page) ? "?frame=video" : ""}`,
  width: WIDTH,
  height: HEIGHT,
  // 방송 중에 보이지 않는 장면으로 가도 페이지를 끄지 않는다(대사·상태 유지).
  shutdown: false,
  restart_when_active: false,
  reroute_audio: false,
  ...SOURCES[page].extra,
});

// 끝나면 처음부터 다시 돈다. 장면이 바뀌어도 멈추지 않고 이어 재생한다.
const videoSettings = key => ({
  is_local_file: true,
  local_file: VIDEOS[key].file,
  looping: true,
  restart_on_activate: false,
  close_when_inactive: false,
  clear_on_media_end: false,
  hw_decode: true,
});
const inputFor = key => (key in VIDEOS
  ? { inputKind: "ffmpeg_source", inputSettings: videoSettings(key) }
  : { inputKind: "browser_source", inputSettings: pageSettings(key) });

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
    const inputName = nameOf(page);
    if (items.has(inputName)) continue;
    let sceneItemId;
    if (existingInputs.has(inputName)) {
      ({ sceneItemId } = await obs.call("CreateSceneItem", { sceneName, sourceName: inputName }));
    } else {
      ({ sceneItemId } = await obs.call("CreateInput", { sceneName, inputName, ...inputFor(page) }));
      existingInputs.add(inputName);
      console.log(`소스 생성: ${inputName}`);
    }
    // 새 항목은 맨 위에 붙는다. 정해진 아래층 항목 바로 위로 내린다.
    const below = pages.slice(0, layer).filter(other => items.has(nameOf(other))).length;
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

// 영상과 그 자리의 페이지 중 쓰는 쪽만 보이게 한다. 안 쓰는 항목은 지우지 않고 숨긴다.
for (const [sceneName, pages] of Object.entries(SCENES)) {
  const { sceneItems } = await obs.call("GetSceneItemList", { sceneName });
  for (const [key, video] of Object.entries(VIDEOS)) {
    for (const [option, show] of [[key, hasVideo(key)], [video.replaces, !hasVideo(key)]]) {
      const item = sceneItems.find(entry => entry.sourceName === nameOf(option));
      if (!item || !pages.includes(pick(key)) || item.sceneItemEnabled === show) continue;
      await obs.call("SetSceneItemEnabled", { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: show });
      console.log(`  ${sceneName}: ${nameOf(option)} ${show ? "보이기" : "숨기기"}`);
    }
  }
}

// 이미 있던 소스도 주소·크기를 맞춘다(서버 포트를 바꾼 경우 등).
for (const page of Object.keys(SOURCES)) {
  await obs.call("SetInputSettings", { inputName: SOURCES[page].name, inputSettings: pageSettings(page), overlay: true });
}
for (const key of Object.keys(VIDEOS).filter(hasVideo)) {
  await obs.call("SetInputSettings", { inputName: VIDEOS[key].name, inputSettings: videoSettings(key), overlay: true });
  await obs.call("SetInputMute", { inputName: VIDEOS[key].name, inputMuted: true });
}

// 전환 영상과 스팅어 "보리 전환"이 있으면 그것을, 아니면 페이드 0.3초(설계 9절)를 쓴다. 페이드 전환도 없으면 그대로 둔다.
const { transitions } = await obs.call("GetSceneTransitionList");
const stinger = transitions.find(transition => transition.transitionName === TRANSITION_NAME && transition.transitionKind === "obs_stinger_transition");
const fade = transitions.find(transition => transition.transitionKind === "fade_transition");
if (transitionFile && stinger) {
  await obs.call("SetCurrentSceneTransition", { transitionName: TRANSITION_NAME });
  const point = transitionPointMs(transitionFile);
  // tp_type 0은 시간(밀리초) 기준이다.
  const timing = point === null ? {} : { tp_type: 0, transition_point: point };
  await obs.call("SetCurrentSceneTransitionSettings", { transitionSettings: { path: transitionFile, hw_decode: true, ...timing }, overlay: true });
  console.log(`전환: ${TRANSITION_NAME} (${transitionFile}, 전환 시점 ${point === null ? "OBS에 저장된 값" : `${point}ms`})`);
} else if (fade) {
  if (transitionFile) console.log(`주의: 전환 영상이 있지만 OBS에 스팅어 전환 "${TRANSITION_NAME}"이 없다. 장면 전환 칸의 + → 스팅어로 그 이름으로 만들고 다시 실행한다.`);
  await obs.call("SetCurrentSceneTransition", { transitionName: fade.transitionName });
  await obs.call("SetCurrentSceneTransitionDuration", { transitionDuration: 300 });
  console.log(`전환: ${fade.transitionName} 0.3초`);
}

for (const [key, video] of Object.entries(VIDEOS)) console.log(`${video.name}: ${hasVideo(key) ? video.file : "파일 없음, 페이지 배경 사용"}`);
console.log(`준비 완료. 소스 주소 ${BASE}/*.html`);
obs.close();
