const { app, BrowserWindow, ipcMain, protocol, safeStorage } = require("electron");
const path = require("node:path");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
protocol.registerSchemesAsPrivileged([{ scheme: "friday", privileges: { secure: true, standard: true } }]);

let mainWindow;

function sendDeepLink(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("deep-link", value);
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 1080, minHeight: 720, backgroundColor: "#0d0f0e", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.cjs") } });
  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

ipcMain.handle("credential:get", (_event, key) => {
  if (!safeStorage.isEncryptionAvailable() || typeof key !== "string" || !key) return undefined;
  try {
    const value = require("node:fs").readFileSync(path.join(app.getPath("userData"), `credential-${encodeURIComponent(key)}`), "utf8");
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch (error) { if (error?.code !== "ENOENT") throw error; return undefined; }
});
ipcMain.handle("credential:set", (_event, key, value) => {
  if (!safeStorage.isEncryptionAvailable() || typeof key !== "string" || !key || typeof value !== "string") return false;
  require("node:fs").writeFileSync(path.join(app.getPath("userData"), `credential-${encodeURIComponent(key)}`), safeStorage.encryptString(value).toString("base64"), { mode: 0o600 });
  return true;
});
ipcMain.handle("credential:clear", (_event, key) => {
  if (typeof key !== "string" || !key) return false;
  try { require("node:fs").unlinkSync(path.join(app.getPath("userData"), `credential-${encodeURIComponent(key)}`)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return true;
});

app.on("second-instance", (_event, commandLine) => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  const link = commandLine.find((value) => value.startsWith("friday://"));
  if (link) sendDeepLink(link);
});

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  const link = process.argv.find((value) => value.startsWith("friday://"));
  if (link) sendDeepLink(link);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
