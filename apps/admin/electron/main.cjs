const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { prepareRendererLog } = require("./log-file.cjs");
const { createRetryTimer, isExternalWebUrl, isSameOrigin, resolveAdminUrl, DEFAULT_ADMIN_URL } = require("./window-policy.cjs");
const { ensureServer, prepareServerLog, resolveServerPort } = require("./server-process.cjs");

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
const WINDOW_TITLE = "보리 스튜디오";

/**
 * 실행 방식.
 * - 스튜디오(`npm run studio`): 보리 서버를 자식으로 띄우고(이미 있으면 그것을 쓰고) 서버가 내주는 /studio/를 연다.
 * - 개발(`npm run dev`, --dev): 서버는 dev:server가 따로 띄우므로 띄우지 않고 Vite 개발 서버를 연다.
 */
const devMode = process.argv.includes("--dev");
const repoRoot = path.resolve(__dirname, "../../..");
const port = resolveServerPort(process.env.BORI_SERVER_PORT);
const defaultUrl = devMode ? DEFAULT_ADMIN_URL : `http://127.0.0.1:${port}/studio/`;

/** 서버가 뜰 때까지 보여 줄 화면. */
const loadingPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>${WINDOW_TITLE}</title><body style="margin:0;padding:32px;color:#f3a9c8;background:#17131a;font-family:Arial,sans-serif">보리 서버를 띄우는 중입니다…</body></html>`)}`;

function createWindow() {
  // preload가 없어 렌더러에 열어 둔 IPC가 없으므로 sandbox를 켜도 잃는 기능이 없다.
  const window = new BrowserWindow({ title: WINDOW_TITLE, width: 1180, height: 860, show: true, backgroundColor: "#17131a", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const target = resolveAdminUrl(process.env.BORI_ADMIN_URL);
  if (target.rejected) log(`[bori-admin] BORI_ADMIN_URL은 이 컴퓨터 주소만 쓸 수 있어 기본 주소를 엽니다: ${target.rejected}`);
  const url = process.env.BORI_ADMIN_URL && !target.rejected ? target.url : defaultUrl;

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
  window.webContents.on("did-finish-load", () => { if (!failed && window.webContents.getURL().startsWith("http")) log(`[bori-admin] loaded ${url}`); });
  // Electron 35부터 위치 인자(level, message, …)는 deprecated라 이벤트 객체의 값을 쓴다.
  window.webContents.on("console-message", (event) => log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`));
  window.webContents.on("render-process-gone", (_event, details) => log(`[bori-admin] renderer gone: ${details.reason}`));

  // 스튜디오 화면 밖으로 이동하거나 새 창을 열지 않는다. 외부 웹 링크(치지직 로그인 포함)는 기본 브라우저로 넘긴다.
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
  return { window, load };
}

/**
 * 스튜디오가 쓰는 보리 서버. 띄우는 중이면 그 약속을 든다. 앱을 끌 때 이것이 끝나기를 기다렸다가 끈다.
 * 바깥 서버(터미널에서 띄운 것)면 stop이 아무것도 하지 않는다.
 */
let serverReady = null;
/** 스튜디오가 띄운 자식. 앱이 비정상으로 끝날 때 마지막으로 끈다. */
let ownedChild = null;

function startServer() {
  // .env는 서버가 스스로 읽는다(cwd와 상관없이 저장소 루트의 .env). 데이터 폴더는 스튜디오 로그와 같은 곳을 쓴다.
  const env = { ...process.env, ...(process.env.BORI_DATA_DIR ? { BORI_DATA_DIR: dataDir } : {}) };
  const serverLog = prepareServerLog(dataDir);
  return ensureServer({ port, cwd: repoRoot, env, logPath: serverLog }).then(server => {
    if (server.external) {
      log(`[bori-studio] 이미 떠 있는 서버를 씁니다: http://127.0.0.1:${port} (스튜디오를 꺼도 이 서버는 그대로 둡니다)`);
    } else {
      ownedChild = server.child;
      log(`[bori-studio] 서버를 띄웠습니다: http://127.0.0.1:${port} (로그 ${serverLog})`);
      server.child.once("exit", (code, signal) => { ownedChild = null; log(`[bori-studio] 서버가 종료되었습니다 (${code ?? signal})`); });
    }
    return server;
  });
}

app.whenReady().then(() => {
  const { window, load } = createWindow();
  if (devMode) { load(); }
  else {
    void window.loadURL(loadingPage).catch(() => {});
    serverReady = startServer().then(server => { load(); return server; }, error => {
      log(`[bori-studio] 서버를 시작하지 못했습니다: ${error.message}`);
      dialog.showErrorBox(WINDOW_TITLE, `보리 서버를 시작하지 못했습니다.\n${error.message}\n\n포트 ${port}를 다른 프로그램이 쓰고 있으면 끄거나 BORI_SERVER_PORT로 다른 포트를 지정하세요.`);
      app.quit();
      return null;
    });
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow().load(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// 앱을 끌 때 스튜디오가 띄운 서버만 끈다. 띄우는 중이었으면 끝나기를 기다렸다가 끈다.
let stopping = false;
app.on("will-quit", event => {
  if (stopping || !serverReady) return;
  event.preventDefault();
  stopping = true;
  serverReady
    .then(server => server?.stop())
    .catch(error => log(`[bori-studio] 서버를 끄지 못했습니다: ${error.message}`))
    .finally(() => app.quit());
});
// 위 정리를 거치지 못하고 끝나는 경우(예외 등)에도 자식이 남지 않게 한다.
process.on("exit", () => { ownedChild?.kill(); });
