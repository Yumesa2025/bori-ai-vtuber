const fs = require("node:fs");
const path = require("node:path");

const LOG_NAME = "admin-renderer.log";
/** 서버의 보관 정리(apps/server/src/retention.ts)가 이 이름을 30일 뒤에 지운다. 바꾸면 거기도 맞춘다. */
const PREVIOUS_LOG_NAME = "admin-renderer.previous.log";

/**
 * 렌더러 로그를 쓸 경로를 정하고, 이전 실행의 로그를 넘겨 둔다.
 * 실행할 때마다 지난 로그를 previous로 옮기고 새로 쓰므로, 남는 것은 지금 실행과 바로 전 실행뿐이다.
 * 서버와 같이 BORI_DATA_DIR이 있으면 그 디렉터리를 쓴다.
 */
function prepareRendererLog(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, LOG_NAME);
  try {
    fs.renameSync(logPath, path.join(dataDir, PREVIOUS_LOG_NAME));
  } catch {
    // 처음 실행이라 넘길 로그가 없다.
  }
  return logPath;
}

module.exports = { prepareRendererLog, LOG_NAME, PREVIOUS_LOG_NAME };
