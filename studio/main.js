const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

let launcherWindow = null;
let editorWindow = null;

function createLauncher() {
  launcherWindow = new BrowserWindow({
    width: 980,
    height: 640,
    resizable: false,
    backgroundColor: "#141417",
    title: "prod-imagen studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.loadFile(path.join(__dirname, "launcher.html"));
}

function createEditor(project) {
  editorWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#141417",
    title: `${project.name} — prod-imagen studio`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  editorWindow.setMenuBarVisibility(false);
  editorWindow.loadFile(path.join(__dirname, "editor.html"), {
    query: { project: encodeURIComponent(JSON.stringify(project)) },
  });
  if (launcherWindow) {
    launcherWindow.close();
    launcherWindow = null;
  }
}

ipcMain.handle("open-project", (_event, project) => {
  createEditor(project);
  return true;
});

ipcMain.handle("save-project-dialog", async (_event, suggestedName) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: "prod-imagen project", extensions: ["dimg"] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle("write-file", async (_event, filePath, contents) => {
  fs.writeFileSync(filePath, contents, "utf-8");
  return true;
});

ipcMain.handle("read-file-dialog", async () => {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "prod-imagen project", extensions: ["dimg"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return {
    path: result.filePaths[0],
    contents: fs.readFileSync(result.filePaths[0], "utf-8"),
  };
});

ipcMain.handle("export-png-dialog", async (_event, suggestedName, dataUrl) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (result.canceled) return null;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(result.filePath, Buffer.from(base64, "base64"));
  return result.filePath;
});

app.whenReady().then(createLauncher);
app.on("window-all-closed", () => app.quit());
