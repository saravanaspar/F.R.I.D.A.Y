const { app, BrowserWindow, ipcMain, protocol, safeStorage } = require("electron");
const { createPrivateKey, generateKeyPairSync, randomUUID, sign } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { credentialFileName, isTrustedRendererUrl, rendererUrl, validatedDeviceName, validatedSigningPayload } = require("./security.cjs");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
protocol.registerSchemesAsPrivileged([{ scheme: "friday", privileges: { secure: true, standard: true } }]);

let mainWindow;
const indexPath = path.join(__dirname, "..", "index.html");

function sendDeepLink(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("deep-link", value);
}

function isTrustedIpcEvent(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && isTrustedRendererUrl(event.senderFrame?.url, indexPath));
}

function credentialPath(deviceId) {
  return path.join(app.getPath("userData"), credentialFileName(deviceId));
}

function saveDeviceCredential(deviceId, value) {
  fs.writeFileSync(credentialPath(deviceId), safeStorage.encryptString(JSON.stringify(value)).toString("base64"), { mode: 0o600 });
}

function loadDeviceCredential(deviceId) {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    const encrypted = fs.readFileSync(credentialPath(deviceId), "utf8");
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
    if (!parsed || typeof parsed !== "object" || typeof parsed.privateKey !== "string" || !parsed.privateKey) return undefined;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 1080, minHeight: 720, backgroundColor: "#0d0f0e", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.cjs") } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, indexPath)) event.preventDefault();
  });
  mainWindow.loadURL(rendererUrl(indexPath));
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

ipcMain.handle("device-identity:create", (event, name) => {
  if (!isTrustedIpcEvent(event) || !safeStorage.isEncryptionAvailable()) return undefined;
  let normalizedName;
  try { normalizedName = validatedDeviceName(name); } catch { return undefined; }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  saveDeviceCredential(deviceId, {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    name: normalizedName,
  });
  return {
    deviceId,
    name: normalizedName,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
});
ipcMain.handle("device-identity:has", (event, deviceId) => {
  if (!isTrustedIpcEvent(event)) return false;
  try { return loadDeviceCredential(deviceId) !== undefined; } catch { return false; }
});
ipcMain.handle("device-identity:sign", (event, deviceId, payload) => {
  if (!isTrustedIpcEvent(event)) return undefined;
  try {
    const credential = loadDeviceCredential(deviceId);
    if (!credential) return undefined;
    const signingPayload = validatedSigningPayload(payload);
    const key = createPrivateKey({ key: Buffer.from(credential.privateKey, "base64url"), type: "pkcs8", format: "der" });
    return sign(null, Buffer.from(signingPayload), key).toString("base64url");
  } catch { return undefined; }
});
ipcMain.handle("device-identity:clear", (event, deviceId) => {
  if (!isTrustedIpcEvent(event)) return false;
  let target;
  try { target = credentialPath(deviceId); } catch { return false; }
  try { fs.unlinkSync(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
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
