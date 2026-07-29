const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  openProject: (project) => ipcRenderer.invoke("open-project", project),
  saveProjectDialog: (name) => ipcRenderer.invoke("save-project-dialog", name),
  writeFile: (filePath, contents) => ipcRenderer.invoke("write-file", filePath, contents),
  readFileDialog: () => ipcRenderer.invoke("read-file-dialog"),
  exportPngDialog: (name, dataUrl) => ipcRenderer.invoke("export-png-dialog", name, dataUrl),
  win: (action) => ipcRenderer.send("win", action),
  saveKeys: (data) => ipcRenderer.invoke("save-keys", data),
  loadKeys: () => ipcRenderer.invoke("load-keys"),
  onMenu: (handler) => ipcRenderer.on("menu", (_e, action) => handler(action)),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  writePng: (filePath, dataUrl) => ipcRenderer.invoke("write-png", filePath, dataUrl),
  newProjectWindow: () => ipcRenderer.invoke("new-project-window"),
  openProjectFile: () => ipcRenderer.invoke("open-project-file"),
});
