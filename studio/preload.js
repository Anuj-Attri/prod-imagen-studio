const { contextBridge, ipcRenderer } = require("electron");

/* The deployed backend this build points at.

   Handed in on the command line by the main process rather than read from
   disk here. A preload runs sandboxed, where the only module available is
   electron: requiring fs threw "module not found", which does not fail
   quietly at all but takes the entire bridge with it. Every function below
   vanished, window.studio was undefined, and the first button pressed in
   the launcher threw. Reading a file was the wrong instinct twice over,
   first in the renderer and then here.

   process.argv is available in a sandbox, so main passes the json through
   it, which is also synchronous: the renderer picks its server address as
   it starts and could not wait for a message. */
function deployment() {
  const flag = "--firestarter-deployment=";
  const found = (process.argv || []).find((arg) => arg.startsWith(flag));
  if (!found) return {};
  try {
    return JSON.parse(found.slice(flag.length));
  } catch (_) {
    return {};
  }
}

contextBridge.exposeInMainWorld("studio", {
  deployment: deployment(),
  // The renderer has to lay itself out differently on a Mac, and cannot
  // ask the operating system directly. process.platform reaches a sandbox.
  platform: process.platform,
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
