/**
 * 현재 OBS 씬을 PNG로 저장한다. 송출 화면을 눈으로 확인할 때 쓴다.
 *
 *   $env:OBS_PASSWORD='...'; node tools/obs/screenshot.mjs
 */
import { writeFile } from "node:fs/promises";
import { connect } from "./client.mjs";

const target = process.env.OBS_SHOT_SOURCE ?? "보리 방송";
const outPath = process.env.OBS_SHOT_PATH ?? "./obs-shot.png";

const obs = await connect();
const shot = await obs.call("GetSourceScreenshot", {
  sourceName: target,
  imageFormat: "png",
  imageWidth: 1280,
});

const base64 = shot.imageData.replace(/^data:image\/png;base64,/, "");
await writeFile(outPath, Buffer.from(base64, "base64"));
console.log(`저장: ${outPath}`);

obs.close();
