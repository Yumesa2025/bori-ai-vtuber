const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { prepareRendererLog } = require("./log-file.cjs");
const { createRetryTimer, isExternalWebUrl, isSameOrigin, resolveAdminUrl } = require("./window-policy.cjs");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

// 렌더러 로그는 실행할 때마다 새로 쓰고 바로 전 실행 것만 남긴다(log-file.cjs).
const dataDir = process.env.BORI_DATA_DIR ? path.resolve(process.env.BORI_DATA_DIR) : path.resolve(__dirname, "../../../data");
const logPath = prepareRendererLog(dataDir);
function log(message) { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`); console.log(message); }

/** 로드에 실패하면 이 간격 뒤에 다시 연다. 렌더러 dev 서버가 늦게 뜨는 경우다. */
const RETRY_DELAY_MS = 1000;
/** did-fail-load의 ERR_ABORTED. 새 로드가 앞 로드를 끊은 것이라 실패로 보지 않는다. */
const ERR_ABORTED = -3;

function createWindow() {
  // preload가 없어 렌더러에 열어 둔 IPC가 없으므로 sandbox를 켜도 잃는 기능이 없다.
  const window = new BrowserWindow({ width: 1100, height: 760, show: true, backgroundColor: "#17131a", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const target = resolveAdminUrl(process.env.BORI_ADMIN_URL);
  if (target.rejected) log(`[bori-admin] BORI_ADMIN_URL은 이 컴퓨터 주소만 쓸 수 있어 기본 주소를 엽니다: ${target.rejected}`);
  const url = target.url;

  // 재시도는 did-fail-load 한 곳에서만 예약한다. loadURL의 reject는 같은 실패라 무시한다.
  const retry = createRetryTimer(RETRY_DELAY_MS);
  let failed = false;
  const load = () => { failed = false; window.loadURL(url).catch(() => { /* did-fail-load에서 기록하고 다시 시도한다. */ }); };
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    failed = true;
    log(`[bori-admin] load failed ${errorCode}: ${errorDescription}`);
    retry.schedule(load);
  });
  // 로드에 실패하면 Chromium 오류 페이지에서도 did-finish-load가 온다. 실패가 없었을 때만 성공으로 기록한다.
  window.webContents.on("did-finish-load", () => { if (!failed) log(`[bori-admin] loaded ${url}`); });
  // Electron 35부터 위치 인자(level, message, …)는 deprecated라 이벤트 객체의 값을 쓴다.
  window.webContents.on("console-message", (event) => log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`));
  window.webContents.on("render-process-gone", (_event, details) => log(`[bori-admin] renderer gone: ${details.reason}`));

  // 관리자 화면 밖으로 이동하거나 새 창을 열지 않는다. 외부 웹 링크는 기본 브라우저로 넘긴다.
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    if (isSameOrigin(navigationUrl, url)) return;
    event.preventDefault();
    log(`[bori-admin] 관리자 화면 밖으로 이동을 막았습니다: ${navigationUrl}`);
    if (isExternalWebUrl(navigationUrl)) void shell.openExternal(navigationUrl);
  });
  window.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (isExternalWebUrl(openUrl)) void shell.openExternal(openUrl);
    return { action: "deny" };
  });
  window.on("closed", () => retry.cancel());
  load();
}

app.whenReady().then(() => { createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
