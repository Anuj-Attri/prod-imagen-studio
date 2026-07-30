const { contextBridge, ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

/* The deployed backend this build points at.

   Read here rather than in the renderer. The renderer has no node access,
   so a require of the json there silently failed in a packaged copy: the
   baked url never loaded, the address fell back to this machine, and a
   fresh install reported the server offline while a perfectly good one was
   running. Preload can read files, and this is exactly what it is for.

   Read synchronously because the renderer decides its server address as it
   starts, before anything asynchronous could have answered. */
function deployment() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "deployment.json"), "utf-8"));
  } catch (_) {
    return {};
  }
}

contextBridge.exposeInMainWorld("studio", {
  deployment: deployment(),
  openProject: (project) => ipcRenderer.invoke("open-project", project),
  saveProjectDialog: (name) => ipcRenderer.invoke("save-project-dialog", name),
  writeFile: (filePath, contents) => ipcRenderer.invoke("write-file", filePath, contents),
  readFileDialog: () => ipcRenderer.invoke("read-file-dialog"),
  exportPngDialog: (name, dataUrl) => ipcRenderer.invoke("export-png-dialog", name, dataUrl),
  win: (action) => ipcRenderer.send("win", action),
  saveKeys: (data) => ipcRenderer.invoke("save-keys", data),
  loadKeys: () => ipcRenderer.invoke("load-keys"),
  onMenu: (handler) => ipcRenderer.on("menu", (_e, action) => handler(action)),
  setUnsaved: (dirty) => ipcRenderer.send("unsaved", dirty),
  closeNow: () => ipcRenderer.send("close-now"),
  autosave: (contents) => ipcRenderer.invoke("autosave", contents),
  version: () => ipcRenderer.invoke("version"),
  exportPdf: (payload) => ipcRenderer.invoke("export-pdf", payload),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  writePng: (filePath, dataUrl) => ipcRenderer.invoke("write-png", filePath, dataUrl),
  newProjectWindow: () => ipcRenderer.invoke("new-project-window"),
  openProjectFile: () => ipcRenderer.invoke("open-project-file"),
  onUpdateStatus: (handler) =>
    ipcRenderer.on("update-status", (_e, detail) => handler(detail)),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
});
