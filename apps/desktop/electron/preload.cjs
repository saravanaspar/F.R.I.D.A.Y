const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fridayDesktop", Object.freeze({
  createDeviceIdentity: (name) => ipcRenderer.invoke("device-identity:create", name),
  hasDeviceCredential: (deviceId) => ipcRenderer.invoke("device-identity:has", deviceId),
  signDevicePayload: (deviceId, payload) => ipcRenderer.invoke("device-identity:sign", deviceId, payload),
  clearDeviceCredential: (deviceId) => ipcRenderer.invoke("device-identity:clear", deviceId),
  onDeepLink: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
}));
