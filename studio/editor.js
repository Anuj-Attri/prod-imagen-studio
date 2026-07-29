/* prod-imagen studio — editor core (v0.3)
   Model: document -> pages -> layers. The layers list is the source of
   truth; the Konva canvas renders it. All lettering is vector text.
   v0.3: brush + eraser, shapes, image import + crop, multi-select,
   marquee, snap guides, align/distribute, undo/redo, clipboard,
   opacity + blend modes, image adjustments. */

// Where the generation server lives. Local by default; a deployed one
// can be named in Settings, with a bearer token when it is protected.
let SERVER = localStorage.getItem("studio-server") || "http://127.0.0.1:8787";
let SERVER_TOKEN = localStorage.getItem("studio-token") || "";

function api(path, options) {
  const settings = options || {};
  const headers = { ...(settings.headers || {}) };
  if (SERVER_TOKEN) headers.Authorization = "Bearer " + SERVER_TOKEN;
  return fetch(SERVER.replace(/\/+$/, "") + path, { ...settings, headers });
}

// Outside Electron (a browser, a test harness) the preload bridge does
// not exist. Without this shim the first call to it throws during start
// up and every later line of init silently never runs.
if (!window.studio) {
  const unavailable = () => {
    toast("This action needs the desktop app", true);
    return null;
  };
  window.studio = {
    openProject: unavailable, saveProjectDialog: unavailable, writeFile: unavailable,
    readFileDialog: unavailable, exportPngDialog: unavailable, chooseFolder: unavailable,
    writePng: unavailable, exportPdf: unavailable, autosave: unavailable,
    setUnsaved: () => {}, closeNow: () => {},
    newProjectWindow: unavailable, openProjectFile: unavailable,
    saveKeys: unavailable, loadKeys: async () => ({}), win: () => {}, onMenu: null,
  };
}

// Surface any failure instead of dying silently.
window.onerror = (message, _src, line) => {
  try { toast(`error: ${message} (line ${line})`, true); } catch (_) { /* noop */ }
};

// ---------------------------------------------------------------- state --
function parseProject() {
  const raw = new URLSearchParams(location.search).get("project");
  if (!raw) return {};
  for (const candidate of [raw, (() => { try { return decodeURIComponent(raw); } catch { return null; } })()]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  return {};
}
const project = parseProject();

// Every document type is the same layered page underneath. What differs
// is the paper size, the default look, and what "build me a page" means.
const PAGE_SIZES = {
  // Pixels are the working size on screen; inches are what the paper
  // actually measures when it is printed. Treating one as the other put
  // every document out by between a fifth and nearly double.
  manga: { w: 900, h: 1273, inW: 6.93, inH: 9.84, paper: "B5" },
  anime: { w: 1024, h: 1024, inW: 8, inH: 8, paper: "square" },
  coloring: { w: 1000, h: 1294, inW: 8.5, inH: 11, paper: "US Letter" },
  poster: { w: 900, h: 1200, inW: 11.69, inH: 16.54, paper: "A3" },
  card: { w: 1050, h: 750, inW: 5.83, inH: 4.13, paper: "A6 landscape" },
  blueprint: { w: 1400, h: 990, inW: 16.54, inH: 11.69, paper: "A3 landscape" },
  diagram: { w: 1100, h: 800, inW: 11.69, inH: 8.27, paper: "A4 landscape" },
  free: { w: 1000, h: 1000, inW: 10.42, inH: 10.42, paper: "free" },
};

const PAGE = PAGE_SIZES[project.kind] || PAGE_SIZES.free;

const KIND_RECIPES = {
  manga: { layout: "panels", style: "manga" },
  anime: { layout: "single", style: "anime" },
  coloring: { layout: "single", style: "coloring" },
  poster: { layout: "poster", style: "poster" },
  card: { layout: "card", style: "card" },
  blueprint: { layout: "blueprint", style: "blueprint" },
  diagram: { layout: "blueprint", style: "blueprint" },
  free: { layout: "panels", style: "anime" },
};

let doc = project.document || {
  version: 1,
  name: project.name || "Untitled",
  mode: project.mode || "image",
  kind: project.kind || "free",
  pages: [{ id: uid(), name: "Page 1", layers: [] }],
  story: { chapter: "", overall: "", flags: [] },
};
doc.chat = doc.chat || [];
// Style contract: every panel on the page is rendered with the same
// look and the same appearance tags per character, which is what keeps
// a sequence from reading as if a different artist drew each panel.
const STYLE_PRESETS = {
  manga: {
    label: "Manga (black and white)",
    tags: "monochrome, greyscale, manga, screentone, halftone shading, sharp ink linework, high contrast",
  },
  anime: {
    label: "Anime (cel colour)",
    tags: "anime style, cel shading, clean lineart, vibrant colors, flat colors",
  },
  manhwa: {
    label: "Manhwa (webtoon colour)",
    tags: "korean webtoon style, soft cel shading, glossy rendering, digital painting, vivid colors",
  },
  noir: {
    label: "Noir ink",
    tags: "monochrome, film noir lighting, heavy blacks, dramatic shadows, thick ink linework",
  },
  sketch: {
    label: "Pencil sketch",
    tags: "pencil sketch, rough lineart, monochrome, cross hatching, sketchbook",
  },
  watercolor: {
    label: "Watercolour",
    tags: "watercolor painting, soft washes, muted palette, painterly, textured paper",
  },
  retro: {
    label: "Retro anime (80s)",
    tags: "1980s anime style, retro cel animation, film grain, muted retro colors",
  },
  coloring: {
    label: "Coloring book line art",
    tags: "lineart, monochrome, coloring book page, thick clean outlines, "
      + "white background, flat, uncoloured, simple shapes",
    // a colour checkpoint will render a full painting unless colour and
    // shading are pushed out explicitly
    negative: "color, colored, colorful, shading, shadow, gradient, greyscale, "
      + "screentone, painting, photorealistic, texture, detailed background",
  },
  poster: {
    label: "Poster art",
    // "strong silhouette" and "negative space" pull the model towards
    // abstraction and lose the subject; keep the subject foremost
    tags: "poster illustration, clear focal subject, bold composition, "
      + "dramatic lighting, limited palette, uncluttered background",
    negative: "abstract, cluttered, busy background, text, letters",
  },
  card: {
    label: "Greeting card",
    tags: "greeting card illustration, charming, warm, decorative border, "
      + "centred composition, cheerful palette",
  },
  blueprint: {
    label: "Technical blueprint",
    tags: "technical blueprint, schematic diagram, cyanotype blue background, "
      + "white line drawing, orthographic projection, measured, precise",
    negative: "1girl, 1boy, person, face, anime, character, painterly, "
      + "colorful, photorealistic",
  },
};
function recipe() { return KIND_RECIPES[doc.kind] || KIND_RECIPES.free; }
doc.style = doc.style || {
  preset: (KIND_RECIPES[doc.kind] || KIND_RECIPES.free).style,
  extra: "",
  lockSeed: true,
  // "page": one render for the whole page, which cannot disagree with
  // itself. "panels": a render per panel, exact beats but weaker
  // continuity between them.
  pageMode: "page",
  pageBg: "#ffffff",
};
if (!doc.style.pageMode) doc.style.pageMode = "page";
if (!doc.style.pageBg) doc.style.pageBg = "#ffffff";
doc.cast = doc.cast || [];
normalizeDocument(doc);
let savePath = project._path || null;
let pageIndex = 0;
let selectedIds = [];
let tool = "select";
let layerSeq = doc.pages.flatMap((p) => p.layers).length;
let clipboard = [];
let cropTarget = null; // layer id while crop mode is active

// Shared drawing state (brush + new shapes pick these up).
const paint = {
  brushColor: "#111111", brushSize: 6, brushOpacity: 100,
  fill: "#e8e8ee", stroke: "#111111", strokeWidth: 2,
};

function uid() { return Math.random().toString(36).slice(2, 10); }
// A project file is plain JSON. People hand edit it, a truncated write
// leaves something parseable but incomplete, and an older build wrote
// fields a newer one expects. Fill the gaps rather than throwing on the
// first missing one.
function normalizeDocument(document_) {
  if (!Array.isArray(document_.pages) || !document_.pages.length) {
    document_.pages = [{ id: uid(), name: "Page 1", layers: [] }];
  }
  document_.pages.forEach((page, index) => {
    if (!page.id) page.id = uid();
    if (!page.name) page.name = `Page ${index + 1}`;
    if (!Array.isArray(page.layers)) page.layers = [];
    page.layers = page.layers.filter((layer) => layer && typeof layer === "object");
    page.layers.forEach((layer) => {
      if (!layer.id) layer.id = uid();
      if (typeof layer.type !== "string") layer.type = "rect";
      if (typeof layer.name !== "string") layer.name = layer.type;
      if (!layer.props || typeof layer.props !== "object") layer.props = {};
      ["x", "y", "w", "h"].forEach((key) => {
        if (typeof layer[key] !== "number" || !Number.isFinite(layer[key])) {
          layer[key] = key === "w" || key === "h" ? 100 : 0;
        }
      });
      if (typeof layer.visible !== "boolean") layer.visible = true;
      if (typeof layer.locked !== "boolean") layer.locked = false;
    });
  });
  return document_;
}

function currentPage() {
  // Never hand back undefined: a restored history entry, a reordered
  // document or a hand-edited file can leave the index past the end,
  // and every caller reaches straight for .layers.
  if (!doc.pages.length) doc.pages.push({ id: uid(), name: "Page 1", layers: [] });
  pageIndex = Math.min(Math.max(pageIndex, 0), doc.pages.length - 1);
  return doc.pages[pageIndex];
}
function findLayer(id) { return currentPage().layers.find((l) => l.id === id); }
function primaryLayer() { return selectedIds.length === 1 ? findLayer(selectedIds[0]) : null; }
function selectedLayers() { return selectedIds.map(findLayer).filter(Boolean); }

// -------------------------------------------------------------- history --
// One stack serves both undo/redo and the visible version list. Entries
// with a label are checkpoints (milestones the user can jump back to);
// unlabelled ones are ordinary edit steps.
let history = [];
let historyIndex = -1;
// Undo snapshots must not carry image data. A rendered page is several
// megabytes of base64, the history keeps many entries, and a chapter
// would put gigabytes of duplicated pixels in memory. Images are
// immutable once generated, so the history stores a reference and the
// pixels live once in a side table.
const imageStore = new Map();   // reference -> data url
const imageRefs = new Map();    // data url -> reference
let imageSeq = 0;

function imageRef(dataUrl) {
  let ref = imageRefs.get(dataUrl);
  if (!ref) {
    ref = "imgref:" + (imageSeq += 1);
    imageRefs.set(dataUrl, ref);
    imageStore.set(ref, dataUrl);
  }
  return ref;
}

function snapshotDoc() {
  return JSON.stringify(doc, (key, value) => {
    if (key === "chat") return undefined;
    if (key === "image" && typeof value === "string" && value.startsWith("data:")) {
      return imageRef(value);
    }
    return value;
  });
}

// Put the pixels back after a snapshot is parsed.
function rehydrateImages(value) {
  if (Array.isArray(value)) { value.forEach(rehydrateImages); return; }
  if (!value || typeof value !== "object") return;
  Object.keys(value).forEach((key) => {
    const child = value[key];
    if (key === "image" && typeof child === "string" && child.startsWith("imgref:")) {
      value[key] = imageStore.get(child) || null;
    } else {
      rehydrateImages(child);
    }
  });
}
function commit(label) {
  const snap = snapshotDoc();
  if (history[historyIndex] && history[historyIndex].json === snap) {
    if (label) { history[historyIndex].label = label; renderHistory(); }
    return;
  }
  history = history.slice(0, historyIndex + 1);
  history.push({ json: snap, label: label || null, at: new Date() });
  if (history.length > 120) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
  renderHistory();
  markDirtyState();
}
function checkpoint(label) { commit(label); }

// The main process asks before closing only if it knows work is at risk.
let savedSnapshot = null;
let autosaveTimer = null;

// A crash takes everything the close guard would have caught. While there
// is unsaved work, keep a recovery copy on disk; a clean exit removes it.
function scheduleAutosave() {
  if (!window.studio || !window.studio.autosave) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (savedSnapshot === snapshotDoc()) return;   // nothing at risk
    const payload = { ...project, name: doc.name, document: doc };
    delete payload._path;
    window.studio.autosave(JSON.stringify(payload));
  }, 20000);
}
function markDirtyState() {
  const dirty = savedSnapshot !== snapshotDoc();
  document.getElementById("save").textContent = dirty ? "Save *" : "Save";
  if (window.studio && window.studio.setUnsaved) window.studio.setUnsaved(dirty);
  if (dirty) scheduleAutosave();
}
function restore(entry) {
  const chat = doc.chat;
  doc = JSON.parse(entry.json);
  rehydrateImages(doc);
  normalizeDocument(doc);
  doc.chat = chat;
  if (pageIndex >= doc.pages.length) pageIndex = doc.pages.length - 1;
  selectedIds = selectedIds.filter((id) => currentPage().layers.some((l) => l.id === id));
  renderCanvas();
  renderStory();
  updateHistoryButtons();
  renderHistory();
}
function undo() { if (historyIndex > 0) { historyIndex -= 1; restore(history[historyIndex]); } }
function redo() { if (historyIndex < history.length - 1) { historyIndex += 1; restore(history[historyIndex]); } }
function updateHistoryButtons() {
  document.getElementById("undo").disabled = historyIndex <= 0;
  document.getElementById("redo").disabled = historyIndex >= history.length - 1;
}
// ----------------------------------------------------------------- style --
function setPageBackground(hex) {
  doc.style.pageBg = hex;
  pageRect.fill(hex);
  // a dark page needs a light edge to stay visible against the desk
  pageRect.stroke(luminance(hex) < 0.45 ? "#3a3a44" : "#c9c9d2");
  pageLayer.batchDraw();
}

function luminance(hex) {
  const value = String(hex).replace("#", "");
  if (value.length !== 6) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function invertHex(hex) {
  const value = String(hex).replace("#", "");
  if (value.length !== 6) return "#000000";
  return "#" + [0, 2, 4]
    .map((i) => (255 - parseInt(value.slice(i, i + 2), 16)).toString(16).padStart(2, "0"))
    .join("");
}

// Flip the page and every piece of lettering at once, for inverted
// looks where white ink sits on black paper.
function invertPage() {
  setPageBackground(invertHex(doc.style.pageBg));
  doc.pages.forEach((page) => {
    page.layers.forEach((layer) => {
      if (!TEXT_TYPES.includes(layer.type)) return;
      ["fill", "stroke", "color", "bg", "ink"].forEach((key) => {
        if (typeof layer.props[key] === "string" && layer.props[key].startsWith("#")) {
          layer.props[key] = invertHex(layer.props[key]);
        }
      });
      if (layer.type === "balloon" && !layer.props.bg) layer.props.bg = "#000000";
      if (layer.type === "balloon" && !layer.props.color) layer.props.color = "#ffffff";
    });
  });
  renderCanvas();
  renderStylePanel();
  commit("Invert page and ink");
  toast("Page and lettering inverted");
}

function mergeCast(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return;
  incoming.forEach((entry) => {
    if (!entry || !entry.name || !entry.tags) return;
    const existing = doc.cast.find(
      (c) => c.name.toLowerCase() === String(entry.name).toLowerCase());
    // an established character keeps its tags: that is the whole point
    if (existing) return;
    doc.cast.push({ id: uid(), name: String(entry.name), tags: String(entry.tags) });
  });
  renderStylePanel();
}

function renderStylePanel() {
  const box = document.getElementById("style-body");
  if (!box) return;
  const options = Object.entries(STYLE_PRESETS).map(([id, preset]) =>
    `<option value="${id}" ${doc.style.preset === id ? "selected" : ""}>${preset.label}</option>`).join("");
  const preset = STYLE_PRESETS[doc.style.preset];
  box.innerHTML = `
    <div class="prop-grid">
      <label>Art style</label><select id="style-preset">${options}</select>
      <label>Extra tags</label><input id="style-extra" value="${escapeHtml(doc.style.extra || "")}" placeholder="optional, comma separated">
      <label>Render</label><select id="style-mode">
        <option value="page" ${doc.style.pageMode !== "panels" ? "selected" : ""}>Whole page at once</option>
        <option value="panels" ${doc.style.pageMode === "panels" ? "selected" : ""}>Panel by panel</option>
      </select>
      <label>Page colour</label><input id="style-bg" type="color" value="${doc.style.pageBg}">
      <label></label><button id="style-invert" style="width:100%">Invert page and ink</button>
      <label>Lock seeds</label><input id="style-lock" type="checkbox" ${doc.style.lockSeed ? "checked" : ""}>
      <div class="prop-note">${doc.style.pageMode === "panels"
        ? "Each panel is its own render: exact control per beat, but panels can drift apart in look."
        : "One render for the entire page. The art cannot disagree with itself, and it is far faster. Redraw single panels afterwards from the Layers tab."}</div>
      <div class="prop-note">${escapeHtml(preset ? preset.tags : "")}</div>
      <div class="prop-note">Applied to every panel on every page, so the
        sequence reads as one artist. Locked seeds make a re-render of an
        unchanged panel come back identical.</div>
    </div>
    <div class="dock-section-title">Cast</div>
    <div id="cast-list"></div>
    <button id="cast-add" style="width:100%;margin-top:8px">Add character</button>
    <div class="prop-note" style="margin-top:8px">Appearance tags only:
      hair, eyes, build, signature clothing, marks. No poses or settings.
      These are prepended to every panel the character appears in.</div>`;
  const list = document.getElementById("cast-list");
  if (!doc.cast.length) {
    list.innerHTML = '<div class="dock-empty" style="margin-top:8px">No characters yet.<br />The agent adds them as it writes,<br />or add one yourself.</div>';
  }
  doc.cast.forEach((member) => {
    const row = document.createElement("div");
    row.className = "cast-row";
    row.innerHTML =
      `<input class="cast-name" value="${escapeHtml(member.name)}" placeholder="Name">` +
      `<button class="cast-del quiet" title="Remove">x</button>` +
      `<textarea class="cast-tags" placeholder="1girl, long black hair, red kimono">${escapeHtml(member.tags)}</textarea>`;
    row.querySelector(".cast-name").addEventListener("change", (e) => {
      member.name = e.target.value.trim();
      commit();
    });
    row.querySelector(".cast-tags").addEventListener("change", (e) => {
      member.tags = e.target.value.trim();
      commit();
    });
    row.querySelector(".cast-del").addEventListener("click", () => {
      doc.cast = doc.cast.filter((c) => c.id !== member.id);
      renderStylePanel();
      commit();
    });
    list.appendChild(row);
  });
  document.getElementById("style-preset").addEventListener("change", (e) => {
    doc.style.preset = e.target.value;
    renderStylePanel();
    renderProps();
    commit(`Style: ${STYLE_PRESETS[e.target.value].label}`);
  });
  document.getElementById("style-extra").addEventListener("change", (e) => {
    doc.style.extra = e.target.value.trim();
    renderProps();
    commit();
  });
  document.getElementById("style-lock").addEventListener("change", (e) => {
    doc.style.lockSeed = e.target.checked;
    commit();
  });
  document.getElementById("style-mode").addEventListener("change", (e) => {
    doc.style.pageMode = e.target.value;
    renderStylePanel();
    commit();
  });
  document.getElementById("style-bg").addEventListener("input", (e) => {
    setPageBackground(e.target.value);
  });
  document.getElementById("style-bg").addEventListener("change", () =>
    commit("Page colour"));
  document.getElementById("style-invert").addEventListener("click", invertPage);
  document.getElementById("cast-add").addEventListener("click", () => {
    doc.cast.push({ id: uid(), name: "New character", tags: "" });
    renderStylePanel();
    commit();
  });
}

function renderHistory() {
  const list = document.getElementById("history-list");
  if (!list) return;
  list.innerHTML = "";
  history.forEach((entry, index) => {
    if (!entry.label && index !== historyIndex && index !== 0) return; // milestones only
    const row = document.createElement("div");
    row.className = "hist-row" + (index === historyIndex ? " now" : "")
      + (index > historyIndex ? " ahead" : "");
    const time = entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const label = entry.label || (index === 0 ? "Opened" : "Current edit");
    row.innerHTML = `<span class="dot"></span><span class="what">${escapeHtml(label)}</span>` +
      `<span class="when">${time}</span>`;
    row.addEventListener("click", () => { historyIndex = index; restore(history[index]); });
    list.prepend(row);
  });
  const empty = document.getElementById("history-empty");
  if (empty) empty.style.display = list.children.length > 1 ? "none" : "block";
}
document.getElementById("undo").onclick = undo;
document.getElementById("redo").onclick = redo;

// ----------------------------------------------------------------- icons --
const ICONS = {
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3l7 16 2.2-6.4L21 10.4 6 3z"/></svg>',
  draw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5l4 4L9 19H5v-4l9.5-9.5z"/><path d="M12.5 7.5l4 4"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 17l-3.2-3.2a1.5 1.5 0 0 1 0-2.1l7-7a1.5 1.5 0 0 1 2.1 0l5.4 5.4a1.5 1.5 0 0 1 0 2.1L13 17H7z"/><path d="M5 20.5h14" stroke-linecap="round"/></svg>',
  picker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3.8a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8l-2 2-5.2-5.2 2-2z"/><path d="M12.8 6.9L5 14.7V19h4.3l7.8-7.8"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M12 8.5v3m0 0v3m0-3h3m-3 0H9" stroke-linecap="round"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M6.5 15.5l3.5-4 3 3.4 2-2.2 3 2.8"/><circle cx="9.2" cy="9.2" r="1.2"/></svg>',
  balloon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5.5h16v10.5h-8.5L8 20v-4H4V5.5z"/></svg>',
  caption: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M7 10.5h10M7 13.5h6" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 6h14M12 6v13"/></svg>',
  sfx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18 5.2l-1.4 4.4L21 12l-4.4 2.4L18 18.8l-4.2-2.4L12 21l-1.8-4.6L6 18.8l1.4-4.4L3 12l4.4-2.4L6 5.2l4.2 2.4L12 3z"/></svg>',
  rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="17" height="12" rx="1.5"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="12" rx="8.5" ry="6"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4.5 19.5L19.5 4.5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19.5L18 6M18 6h-6M18 6v6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.2 5.8-5.2-3-5.2 3 1.2-5.8-4.4-4 5.9-.6L12 3.5z"/></svg>',
};
// Rail shows the common tools; the five shapes collapse into one
// flyout entry (Adobe-style tool group). Shortcuts still reach every
// shape directly.
const TOOL_DEFS = [
  ["select", "Select / move", "V"],
  ["draw", "Brush", "D"],
  ["eraser", "Eraser (strokes)", "E"],
  ["picker", "Pick color", "I"],
  ["panel", "AI panel frame", "P"],
  ["image", "Place image", "M"],
  ["balloon", "Speech balloon", "B"],
  ["caption", "Caption box", "C"],
  ["text", "Title text", "T"],
  ["sfx", "Onomatopoeia / SFX", "S"],
];
const SHAPE_DEFS = [
  ["rect", "Rectangle", "R"],
  ["ellipse", "Ellipse", "O"],
  ["line", "Line", "L"],
  ["arrow", "Arrow", "A"],
  ["star", "Star", "W"],
];
const SHAPE_IDS = SHAPE_DEFS.map(([id]) => id);
const SHAPE_TOOLS = ["rect", "ellipse", "star"];
const STROKE_TOOLS = ["line", "arrow"];
let lastShape = "rect";
const toolRail = document.getElementById("tools");
TOOL_DEFS.forEach(([id, label, key]) => {
  const el = document.createElement("div");
  el.className = "tool" + (id === "select" ? " active" : "");
  el.dataset.tool = id;
  el.innerHTML = ICONS[id] + `<span class="tip">${label} · ${key}</span>`;
  el.addEventListener("click", () => setTool(id));
  toolRail.appendChild(el);
});
const shapesBtn = document.createElement("div");
shapesBtn.className = "tool";
shapesBtn.id = "shapes-tool";
shapesBtn.innerHTML = ICONS[lastShape] + '<span class="flyout-mark"></span>' +
  '<span class="tip">Shapes · R O L A W</span>';
toolRail.appendChild(shapesBtn);
const shapeMenu = document.createElement("div");
shapeMenu.id = "shape-menu";
shapeMenu.innerHTML = SHAPE_DEFS.map(([id, label, key]) =>
  `<div class="shape-item" data-shape="${id}">${ICONS[id]}<span>${label}</span><span class="key">${key}</span></div>`).join("");
document.body.appendChild(shapeMenu);
shapesBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (shapeMenu.classList.contains("show")) { shapeMenu.classList.remove("show"); return; }
  const rect = shapesBtn.getBoundingClientRect();
  shapeMenu.style.left = rect.right + 8 + "px";
  shapeMenu.style.top = rect.top + "px";
  shapeMenu.classList.add("show");
});
shapeMenu.querySelectorAll(".shape-item").forEach((item) => {
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    shapeMenu.classList.remove("show");
    setTool(item.dataset.shape);
  });
});
document.addEventListener("click", () => shapeMenu.classList.remove("show"));

// ---------------------------------------------------------------- konva --
const wrap = document.getElementById("canvas-wrap");
const stage = new Konva.Stage({
  container: "canvas-wrap",
  width: wrap.clientWidth,
  height: wrap.clientHeight,
});
const world = new Konva.Group();            // pan/zoom container
const pageLayer = new Konva.Layer();
const nodeGroup = new Konva.Group();
const uiLayer = new Konva.Layer();
pageLayer.add(world);
world.add(nodeGroup);
stage.add(pageLayer, uiLayer);

const pageRect = new Konva.Rect({
  x: 0, y: 0, width: PAGE.w, height: PAGE.h,
  fill: doc.style.pageBg || "#ffffff", stroke: "#c9c9d2", strokeWidth: 1,
  shadowColor: "#000", shadowBlur: 30, shadowOpacity: 0.45, listening: false,
});
world.add(pageRect);
pageRect.moveToBottom();

const transformer = new Konva.Transformer({
  rotateEnabled: false, anchorSize: 8, borderStroke: "#5b8def",
  anchorStroke: "#5b8def", anchorFill: "#141417", ignoreStroke: true,
});
world.add(transformer);
const guides = new Konva.Group({ listening: false });   // transient snap lines
const guideLayer = new Konva.Group({ listening: false }); // persistent guides
world.add(guides);
world.add(guideLayer);

const nodes = new Map(); // layerId -> Konva node

const FONTS = [
  "Segoe UI", "Arial Black", "Impact", "Bahnschrift", "Comic Sans MS",
  "Georgia", "Trebuchet MS", "Courier New", "Yu Gothic UI", "Verdana",
];
const FONT_DEFAULTS = { balloon: "Segoe UI", caption: "Georgia", text: "Segoe UI", sfx: "Impact" };
function fontOf(layer) { return layer.props.font || FONT_DEFAULTS[layer.type] || "Segoe UI"; }

// Types whose corner handle may rotate. Panels and lettering frames stay
// axis-aligned; sfx and freeform art rotate.
const ROTATABLE = ["sfx", "image", "rect", "ellipse", "star", "text", "draw", "line", "arrow"];
const POINT_TYPES = ["draw", "line", "arrow"]; // geometry lives in points, not w/h
const TEXT_TYPES = ["balloon", "caption", "text", "sfx"]; // sized by font

// ------------------------------------------------------------- pan/zoom --
let zoom = 1;
function applyView() {
  // The inline text editor is a plain element floating at coordinates
  // worked out when it opened. Moving the view under it would leave it
  // over the wrong panel, so it commits instead.
  const editing = document.querySelector("textarea.inline-text-editor");
  if (editing) editing.blur();
  world.scale({ x: zoom, y: zoom });
  document.getElementById("zoom-pct").textContent = Math.round(zoom * 100) + "%";
  guideLayer.getChildren().forEach((line) => line.strokeWidth(1 / zoom));
  drawRulers();
  pageLayer.batchDraw();
  uiLayer.batchDraw();
}
function setZoom(next, pivot) {
  const clamped = Math.min(3, Math.max(0.15, next));
  const anchor = pivot || { x: stage.width() / 2, y: stage.height() / 2 };
  const worldPos = {
    x: (anchor.x - world.x()) / zoom,
    y: (anchor.y - world.y()) / zoom,
  };
  zoom = clamped;
  world.position({ x: anchor.x - worldPos.x * zoom, y: anchor.y - worldPos.y * zoom });
  applyView();
}
function zoomToSelection() {
  const layers = selectedLayers();
  if (!layers.length) { fitPage(); return; }
  const rects = layers.map(layerRect);
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  const margin = 60;
  zoom = Math.min(
    (stage.width() - margin * 2) / Math.max(x2 - x1, 1),
    (stage.height() - margin * 2) / Math.max(y2 - y1, 1),
    3,
  );
  world.position({
    x: (stage.width() - (x2 - x1) * zoom) / 2 - x1 * zoom,
    y: (stage.height() - (y2 - y1) * zoom) / 2 - y1 * zoom,
  });
  applyView();
}

function fitPage() {
  const margin = 56;
  zoom = Math.min(
    (stage.width() - margin * 2) / PAGE.w,
    (stage.height() - margin * 2) / PAGE.h,
    1.6,
  );
  world.position({
    x: (stage.width() - PAGE.w * zoom) / 2,
    y: (stage.height() - PAGE.h * zoom) / 2,
  });
  applyView();
}
document.getElementById("zoom-in").onclick = () => setZoom(zoom * 1.2);
document.getElementById("zoom-out").onclick = () => setZoom(zoom / 1.2);
document.getElementById("zoom-fit").onclick = fitPage;
wrap.addEventListener("wheel", (event) => {
  if (event.ctrlKey) {
    event.preventDefault();
    const pointer = stage.getPointerPosition() || { x: stage.width() / 2, y: stage.height() / 2 };
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), pointer);
  } else {
    world.move({ x: -event.deltaX, y: -event.deltaY });
    applyView();
  }
}, { passive: false });

let spaceDown = false;
let panStart = null;
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && document.activeElement.tagName !== "TEXTAREA"
      && document.activeElement.tagName !== "INPUT") {
    spaceDown = true;
    stage.container().style.cursor = "grab";
    event.preventDefault();
  }
});
document.addEventListener("keyup", (event) => {
  if (event.code === "Space") { spaceDown = false; panStart = null; stage.container().style.cursor = ""; }
});

window.addEventListener("resize", () => {
  stage.size({ width: wrap.clientWidth, height: wrap.clientHeight });
  applyView();
});

function toWorld(pointer) {
  return { x: (pointer.x - world.x()) / zoom, y: (pointer.y - world.y()) / zoom };
}

// ------------------------------------------------------------ rendering --
// A flat colour is not enough for poster and card backgrounds. Konva
// takes gradient stops in the shape's own coordinate space, so the
// angle is resolved against the layer box here.
// Lettering laid over dark art is unreadable without an outline. SFX
// always had one; every text layer can now take one.
function outlineProps(layer) {
  const width = layer.props.outlineWidth || 0;
  // Konva defaults strokeWidth to 2, so "no outline" must be stated
  // rather than omitted, or a stroke colour set elsewhere would show.
  if (!width) return { strokeWidth: 0 };
  return {
    stroke: layer.props.outline || "#ffffff",
    strokeWidth: width,
    fillAfterStrokeEnabled: true,
    lineJoin: "round",
  };
}

function fillProps(layer) {
  if (layer.props.fillType !== "linear") return { fill: layer.props.fill };
  const angle = ((layer.props.gradientAngle || 0) * Math.PI) / 180;
  const w = layer.w || 1;
  const h = layer.h || 1;
  const cx = w / 2;
  const cy = h / 2;
  const reach = (Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h) / 2;
  return {
    fillLinearGradientStartPoint: {
      x: cx - Math.cos(angle) * reach, y: cy - Math.sin(angle) * reach,
    },
    fillLinearGradientEndPoint: {
      x: cx + Math.cos(angle) * reach, y: cy + Math.sin(angle) * reach,
    },
    fillLinearGradientColorStops: [
      0, layer.props.fill || "#ffffff",
      1, layer.props.fill2 || "#000000",
    ],
  };
}

function buildNode(layer) {
  const common = {
    x: layer.x, y: layer.y,
    draggable: !layer.locked, visible: layer.visible, name: layer.type, id: layer.id,
  };
  if (ROTATABLE.includes(layer.type)) common.rotation = layer.props.rot || 0;
  let node;
  if (layer.type === "panel") {
    node = new Konva.Group(common);
    node.add(new Konva.Rect({
      width: layer.w, height: layer.h, name: "frame",
      stroke: "#111", strokeWidth: 3,
      fill: layer.props.image ? undefined : "#f1f1f4",
      fillEnabled: !layer.props.image,
    }));
    node.add(new Konva.Text({
      width: layer.w, height: layer.h, align: "center", verticalAlign: "middle",
      text: layer.name + "\nprompt in Properties → Generate",
      fontSize: 14, fill: "#9b9ba6", name: "placeholder",
      visible: !layer.props.image, listening: false,
    }));
    if (layer.props.image) attachImage(node, layer);
  } else if (layer.type === "image") {
    node = new Konva.Group(common);
    node.add(new Konva.Rect({
      width: layer.w, height: layer.h, name: "frame",
      fill: "#f1f1f4", stroke: "#c9c9d2", strokeWidth: 1, dash: [5, 4],
    }));
    if (layer.props.image) attachImage(node, layer);
  } else if (layer.type === "draw") {
    node = new Konva.Line({
      ...common,
      points: layer.props.points,
      stroke: layer.props.stroke, strokeWidth: layer.props.strokeWidth,
      lineCap: "round", lineJoin: "round", tension: 0.4,
      hitStrokeWidth: Math.max(layer.props.strokeWidth + 10, 16),
    });
  } else if (layer.type === "line" || layer.type === "arrow") {
    node = new Konva.Group(common);
    const Shape = layer.type === "arrow" ? Konva.Arrow : Konva.Line;
    node.add(new Shape({
      points: layer.props.points,
      stroke: layer.props.stroke, strokeWidth: layer.props.strokeWidth,
      fill: layer.props.stroke, pointerLength: 14, pointerWidth: 13,
      lineCap: "round", hitStrokeWidth: Math.max(layer.props.strokeWidth + 10, 16),
      name: "shape",
    }));
  } else if (layer.type === "ellipse") {
    node = new Konva.Group(common);
    node.add(new Konva.Ellipse({
      x: layer.w / 2, y: layer.h / 2, radiusX: layer.w / 2, radiusY: layer.h / 2,
      ...fillProps(layer),
      stroke: layer.props.stroke,
      strokeWidth: layer.props.strokeWidth, name: "shape",
    }));
  } else if (layer.type === "star") {
    node = new Konva.Group(common);
    const outer = Math.min(layer.w, layer.h) / 2;
    node.add(new Konva.Star({
      x: layer.w / 2, y: layer.h / 2, numPoints: layer.props.points5 || 5,
      outerRadius: outer, innerRadius: outer * 0.45,
      fill: layer.props.fill, stroke: layer.props.stroke,
      strokeWidth: layer.props.strokeWidth, name: "shape",
    }));
  } else if (layer.type === "balloon") {
    // Built as an ordinary group rather than Konva.Label, which anchors
    // its origin at the tail tip: a balloon would then sit far above the
    // coordinate it claims to be at, unlike every other layer.
    node = new Konva.Group(common);
    const padding = 13;
    const body = new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontStyle: "600",
      fontSize: layer.props.fontSize, fill: layer.props.color || "#111",
      padding, width: layer.w, align: "center", wrap: "word", name: "label-text",
      ...outlineProps(layer),
      lineHeight: layer.props.lineHeight || 1.15,
      letterSpacing: layer.props.letterSpacing || 0,
    });
    const bodyH = Math.max(body.height(), layer.props.fontSize + padding * 2);
    const tailLen = layer.props.tailLength || 26;
    const tailW = layer.props.tailWidth || 22;
    const direction = layer.props.tail || "down";
    const tails = {
      down: [layer.w * 0.34, bodyH, layer.w * 0.34 + tailW, bodyH,
             layer.w * 0.40, bodyH + tailLen],
      up: [layer.w * 0.34, 0, layer.w * 0.34 + tailW, 0, layer.w * 0.40, -tailLen],
      left: [0, bodyH * 0.45, 0, bodyH * 0.45 + tailW, -tailLen, bodyH * 0.40],
      right: [layer.w, bodyH * 0.45, layer.w, bodyH * 0.45 + tailW,
              layer.w + tailLen, bodyH * 0.40],
    };
    if (direction !== "none" && tails[direction]) {
      node.add(new Konva.Line({
        points: tails[direction], closed: true,
        fill: layer.props.bg || "#fff",
        stroke: layer.props.ink || "#111", strokeWidth: 2.5,
        lineJoin: "round", name: "tail",
      }));
    }
    node.add(new Konva.Rect({
      width: layer.w, height: bodyH, name: "frame",
      fill: layer.props.bg || "#fff",
      stroke: layer.props.ink || "#111", strokeWidth: 2.5,
      cornerRadius: layer.props.shape === "thought" ? 26 : 18,
    }));
    node.add(body);
    // the tail is drawn first so the body's outline covers its base
    node.findOne(".tail") && node.findOne(".tail").moveToBottom();
  } else if (layer.type === "caption") {
    node = new Konva.Group(common);
    const text = new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontSize: layer.props.fontSize,
      fill: layer.props.color || "#111", padding: 9, width: layer.w, name: "label-text",
      align: layer.props.align || "left",
      ...outlineProps(layer),
      lineHeight: layer.props.lineHeight || 1.15,
      letterSpacing: layer.props.letterSpacing || 0,
    });
    node.add(new Konva.Rect({
      width: layer.w, height: text.height(), name: "frame",
      fill: layer.props.bg || "#fdf6de", stroke: layer.props.ink || "#111", strokeWidth: 2,
    }));
    node.add(text);
  } else if (layer.type === "text") {
    node = new Konva.Group(common);
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer),
      fontStyle: layer.props.style || "700",
      fontSize: layer.props.fontSize, fill: layer.props.fill, width: layer.w,
      align: layer.props.align || "left", name: "label-text",
      ...outlineProps(layer),
      lineHeight: layer.props.lineHeight || 1.15,
      letterSpacing: layer.props.letterSpacing || 0,
    }));
  } else if (layer.type === "sfx") {
    node = new Konva.Group(common);
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontStyle: "900",
      fontSize: layer.props.fontSize, fill: layer.props.fill,
      stroke: layer.props.stroke, strokeWidth: layer.props.strokeWidth,
      fillAfterStrokeEnabled: true, lineJoin: "round",
      align: "center", name: "label-text",
      lineHeight: layer.props.lineHeight || 1.15,
      letterSpacing: layer.props.letterSpacing || 0,
    }));
  } else {
    node = new Konva.Group(common);
    node.add(new Konva.Rect({
      width: layer.w, height: layer.h, name: "shape",
      ...fillProps(layer), stroke: layer.props.stroke || "#111",
      strokeWidth: layer.props.strokeWidth != null ? layer.props.strokeWidth : 2,
      cornerRadius: layer.props.radius || 0,
    }));
    if (layer.props.label) {
      node.add(new Konva.Text({
        width: layer.w, height: layer.h, text: layer.props.label,
        align: "center", verticalAlign: "middle", padding: 8,
        fontFamily: fontOf(layer), fontSize: layer.props.labelSize || 14,
        fill: layer.props.labelColor || "#111", name: "box-label",
        listening: false,
      }));
    }
  }
  applyFlip(node, layer);
  node.opacity((layer.props.opacity != null ? layer.props.opacity : 100) / 100);
  if (layer.props.blend && layer.props.blend !== "normal") {
    node.globalCompositeOperation(layer.props.blend);
  }

  node.on("dragstart", (event) => {
    if (!selectedIds.includes(layer.id)) select(layer.id);
    // holding alt drops a copy at the original position and drags on
    if (event.evt && event.evt.altKey && !node._duplicated) {
      node._duplicated = true;
      const stamp = selectedLayers().map((l) => JSON.parse(JSON.stringify(l)));
      stamp.forEach((copy) => {
        copy.id = uid();
        layerSeq += 1;
        copy.name = copy.name.replace(/\d+$/, "") + layerSeq;
        currentPage().layers.push(copy);
      });
      renderLayerList();
    }
  });
  node.on("dragmove", () => {
    // A Transformer already carries every node attached to it when one
    // is dragged. Moving the siblings here as well applied the delta
    // twice and threw a multiple selection apart.
    if (selectedIds.length === 1) snapDrag(node);
    pageLayer.batchDraw();
  });
  node.on("dragend", () => {
    guides.destroyChildren();
    node._duplicated = false;
    selectedIds.forEach((id) => {
      const other = nodes.get(id);
      const model = findLayer(id);
      if (other && model) {
        model.x = Math.round(other.x());
        model.y = Math.round(other.y());
      }
    });
    pageLayer.batchDraw();
    commit();
  });
  node.on("click tap", (event) => {
    event.cancelBubble = true;
    select(layer.id, { toggle: event.evt.shiftKey });
  });
  node.on("dblclick dbltap", () => {
    const model = findLayer(layer.id);
    if (["balloon", "caption", "text", "sfx"].includes(model.type)) editTextInline(node, model);
  });
  return node;
}

// Mirror the contents inside the layer's own box. Flipping the group
// node itself would feed a negative scale and a shifted origin back
// into the drag and transform handlers, which store node coordinates.
function applyFlip(node, layer) {
  if (!layer.props.flipX && !layer.props.flipY) return;
  if (typeof node.getChildren !== "function") return;
  node.getChildren().forEach((child) => {
    if (layer.props.flipX) {
      child.scaleX(-1);
      child.x(layer.w - child.x());
    }
    if (layer.props.flipY) {
      child.scaleY(-1);
      child.y(layer.h - child.y());
    }
  });
}

// Rebuilding the canvas recreates every node, and decoding an image is
// asynchronous, so art vanished until it loaded again: every edit made
// the whole page flash empty. Images do not change once decoded, so keep
// them and attach synchronously when we already have one.
const decodedImages = new Map();

function placeArt(group, layer, image) {
  const old = group.findOne(".art");
  if (old) old.destroy();
  // The art must take pointer events: with a hidden or unfilled frame
  // it is the only hit area the layer has, and without it a rendered
  // panel can only be grabbed by its 3px border.
  const art = new Konva.Image({
    image, width: layer.w, height: layer.h, name: "art",
  });
  const crop = layer.props.crop;
  if (crop) {
    art.crop({
      x: crop.x * image.naturalWidth, y: crop.y * image.naturalHeight,
      width: crop.w * image.naturalWidth, height: crop.h * image.naturalHeight,
    });
  }
  group.add(art);
  applyFlip(group, layer);
  const frame = group.findOne(".frame");
  if (frame) {
    frame.fillEnabled(false);
    frame.moveToTop();
    if (layer.type === "image") frame.visible(false);
  }
  const placeholder = group.findOne(".placeholder");
  if (placeholder) placeholder.visible(false);
  applyAdjust(group, layer);
}

function attachImage(group, layer) {
  const source = layer.props.image;
  const ready = decodedImages.get(source);
  if (ready && ready.complete && ready.naturalWidth) {
    delete layer.props.imageBroken;
    placeArt(group, layer, ready);      // no flicker: it is already decoded
    return;
  }
  const image = new window.Image();
  image.onerror = () => {
    // a truncated render or a damaged file otherwise leaves an empty
    // frame with nothing to say why
    layer.props.imageBroken = true;
    const placeholder = group.findOne(".placeholder");
    if (placeholder) {
      placeholder.text(`${layer.name}
this image could not be read`);
      placeholder.visible(true);
    }
    pageLayer.batchDraw();
    toast(`${layer.name}: image could not be read`, true);
  };
  image.onload = () => {
    delete layer.props.imageBroken;
    decodedImages.set(source, image);
    // keep the most recent; a long session should not grow without end
    if (decodedImages.size > 60) {
      decodedImages.delete(decodedImages.keys().next().value);
    }
    placeArt(group, layer, image);
    pageLayer.batchDraw();
  };
  image.src = source;
}

function applyAdjust(group, layer) {
  const art = group.findOne(".art");
  if (!art) return;
  const a = layer.props.adjust || {};
  const filters = [];
  if (a.bright) filters.push(Konva.Filters.Brighten);
  if (a.contrast) filters.push(Konva.Filters.Contrast);
  if (a.sat) filters.push(Konva.Filters.HSL);
  if (a.blur) filters.push(Konva.Filters.Blur);
  if (a.gray) filters.push(Konva.Filters.Grayscale);
  if (!filters.length) { art.clearCache(); art.filters([]); return; }
  art.cache({ pixelRatio: 1 });
  art.filters(filters);
  art.brightness((a.bright || 0) / 100);
  art.contrast(a.contrast || 0);
  art.saturation((a.sat || 0) / 50);
  art.blurRadius(a.blur || 0);
}

function renderCanvas() {
  nodes.forEach((node) => node.destroy());
  nodes.clear();
  currentPage().layers.forEach((layer) => {
    const node = buildNode(layer);
    nodes.set(layer.id, node);
    nodeGroup.add(node);
  });
  document.getElementById("empty-hint").style.display =
    currentPage().layers.length ? "none" : "block";
  document.getElementById("layers-empty").style.display =
    currentPage().layers.length ? "none" : "block";
  syncSelection();
  pageLayer.batchDraw();
  renderLayerList();
  renderPageLabel();
  renderPageGrid();
}

function syncSelection() {
  const active = selectedLayers().filter((l) => !l.locked);
  transformer.nodes(active.map((l) => nodes.get(l.id)).filter(Boolean));
  transformer.rotateEnabled(active.length > 0 && active.every((l) => ROTATABLE.includes(l.type)));
  transformer.moveToTop();
  pageLayer.batchDraw();
  renderProps();
  renderLayerList();
  renderOptions();
  const single = primaryLayer();
  document.getElementById("generate").disabled = !(single && single.type === "panel");
}

function select(id, opts = {}) {
  if (id == null) selectedIds = [];
  else if (opts.toggle) {
    selectedIds = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
  } else selectedIds = [id];
  selectedIds = expandGroups(selectedIds);
  syncSelection();
  if (id != null && !opts.toggle && selectedIds.length === 1) {
    document.querySelectorAll(".dock-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".dock-page").forEach((p) => p.classList.remove("active"));
    const target = findLayer(id).type === "panel" ? "props" : "layers";
    document.querySelector(`.dock-tab[data-page="${target}"]`).classList.add("active");
    document.querySelector(`.dock-page[data-page="${target}"]`).classList.add("active");
  }
}

let squelchStageClick = false;
stage.on("click tap", (event) => {
  if (squelchStageClick) { squelchStageClick = false; return; }
  if (event.target === stage || event.target === pageRect) select(null);
});

transformer.on("transformend", () => {
  transformer.nodes().forEach((node) => {
    const layer = findLayer(node.id());
    if (!layer) return;
    if (ROTATABLE.includes(layer.type)) layer.props.rot = Math.round(node.rotation());
    const scaleX = node.scaleX(), scaleY = node.scaleY();
    node.scale({ x: 1, y: 1 });
    if (POINT_TYPES.includes(layer.type)) {
      // geometry is a point list: bake the scale into the points
      layer.props.points = layer.props.points.map((v, i) =>
        Math.round(v * (i % 2 === 0 ? scaleX : scaleY)));
      if (layer.type === "draw") {
        layer.props.strokeWidth = Math.max(1, Math.round(layer.props.strokeWidth * (scaleX + scaleY) / 2));
      }
    } else if (TEXT_TYPES.includes(layer.type)) {
      // Type is sized by font, not by a box: scaling the width alone
      // would do nothing visible. Side handles reflow, the bottom
      // handle sets type size, a corner does both.
      if (layer.type === "sfx") {
        const uniform = (scaleX + scaleY) / 2;
        layer.props.fontSize = Math.max(8, Math.round(layer.props.fontSize * uniform));
      } else {
        layer.props.fontSize = Math.max(6, Math.round(layer.props.fontSize * scaleY));
      }
      layer.w = Math.round(Math.max(40, layer.w * scaleX));
    } else {
      layer.w = Math.round(Math.max(24, layer.w * scaleX));
      layer.h = Math.round(Math.max(24, layer.h * scaleY));
    }
    layer.x = Math.round(node.x());
    layer.y = Math.round(node.y());
  });
  const kept = [...selectedIds];
  renderCanvas();
  selectedIds = kept;
  syncSelection();
  commit();
});

// --------------------------------------------------------------- rulers --
// Rulers read page coordinates, not screen pixels: a mark at 500 sits at
// x=500 on the page whatever the zoom. Dragging off a ruler drops a
// guide, and layers snap to guides like any other edge.
doc.guides = doc.guides || { v: [], h: [] };
let rulersOn = localStorage.getItem("studio-rulers") !== "off";

function niceStep(pixelsPerUnit) {
  const targets = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  return targets.find((t) => t * pixelsPerUnit >= 60) || 1000;
}

function drawRulers() {
  const top = document.getElementById("ruler-top");
  const left = document.getElementById("ruler-left");
  if (!top || !left) return;
  document.body.classList.toggle("rulers-on", rulersOn);
  if (!rulersOn) return;

  const width = Math.max(wrap.clientWidth, 1);
  const height = Math.max(wrap.clientHeight, 1);
  top.width = width; top.height = 20;
  left.width = 20; left.height = height;
  const styles = getComputedStyle(document.documentElement);
  const ink = styles.getPropertyValue("--ink-3").trim() || "#888";
  const stroke = styles.getPropertyValue("--hairline-strong").trim() || "#555";
  const step = niceStep(zoom);

  const axis = (context, length, offset, horizontal) => {
    context.clearRect(0, 0, horizontal ? length : 20, horizontal ? 20 : length);
    context.strokeStyle = stroke;
    context.fillStyle = ink;
    context.font = "9px 'Segoe UI', sans-serif";
    context.beginPath();
    const first = Math.floor((-offset / zoom) / step) * step;
    const last = first + length / zoom + step;
    for (let value = first; value <= last; value += step) {
      const at = Math.round(value * zoom + offset) + 0.5;
      if (at < 0 || at > length) continue;
      if (horizontal) {
        context.moveTo(at, 13); context.lineTo(at, 20);
        context.fillText(String(value), at + 2, 9);
      } else {
        context.moveTo(13, at); context.lineTo(20, at);
        context.save();
        context.translate(9, at - 2);
        context.rotate(-Math.PI / 2);
        context.fillText(String(value), 0, 0);
        context.restore();
      }
    }
    context.stroke();
  };
  axis(top.getContext("2d"), width, world.x(), true);
  axis(left.getContext("2d"), height, world.y(), false);
}

function drawGuides() {
  guideLayer.destroyChildren();
  doc.guides.v.forEach((x) => guideLayer.add(new Konva.Line({
    points: [x, -4000, x, 4000], stroke: "#3ba7c9", strokeWidth: 1 / zoom, listening: false,
  })));
  doc.guides.h.forEach((y) => guideLayer.add(new Konva.Line({
    points: [-4000, y, 4000, y], stroke: "#3ba7c9", strokeWidth: 1 / zoom, listening: false,
  })));
  pageLayer.batchDraw();
}

function setupRulerDragging() {
  [["ruler-top", "v"], ["ruler-left", "h"]].forEach(([id, which]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const preview = (moveEvent) => {
        const at = toWorld({
          x: moveEvent.clientX - rect.left,
          y: moveEvent.clientY - rect.top,
        });
        drawGuides();
        guideLayer.add(new Konva.Line({
          points: which === "v" ? [at.x, -4000, at.x, 4000] : [-4000, at.y, 4000, at.y],
          stroke: "#3ba7c9", strokeWidth: 1 / zoom, dash: [4, 4], listening: false,
        }));
        pageLayer.batchDraw();
      };
      const drop = (upEvent) => {
        window.removeEventListener("mousemove", preview);
        window.removeEventListener("mouseup", drop);
        const pointer = { x: upEvent.clientX - rect.left, y: upEvent.clientY - rect.top };
        // let go back over the ruler to cancel
        if (pointer.x < 0 || pointer.y < 0) { drawGuides(); return; }
        const at = toWorld(pointer);
        if (which === "v") doc.guides.v.push(Math.round(at.x));
        else doc.guides.h.push(Math.round(at.y));
        drawGuides();
        commit("Add guide");
      };
      window.addEventListener("mousemove", preview);
      window.addEventListener("mouseup", drop);
    });
  });
}

function clearGuides() {
  doc.guides = { v: [], h: [] };
  drawGuides();
  commit("Clear guides");
  toast("Guides cleared");
}

function toggleRulers() {
  rulersOn = !rulersOn;
  localStorage.setItem("studio-rulers", rulersOn ? "on" : "off");
  document.body.classList.toggle("rulers-on", rulersOn);
  stage.size({ width: wrap.clientWidth, height: wrap.clientHeight });
  applyView();
}

// -------------------------------------------------------------- snapping --
function snapDrag(node) {
  guides.destroyChildren();
  const tol = 6 / zoom;
  const r = node.getClientRect({ relativeTo: world });
  const xs = [0, PAGE.w / 2, PAGE.w, ...doc.guides.v];
  const ys = [0, PAGE.h / 2, PAGE.h, ...doc.guides.h];
  currentPage().layers.forEach((layer) => {
    if (selectedIds.includes(layer.id) || !layer.visible) return;
    const other = nodes.get(layer.id);
    if (!other) return;
    const o = other.getClientRect({ relativeTo: world });
    xs.push(o.x, o.x + o.width / 2, o.x + o.width);
    ys.push(o.y, o.y + o.height / 2, o.y + o.height);
  });
  const edgesX = [r.x, r.x + r.width / 2, r.x + r.width];
  const edgesY = [r.y, r.y + r.height / 2, r.y + r.height];
  let snapped;
  outerX: for (const edge of edgesX) {
    for (const cand of xs) {
      if (Math.abs(cand - edge) < tol) {
        node.x(node.x() + cand - edge);
        snapped = cand;
        break outerX;
      }
    }
  }
  if (snapped != null) {
    guides.add(new Konva.Line({
      points: [snapped, -24, snapped, PAGE.h + 24],
      stroke: "#7a6cc8", strokeWidth: 1 / zoom, dash: [4, 4],
    }));
  }
  snapped = null;
  outerY: for (const edge of edgesY) {
    for (const cand of ys) {
      if (Math.abs(cand - edge) < tol) {
        node.y(node.y() + cand - edge);
        snapped = cand;
        break outerY;
      }
    }
  }
  if (snapped != null) {
    guides.add(new Konva.Line({
      points: [-24, snapped, PAGE.w + 24, snapped],
      stroke: "#7a6cc8", strokeWidth: 1 / zoom, dash: [4, 4],
    }));
  }
}

// --------------------------------------------------------------- layers --
function addLayer(type, geometry, extraProps) {
  layerSeq += 1;
  const defaults = {
    panel: { w: 380, h: 380, props: { prompt: "", seed: null, image: null } },
    image: { w: 400, h: 300, props: { image: null } },
    draw: { w: 0, h: 0, props: { points: [], stroke: paint.brushColor, strokeWidth: paint.brushSize, opacity: paint.brushOpacity } },
    balloon: { w: 210, h: 0, props: { text: "SPEECH HERE!", fontSize: 20 } },
    caption: { w: 300, h: 0, props: { text: "Narration caption.", fontSize: 16 } },
    text: { w: 340, h: 0, props: { text: "TITLE", fontSize: 44, fill: "#111111" } },
    rect: { w: 200, h: 120, props: { fill: paint.fill, stroke: paint.stroke, strokeWidth: paint.strokeWidth } },
    ellipse: { w: 200, h: 140, props: { fill: paint.fill, stroke: paint.stroke, strokeWidth: paint.strokeWidth } },
    star: { w: 180, h: 180, props: { fill: paint.fill, stroke: paint.stroke, strokeWidth: paint.strokeWidth } },
    line: { w: 0, h: 0, props: { points: [0, 0, 160, 0], stroke: paint.stroke, strokeWidth: Math.max(paint.strokeWidth, 2) } },
    arrow: { w: 0, h: 0, props: { points: [0, 0, 160, 0], stroke: paint.stroke, strokeWidth: Math.max(paint.strokeWidth, 2) } },
    sfx: { w: 420, h: 0, props: { text: "DOOM!!", fontSize: 92, fill: "#111111", stroke: "#ffffff", strokeWidth: 5, rot: -8 } },
  }[type];
  const layer = {
    id: uid(), type,
    name: `${type[0].toUpperCase() + type.slice(1)} ${layerSeq}`,
    x: geometry && geometry.x != null ? geometry.x : 60,
    y: geometry && geometry.y != null ? geometry.y : 60,
    w: geometry && geometry.w ? geometry.w : defaults.w,
    h: geometry && geometry.h ? geometry.h : defaults.h,
    visible: true, locked: false,
    props: { ...defaults.props, ...(extraProps || {}) },
  };
  currentPage().layers.push(layer);
  renderCanvas();
  select(layer.id);
  commit();
  return layer;
}

function deleteSelected() {
  if (!selectedIds.length) return;
  const page = currentPage();
  page.layers = page.layers.filter((l) => !selectedIds.includes(l.id));
  selectedIds = [];
  renderCanvas();
  commit();
}

function copySelected() {
  clipboard = selectedLayers().map((l) => JSON.parse(JSON.stringify(l)));
}
function pasteClipboard(inPlace) {
  if (!clipboard.length) return;
  const offset = inPlace ? 0 : 16;
  const fresh = clipboard.map((l) => {
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid();
    copy.x += offset;
    copy.y += offset;
    layerSeq += 1;
    copy.name = copy.name.replace(/\d+$/, "") + layerSeq;
    return copy;
  });
  currentPage().layers.push(...fresh);
  selectedIds = fresh.map((l) => l.id);
  renderCanvas();
  commit();
}
function duplicateSelected() { copySelected(); pasteClipboard(); }

// Flipping is a scale of -1 about the layer's own centre, stored so it
// survives a re-render.
function flipSelected(axis) {
  const layers = selectedLayers();
  if (!layers.length) return;
  layers.forEach((layer) => {
    if (POINT_TYPES.includes(layer.type)) {
      const points = layer.props.points;
      const coords = points.filter((_, i) => (i % 2 === 0) === (axis === "x"));
      const mid = (Math.min(...coords) + Math.max(...coords)) / 2;
      layer.props.points = points.map((v, i) =>
        ((i % 2 === 0) === (axis === "x")) ? Math.round(2 * mid - v) : v);
    } else {
      const key = axis === "x" ? "flipX" : "flipY";
      layer.props[key] = !layer.props[key];
    }
  });
  const kept = [...selectedIds];
  renderCanvas();
  selectedIds = kept;
  syncSelection();
  commit(`Flip ${axis === "x" ? "horizontal" : "vertical"}`);
}

// Grouping keeps the layers in the model and marks them with a shared
// group id, so selecting one selects the set.
function groupSelected() {
  const layers = selectedLayers();
  if (layers.length < 2) { toast("Select two or more layers to group"); return; }
  const groupId = uid();
  layers.forEach((layer) => { layer.group = groupId; });
  renderCanvas();
  syncSelection();
  commit("Group");
  toast(`Grouped ${layers.length} layers`);
}

function ungroupSelected() {
  const layers = selectedLayers().filter((l) => l.group);
  if (!layers.length) { toast("Nothing grouped in the selection"); return; }
  layers.forEach((layer) => { delete layer.group; });
  renderCanvas();
  syncSelection();
  commit("Ungroup");
}

// Selecting any member of a group selects the whole group.
function expandGroups(ids) {
  const groups = new Set(ids.map((id) => {
    const layer = findLayer(id);
    return layer && layer.group;
  }).filter(Boolean));
  if (!groups.size) return ids;
  const expanded = new Set(ids);
  currentPage().layers.forEach((layer) => {
    if (layer.group && groups.has(layer.group)) expanded.add(layer.id);
  });
  return [...expanded];
}

function reorderSelected(mode) {
  const arr = currentPage().layers;
  const picked = arr.filter((l) => selectedIds.includes(l.id));
  if (!picked.length) return;
  const rest = arr.filter((l) => !selectedIds.includes(l.id));
  if (mode === "front") currentPage().layers = [...rest, ...picked];
  else if (mode === "back") currentPage().layers = [...picked, ...rest];
  else if (mode === "forward" || mode === "backward") {
    const delta = mode === "forward" ? 1 : -1;
    const indexed = picked.map((l) => arr.indexOf(l)).sort((a, b) => delta > 0 ? b - a : a - b);
    indexed.forEach((from) => {
      const to = Math.min(arr.length - 1, Math.max(0, from + delta));
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
    });
  }
  renderCanvas();
  commit();
}

// ---------------------------------------------------- align / distribute --
function layerRect(layer) {
  const node = nodes.get(layer.id);
  return node ? node.getClientRect({ relativeTo: world }) : { x: layer.x, y: layer.y, width: layer.w, height: layer.h };
}
function alignSelected(mode) {
  const layers = selectedLayers();
  if (!layers.length) return;
  const rects = layers.map(layerRect);
  let bounds;
  if (layers.length > 1) {
    const x1 = Math.min(...rects.map((r) => r.x));
    const y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.width));
    const y2 = Math.max(...rects.map((r) => r.y + r.height));
    bounds = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  } else {
    bounds = { x: 0, y: 0, width: PAGE.w, height: PAGE.h };
  }
  layers.forEach((layer, i) => {
    const r = rects[i];
    let dx = 0, dy = 0;
    if (mode === "left") dx = bounds.x - r.x;
    if (mode === "hcenter") dx = bounds.x + (bounds.width - r.width) / 2 - r.x;
    if (mode === "right") dx = bounds.x + bounds.width - r.width - r.x;
    if (mode === "top") dy = bounds.y - r.y;
    if (mode === "vcenter") dy = bounds.y + (bounds.height - r.height) / 2 - r.y;
    if (mode === "bottom") dy = bounds.y + bounds.height - r.height - r.y;
    layer.x = Math.round(layer.x + dx);
    layer.y = Math.round(layer.y + dy);
  });
  const kept = [...selectedIds];
  renderCanvas();
  selectedIds = kept;
  syncSelection();
  commit();
}
function distributeSelected(axis) {
  const layers = selectedLayers();
  if (layers.length < 3) return;
  const entries = layers.map((layer) => ({ layer, r: layerRect(layer) }));
  const key = axis === "h" ? "x" : "y";
  const size = axis === "h" ? "width" : "height";
  entries.sort((a, b) => a.r[key] - b.r[key]);
  const first = entries[0], last = entries[entries.length - 1];
  const span = (last.r[key] + last.r[size]) - first.r[key];
  const total = entries.reduce((sum, e) => sum + e.r[size], 0);
  const gap = (span - total) / (entries.length - 1);
  let cursor = first.r[key];
  entries.forEach((e) => {
    const delta = cursor - e.r[key];
    if (axis === "h") e.layer.x = Math.round(e.layer.x + delta);
    else e.layer.y = Math.round(e.layer.y + delta);
    cursor += e.r[size] + gap;
  });
  const kept = [...selectedIds];
  renderCanvas();
  selectedIds = kept;
  syncSelection();
  commit();
}

function renderLayerList() {
  const list = document.getElementById("layer-list");
  list.innerHTML = "";
  [...currentPage().layers].reverse().forEach((layer) => {
    const row = document.createElement("div");
    row.className = "layer-row" + (selectedIds.includes(layer.id) ? " sel" : "");
    row.draggable = true;
    // a thumbnail of the actual art beats a type glyph for finding a layer
    const thumb = layer.props && layer.props.image
      ? `<span class="glyph art"><img src="${layer.props.image}" alt=""></span>`
      : `<span class="glyph">${ICONS[layer.type] || ICONS.rect}</span>`;
    row.innerHTML = thumb +
      `<span class="name" title="Double click to rename">${escapeHtml(layer.name)}</span>` +
      `<span class="mini vis ${layer.visible ? "" : "engaged"}" title="show or hide">${layer.visible ? "●" : "○"}</span>` +
      `<span class="mini lock ${layer.locked ? "engaged" : ""}" title="lock">${layer.locked ? "L" : "U"}</span>`;
    row.addEventListener("click", (event) => {
      if (event.target.classList.contains("vis")) { layer.visible = !layer.visible; renderCanvas(); commit(); return; }
      if (event.target.classList.contains("lock")) { layer.locked = !layer.locked; renderCanvas(); commit(); return; }
      select(layer.id, { toggle: event.shiftKey || event.ctrlKey });
    });
    row.querySelector(".name").addEventListener("dblclick", (event) => {
      event.stopPropagation();
      const cell = event.target;
      const input = document.createElement("input");
      input.className = "rename";
      input.value = layer.name;
      cell.replaceWith(input);
      input.focus();
      input.select();
      const finish = (keep) => {
        if (keep && input.value.trim()) layer.name = input.value.trim();
        renderLayerList();
        if (keep) commit("Rename layer");
      };
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (keyEvent) => {
        keyEvent.stopPropagation();
        if (keyEvent.key === "Enter") input.blur();
        if (keyEvent.key === "Escape") { input.value = ""; finish(false); }
      });
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedIds.includes(layer.id)) select(layer.id);
      showContextMenu(event.clientX, event.clientY, contextItemsForSelection());
    });
    // Reordering drops above or below the row the pointer is nearest to,
    // with a visible insertion line, instead of swapping blindly.
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", layer.id);
      event.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      list.querySelectorAll(".layer-row").forEach((r) =>
        r.classList.remove("drop-above", "drop-below"));
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = row.getBoundingClientRect();
      const above = event.clientY < box.top + box.height / 2;
      list.querySelectorAll(".layer-row").forEach((r) =>
        r.classList.remove("drop-above", "drop-below"));
      row.classList.add(above ? "drop-above" : "drop-below");
    });
    row.addEventListener("dragleave", () =>
      row.classList.remove("drop-above", "drop-below"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const draggedId = event.dataTransfer.getData("text/plain");
      list.querySelectorAll(".layer-row").forEach((r) =>
        r.classList.remove("drop-above", "drop-below"));
      if (!draggedId || draggedId === layer.id) return;
      const arr = currentPage().layers;
      const from = arr.findIndex((l) => l.id === draggedId);
      if (from < 0) return;
      const box = row.getBoundingClientRect();
      const dropAbove = event.clientY < box.top + box.height / 2;
      const [moved] = arr.splice(from, 1);
      // the list is drawn top-down but the model is bottom-up
      const target = arr.findIndex((l) => l.id === layer.id);
      if (target < 0) { arr.splice(from, 0, moved); return; }
      arr.splice(dropAbove ? target + 1 : target, 0, moved);
      renderCanvas();
      commit();
    });
    list.appendChild(row);
  });
}

// ------------------------------------------------------- tool options bar --
const OPT_ICONS = {
  alignLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4v16"/><rect x="8" y="7" width="10" height="3.6"/><rect x="8" y="13.4" width="6" height="3.6"/></svg>',
  alignH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v16"/><rect x="7" y="7" width="10" height="3.6"/><rect x="9" y="13.4" width="6" height="3.6"/></svg>',
  alignRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 4v16"/><rect x="6" y="7" width="10" height="3.6"/><rect x="10" y="13.4" width="6" height="3.6"/></svg>',
  alignTop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16"/><rect x="7" y="8" width="3.6" height="10"/><rect x="13.4" y="8" width="3.6" height="6"/></svg>',
  alignV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12h16"/><rect x="7" y="7" width="3.6" height="10"/><rect x="13.4" y="9" width="3.6" height="6"/></svg>',
  alignBottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19h16"/><rect x="7" y="6" width="3.6" height="10"/><rect x="13.4" y="10" width="3.6" height="6"/></svg>',
  distH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 5v14M19.5 5v14"/><rect x="10" y="8" width="4" height="8"/></svg>',
  distV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4.5h14M5 19.5h14"/><rect x="8" y="10" width="8" height="4"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11"/><path d="M15.5 4.5h-11v11"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4.5" y="4.5" width="11" height="11"/><path d="M8.5 19.5h11v-11"/></svg>',
};
function renderOptions() {
  const bar = document.getElementById("tool-options");
  let html = "";
  if (tool === "draw" || tool === "eraser") {
    if (tool === "draw") html += `<input type="color" id="opt-brush-color" value="${paint.brushColor}" title="Brush color">`;
    html += `<label>Size</label><input type="range" id="opt-brush-size" min="1" max="60" value="${paint.brushSize}">`;
    if (tool === "draw") html += `<label>Opacity</label><input type="range" id="opt-brush-op" min="5" max="100" value="${paint.brushOpacity}">`;
    if (tool === "eraser") html += `<label>Click or drag over strokes to remove them</label>`;
  } else if (SHAPE_TOOLS.includes(tool) || STROKE_TOOLS.includes(tool)) {
    if (SHAPE_TOOLS.includes(tool)) html += `<label>Fill</label><input type="color" id="opt-fill" value="${paint.fill}" title="Fill">`;
    html += `<label>Stroke</label><input type="color" id="opt-stroke" value="${paint.stroke}" title="Stroke">`;
    html += `<input type="range" id="opt-stroke-w" min="0" max="20" value="${paint.strokeWidth}" title="Stroke width">`;
  }
  if (selectedIds.length) {
    if (html) html += `<span class="divider"></span>`;
    const many = selectedIds.length > 1 ? "selection" : "page";
    html += [
      ["left", "alignLeft", `Align left of ${many}`], ["hcenter", "alignH", "Center horizontally"],
      ["right", "alignRight", "Align right"], ["top", "alignTop", "Align top"],
      ["vcenter", "alignV", "Center vertically"], ["bottom", "alignBottom", "Align bottom"],
    ].map(([mode, icon, title]) =>
      `<button class="opt-btn" data-align="${mode}" title="${title}">${OPT_ICONS[icon]}</button>`).join("");
    html += `<button class="opt-btn" data-dist="h" title="Distribute horizontally" ${selectedIds.length < 3 ? "disabled" : ""}>${OPT_ICONS.distH}</button>`;
    html += `<button class="opt-btn" data-dist="v" title="Distribute vertically" ${selectedIds.length < 3 ? "disabled" : ""}>${OPT_ICONS.distV}</button>`;
    html += `<span class="divider"></span>`;
    html += `<button class="opt-btn" data-order="forward" title="Bring forward (Ctrl+])">${OPT_ICONS.up}</button>`;
    html += `<button class="opt-btn" data-order="backward" title="Send backward (Ctrl+[)">${OPT_ICONS.down}</button>`;
  }
  bar.innerHTML = html;
  bar.classList.toggle("show", Boolean(html));
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("input", fn); };
  bind("opt-brush-color", (e) => { paint.brushColor = e.target.value; });
  bind("opt-brush-size", (e) => { paint.brushSize = parseInt(e.target.value, 10); });
  bind("opt-brush-op", (e) => { paint.brushOpacity = parseInt(e.target.value, 10); });
  bind("opt-fill", (e) => { paint.fill = e.target.value; });
  bind("opt-stroke", (e) => { paint.stroke = e.target.value; });
  bind("opt-stroke-w", (e) => { paint.strokeWidth = parseInt(e.target.value, 10); });
  bar.querySelectorAll("[data-align]").forEach((b) => b.addEventListener("click", () => alignSelected(b.dataset.align)));
  bar.querySelectorAll("[data-dist]").forEach((b) => b.addEventListener("click", () => distributeSelected(b.dataset.dist)));
  bar.querySelectorAll("[data-order]").forEach((b) => b.addEventListener("click", () => reorderSelected(b.dataset.order)));
}

// ------------------------------------------------------- context menu --
const contextMenu = document.createElement("div");
contextMenu.className = "menu-drop";
document.body.appendChild(contextMenu);

function hideContextMenu() { contextMenu.classList.remove("show"); }

function showContextMenu(clientX, clientY, items) {
  contextMenu.innerHTML = items.map((item, index) => item === "-"
    ? '<div class="menu-sep"></div>'
    : `<div class="menu-item" data-idx="${index}"${item.disabled ? ' style="opacity:.4"' : ""}>` +
      `${escapeHtml(item.label)}${item.accel ? `<span class="accel">${item.accel}</span>` : ""}</div>`
  ).join("");
  contextMenu.classList.add("show");
  // keep the menu on screen when opened near an edge
  const { offsetWidth: w, offsetHeight: h } = contextMenu;
  contextMenu.style.left = Math.min(clientX, window.innerWidth - w - 8) + "px";
  contextMenu.style.top = Math.min(clientY, window.innerHeight - h - 8) + "px";
  contextMenu.querySelectorAll(".menu-item").forEach((el) => {
    const item = items[Number(el.dataset.idx)];
    if (!item || item.disabled) return;
    el.addEventListener("click", () => { hideContextMenu(); item.run(); });
  });
}

function contextItemsForSelection() {
  const layers = selectedLayers();
  const one = layers.length === 1 ? layers[0] : null;
  const items = [
    { label: "Cut", accel: "Ctrl+X", run: () => { copySelected(); deleteSelected(); } },
    { label: "Copy", accel: "Ctrl+C", run: copySelected },
    { label: "Duplicate", accel: "Ctrl+D", run: duplicateSelected },
    { label: "Delete", accel: "Del", run: deleteSelected },
    "-",
    { label: "Flip Horizontal", run: () => flipSelected("x") },
    { label: "Flip Vertical", run: () => flipSelected("y") },
    "-",
    { label: layers.some((l) => l.group) ? "Ungroup" : "Group",
      disabled: layers.length < 2 && !layers.some((l) => l.group),
      run: () => (layers.some((l) => l.group) ? ungroupSelected() : groupSelected()) },
    "-",
    { label: "Bring to Front", accel: "Ctrl+Shift+]", run: () => reorderSelected("front") },
    { label: "Bring Forward", accel: "Ctrl+]", run: () => reorderSelected("forward") },
    { label: "Send Backward", accel: "Ctrl+[", run: () => reorderSelected("backward") },
    { label: "Send to Back", accel: "Ctrl+Shift+[", run: () => reorderSelected("back") },
    "-",
    {
      label: layers.every((l) => l.locked) ? "Unlock" : "Lock",
      run: () => {
        const lock = !layers.every((l) => l.locked);
        layers.forEach((l) => { l.locked = lock; });
        renderCanvas();
        commit();
      },
    },
    {
      label: layers.every((l) => !l.visible) ? "Show" : "Hide",
      run: () => {
        const show = layers.every((l) => !l.visible);
        layers.forEach((l) => { l.visible = show; });
        renderCanvas();
        commit();
      },
    },
  ];
  if (layers.length > 1) {
    items.push("-",
      { label: "Align Left", run: () => alignSelected("left") },
      { label: "Align Top", run: () => alignSelected("top") },
      { label: "Distribute Horizontally", disabled: layers.length < 3, run: () => distributeSelected("h") },
    );
  }
  if (one && TEXT_TYPES.includes(one.type)) {
    items.push("-", {
      label: "Edit Text",
      run: () => {
        const node = nodes.get(one.id);
        if (node) editTextInline(node, one);
      },
    });
  }
  if (one && one.type === "panel") {
    items.push("-", {
      label: one.props.image ? "Regenerate Art" : "Generate Art",
      run: () => document.getElementById("generate").click(),
    });
  }
  if (one && (one.type === "image" || one.type === "panel") && one.props.image) {
    items.push({
      label: "Crop",
      run: () => {
        cropTarget = one.id;
        stage.container().style.cursor = "crosshair";
        toast("Drag a region on the image to crop. Esc cancels.");
      },
    });
    if (one.props.crop) {
      items.push({
        label: "Reset Crop",
        run: () => { delete one.props.crop; renderCanvas(); select(one.id); commit(); },
      });
    }
  }
  return items;
}

function contextItemsForCanvas() {
  return [
    { label: "Paste", accel: "Ctrl+V", disabled: !clipboard.length, run: pasteClipboard },
    { label: "Select All", accel: "Ctrl+A", run: () => {
      selectedIds = currentPage().layers.map((l) => l.id);
      syncSelection();
    } },
    "-",
    { label: "Place Image...", accel: "M", run: () => document.getElementById("image-file").click() },
    { label: "Re-flow Panels", run: relayoutPage },
    "-",
    { label: "Add Page", run: () => document.getElementById("page-add").click() },
    { label: "Fit Page", accel: "Ctrl+0", run: fitPage },
  ];
}

stage.container().addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const pointer = stage.getPointerPosition();
  const hit = pointer ? stage.getIntersection(pointer) : null;
  // walk up to the layer group that owns whatever was hit
  let owner = hit;
  while (owner && !nodes.has(owner.id())) owner = owner.getParent();
  if (owner && nodes.has(owner.id())) {
    if (!selectedIds.includes(owner.id())) select(owner.id());
    showContextMenu(event.clientX, event.clientY, contextItemsForSelection());
  } else {
    showContextMenu(event.clientX, event.clientY, contextItemsForCanvas());
  }
});
document.addEventListener("click", hideContextMenu);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideContextMenu(); });
window.addEventListener("blur", hideContextMenu);

// ----------------------------------------------------------- properties --
function propField(label, inputHtml) { return `<label>${label}</label>${inputHtml}`; }

const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "difference"];

function renderProps() {
  const body = document.getElementById("props-body");
  const layer = primaryLayer();
  if (!layer) {
    body.innerHTML = selectedIds.length > 1
      ? `<div class="dock-empty">${selectedIds.length} elements selected.<br />Align and arrange from the bar<br />above the canvas.</div>`
      : '<div class="dock-empty">Select an element to edit<br />its properties.</div>';
    return;
  }
  let html = '<div class="prop-grid">';
  html += propField("Name", `<input data-k="name" value="${escapeHtml(layer.name)}">`);
  html += propField("X / Y", `<input data-k="xy" value="${layer.x}, ${layer.y}">`);
  if (!POINT_TYPES.includes(layer.type)) {
    html += propField("W / H", `<input data-k="wh" value="${layer.w}, ${layer.h}">`);
  }
  html += propField("Opacity", `<input data-live="opacity" type="range" min="0" max="100" value="${layer.props.opacity != null ? layer.props.opacity : 100}">`);
  html += propField("Blend", `<select data-k="blend">${BLEND_MODES.map((m) =>
    `<option value="${m}" ${(layer.props.blend || "normal") === m ? "selected" : ""}>${m}</option>`).join("")}</select>`);
  if (layer.type === "panel") {
    html += `<textarea data-k="prompt" placeholder="Shot tags: pose, action, setting, framing, lighting">${escapeHtml(layer.props.prompt || "")}</textarea>`;
    const castOptions = doc.cast.map((c) => {
      const on = (layer.props.cast || []).some((n) => n.toLowerCase() === c.name.toLowerCase());
      return `<label class="cast-pick"><input type="checkbox" data-cast="${escapeHtml(c.name)}" ${on ? "checked" : ""}>${escapeHtml(c.name)}</label>`;
    }).join("");
    html += propField("In panel", castOptions
      ? `<div class="cast-picks">${castOptions}</div>`
      : `<span class="prop-note">No cast yet. Add characters in the Style tab.</span>`);
    html += propField("Seed", `<input data-k="seed" type="number" value="${layer.props.seed ?? ""}" placeholder="${doc.style.lockSeed ? "locked" : "random"}">`);
    html += `<div class="prop-note">Sent to the engine:<br />${escapeHtml(composePrompt(layer))}</div>`;
    if (layer.props.engineUsed) html += `<div class="prop-note">last render: ${layer.props.engineUsed} · seed ${layer.props.seedUsed}</div>`;
  }
  if (["balloon", "caption", "text", "sfx"].includes(layer.type)) {
    html += `<textarea data-k="text">${escapeHtml(layer.props.text)}</textarea>`;
    const fontOptions = FONTS.map((f) =>
      `<option value="${f}" ${fontOf(layer) === f ? "selected" : ""}>${f}</option>`).join("");
    html += propField("Font", `<select data-k="font">${fontOptions}</select>`);
    html += propField("Text size", `<input data-k="fontSize" type="number" value="${layer.props.fontSize}">`);
    html += propField("Line height", `<input data-k="lineHeight" type="number" step="0.05" value="${layer.props.lineHeight || 1.15}">`);
    html += propField("Letter space", `<input data-k="letterSpacing" type="number" value="${layer.props.letterSpacing || 0}">`);
  }
  if (layer.type === "balloon") {
    html += propField("Tail", `<select data-k="tail">${
      ["down", "up", "left", "right", "none"].map((d) =>
        `<option value="${d}" ${(layer.props.tail || "down") === d ? "selected" : ""}>${d}</option>`).join("")
    }</select>`);
    html += propField("Tail length", `<input data-k="tailLength" type="number" value="${layer.props.tailLength || 26}">`);
  }
  if (["balloon", "caption"].includes(layer.type)) {
    html += propField("Fill", `<input data-k="bg" type="color" value="${layer.props.bg || (layer.type === "balloon" ? "#ffffff" : "#fdf6de")}">`);
    html += propField("Text color", `<input data-k="color" type="color" value="${layer.props.color || "#111111"}">`);
  }
  if (["text", "caption"].includes(layer.type)) {
    html += propField("Align", `<select data-k="align">${["left", "center", "right"].map((a) =>
      `<option value="${a}" ${(layer.props.align || "left") === a ? "selected" : ""}>${a}</option>`).join("")}</select>`);
  }
  if (["text", "sfx"].includes(layer.type)) html += propField("Color", `<input data-k="fill" type="color" value="${layer.props.fill}">`);
  if (layer.type === "sfx") {
    html += propField("Outline", `<input data-k="stroke" type="color" value="${layer.props.stroke}">`);
    html += propField("Outline px", `<input data-k="strokeWidth" type="number" value="${layer.props.strokeWidth}">`);
  } else if (TEXT_TYPES.includes(layer.type)) {
    html += propField("Outline", `<input data-k="outline" type="color" value="${layer.props.outline || "#ffffff"}">`);
    html += propField("Outline px", `<input data-k="outlineWidth" type="number" value="${layer.props.outlineWidth || 0}">`);
  }
  if (ROTATABLE.includes(layer.type)) {
    html += propField("Rotation", `<input data-k="rot" type="number" value="${layer.props.rot || 0}">`);
  }
  if (["rect", "ellipse", "star"].includes(layer.type)) {
    html += propField("Fill type", `<select data-k="fillType">
      <option value="solid" ${layer.props.fillType !== "linear" ? "selected" : ""}>Solid</option>
      <option value="linear" ${layer.props.fillType === "linear" ? "selected" : ""}>Gradient</option>
    </select>`);
    html += propField("Fill", `<input data-k="fill" type="color" value="${layer.props.fill}">`);
    if (layer.props.fillType === "linear") {
      html += propField("Fill 2", `<input data-k="fill2" type="color" value="${layer.props.fill2 || "#000000"}">`);
      html += propField("Angle", `<input data-k="gradientAngle" type="number" value="${layer.props.gradientAngle || 0}">`);
    }
    html += propField("Stroke", `<input data-k="stroke" type="color" value="${layer.props.stroke || "#111111"}">`);
    html += propField("Stroke px", `<input data-k="strokeWidth" type="number" value="${layer.props.strokeWidth != null ? layer.props.strokeWidth : 2}">`);
    if (layer.type === "rect") {
      html += propField("Corner", `<input data-k="radius" type="number" value="${layer.props.radius || 0}">`);
      html += propField("Label", `<input data-k="label" value="${escapeHtml(layer.props.label || "")}" placeholder="optional text inside">`);
    }
  }
  if (["draw", "line", "arrow"].includes(layer.type)) {
    html += propField("Color", `<input data-k="stroke" type="color" value="${layer.props.stroke}">`);
    html += propField("Width", `<input data-k="strokeWidth" type="number" value="${layer.props.strokeWidth}">`);
  }
  if ((layer.type === "image" || layer.type === "panel") && layer.props.image) {
    html += `<div class="prop-note" style="margin-top:4px"><b>Adjust</b></div>`;
    const a = layer.props.adjust || {};
    html += propField("Brightness", `<input data-adjust="bright" type="range" min="-100" max="100" value="${a.bright || 0}">`);
    html += propField("Contrast", `<input data-adjust="contrast" type="range" min="-100" max="100" value="${a.contrast || 0}">`);
    html += propField("Saturation", `<input data-adjust="sat" type="range" min="-100" max="100" value="${a.sat || 0}">`);
    html += propField("Blur", `<input data-adjust="blur" type="range" min="0" max="30" value="${a.blur || 0}">`);
    html += propField("Grayscale", `<input data-adjust="gray" type="checkbox" ${a.gray ? "checked" : ""}>`);
    html += `<button data-act="crop" style="grid-column:1/-1">Crop: drag a region on the image</button>`;
    if (layer.props.crop) html += `<button data-act="uncrop" style="grid-column:1/-1">Reset crop</button>`;
  }
  html += "</div>";
  body.innerHTML = html;
  body.querySelectorAll("[data-k]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.k;
      if (key === "name") layer.name = input.value;
      else if (key === "xy") {
        const [x, y] = input.value.split(",").map((v) => parseInt(v, 10));
        if (!Number.isNaN(x)) layer.x = x;
        if (!Number.isNaN(y)) layer.y = y;
      } else if (key === "wh") {
        const [w, h] = input.value.split(",").map((v) => parseInt(v, 10));
        if (!Number.isNaN(w)) layer.w = w;
        if (!Number.isNaN(h)) layer.h = h;
      } else if (key === "prompt") layer.props.prompt = input.value;
      else if (key === "seed") layer.props.seed = input.value === "" ? null : parseInt(input.value, 10);
      else if (key === "text") layer.props.text = input.value;
      else if (key === "fontSize") layer.props.fontSize = parseInt(input.value, 10) || 16;
      else if (key === "lineHeight") layer.props.lineHeight = parseFloat(input.value) || 1.15;
      else if (["strokeWidth", "rot", "radius", "letterSpacing", "gradientAngle",
                "outlineWidth", "tailLength"].includes(key)) layer.props[key] = parseInt(input.value, 10) || 0;
      else layer.props[key] = input.value;
      renderCanvas();
      select(layer.id);
      commit();
    });
  });
  body.querySelectorAll("[data-cast]").forEach((box) => {
    box.addEventListener("change", () => {
      const name = box.dataset.cast;
      const current = layer.props.cast || [];
      layer.props.cast = box.checked
        ? [...current, name]
        : current.filter((n) => n.toLowerCase() !== name.toLowerCase());
      renderProps();
      commit();
    });
  });
  const opacityInput = body.querySelector('[data-live="opacity"]');
  if (opacityInput) {
    opacityInput.addEventListener("input", () => {
      layer.props.opacity = parseInt(opacityInput.value, 10);
      const node = nodes.get(layer.id);
      if (node) { node.opacity(layer.props.opacity / 100); pageLayer.batchDraw(); }
    });
    opacityInput.addEventListener("change", commit);
  }
  body.querySelectorAll("[data-adjust]").forEach((input) => {
    const apply = () => {
      layer.props.adjust = layer.props.adjust || {};
      layer.props.adjust[input.dataset.adjust] =
        input.type === "checkbox" ? input.checked : parseInt(input.value, 10);
      const node = nodes.get(layer.id);
      if (node) { applyAdjust(node, layer); pageLayer.batchDraw(); }
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", () => { apply(); commit(); });
  });
  const cropBtn = body.querySelector('[data-act="crop"]');
  if (cropBtn) cropBtn.addEventListener("click", () => {
    cropTarget = layer.id;
    stage.container().style.cursor = "crosshair";
    toast("Drag a region on the image to crop. Esc cancels.");
  });
  const uncropBtn = body.querySelector('[data-act="uncrop"]');
  if (uncropBtn) uncropBtn.addEventListener("click", () => {
    delete layer.props.crop;
    renderCanvas();
    select(layer.id);
    commit();
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ------------------------------------------------------- inline text edit --
function editTextInline(node, layer) {
  const textNode = node.findOne(".label-text");
  if (!textNode) return;
  const rect = stage.container().getBoundingClientRect();
  const absolute = textNode.getAbsolutePosition(stage);
  const input = document.createElement("textarea");
  // named so it can be found again: it floats over the canvas and has
  // to be dealt with when the view moves under it
  input.className = "inline-text-editor";
  document.body.appendChild(input);
  input.value = layer.props.text;
  Object.assign(input.style, {
    position: "fixed",
    top: rect.top + absolute.y + "px",
    left: rect.left + absolute.x + "px",
    width: Math.max(layer.w * zoom, 180) + "px", minHeight: "58px",
    font: `600 ${Math.max(layer.props.fontSize * zoom, 12)}px '${fontOf(layer)}'`,
    background: "#fff", color: "#111", border: "2px solid #5b8def",
    borderRadius: "5px", padding: "5px", zIndex: 80, userSelect: "text",
  });
  input.focus();
  input.select();
  const commitText = () => {
    layer.props.text = input.value;
    input.remove();
    renderCanvas();
    select(layer.id);
    commit();
  };
  input.addEventListener("blur", commitText);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") input.remove();
  });
}

// ----------------------------------------------------------------- tools --
function setTool(name) {
  if (name === "image") { document.getElementById("image-file").click(); return; }
  tool = name;
  const isShape = SHAPE_IDS.includes(name);
  document.querySelectorAll(".tool").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === name));
  if (isShape) {
    lastShape = name;
    shapesBtn.innerHTML = ICONS[name] + '<span class="flyout-mark"></span>' +
      '<span class="tip">Shapes · R O L A W</span>';
  }
  shapesBtn.classList.toggle("active", isShape);
  stage.container().style.cursor = name === "select" ? "" : "crosshair";
  renderOptions();
}

let drawStart = null;
let ghost = null;        // rect preview for panel/rect/ellipse/star + crop + marquee
let ghostLine = null;    // preview for line/arrow/brush
let marquee = false;
let brushPoints = null;
let erasing = false;

function eraseAt(pointer) {
  const hits = [];
  currentPage().layers.forEach((layer) => {
    if (layer.type !== "draw" || layer.locked || !layer.visible) return;
    const node = nodes.get(layer.id);
    if (node && node.intersects(pointer)) hits.push(layer.id);
  });
  if (hits.length) {
    const page = currentPage();
    page.layers = page.layers.filter((l) => !hits.includes(l.id));
    selectedIds = selectedIds.filter((id) => !hits.includes(id));
    renderCanvas();
  }
}

stage.on("mousedown", (event) => {
  const pointer = stage.getPointerPosition();
  if (event.evt.button === 1 || spaceDown) { // middle mouse or space: pan
    event.evt.preventDefault();
    panStart = { ...pointer, wx: world.x(), wy: world.y() };
    stage.container().style.cursor = "grabbing";
    return;
  }
  const at = toWorld(pointer);
  if (cropTarget) {
    drawStart = at;
    ghost = new Konva.Rect({
      x: at.x, y: at.y, width: 1, height: 1,
      stroke: "#7a6cc8", dash: [6, 4], strokeWidth: 1.5 / zoom, listening: false,
    });
    world.add(ghost);
    return;
  }
  if (tool === "draw") {
    drawStart = at;
    brushPoints = [at.x, at.y];
    ghostLine = new Konva.Line({
      points: brushPoints, stroke: paint.brushColor,
      strokeWidth: paint.brushSize, opacity: paint.brushOpacity / 100,
      lineCap: "round", lineJoin: "round", tension: 0.4, listening: false,
    });
    world.add(ghostLine);
    return;
  }
  if (tool === "eraser") { erasing = true; eraseAt(pointer); return; }
  if (tool === "picker") {
    const canvas = stage.toCanvas({ pixelRatio: 1 });
    const data = canvas.getContext("2d").getImageData(Math.round(pointer.x), Math.round(pointer.y), 1, 1).data;
    const hex = "#" + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    paint.brushColor = hex;
    paint.fill = hex;
    toast("Picked " + hex);
    renderOptions();
    return;
  }
  if (tool === "select") {
    if (event.target !== stage && event.target !== pageRect) return;
    drawStart = at;
    marquee = false; // becomes true after movement threshold
    return;
  }
  if (event.target !== stage && event.target !== pageRect) return;
  drawStart = at;
  if (["panel", "rect", "ellipse", "star"].includes(tool)) {
    ghost = new Konva.Rect({
      x: at.x, y: at.y, width: 1, height: 1,
      stroke: "#5b8def", dash: [6, 4], strokeWidth: 1.5 / zoom, listening: false,
    });
    world.add(ghost);
  } else if (STROKE_TOOLS.includes(tool)) {
    ghostLine = new Konva.Line({
      points: [at.x, at.y, at.x, at.y], stroke: paint.stroke,
      strokeWidth: Math.max(paint.strokeWidth, 2), dash: [6, 4], listening: false,
    });
    world.add(ghostLine);
  }
});

stage.on("mousemove", () => {
  const pointer = stage.getPointerPosition();
  if (panStart) {
    world.position({ x: panStart.wx + pointer.x - panStart.x, y: panStart.wy + pointer.y - panStart.y });
    applyView();
    return;
  }
  if (erasing) { eraseAt(pointer); return; }
  const at = toWorld(pointer);
  if (brushPoints && ghostLine) {
    brushPoints.push(at.x, at.y);
    ghostLine.points(brushPoints);
    pageLayer.batchDraw();
    return;
  }
  if (tool === "select" && drawStart && !ghost) {
    if (Math.abs(at.x - drawStart.x) > 4 / zoom || Math.abs(at.y - drawStart.y) > 4 / zoom) {
      marquee = true;
      ghost = new Konva.Rect({
        x: drawStart.x, y: drawStart.y, width: 1, height: 1,
        stroke: "#5b8def", dash: [4, 4], strokeWidth: 1 / zoom,
        fill: "rgba(91,141,239,0.08)", listening: false,
      });
      world.add(ghost);
    }
  }
  if (ghost && drawStart) {
    ghost.width(at.x - drawStart.x);
    ghost.height(at.y - drawStart.y);
    pageLayer.batchDraw();
  }
  if (ghostLine && drawStart && !brushPoints) {
    ghostLine.points([drawStart.x, drawStart.y, at.x, at.y]);
    pageLayer.batchDraw();
  }
});

stage.on("mouseup", () => {
  if (panStart) {
    panStart = null;
    stage.container().style.cursor = tool === "select" ? "" : "crosshair";
    return;
  }
  if (erasing) { erasing = false; commit(); return; }
  if (brushPoints) {
    const points = brushPoints;
    if (ghostLine) { ghostLine.destroy(); ghostLine = null; }
    brushPoints = null;
    drawStart = null;
    if (points.length >= 4) {
      addLayer("draw", { x: 0, y: 0 }, {
        points: points.map((v) => Math.round(v)),
        stroke: paint.brushColor, strokeWidth: paint.brushSize, opacity: paint.brushOpacity,
      });
    }
    return;
  }
  if (!drawStart) return;
  const at = toWorld(stage.getPointerPosition());
  const geometry = {
    x: Math.round(Math.min(drawStart.x, at.x)),
    y: Math.round(Math.min(drawStart.y, at.y)),
    w: Math.round(Math.abs(at.x - drawStart.x)),
    h: Math.round(Math.abs(at.y - drawStart.y)),
  };
  if (ghost) { ghost.destroy(); ghost = null; pageLayer.batchDraw(); }
  if (ghostLine) { ghostLine.destroy(); ghostLine = null; pageLayer.batchDraw(); }
  if (cropTarget) {
    applyCrop(cropTarget, geometry);
    cropTarget = null;
    stage.container().style.cursor = "";
    drawStart = null;
    return;
  }
  if (tool === "select") {
    if (marquee) {
      squelchStageClick = true;
      const hit = currentPage().layers.filter((layer) => {
        if (!layer.visible) return false;
        const r = layerRect(layer);
        return r.x < geometry.x + geometry.w && r.x + r.width > geometry.x
          && r.y < geometry.y + geometry.h && r.y + r.height > geometry.y;
      });
      selectedIds = hit.map((l) => l.id);
      syncSelection();
    }
    marquee = false;
    drawStart = null;
    return;
  }
  if (["panel", "rect", "ellipse", "star"].includes(tool)) {
    if (geometry.w > 30 && geometry.h > 30) addLayer(tool, geometry);
  } else if (STROKE_TOOLS.includes(tool)) {
    const dx = Math.round(at.x - drawStart.x), dy = Math.round(at.y - drawStart.y);
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      addLayer(tool, { x: Math.round(drawStart.x), y: Math.round(drawStart.y) },
        { points: [0, 0, dx, dy], stroke: paint.stroke, strokeWidth: Math.max(paint.strokeWidth, 2) });
    }
  } else if (["balloon", "caption", "text", "sfx"].includes(tool)) {
    addLayer(tool, { x: geometry.x, y: geometry.y });
  }
  drawStart = null;
  setTool("select");
});

function applyCrop(layerId, region) {
  const layer = findLayer(layerId);
  if (!layer || region.w < 12 || region.h < 12) { toast("Crop cancelled"); return; }
  const x1 = Math.max(region.x, layer.x), y1 = Math.max(region.y, layer.y);
  const x2 = Math.min(region.x + region.w, layer.x + layer.w);
  const y2 = Math.min(region.y + region.h, layer.y + layer.h);
  if (x2 - x1 < 12 || y2 - y1 < 12) { toast("Drag inside the image to crop"); return; }
  const old = layer.props.crop || { x: 0, y: 0, w: 1, h: 1 };
  const fx = (x1 - layer.x) / layer.w, fy = (y1 - layer.y) / layer.h;
  const fw = (x2 - x1) / layer.w, fh = (y2 - y1) / layer.h;
  layer.props.crop = {
    x: old.x + fx * old.w, y: old.y + fy * old.h,
    w: fw * old.w, h: fh * old.h,
  };
  layer.x = Math.round(x1);
  layer.y = Math.round(y1);
  layer.w = Math.round(x2 - x1);
  layer.h = Math.round(y2 - y1);
  renderCanvas();
  select(layer.id);
  commit();
}

// ------------------------------------------------------- image placement --
document.getElementById("image-file").addEventListener("change", (event) => {
  placeImageFiles([...event.target.files]);
  event.target.value = "";
});
wrap.addEventListener("dragover", (event) => event.preventDefault());
wrap.addEventListener("drop", (event) => {
  event.preventDefault();
  const files = [...event.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) placeImageFiles(files);
});
// Nothing on a page needs more resolution than twice the page itself.
// A photograph straight from a camera is many times that, and every byte
// of it would be carried in the project file and in every export.
const MAX_IMPORT_EDGE = 2400;

function downscaleIfHuge(source, naturalWidth, naturalHeight, probe) {
  const longest = Math.max(naturalWidth, naturalHeight);
  if (longest <= MAX_IMPORT_EDGE) return source;
  const scale = MAX_IMPORT_EDGE / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(naturalWidth * scale);
  canvas.height = Math.round(naturalHeight * scale);
  canvas.getContext("2d").drawImage(probe, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return source;      // tainted canvas: keep the original
  }
}

function placeImageFiles(files) {
  files.filter((f) => f.type.startsWith("image/")).forEach((file, index) => {
    const reader = new FileReader();
    reader.onerror = () => toast(`${file.name}: could not be read`, true);
    reader.onload = () => {
      const probe = new window.Image();
      probe.onerror = () => toast(`${file.name}: not a readable image`, true);
      probe.onload = () => {
        const stored = downscaleIfHuge(reader.result,
          probe.naturalWidth, probe.naturalHeight, probe);
        const maxW = PAGE.w * 0.6, maxH = PAGE.h * 0.6;
        const scale = Math.min(maxW / probe.naturalWidth, maxH / probe.naturalHeight, 1);
        addLayer("image", {
          x: 80 + index * 24, y: 80 + index * 24,
          w: Math.round(probe.naturalWidth * scale),
          h: Math.round(probe.naturalHeight * scale),
        }, { image: stored });
      };
      probe.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// -------------------------------------------------------------- keyboard --
document.addEventListener("keydown", (event) => {
  if (["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName)) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); return; }
    if (key === "y" || (key === "z" && event.shiftKey)) { event.preventDefault(); redo(); return; }
    if (key === "g") {
      event.preventDefault();
      if (event.shiftKey) ungroupSelected(); else groupSelected();
      return;
    }
    if (key === "c") { event.preventDefault(); copySelected(); return; }
    if (key === "x") { event.preventDefault(); copySelected(); deleteSelected(); return; }
    if (key === "v") {
      event.preventDefault();
      pasteClipboard(event.shiftKey);  // shift pastes in place
      return;
    }
    if (key === "d") { event.preventDefault(); duplicateSelected(); return; }
    if (key === "a") {
      event.preventDefault();
      selectedIds = currentPage().layers.map((l) => l.id);
      syncSelection();
      return;
    }
    if (key === "s") { event.preventDefault(); document.getElementById("save").click(); return; }
    if (event.key === "]") { event.preventDefault(); reorderSelected(event.shiftKey ? "front" : "forward"); return; }
    if (event.key === "[") { event.preventDefault(); reorderSelected(event.shiftKey ? "back" : "backward"); return; }
    return;
  }
  if (event.key === "Escape") {
    if (cropTarget) { cropTarget = null; stage.container().style.cursor = ""; toast("Crop cancelled"); }
    else select(null);
    return;
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selectedIds.length) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    selectedLayers().forEach((layer) => { layer.x += dx; layer.y += dy; });
    const kept = [...selectedIds];
    renderCanvas();
    selectedIds = kept;
    syncSelection();
    clearTimeout(document._nudgeT);
    document._nudgeT = setTimeout(commit, 400);
    return;
  }
  const map = {
    v: "select", d: "draw", e: "eraser", i: "picker", p: "panel", m: "image",
    b: "balloon", c: "caption", t: "text", s: "sfx",
    r: "rect", o: "ellipse", l: "line", a: "arrow", w: "star",
  };
  if (map[key]) setTool(map[key]);
  if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
});

// ----------------------------------------------------------------- pages --
function renderPageLabel() {
  document.getElementById("page-label").textContent = `Page ${pageIndex + 1}/${doc.pages.length}`;
}

// A chapter is many pages, so they need to be visible and rearrangeable
// rather than reachable only through the previous and next arrows.
function goToPage(index) {
  if (index < 0 || index >= doc.pages.length) return;
  pageIndex = index;
  selectedIds = [];
  renderCanvas();
}

// A page thumbnail is about a hundred pixels wide, but the source is a
// full render. Handing the browser the original means it decodes the
// whole bitmap for every page in the document, which a chapter cannot
// afford, so each one is downscaled once and remembered.
const thumbCache = new Map();
function pageThumbnail(dataUrl, onReady) {
  const cached = thumbCache.get(dataUrl);
  if (cached) { onReady(cached); return; }
  const probe = new window.Image();
  probe.onload = () => {
    const scale = Math.min(180 / probe.naturalWidth, 240 / probe.naturalHeight, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(probe.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(probe.naturalHeight * scale));
    canvas.getContext("2d").drawImage(probe, 0, 0, canvas.width, canvas.height);
    let small;
    try { small = canvas.toDataURL("image/jpeg", 0.7); } catch { small = dataUrl; }
    thumbCache.set(dataUrl, small);
    onReady(small);
  };
  probe.onerror = () => onReady(null);
  probe.src = dataUrl;
}

function renderPageGrid() {
  const grid = document.getElementById("page-grid");
  if (!grid) return;
  grid.innerHTML = "";
  doc.pages.forEach((page, index) => {
    const card = document.createElement("div");
    card.className = "page-card" + (index === pageIndex ? " sel" : "");
    card.draggable = true;
    const art = page.layers.find((l) => l.props && l.props.image);
    card.innerHTML =
      `<div class="shot">${art
        ? `<img alt="">`
        : `<span style="color:var(--ink-3);font-size:11px">empty</span>`}</div>` +
      `<div class="cap"><span>${index + 1}</span>` +
      `<span class="kill mini" title="Delete page">x</span></div>`;
    if (art) {
      const slot = card.querySelector("img");
      pageThumbnail(art.props.image, (small) => { if (small) slot.src = small; });
    }
    card.addEventListener("click", (event) => {
      if (event.target.classList.contains("kill")) {
        if (doc.pages.length === 1) { toast("A document needs one page"); return; }
        doc.pages.splice(index, 1);
        if (pageIndex >= doc.pages.length) pageIndex = doc.pages.length - 1;
        selectedIds = [];
        renderCanvas();
        commit("Delete page");
        return;
      }
      goToPage(index);
    });
    card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", String(index)));
    card.addEventListener("dragover", (e) => e.preventDefault());
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (Number.isNaN(from) || from === index) return;
      const current = doc.pages[pageIndex];
      const [moved] = doc.pages.splice(from, 1);
      doc.pages.splice(index, 0, moved);
      pageIndex = doc.pages.indexOf(current);
      renderCanvas();
      commit("Reorder pages");
    });
    grid.appendChild(card);
  });
}

function addPage(copyCurrent) {
  const page = copyCurrent
    ? { ...JSON.parse(JSON.stringify(currentPage())), id: uid() }
    : { id: uid(), name: `Page ${doc.pages.length + 1}`, layers: [] };
  if (copyCurrent) page.layers.forEach((l) => { l.id = uid(); });
  doc.pages.splice(pageIndex + 1, 0, page);
  pageIndex += 1;
  selectedIds = [];
  renderCanvas();
  commit(copyCurrent ? "Duplicate page" : "Add page");
}
document.getElementById("page-add").onclick = () => addPage(false);
document.getElementById("page-new").onclick = () => addPage(false);
document.getElementById("page-dupe").onclick = () => addPage(true);
document.getElementById("page-prev").onclick = () => goToPage(pageIndex - 1);
document.getElementById("page-next").onclick = () => goToPage(pageIndex + 1);

// ------------------------------------------------------------ generation --
async function loadEngines() {
  const select_ = document.getElementById("engine");
  try {
    const response = await api("/engines");
    const { engines } = await response.json();
    select_.innerHTML = "";
    engines.forEach((engine) => {
      const option = document.createElement("option");
      option.value = engine.id;
      option.textContent = engine.label + (engine.available ? "" : " — needs key");
      option.disabled = !engine.available;
      select_.appendChild(option);
    });
  } catch {
    select_.innerHTML = "<option>server offline</option>";
  }
  showNoEngine(currentPage().layers.some((l) => l.type === "panel"));
}

function engineReady() {
  const select_ = document.getElementById("engine");
  const option = select_.selectedOptions[0];
  return Boolean(select_.value && option && !option.disabled && select_.value !== "server offline");
}

// Ask the engine for art shaped like the panel it fills, at roughly the
// one-megapixel budget diffusion models are trained on.
function renderSize(layer) {
  const ratio = Math.min(2.2, Math.max(0.45, (layer.w || 1) / (layer.h || 1)));
  const round64 = (v) => Math.max(512, Math.min(1536, Math.round(v / 64) * 64));
  return {
    width: round64(Math.sqrt(1024 * 1024 * ratio)),
    height: round64(Math.sqrt((1024 * 1024) / ratio)),
  };
}

function styleTags() {
  const preset = STYLE_PRESETS[doc.style.preset];
  return [preset ? preset.tags : "", doc.style.extra].filter(Boolean).join(", ");
}

// Some looks are defined as much by what must be absent as by what is
// present: a coloring page fails the moment the model adds colour.
function styleNegative() {
  const preset = STYLE_PRESETS[doc.style.preset];
  return (preset && preset.negative) || "";
}

function castTags(names) {
  return (names || [])
    .map((name) => doc.cast.find((c) => c.name.toLowerCase() === String(name).toLowerCase()))
    .filter(Boolean)
    .map((c) => c.tags)
    .join(", ");
}

// Cast tags first, then the beat, then the project style. Identical
// leading and trailing tags across panels are what hold a sequence
// together visually.
function composePrompt(layer) {
  return [castTags(layer.props.cast), layer.props.prompt, styleTags()]
    .map((part) => String(part || "").trim().replace(/^,|,$/g, "").trim())
    .filter(Boolean)
    .join(", ");
}

// A locked base seed makes a page reproducible: re-rendering a panel
// gives the same art unless its prompt changed.
function panelSeed(layer) {
  if (layer.props.seed != null) return layer.props.seed;
  if (!doc.style.lockSeed) return null;
  if (doc.style.seedBase == null) doc.style.seedBase = Math.floor(Math.random() * 1_000_000);
  const index = currentPage().layers.filter((l) => l.type === "panel").indexOf(layer);
  return doc.style.seedBase + Math.max(index, 0) * 101 + pageIndex * 7919;
}

// A render takes many seconds, and the page can change underneath it.
// Writing the result to a layer that has since been deleted loses the
// work quietly and still reports success.
function layerStillPresent(layer) {
  return doc.pages.some((page) => page.layers.includes(layer));
}

async function generatePanel(layer) {
  if (!engineReady()) throw new Error("no image engine configured");
  const size = renderSize(layer);
  const response = await api("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      engine: document.getElementById("engine").value,
      prompt: composePrompt(layer), seed: panelSeed(layer),
      width: size.width, height: size.height, no_text: true,
      negative: styleNegative(),
    }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "generation failed");
  if (!layerStillPresent(layer)) {
    throw new Error(`${layer.name} was removed before its art arrived`);
  }
  layer.props.image = "data:image/png;base64," + result.image_base64;
  layer.props.engineUsed = result.engine;
  layer.props.seedUsed = result.seed;
  delete layer.props.crop;
  renderCanvas();
  return result;
}

document.getElementById("generate").onclick = async () => {
  const layer = primaryLayer();
  if (!layer || layer.type !== "panel") return;
  if (!layer.props.prompt || !layer.props.prompt.trim()) {
    toast("Write a prompt in Properties first");
    return;
  }
  const button = document.getElementById("generate");
  button.disabled = true;
  button.textContent = "Generating…";
  try {
    const result = await generatePanel(layer);
    select(layer.id);
    commit();
    toast(`${layer.name} · ${result.engine} · ${(result.latency_ms / 1000).toFixed(1)}s`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Generate";
  }
};

// ------------------------------------------------------- page layout --
// Panel geometry is computed here, never by the language model: a model
// has no spatial sense and produces overlapping, ragged pages. Tiers of
// varying height, wider gutters between tiers than within one (standard
// comics practice), manga pages read right to left.
const MARGIN = Math.round(PAGE.w * 0.045);
const GUTTER_X = Math.round(PAGE.w * 0.018);
const GUTTER_Y = Math.round(PAGE.w * 0.03);

// Each template is a list of tiers: height weight + column weights.
// Chosen so the opening and closing beats get the most area.
const PAGE_TEMPLATES = {
  1: [[1, [1]]],
  2: [[1.15, [1]], [1, [1]]],
  3: [[1.25, [1]], [1, [1, 1]]],
  4: [[1, [1, 1]], [1.1, [1, 1]]],
  5: [[1.2, [1]], [1, [1, 1]], [1, [1, 1]]],
  6: [[1, [1, 1]], [1, [1, 1]], [1, [1, 1]]],
  7: [[1.15, [1]], [1, [1, 1]], [1, [1, 1]], [1, [1, 1]]],
  8: [[1, [1, 1]], [1, [1, 1]], [1, [1, 1]], [1, [1, 1]]],
};

function pageLayout(count) {
  const tiers = PAGE_TEMPLATES[Math.min(Math.max(count, 1), 8)];
  const rightToLeft = doc.kind === "manga";
  const innerW = PAGE.w - MARGIN * 2;
  const innerH = PAGE.h - MARGIN * 2;
  const weightSum = tiers.reduce((sum, [hw]) => sum + hw, 0);
  const usableH = innerH - GUTTER_Y * (tiers.length - 1);
  const rects = [];
  let y = MARGIN;
  tiers.forEach(([heightWeight, cols]) => {
    const h = Math.round((usableH * heightWeight) / weightSum);
    const usableW = innerW - GUTTER_X * (cols.length - 1);
    const colSum = cols.reduce((a, b) => a + b, 0);
    let x = MARGIN;
    const tierRects = cols.map((cw) => {
      const w = Math.round((usableW * cw) / colSum);
      const rect = { x, y, w, h };
      x += w + GUTTER_X;
      return rect;
    });
    // manga reads right to left: first beat sits at the right edge
    rects.push(...(rightToLeft ? tierRects.reverse() : tierRects));
    y += h + GUTTER_Y;
  });
  return rects.slice(0, count);
}

// Lettering is placed relative to its panel so balloons always land
// inside the art they belong to.
function placeDialogue(panelRect, entries) {
  const placed = [];
  let balloonRow = 0;
  let captionCount = 0;
  entries.forEach((entry) => {
    const kind = ["balloon", "caption", "sfx"].includes(entry.kind) ? entry.kind : "balloon";
    const text = String(entry.text || "").slice(0, 300);
    if (!text) return;
    if (kind === "balloon") {
      const w = Math.round(Math.min(panelRect.w * 0.46, 230));
      const rightSide = entry.speaker === "right" || (entry.speaker !== "left" && balloonRow % 2 === 1);
      placed.push({
        kind, text, w,
        x: rightSide ? panelRect.x + panelRect.w - w - Math.round(panelRect.w * 0.06)
                     : panelRect.x + Math.round(panelRect.w * 0.06),
        y: panelRect.y + Math.round(panelRect.h * 0.08) + balloonRow * Math.round(panelRect.h * 0.22),
      });
      balloonRow += 1;
    } else if (kind === "caption") {
      const w = Math.round(Math.min(panelRect.w * 0.5, 280));
      placed.push({
        kind, text, w,
        x: panelRect.x + Math.round(panelRect.w * 0.04),
        // first caption tops the panel, a second one anchors the bottom
        y: captionCount === 0
          ? panelRect.y + Math.round(panelRect.h * 0.04)
          : panelRect.y + panelRect.h - Math.round(panelRect.h * 0.16),
      });
      captionCount += 1;
    } else {
      placed.push({
        kind, text,
        w: Math.round(panelRect.w * 0.7),
        fontSize: Math.round(Math.min(panelRect.w * 0.13, 96)),
        x: panelRect.x + Math.round(panelRect.w * 0.18),
        y: panelRect.y + Math.round(panelRect.h * 0.42),
      });
    }
  });
  return placed;
}

// ------------------------------------------------------ panel detection --
// A whole-page render draws its own borders, so panel rectangles have to
// be recovered from the pixels before lettering can be placed inside
// them. Recursive XY-cut: split on wide bands of near-white gutter,
// alternating axes, and stop when a region no longer splits.
function detectPanels(image, pageW, pageH) {
  const W = 220;
  const H = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * W));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, W, H);
  const pixels = context.getImageData(0, 0, W, H).data;

  const bright = (x, y) => {
    const i = (y * W + x) * 4;
    return (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  };
  const GUTTER = 232;      // a gutter is paper, not art
  const MIN_RUN = 2;       // ignore single-pixel noise lines
  const MIN_SIDE = 26;     // a panel smaller than this is not a panel

  // rows or columns that are gutter across the whole region
  function emptyLines(box, axis) {
    const lines = [];
    const outer = axis === "y" ? [box.y, box.y + box.h] : [box.x, box.x + box.w];
    const inner = axis === "y" ? [box.x, box.x + box.w] : [box.y, box.y + box.h];
    for (let a = outer[0]; a < outer[1]; a += 1) {
      let clear = true;
      for (let b = inner[0]; b < inner[1]; b += 1) {
        const value = axis === "y" ? bright(b, a) : bright(a, b);
        if (value < GUTTER) { clear = false; break; }
      }
      if (clear) lines.push(a);
    }
    return lines;
  }

  function runs(lines) {
    const out = [];
    let start = null, prev = null;
    lines.forEach((v) => {
      if (start === null) { start = prev = v; return; }
      if (v === prev + 1) { prev = v; return; }
      out.push([start, prev]);
      start = prev = v;
    });
    if (start !== null) out.push([start, prev]);
    return out.filter(([a, b]) => b - a + 1 >= MIN_RUN);
  }

  const boxes = [];
  function cut(box, axis, depth) {
    if (depth > 6 || box.w < MIN_SIDE || box.h < MIN_SIDE) { boxes.push(box); return; }
    const bands = runs(emptyLines(box, axis))
      // a band touching the region edge is margin, not a separator
      .filter(([a, b]) => a > (axis === "y" ? box.y : box.x)
        && b < (axis === "y" ? box.y + box.h - 1 : box.x + box.w - 1));
    if (!bands.length) {
      if (depth === 0 || axis !== "y") {
        // try the other axis once before giving up on this region
        const other = axis === "y" ? "x" : "y";
        const otherBands = runs(emptyLines(box, other)).filter(([a, b]) =>
          a > (other === "y" ? box.y : box.x)
          && b < (other === "y" ? box.y + box.h - 1 : box.x + box.w - 1));
        if (otherBands.length) { cut(box, other, depth + 1); return; }
      }
      boxes.push(box);
      return;
    }
    let cursor = axis === "y" ? box.y : box.x;
    const limit = axis === "y" ? box.y + box.h : box.x + box.w;
    const pieces = [];
    bands.forEach(([a, b]) => {
      if (a - cursor >= MIN_SIDE) pieces.push([cursor, a]);
      cursor = b + 1;
    });
    if (limit - cursor >= MIN_SIDE) pieces.push([cursor, limit]);
    if (pieces.length < 2) { boxes.push(box); return; }
    pieces.forEach(([from, to]) => {
      const child = axis === "y"
        ? { x: box.x, y: from, w: box.w, h: to - from }
        : { x: from, y: box.y, w: to - from, h: box.h };
      cut(child, axis === "y" ? "x" : "y", depth + 1);
    });
  }
  cut({ x: 0, y: 0, w: W, h: H }, "y", 0);

  const scaleX = pageW / W;
  const scaleY = pageH / H;
  return boxes
    .filter((b) => b.w >= MIN_SIDE && b.h >= MIN_SIDE)
    .map((b) => ({
      x: Math.round(b.x * scaleX), y: Math.round(b.y * scaleY),
      w: Math.round(b.w * scaleX), h: Math.round(b.h * scaleY),
    }))
    .sort((a, b) => (a.y - b.y) || (doc.kind === "manga" ? b.x - a.x : a.x - b.x));
}

// ------------------------------------------------------------ blueprint --
// A diagram has to be exact, so it is drawn as real boxes and arrows
// rather than generated as a picture. Nodes are placed in columns by how
// far they sit from an input, which reads as flow from left to right.
const NODE_ROLES = {
  input: { fill: "#123a5c", ink: "#7fc4ff" },
  process: { fill: "#152b4a", ink: "#9fd0ff" },
  store: { fill: "#1c2f4f", ink: "#b5c9ff" },
  output: { fill: "#14402f", ink: "#8fe0b6" },
  decision: { fill: "#432a12", ink: "#ffc98f" },
};

function columnsForGraph(nodes, edges) {
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  // longest path from a root, bounded so a cycle cannot spin forever
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    edges.forEach((edge) => {
      const next = (depth.get(edge.from) || 0) + 1;
      if (next > (depth.get(edge.to) || 0)) { depth.set(edge.to, next); changed = true; }
    });
    if (!changed) break;
  }
  const columns = new Map();
  nodes.forEach((node) => {
    const d = depth.get(node.id) || 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(node);
  });
  return columns;
}

function buildBlueprint(nodes, edges) {
  pageForNewWork("New diagram");
  setPageBackground("#0a1b2e");

  const columns = columnsForGraph(nodes, edges);
  const count = columns.size || 1;
  const boxW = Math.max(120, Math.min(210, Math.floor((PAGE.w - 80) / count) - 30));
  const boxH = 76;
  const step = count > 1 ? Math.floor((PAGE.w - 80 - boxW) / (count - 1)) : 0;

  const placed = new Map();
  [...columns.keys()].sort((a, b) => a - b).forEach((depth, columnIndex) => {
    const column = columns.get(depth);
    const spacing = PAGE.h / (column.length + 1);
    column.forEach((node, rowIndex) => {
      const box = {
        x: 40 + columnIndex * step,
        y: Math.round(spacing * (rowIndex + 1) - boxH / 2),
        w: boxW, h: boxH,
      };
      const role = NODE_ROLES[node.role] || NODE_ROLES.process;
      const layer = addLayer("rect", box, {
        fill: role.fill, stroke: role.ink, strokeWidth: 2, radius: 8,
        label: node.label, labelColor: role.ink,
      });
      layer.name = node.label;
      placed.set(node.id, { layer, box });
    });
  });

  edges.forEach((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return;
    const forward = to.box.x >= from.box.x;
    const start = {
      x: forward ? from.box.x + from.box.w : from.box.x,
      y: from.box.y + from.box.h / 2,
    };
    const end = {
      x: forward ? to.box.x : to.box.x + to.box.w,
      y: to.box.y + to.box.h / 2,
    };
    const connector = addLayer("arrow", { x: Math.round(start.x), y: Math.round(start.y) }, {
      points: [0, 0, Math.round(end.x - start.x), Math.round(end.y - start.y)],
      stroke: "#6f9fd8", strokeWidth: 2,
    });
    connector.name = `${edge.from} to ${edge.to}`;
    if (edge.label) {
      const label = addLayer("caption", {
        x: Math.round((start.x + end.x) / 2 - 55),
        y: Math.round((start.y + end.y) / 2 - 26),
        w: 110,
      }, { fontSize: 12, bg: "#0a1b2e", color: "#cfe3ff", ink: "#6f9fd8" });
      label.props.text = edge.label;
      label.name = edge.label;
    }
  });

  select(null);
  renderCanvas();
  checkpoint(`Blueprint: ${nodes.length} components`);
  toast(`Diagram with ${nodes.length} components`);
}

// The agent's page plan: lay the page out here, create the layers, then
// render each panel's art with the engine picked in the top bar.
// A document that is not a comic is one artwork plus lettering, not a
// grid of panels: a coloring page, a poster, a card front, a schematic.
async function applyAgentArtwork(beats, layout) {
  const names = [...new Set(beats.flatMap((b) => b.cast || []))];
  const subject = beats.map((b) => String(b.prompt || "").trim()).filter(Boolean).join(", ");
  const prompt = [castTags(names), subject, styleTags()].filter(Boolean).join(", ");

  pageForNewWork("New artwork");

  // A card keeps its lower third clear for the greeting.
  const artBox = layout === "card"
    ? { x: 0, y: 0, w: PAGE.w, h: Math.round(PAGE.h * 0.66) }
    : { x: 0, y: 0, w: PAGE.w, h: PAGE.h };

  const art = addLayer("image", artBox);
  art.name = "Artwork";
  art.locked = true;
  art.props.prompt = prompt;

  const lines = beats.flatMap((b) => b.dialogue || []).filter((d) => d && d.text);
  placeArtworkText(layout, lines, artBox);
  select(null);
  renderCanvas();
  // A card is folded: the front is only half of it.
  if (layout === "card") buildCardInside(lines.slice(1));

  if (!engineReady()) {
    showNoEngine(true);
    toast("Layout ready. No image engine configured.", true);
    return;
  }
  setBusy("Rendering artwork");
  try {
    const size = renderSize(art);
    const response = await api("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: document.getElementById("engine").value,
        prompt, seed: doc.style.lockSeed ? panelSeed(art) : null,
        width: size.width, height: size.height, no_text: true,
        negative: styleNegative(),
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "generation failed");
    art.props.image = "data:image/png;base64," + result.image_base64;
    art.props.engineUsed = result.engine;
    art.props.seedUsed = result.seed;
    renderCanvas();
    checkpoint(`${doc.kind}: artwork`);
    toast(`Rendered in ${(result.latency_ms / 1000).toFixed(1)}s`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(null);
  }
}

// A greeting card is folded, so the message belongs on a second page.
// Building only the front leaves the object half made.
function buildCardInside(lines) {
  if (!lines.length) return;
  const front = pageIndex;
  addPage(false);
  currentPage().name = "Inside";
  const message = addLayer("text", {
    x: Math.round(PAGE.w * 0.12), y: Math.round(PAGE.h * 0.3),
    w: Math.round(PAGE.w * 0.76),
  });
  message.name = "Message";
  message.props.text = lines[0].text;
  message.props.fontSize = Math.round(PAGE.w * 0.038);
  message.props.align = "center";
  message.props.font = "Georgia";
  message.props.lineHeight = 1.6;
  if (lines[1]) {
    const signoff = addLayer("text", {
      x: Math.round(PAGE.w * 0.12), y: Math.round(PAGE.h * 0.66),
      w: Math.round(PAGE.w * 0.76),
    });
    signoff.name = "Sign off";
    signoff.props.text = lines[1].text;
    signoff.props.fontSize = Math.round(PAGE.w * 0.03);
    signoff.props.align = "center";
    signoff.props.font = "Georgia";
  }
  select(null);
  renderCanvas();
  goToPage(front);        // leave the front showing, as it would be seen
}

// Titles, greetings and labels sit differently on each kind of document.
function placeArtworkText(layout, lines, artBox) {
  if (!lines.length) return;
  const add = (kind, text, geo, props = {}) => {
    const layer = addLayer(kind, geo);
    layer.props.text = text;
    Object.assign(layer.props, props);
    return layer;
  };
  if (layout === "poster") {
    const [title, ...rest] = lines;
    add("text", title.text, {
      x: Math.round(PAGE.w * 0.08), y: Math.round(PAGE.h * 0.74),
      w: Math.round(PAGE.w * 0.84),
    }, { fontSize: Math.round(PAGE.w * 0.11), fill: "#ffffff", align: "center", font: "Arial Black" });
    rest.slice(0, 2).forEach((line, i) => {
      add("text", line.text, {
        x: Math.round(PAGE.w * 0.08), y: Math.round(PAGE.h * (0.87 + i * 0.05)),
        w: Math.round(PAGE.w * 0.84),
      }, { fontSize: Math.round(PAGE.w * 0.035), fill: "#ffffff", align: "center" });
    });
    return;
  }
  if (layout === "card") {
    // the front carries the greeting only; the words go inside
    const [greeting] = lines;
    add("text", greeting.text, {
      x: Math.round(PAGE.w * 0.08), y: artBox.h + Math.round(PAGE.h * 0.05),
      w: Math.round(PAGE.w * 0.84),
    }, { fontSize: Math.round(PAGE.w * 0.075), fill: "#111111", align: "center", font: "Georgia" });
    return;
  }
  if (layout === "blueprint") {
    lines.slice(0, 8).forEach((line, i) => {
      add("caption", line.text, {
        x: Math.round(PAGE.w * 0.04),
        y: Math.round(PAGE.h * (0.06 + i * 0.075)),
        w: Math.round(PAGE.w * 0.26),
      }, { fontSize: 15, bg: "#0d2b4e", color: "#e8f1ff", ink: "#7fb0e0" });
    });
    return;
  }
  // single artwork: one caption strip at the foot of the page
  add("caption", lines[0].text, {
    x: Math.round(PAGE.w * 0.06), y: Math.round(PAGE.h * 0.88),
    w: Math.round(PAGE.w * 0.88),
  }, { fontSize: 18 });
}

// Whole-page mode: one render for the entire page. A single diffusion
// sample cannot disagree with itself, so the page reads as one artist.
// Panel rectangles are recovered from the result and the lettering is
// dropped into them.
// A second request must not destroy the first page: that is what makes
// a chapter, or a multi page coloring book, possible at all.
function pageForNewWork(label) {
  if (currentPage().layers.length) {
    addPage(false);
    toast(`${label} on page ${pageIndex + 1}`);
  }
  currentPage().layers = [];
  selectedIds = [];
  return currentPage();
}

async function applyAgentPage(panels, cast) {
  const beats = panels.slice(0, 8);
  const names = [...new Set(beats.flatMap((p) => p.cast || []))];
  const actions = beats.map((p) => String(p.prompt || "").split(",")[0].trim())
    .filter(Boolean).slice(0, 6).join(", ");
  const setting = beats.map((p) => String(p.prompt || "").split(",").slice(1).join(","))
    .join(",").split(",").map((t) => t.trim()).filter(Boolean);
  const scenery = [...new Set(setting)].slice(0, 8).join(", ");

  const pagePrompt = [
    castTags(names),
    `comic, multiple views, ${beats.length} panels, panel borders`,
    actions, scenery, styleTags(),
  ].filter(Boolean).join(", ");

  pageForNewWork("New page");
  const sheet = addLayer("image", { x: 0, y: 0, w: PAGE.w, h: PAGE.h });
  sheet.name = "Page art";
  sheet.locked = true;
  sheet.props.prompt = pagePrompt;
  sheet.props.isPage = true;

  if (!engineReady()) {
    renderCanvas();
    showNoEngine(true);
    toast("No image engine configured", true);
    return;
  }
  setBusy("Rendering the page");
  try {
    const response = await api("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: document.getElementById("engine").value,
        prompt: pagePrompt, seed: doc.style.lockSeed ? panelSeed(sheet) : null,
        width: 832, height: 1216, no_text: true,
        negative: styleNegative(),
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "generation failed");
    sheet.props.image = "data:image/png;base64," + result.image_base64;
    sheet.props.engineUsed = result.engine;
    sheet.props.seedUsed = result.seed;
    renderCanvas();
    await placeLetteringOnPage(sheet, beats);
    checkpoint(`Agent page: ${beats.length} beats`);
    toast(`Page rendered in ${(result.latency_ms / 1000).toFixed(1)}s`);
  } catch (error) {
    renderCanvas();
    toast(error.message, true);
  } finally {
    setBusy(null);
  }
}

// Lettering goes into detected panels in reading order; if the art has
// no readable gutters the lines still land down the page in order so
// nothing is lost and they can be dragged.
function placeLetteringOnPage(sheet, beats) {
  return new Promise((resolve) => {
    const probe = new window.Image();
    probe.onload = () => {
      let boxes = [];
      try { boxes = detectPanels(probe, PAGE.w, PAGE.h); } catch { boxes = []; }
      const usable = boxes.filter((b) => b.w > PAGE.w * 0.12 && b.h > PAGE.h * 0.07);
      const withText = beats.filter((b) => (b.dialogue || []).length);
      withText.forEach((beat, index) => {
        const box = usable[Math.min(index, usable.length - 1)] || {
          x: Math.round(PAGE.w * 0.08),
          y: Math.round(PAGE.h * (0.1 + 0.8 * (index / Math.max(withText.length, 1)))),
          w: Math.round(PAGE.w * 0.84),
          h: Math.round(PAGE.h * 0.18),
        };
        placeDialogue(box, beat.dialogue.slice(0, 3)).forEach((d) => {
          const layer = addLayer(d.kind, { x: d.x, y: d.y, w: d.w });
          layer.props.text = d.text;
          if (d.fontSize) layer.props.fontSize = d.fontSize;
        });
      });
      sheet.props.panelBoxes = usable;
      select(null);
      renderCanvas();
      resolve(usable.length);
    };
    probe.onerror = () => resolve(0);
    probe.src = sheet.props.image;
  });
}

async function applyAgentPanels(panels, opts = {}) {
  const plan = panels.slice(0, 8).filter((p) => p && p.prompt);
  if (!plan.length) return;
  if (opts.replacePage) pageForNewWork("New page");
  const rects = pageLayout(plan.length);
  const created = [];
  plan.forEach((p, i) => {
    const rect = rects[i];
    const layer = addLayer("panel", rect);
    layer.props.prompt = String(p.prompt).slice(0, 2000);
    layer.props.cast = Array.isArray(p.cast) ? p.cast.map(String) : [];
    layer.name = `Panel ${i + 1}`;
    created.push(layer);
    placeDialogue(rect, Array.isArray(p.dialogue) ? p.dialogue.slice(0, 5) : [])
      .forEach((d) => {
        const dl = addLayer(d.kind, { x: d.x, y: d.y, w: d.w });
        dl.props.text = d.text;
        if (d.fontSize) dl.props.fontSize = d.fontSize;
      });
  });
  select(null);
  renderCanvas();
  checkpoint(`Agent page: ${plan.length} panels`);
  if (!engineReady()) {
    showNoEngine(true);
    toast(`${created.length} panels laid out. No image engine configured.`, true);
    return;
  }
  for (let i = 0; i < created.length; i += 1) {
    setBusy(`Rendering panel ${i + 1} of ${created.length}`);
    try {
      await generatePanel(created[i]);
    } catch (error) {
      toast(`Panel ${i + 1}: ${error.message}`, true);
    }
  }
  setBusy(null);
  checkpoint("Page rendered");
  toast("Page rendered");
}

// Re-flow the current page's panels through the layout engine.
function relayoutPage() {
  const panels = currentPage().layers.filter((l) => l.type === "panel");
  if (!panels.length) { toast("No panels on this page"); return; }
  const rects = pageLayout(panels.length);
  panels.forEach((panel, i) => Object.assign(panel, rects[i]));
  renderCanvas();
  checkpoint("Re-flow page");
  toast(`${panels.length} panels re-flowed`);
}

// ----------------------------------------------------------------- story --
document.getElementById("story-analyze").onclick = async () => {
  const button = document.getElementById("story-analyze");
  button.disabled = true;
  button.textContent = "Analyzing…";
  setBusy("Reading the story so far");
  try {
    const pages = doc.pages.map((page, index) => ({
      index: index + 1,
      panels: page.layers.filter((l) => l.type === "panel").map((l) => l.props.prompt || ""),
      dialogue: page.layers.filter((l) => ["balloon", "caption", "text"].includes(l.type))
        .map((l) => l.props.text || ""),
    }));
    const response = await api("/story/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: doc.name, kind: doc.kind, pages, previous: doc.story }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "story engine failed");
    doc.story = { chapter: result.chapter, overall: result.overall, flags: result.flags };
    renderStory();
    commit("Story analysis");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(null);
    button.disabled = false;
    button.textContent = "Analyze story so far";
  }
};

function renderStory() {
  document.getElementById("story-chapter").textContent = doc.story.chapter || "No analysis yet.";
  document.getElementById("story-overall").textContent = doc.story.overall || "No analysis yet.";
  const flagsBox = document.getElementById("story-flags");
  flagsBox.innerHTML = "";
  (doc.story.flags || []).forEach((flag) => {
    const block = document.createElement("div");
    block.className = "story-block flag" + (flag.severity === "high" ? " bad" : "");
    block.innerHTML = `<b>${escapeHtml(flag.title)}</b><br>${escapeHtml(flag.detail)}`;
    flagsBox.appendChild(block);
  });
  if (!(doc.story.flags || []).length) {
    flagsBox.innerHTML = '<div class="story-block">No inconsistencies flagged.</div>';
  }
}

// ------------------------------------------------------------ save/export --
document.getElementById("save").onclick = async () => {
  if (!savePath) {
    savePath = await window.studio.saveProjectDialog(`${doc.name}.dimg`);
    if (!savePath) return false;   // cancelled: the caller must not close
  }
  const payload = { ...project, name: doc.name, document: doc };
  delete payload._path;
  await window.studio.writeFile(savePath, JSON.stringify(payload));
  savedSnapshot = snapshotDoc();
  markDirtyState();
  toast("Saved");
  return true;
};

// Rendering a page that is not on screen: swap it in, snapshot, swap
// back. The canvas only ever draws the current page.
function renderPageToDataUrl() {
  transformer.nodes([]);
  guides.destroyChildren();
  const priorZoom = zoom;
  const priorPos = world.position();
  zoom = 1;
  world.position({ x: 0, y: 0 });
  applyView();
  const url = stage.toDataURL({ x: 0, y: 0, width: PAGE.w, height: PAGE.h, pixelRatio: 2 });
  zoom = priorZoom;
  world.position(priorPos);
  applyView();
  return url;
}

// A snapshot captures what is drawn, so art still decoding would be
// written out as a hole. Wait for it rather than guessing at a delay.
function waitForArt(timeoutMs) {
  const undrawn = () => currentPage().layers.filter((layer) => {
    if (!layer.props || !layer.props.image || layer.props.imageBroken) return false;
    const node = nodes.get(layer.id);
    return !node || !node.findOne(".art");
  }).length;
  const deadline = Date.now() + (timeoutMs || 5000);
  return new Promise((resolve) => {
    const tick = () => {
      // give up rather than hang: a broken image must not stop an export
      if (!undrawn() || Date.now() > deadline) resolve(undrawn());
      else setTimeout(tick, 40);
    };
    tick();
  });
}

// Walk every page through the canvas, snapshotting each, then put the
// document back exactly as the user left it.
async function forEachPageSnapshot(onPage) {
  const startPage = pageIndex;
  const startSelection = [...selectedIds];
  try {
    for (let i = 0; i < doc.pages.length; i += 1) {
      pageIndex = i;
      selectedIds = [];
      renderCanvas();
      const missing = await waitForArt();
      if (missing) toast(`Page ${i + 1}: ${missing} image(s) not ready`, true);
      setBusy(`Rendering page ${i + 1} of ${doc.pages.length}`);
      await onPage(renderPageToDataUrl(), i);
    }
  } finally {
    pageIndex = startPage;
    selectedIds = startSelection;
    renderCanvas();
  }
}

document.getElementById("export-all").onclick = async () => {
  const folder = await window.studio.chooseFolder();
  if (!folder) return;
  setBusy("Exporting pages");
  let written = 0;
  try {
    await forEachPageSnapshot(async (dataUrl, index) => {
      const name = `${doc.name}-p${String(index + 1).padStart(2, "0")}.png`;
      await window.studio.writePng(`${folder}/${name}`, dataUrl);
      written += 1;
    });
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(null);
  }
  if (written) toast(`Exported ${written} page${written === 1 ? "" : "s"} to ${folder}`);
};

document.getElementById("export-pdf").onclick = async () => {
  setBusy("Building PDF");
  const images = [];
  try {
    await forEachPageSnapshot((dataUrl) => { images.push(dataUrl); });
    setBusy("Writing PDF");
    // the sheet is described in inches; the image on it supplies the
    // resolution, which the two times capture makes generous
    const widthIn = PAGE.inW || PAGE.w / 96;
    const heightIn = PAGE.inH || PAGE.h / 96;
    const saved = await window.studio.exportPdf({
      suggestedName: `${doc.name}.pdf`,
      widthIn, heightIn, images,
    });
    if (saved) {
      const dpi = Math.round((PAGE.w * 2) / widthIn);
      toast(`Exported ${images.length} pages, ${PAGE.paper || "custom"} at ${dpi} dpi`);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(null);
  }
};

document.getElementById("export").onclick = async () => {
  transformer.nodes([]);
  guides.destroyChildren();
  pageLayer.batchDraw();
  const priorZoom = zoom;
  const priorPos = world.position();
  zoom = 1;
  world.position({ x: 0, y: 0 });
  applyView();
  const dataUrl = stage.toDataURL({ x: 0, y: 0, width: PAGE.w, height: PAGE.h, pixelRatio: 2 });
  zoom = priorZoom;
  world.position(priorPos);
  applyView();
  syncSelection();
  const saved = await window.studio.exportPngDialog(`${doc.name}-p${pageIndex + 1}.png`, dataUrl);
  if (saved) toast("Exported " + saved);
};

// ---------------------------------------------------- status + layout ui --
// Long local-model calls must never look frozen: show what is running
// and how long it has been going.
let busyTimer = null;
function setBusy(text) {
  const bar = document.getElementById("busy");
  if (!text) {
    clearInterval(busyTimer);
    busyTimer = null;
    bar.classList.remove("show");
    return;
  }
  const started = Date.now();
  bar.classList.add("show");
  const tick = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    bar.innerHTML = `<span class="spin"></span>${escapeHtml(text)}<span class="secs">${seconds}s</span>`;
  };
  tick();
  clearInterval(busyTimer);
  busyTimer = setInterval(tick, 1000);
}

let serverReachable = true;

// A packaged install ships the application only: the generation server
// is started separately. Someone opening the app for the first time
// otherwise sees nothing but the words "server offline" in a dropdown.
function showNoEngine(show) {
  const box = document.getElementById("no-engine");
  const alreadyDrawn = currentPage().layers.some((l) => l.props && l.props.image);
  const wanted = show && !engineReady() && !alreadyDrawn;
  if (!wanted) { box.classList.remove("show"); return; }
  box.querySelector("b").textContent = serverReachable
    ? "No image engine configured"
    : "The generation server is not running";
  box.querySelector("p").innerHTML = serverReachable
    ? "Panels are laid out and prompts are written, but nothing can render "
      + "the art yet. Add a hosted key, or run a local engine on your GPU."
    : "Drawing, lettering, editing and export all work without it. "
      + "Generated art and the agent need it: run the server from the "
      + "project, or name a deployed one under Advanced in Settings.";
  box.classList.add("show");
}

// Draggable splitter: the right dock is resizable and the width sticks.
const dockWidth = parseInt(localStorage.getItem("studio-dock-w"), 10);
if (dockWidth) document.body.style.setProperty("--dock-w", dockWidth + "px");
(() => {
  const handle = document.getElementById("dock-resize");
  let dragging = false;
  handle.addEventListener("mousedown", (event) => {
    dragging = true;
    event.preventDefault();
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    const width = Math.min(620, Math.max(240, window.innerWidth - event.clientX));
    document.body.style.setProperty("--dock-w", width + "px");
    stage.size({ width: wrap.clientWidth, height: wrap.clientHeight });
    applyView();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    localStorage.setItem("studio-dock-w",
      parseInt(getComputedStyle(document.body).getPropertyValue("--dock-w"), 10));
  });
})();

// ----------------------------------------------------------------- misc --
function toast(message, isError) {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.style.borderColor = isError ? "#d05d5d" : "#2b2b33";
  box.classList.add("show");
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.remove("show"), 3000);
}

async function pollHealth() {
  try {
    const response = await api("/health");
    const health = await response.json();
    serverReachable = true;
    setEngineDot("eng-local", health.local);
    setEngineDot("eng-api", health.apis);
    setEngineDot("eng-story", health.story);
  } catch {
    serverReachable = false;
    ["eng-local", "eng-api", "eng-story"].forEach((id) => setEngineDot(id, false));
  }
  // an offline server is worth saying plainly, not only in a dropdown
  showNoEngine(!serverReachable || currentPage().layers.some((l) => l.type === "panel"));
  setTimeout(pollHealth, 6000);
}
function setEngineDot(id, ok) {
  document.getElementById(id).classList.toggle("ok", Boolean(ok));
}


// ------------------------------------------------- window / theme / chat --
document.getElementById("win-min").onclick = () => window.studio.win("min");
document.getElementById("win-max").onclick = () => window.studio.win("max");
document.getElementById("win-close").onclick = () => window.studio.win("close");

const savedTheme = localStorage.getItem("studio-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
document.getElementById("theme-toggle").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "" : "light";
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  localStorage.setItem("studio-theme", next);
};

async function sendChat(overrideText, quiet) {
  const input = document.getElementById("chat-input");
  const text = (overrideText != null ? overrideText : input.value).trim();
  if (!text) return;
  if (overrideText == null) input.value = "";
  if (!quiet) appendMsg("user", text);
  doc.chat.push({ role: "user", content: text });
  const thinking = appendMsg("agent", "…");
  setBusy("Directing the page");
  try {
    const pages = doc.pages.map((page, index) => ({
      index: index + 1,
      panels: page.layers.filter((l) => l.type === "panel").map((l) => l.props.prompt || ""),
      dialogue: page.layers.filter((l) => ["balloon", "caption", "text", "sfx"].includes(l.type))
        .map((l) => l.props.text || ""),
    }));
    const response = await api("/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: doc.chat.slice(-16), project: doc.name, kind: doc.kind,
        art_style: (STYLE_PRESETS[doc.style.preset] || {}).label,
        layout: recipe().layout, cast: doc.cast, pages,
        // the established chapter, so a continuing page follows it
        story: doc.story && doc.story.chapter ? doc.story : undefined,
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "agent unavailable");
    thinking.textContent = result.reply;
    doc.chat.push({ role: "assistant", content: result.reply });
    setBusy(null);
    mergeCast(result.cast);
    if (Array.isArray(result.nodes) && result.nodes.length) {
      buildBlueprint(result.nodes, result.edges || []);
    } else if (Array.isArray(result.panels) && result.panels.length) {
      const layout = recipe().layout;
      if (layout !== "panels") await applyAgentArtwork(result.panels, layout);
      else if (doc.style.pageMode !== "panels") await applyAgentPage(result.panels);
      else await applyAgentPanels(result.panels, { replacePage: true });
    }
  } catch (error) {
    thinking.textContent = "Agent offline: " + error.message;
  } finally {
    setBusy(null);
  }
}
function appendMsg(kind, text) {
  const log = document.getElementById("chat-log");
  const el = document.createElement("div");
  el.className = "msg " + kind;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
const settingsModal = document.getElementById("settings-modal");
document.getElementById("settings-btn").onclick = async () => {
  const saved = await window.studio.loadKeys();
  document.getElementById("key-anthropic").value = saved.anthropic || "";
  document.getElementById("key-ideogram").value = saved.ideogram || "";
  document.getElementById("key-openai").value = saved.openai || "";
  document.getElementById("key-bfl").value = saved.bfl || "";
  document.getElementById("key-llm-url").value = saved.llm_url || "";
  document.getElementById("key-llm-model").value = saved.llm_model || "";
  // the server address belongs to this machine, not to the server's keys
  document.getElementById("key-server").value =
    localStorage.getItem("studio-server") || "";
  document.getElementById("key-server-token").value =
    localStorage.getItem("studio-token") || "";
  settingsModal.style.display = "grid";
};
document.getElementById("settings-cancel").onclick = () => { settingsModal.style.display = "none"; };
document.getElementById("settings-save").onclick = async () => {
  await window.studio.saveKeys({
    anthropic: document.getElementById("key-anthropic").value.trim(),
    ideogram: document.getElementById("key-ideogram").value.trim(),
    openai: document.getElementById("key-openai").value.trim(),
    bfl: document.getElementById("key-bfl").value.trim(),
    llm_url: document.getElementById("key-llm-url").value.trim(),
    llm_model: document.getElementById("key-llm-model").value.trim(),
  });
  const address = document.getElementById("key-server").value.trim();
  const token = document.getElementById("key-server-token").value.trim();
  localStorage.setItem("studio-server", address);
  localStorage.setItem("studio-token", token);
  SERVER = address || "http://127.0.0.1:8787";
  SERVER_TOKEN = token;
  settingsModal.style.display = "none";
  toast("Saved. Engines refresh in a few seconds.");
  loadEngines();
};

doc.chat.forEach((m) => appendMsg(m.role === "user" ? "user" : "agent", m.content));
document.getElementById("chat-send").onclick = () => sendChat();

// Repeat the last brief across several new pages. Each round is told
// what came before so the pages differ instead of duplicating.
async function generateMorePages(count) {
  const lastBrief = [...doc.chat].reverse().find((m) => m.role === "user");
  if (!lastBrief) { toast("Ask the agent for a page first"); return; }
  const button = document.getElementById("more-pages");
  button.disabled = true;
  try {
    for (let i = 0; i < count; i += 1) {
      setBusy(`Building page ${i + 2} of ${count + 1}`);
      await sendChat(
        `${lastBrief.content}

This is a further page in the same work. `
        + "Use a different scene, composition and camera from the previous "
        + "pages, keeping the same characters and style.", true);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(null);
    button.disabled = false;
  }
}
// A chapter usually exists as writing before it exists as pages. Taking
// it a scene at a time is the difference between using this for a
// chapter and using it for a page.
function scenesFrom(text) {
  const BLANK_LINE = new RegExp("\\n\\s*\\n");   // a blank line separates scenes
  return String(text)
    .split(BLANK_LINE)
    .map((scene) => scene.replace(/\s+/g, " ").trim())
    .filter((scene) => scene.length > 3)
    .slice(0, 24);
}

async function buildFromScript(text) {
  const scenes = scenesFrom(text);
  if (!scenes.length) { toast("Nothing to build: paste a scene or two"); return 0; }
  const button = document.getElementById("script-build");
  button.disabled = true;
  try {
    for (let i = 0; i < scenes.length; i += 1) {
      setBusy(`Scene ${i + 1} of ${scenes.length}`);
      await sendChat(scenes[i], true);
    }
    toast(`Built ${scenes.length} pages from the script`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(null);
    button.disabled = false;
  }
  return scenes.length;
}

document.getElementById("script-build").onclick = () =>
  buildFromScript(document.getElementById("script-text").value);

document.getElementById("more-pages").onclick = () => {
  const count = parseInt(document.getElementById("more-count").value, 10) || 1;
  generateMorePages(Math.min(Math.max(count, 1), 12));
};
document.getElementById("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); }
});

// ------------------------------------------------------------------ init --
document.getElementById("project-title").textContent = doc.name;
document.title = `${doc.name} — prod-imagen studio`;
document.querySelectorAll(".dock-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".dock-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".dock-page").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.dock-page[data-page="${tab.dataset.page}"]`).classList.add("active");
  });
});
document.getElementById("relayout").onclick = relayoutPage;

// ------------------------------------------------------------- menu bar --
// The window is frameless, so the OS menu bar never shows; this is the
// in-app equivalent. The native Menu still supplies the accelerators.
const MENU_ACTIONS = {
  "new-project": () => window.studio.newProjectWindow(),
  "open-project": () => window.studio.openProjectFile(),
  save: () => document.getElementById("save").click(),
  "save-then-close": async () => {
    const done = await document.getElementById("save").onclick();
    // a cancelled save dialog must not close the window
    if (done && window.studio.closeNow) window.studio.closeNow();
  },
  "save-as": () => { savePath = null; document.getElementById("save").click(); },
  export: () => document.getElementById("export").click(),
  undo, redo, relayout: relayoutPage,
  duplicate: duplicateSelected,
  delete: deleteSelected,
  group: groupSelected,
  ungroup: ungroupSelected,
  "flip-x": () => flipSelected("x"),
  "flip-y": () => flipSelected("y"),
  "select-all": () => { selectedIds = currentPage().layers.map((l) => l.id); syncSelection(); },
  "zoom-in": () => setZoom(zoom * 1.2),
  "zoom-out": () => setZoom(zoom / 1.2),
  "zoom-fit": fitPage,
  "zoom-selection": zoomToSelection,
  "paste-in-place": () => pasteClipboard(true),
  theme: () => document.getElementById("theme-toggle").click(),
  rulers: toggleRulers,
  "clear-guides": clearGuides,
  settings: () => document.getElementById("settings-btn").click(),
  "page-next": () => goToPage(pageIndex + 1),
  "page-prev": () => goToPage(pageIndex - 1),
  "page-add": () => addPage(false),
  "page-dupe": () => addPage(true),
  "export-all": () => document.getElementById("export-all").click(),
  "export-pdf": () => document.getElementById("export-pdf").click(),
  "analyze-story": () => document.getElementById("story-analyze").click(),
};

const MENUS = [
  ["File", [
    ["New Project...", "new-project", "Ctrl+N"],
    ["Open Project...", "open-project", "Ctrl+O"],
    ["-"],
    ["Save", "save", "Ctrl+S"],
    ["Save As...", "save-as", "Ctrl+Shift+S"],
    ["Export Page as PNG...", "export", "Ctrl+E"],
    ["Export All Pages as PNG...", "export-all"],
    ["Export Chapter as PDF...", "export-pdf"],
  ]],
  ["Edit", [
    ["Undo", "undo", "Ctrl+Z"],
    ["Redo", "redo", "Ctrl+Y"],
    ["-"],
    ["Duplicate", "duplicate", "Ctrl+D"],
    ["Paste in Place", "paste-in-place", "Ctrl+Shift+V"],
    ["Select All", "select-all", "Ctrl+A"],
    ["Delete", "delete", "Del"],
    ["-"],
    ["Group", "group", "Ctrl+G"],
    ["Ungroup", "ungroup", "Ctrl+Shift+G"],
    ["-"],
    ["Flip Horizontal", "flip-x"],
    ["Flip Vertical", "flip-y"],
  ]],
  ["View", [
    ["Zoom In", "zoom-in", "Ctrl+="],
    ["Zoom Out", "zoom-out", "Ctrl+-"],
    ["Fit Page", "zoom-fit", "Ctrl+0"],
    ["Zoom to Selection", "zoom-selection", "Ctrl+2"],
    ["-"],
    ["Toggle Light / Dark", "theme"],
    ["-"],
    ["Rulers", "rulers", "Ctrl+R"],
    ["Clear Guides", "clear-guides"],
    ["Settings...", "settings"],
  ]],
  ["Page", [
    ["Previous Page", "page-prev", "Ctrl+Left"],
    ["Next Page", "page-next", "Ctrl+Right"],
    ["Add Page", "page-add"],
    ["Duplicate Page", "page-dupe"],
    ["-"],
    ["Re-flow Panels", "relayout"],
    ["Analyze Story", "analyze-story"],
  ]],
];

(() => {
  const bar = document.getElementById("menubar");
  const drop = document.createElement("div");
  drop.className = "menu-drop";
  document.body.appendChild(drop);
  let openIndex = null;

  const close = () => {
    drop.classList.remove("show");
    bar.querySelectorAll(".menu-top").forEach((t) => t.classList.remove("open"));
    openIndex = null;
  };
  const open = (index, button) => {
    const [, items] = MENUS[index];
    drop.innerHTML = items.map(([label, action, accel]) => label === "-"
      ? '<div class="menu-sep"></div>'
      : `<div class="menu-item" data-action="${action}">${label}` +
        `${accel ? `<span class="accel">${accel}</span>` : ""}</div>`).join("");
    const rect = button.getBoundingClientRect();
    drop.style.left = rect.left + "px";
    drop.style.top = rect.bottom + 4 + "px";
    drop.classList.add("show");
    bar.querySelectorAll(".menu-top").forEach((t, i) => t.classList.toggle("open", i === index));
    openIndex = index;
    drop.querySelectorAll(".menu-item").forEach((item) => {
      item.addEventListener("click", () => {
        close();
        const run = MENU_ACTIONS[item.dataset.action];
        if (run) run();
      });
    });
  };

  MENUS.forEach(([label], index) => {
    const button = document.createElement("div");
    button.className = "menu-top";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openIndex === index) close();
      else open(index, button);
    });
    // once a menu is open, hovering the bar switches menus
    button.addEventListener("mouseenter", () => {
      if (openIndex !== null && openIndex !== index) open(index, button);
    });
    bar.appendChild(button);
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
})();

if (window.studio && window.studio.onMenu) window.studio.onMenu((action) => {
  const run = MENU_ACTIONS[action];
  if (run) run();
});
document.getElementById("no-engine-settings").onclick = () => {
  document.getElementById("no-engine").classList.remove("show");
  document.getElementById("settings-btn").click();
};
document.getElementById("no-engine-dismiss").onclick = () =>
  document.getElementById("no-engine").classList.remove("show");

setupRulerDragging();
drawGuides();
fitPage();
renderCanvas();
renderStory();
renderStylePanel();
setPageBackground(doc.style.pageBg);
loadEngines();
pollHealth();
commit("Opened");
savedSnapshot = snapshotDoc();
markDirtyState();
