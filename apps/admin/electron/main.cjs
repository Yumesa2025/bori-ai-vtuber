const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { prepareRendererLog } = require("./log-file.cjs");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

// 렌더러 로그는 실행할 때마다 새로 쓰고 바로 전 실행 것만 남긴다(log-file.cjs).
const dataDir = process.env.BORI_DATA_DIR ? path.resolve(process.env.BORI_DATA_DIR) : path.resolve(__dirname, "../../../data");
const logPath = prepareRendererLog(dataDir);
function log(message) { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`); console.log(message); }

function createWindow() {
  const window = new BrowserWindow({ width: 1100, height: 760, show: true, backgroundColor: "#17131a", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const url = process.env.BORI_ADMIN_URL || "http://127.0.0.1:5174";
  const load = () => window.loadURL(url).catch((error) => { console.error("[bori-admin] failed to load:", error); setTimeout(load, 1000); });
  window.webContents.on("did-finish-load", () => log(`[bori-admin] loaded ${url}`));
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => log(`[renderer:${level}] ${message} (${sourceId}:${line})`));
  window.webContents.on("render-process-gone", (_event, details) => log(`[bori-admin] renderer gone: ${details.reason}`));
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => { log(`[bori-admin] load failed ${errorCode}: ${errorDescription}`); setTimeout(load, 1000); });
  load();
}

app.whenReady().then(() => { createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
