const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const editorWindows = new Set();
let launcherWindow = null;

// Recovery copies of dirty documents. A clean exit deletes its own file,
// so anything still here on the next launch is work a crash took.
const recoveryDir = path.join(app.getPath("userData"), "recovery");
function recoveryPath(id) { return path.join(recoveryDir, `session-${id}.dimg`); }
function listRecoveries() {
  try {
    return fs.readdirSync(recoveryDir)
      .filter((name) => name.endsWith(".dimg"))   // never a .part
      .map((name) => path.join(recoveryDir, name));
  } catch {
    return [];
  }
}
// Renderers report whether they hold unsaved work, so closing a window
// can ask rather than discard an afternoon of it.
const unsaved = new Map();

const frameless = {
  frame: false,
  backgroundColor: "#0b0a0e",
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
  },
};

function createLauncher() {
  if (launcherWindow) {
    launcherWindow.focus();
    return launcherWindow;
  }
  launcherWindow = new BrowserWindow({ width: 980, height: 640, resizable: false, ...frameless });
  launcherWindow.loadFile(path.join(__dirname, "launcher.html"));
  launcherWindow.on("closed", () => { launcherWindow = null; });
  return launcherWindow;
}

function createEditor(project, opts = {}) {
  const win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1180, minHeight: 720, ...frameless,
  });
  win.loadFile(path.join(__dirname, "editor.html"), {
    query: { project: JSON.stringify(project) },
  });
  editorWindows.add(win);
  win.on("close", (event) => {
    if (!unsaved.get(win.id)) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Save", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      title: "Unsaved changes",
      message: "This project has changes that are not saved.",
      detail: "Saving keeps everything. Discarding loses the work since the last save.",
    });
    if (choice === 2) return;                       // cancel: stay open
    if (choice === 1) {                             // discard
      unsaved.set(win.id, false);
      win.close();
      return;
    }
    win.webContents.send("menu", "save-then-close"); // save, then close
  });
  win.on("closed", () => {
    unsaved.delete(win.id);
    editorWindows.delete(win);
    // closed on purpose, so its recovery copy is no longer wanted
    try { fs.unlinkSync(recoveryPath(win.id)); } catch { /* none written */ }
  });
  // Opening from the launcher consumes it; File > New keeps it around.
  if (launcherWindow && !opts.keepLauncher) {
    launcherWindow.close();
    launcherWindow = null;
  }
  return win;
}

function focused() {
  return BrowserWindow.getFocusedWindow();
}

function toEditor(channel, payload) {
  const win = focused();
  if (win && editorWindows.has(win)) win.webContents.send(channel, payload);
}

async function openProjectFile() {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "prod-imagen project", extensions: ["dimg"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return;
  const filePath = result.filePaths[0];
  try {
    const project = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    project._path = filePath;
    createEditor(project, { keepLauncher: true });
  } catch (error) {
    dialog.showErrorBox("Cannot open project", `${filePath}\n\n${error.message}`);
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Project...",
          accelerator: "CmdOrCtrl+N",
          click: () => createLauncher(),
        },
        {
          label: "Open Project...",
          accelerator: "CmdOrCtrl+O",
          click: () => openProjectFile(),
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => toEditor("menu", "save"),
        },
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => toEditor("menu", "save-as"),
        },
        {
          label: "Export Page as PNG...",
          accelerator: "CmdOrCtrl+E",
          click: () => toEditor("menu", "export"),
        },
        { type: "separator" },
        { role: isMac ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => toEditor("menu", "undo") },
        { label: "Redo", accelerator: "CmdOrCtrl+Y", click: () => toEditor("menu", "redo") },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => toEditor("menu", "zoom-in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => toEditor("menu", "zoom-out") },
        { label: "Fit Page", accelerator: "CmdOrCtrl+0", click: () => toEditor("menu", "zoom-fit") },
        { type: "separator" },
        { label: "Toggle Light / Dark", click: () => toEditor("menu", "theme") },
        { type: "separator" },
        { role: "reload" }, { role: "toggleDevTools" }, { role: "togglefullscreen" },
      ],
    },
    {
      label: "Page",
      submenu: [
        { label: "Next Page", accelerator: "CmdOrCtrl+Right", click: () => toEditor("menu", "page-next") },
        { label: "Previous Page", accelerator: "CmdOrCtrl+Left", click: () => toEditor("menu", "page-prev") },
        { label: "Add Page", click: () => toEditor("menu", "page-add") },
        { type: "separator" },
        { label: "Re-flow Panels", click: () => toEditor("menu", "relayout") },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Project Repository",
          click: () => shell.openExternal("https://github.com/prod-imagen-studio"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("open-project", (_e, project) => { createEditor(project); return true; });
ipcMain.handle("new-project-window", () => { createLauncher(); return true; });
ipcMain.handle("version", () => app.getVersion());
ipcMain.on("unsaved", (event, isDirty) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) unsaved.set(win.id, Boolean(isDirty));
});
ipcMain.handle("autosave", async (event, contents) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  try {
    // A chapter is tens of megabytes: writing it synchronously here
    // would freeze every window for the duration.
    await fs.promises.mkdir(recoveryDir, { recursive: true });
    const target = recoveryPath(win.id);
    await fs.promises.writeFile(target + ".part", contents, "utf-8");
    // rename last, so a crash mid-write cannot leave a truncated file
    // where a complete one used to be
    await fs.promises.rename(target + ".part", target);
    return true;
  } catch {
    return false;   // a failed recovery write must never break editing
  }
});
ipcMain.on("close-now", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  unsaved.set(win.id, false);
  win.close();
});
ipcMain.handle("open-project-file", async () => { await openProjectFile(); return true; });
ipcMain.on("win", (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === "min") win.minimize();
  else if (action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
});

ipcMain.handle("save-project-dialog", async (_e, suggestedName) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: "prod-imagen project", extensions: ["dimg"] }],
  });
  return result.canceled ? null : result.filePath;
});
ipcMain.handle("write-file", async (_e, filePath, contents) => {
  await fs.promises.writeFile(filePath, contents, "utf-8");
  return true;
});
ipcMain.handle("read-file-dialog", async () => {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "prod-imagen project", extensions: ["dimg"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return { path: result.filePaths[0], contents: fs.readFileSync(result.filePaths[0], "utf-8") };
});
ipcMain.handle("export-png-dialog", async (_e, suggestedName, dataUrl) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (result.canceled) return null;
  await fs.promises.writeFile(result.filePath,
    Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
  return result.filePath;
});

// A chapter is delivered as one document. The pages are already
// rasterised by the renderer; this lays them out one per sheet in an
// offscreen window and prints that to PDF at the page's real size.
ipcMain.handle("export-pdf", async (_e, { suggestedName, widthIn, heightIn, images }) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (result.canceled) return null;

  const body = images.map((src) =>
    `<div class="sheet"><img src="${src}"></div>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    @page { size: ${widthIn}in ${heightIn}in; margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .sheet {
      width: ${widthIn}in; height: ${heightIn}in;
      page-break-after: always; overflow: hidden;
    }
    .sheet:last-child { page-break-after: auto; }
    .sheet img { width: 100%; height: 100%; object-fit: contain; display: block; }
  </style>${body}`;

  const sheet = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await sheet.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdf = await sheet.webContents.printToPDF({
      printBackground: true,
      // inches, not microns: an older signature took microns and the
      // conversion survived, which produced sheets thousands of inches
      // across. Measured with studio/pdfcheck.js.
      pageSize: { width: widthIn, height: heightIn },
      margins: { marginType: "none" },
    });
    await fs.promises.writeFile(result.filePath, pdf);
    return result.filePath;
  } finally {
    sheet.destroy();
  }
});

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});
ipcMain.handle("write-png", async (_e, filePath, dataUrl) => {
  await fs.promises.writeFile(filePath,
    Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
  return true;
});

ipcMain.handle("save-keys", async (_e, data) => {
  const keysPath = path.join(__dirname, "..", "server", "keys.json");
  fs.writeFileSync(keysPath, JSON.stringify(data, null, 2), "utf-8");
  return true;
});
ipcMain.handle("load-keys", async () => {
  const keysPath = path.join(__dirname, "..", "server", "keys.json");
  try { return JSON.parse(fs.readFileSync(keysPath, "utf-8")); } catch { return {}; }
});

app.whenReady().then(() => {
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.checkForUpdatesAndNotify();
    } catch (_) { /* updater unavailable in dev */ }
  }
  buildMenu();
  offerRecovery();
  createLauncher();
});

// Anything left in the recovery folder was not closed cleanly.
function offerRecovery() {
  const files = listRecoveries();
  if (!files.length) return;
  const choice = dialog.showMessageBoxSync({
    type: "question",
    buttons: files.length === 1 ? ["Recover", "Discard"] : ["Recover all", "Discard"],
    defaultId: 0,
    cancelId: 1,
    title: "Unsaved work found",
    message: files.length === 1
      ? "A project was not closed properly."
      : `${files.length} projects were not closed properly.`,
    detail: "Recovering reopens the work as it was. Discarding deletes it.",
  });
  files.forEach((file) => {
    if (choice === 0) {
      try {
        const project = JSON.parse(fs.readFileSync(file, "utf-8"));
        delete project._path;   // recovered work is unsaved: force Save As
        createEditor(project, { keepLauncher: true });
      } catch { /* unreadable copy, nothing to recover */ }
    }
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  });
}

app.on("activate", () => {
  if (!BrowserWindow.getAllWindows().length) createLauncher();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
