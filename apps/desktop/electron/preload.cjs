const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fridayDesktop", Object.freeze({
  getCredential: (key) => ipcRenderer.invoke("credential:get", key),
  setCredential: (key, value) => ipcRenderer.invoke("credential:set", key, value),
  clearCredential: (key) => ipcRenderer.invoke("credential:clear", key),
  onDeepLink: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
}));
