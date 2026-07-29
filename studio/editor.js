/* prod-imagen studio — editor core (v0.2.1)
   Model: document -> pages -> layers. The layers list is the source of
   truth; the Konva canvas renders it. All lettering is vector text. */

const SERVER = "http://127.0.0.1:8787";

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

const PAGE_SIZES = {
  manga: { w: 900, h: 1273 }, anime: { w: 1024, h: 1024 },
  poster: { w: 900, h: 1200 }, diagram: { w: 1100, h: 800 }, free: { w: 1000, h: 1000 },
};
const PAGE = PAGE_SIZES[project.kind] || PAGE_SIZES.free;

let doc = project.document || {
  version: 1,
  name: project.name || "Untitled",
  mode: project.mode || "image",
  kind: project.kind || "free",
  pages: [{ id: uid(), name: "Page 1", layers: [] }],
  story: { chapter: "", overall: "", flags: [] },
};
let savePath = project._path || null;
let pageIndex = 0;
let selectedId = null;
let tool = "select";
let layerSeq = doc.pages.flatMap((p) => p.layers).length;

function uid() { return Math.random().toString(36).slice(2, 10); }
function currentPage() { return doc.pages[pageIndex]; }
function findLayer(id) { return currentPage().layers.find((l) => l.id === id); }

// ----------------------------------------------------------------- icons --
const ICONS = {
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3l7 16 2.2-6.4L21 10.4 6 3z"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M12 8.5v3m0 0v3m0-3h3m-3 0H9" stroke-linecap="round"/></svg>',
  balloon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5.5h16v10.5h-8.5L8 20v-4H4V5.5z"/></svg>',
  caption: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M7 10.5h10M7 13.5h6" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 6h14M12 6v13"/></svg>',
  rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="17" height="12" rx="1.5"/></svg>',
  sfx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18 5.2l-1.4 4.4L21 12l-4.4 2.4L18 18.8l-4.2-2.4L12 21l-1.8-4.6L6 18.8l1.4-4.4L3 12l4.4-2.4L6 5.2l4.2 2.4L12 3z"/></svg>',
};
const TOOL_DEFS = [
  ["select", "Select / move", "V"],
  ["panel", "AI panel frame", "P"],
  ["balloon", "Speech balloon", "B"],
  ["caption", "Caption box", "C"],
  ["text", "Title text", "T"],
  ["sfx", "Onomatopoeia / SFX", "S"],
  ["rect", "Shape", "R"],
];
const toolRail = document.getElementById("tools");
TOOL_DEFS.forEach(([id, label, key]) => {
  const el = document.createElement("div");
  el.className = "tool" + (id === "select" ? " active" : "");
  el.dataset.tool = id;
  el.innerHTML = ICONS[id] + `<span class="tip">${label} · ${key}</span>`;
  el.addEventListener("click", () => setTool(id));
  toolRail.appendChild(el);
});

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

const PAGE_X = 0, PAGE_Y = 0;
const pageRect = new Konva.Rect({
  x: 0, y: 0, width: PAGE.w, height: PAGE.h,
  fill: "#ffffff", stroke: "#c9c9d2", strokeWidth: 1,
  shadowColor: "#000", shadowBlur: 30, shadowOpacity: 0.45, listening: false,
});
world.add(pageRect);
pageRect.moveToBottom();

const transformer = new Konva.Transformer({
  rotateEnabled: false, anchorSize: 8, borderStroke: "#5b8def",
  anchorStroke: "#5b8def", anchorFill: "#141417", ignoreStroke: true,
});
world.add(transformer);

const nodes = new Map(); // layerId -> Konva node

const FONTS = [
  "Segoe UI", "Arial Black", "Impact", "Bahnschrift", "Comic Sans MS",
  "Georgia", "Trebuchet MS", "Courier New", "Yu Gothic UI", "Verdana",
];
const FONT_DEFAULTS = { balloon: "Segoe UI", caption: "Georgia", text: "Segoe UI", sfx: "Impact" };
function fontOf(layer) { return layer.props.font || FONT_DEFAULTS[layer.type] || "Segoe UI"; }

// ------------------------------------------------------------- pan/zoom --
let zoom = 1;
function applyView() {
  world.scale({ x: zoom, y: zoom });
  document.getElementById("zoom-pct").textContent = Math.round(zoom * 100) + "%";
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
function buildNode(layer) {
  const common = {
    x: layer.x, y: layer.y,
    draggable: !layer.locked, visible: layer.visible, name: layer.type, id: layer.id,
  };
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
  } else if (layer.type === "balloon") {
    node = new Konva.Label(common);
    node.add(new Konva.Tag({
      fill: "#fff", stroke: "#111", strokeWidth: 2.5, cornerRadius: 18,
      pointerDirection: "down", pointerWidth: 22, pointerHeight: 26,
    }));
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontStyle: "600",
      fontSize: layer.props.fontSize, fill: "#111", padding: 13,
      width: layer.w, align: "center", wrap: "word", name: "label-text",
    }));
  } else if (layer.type === "caption") {
    node = new Konva.Group(common);
    const text = new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontSize: layer.props.fontSize,
      fill: "#111", padding: 9, width: layer.w, name: "label-text",
    });
    node.add(new Konva.Rect({
      width: layer.w, height: text.height(), name: "frame",
      fill: "#fdf6de", stroke: "#111", strokeWidth: 2,
    }));
    node.add(text);
  } else if (layer.type === "text") {
    node = new Konva.Group(common);
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontStyle: "700",
      fontSize: layer.props.fontSize, fill: layer.props.fill, width: layer.w,
      name: "label-text",
    }));
  } else if (layer.type === "sfx") {
    node = new Konva.Group({ ...common, rotation: layer.props.rot || 0 });
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontStyle: "900",
      fontSize: layer.props.fontSize, fill: layer.props.fill,
      stroke: layer.props.stroke, strokeWidth: layer.props.strokeWidth,
      fillAfterStrokeEnabled: true, lineJoin: "round",
      name: "label-text",
    }));
  } else {
    node = new Konva.Group(common);
    node.add(new Konva.Rect({
      width: layer.w, height: layer.h, name: "frame",
      fill: layer.props.fill, stroke: "#111", strokeWidth: 2,
    }));
  }
  node.on("dragend", () => {
    const model = findLayer(layer.id);
    model.x = Math.round(node.x());
    model.y = Math.round(node.y());
  });
  node.on("click tap", (event) => { event.cancelBubble = true; select(layer.id); });
  node.on("dblclick dbltap", () => {
    const model = findLayer(layer.id);
    if (["balloon", "caption", "text", "sfx"].includes(model.type)) editTextInline(node, model);
  });
  return node;
}

function attachImage(group, layer) {
  const image = new window.Image();
  image.onload = () => {
    const old = group.findOne(".art");
    if (old) old.destroy();
    const art = new Konva.Image({
      image, width: layer.w, height: layer.h, name: "art", listening: false,
    });
    group.add(art);
    const frame = group.findOne(".frame");
    frame.fillEnabled(false);
    frame.moveToTop();
    const placeholder = group.findOne(".placeholder");
    if (placeholder) placeholder.visible(false);
    pageLayer.batchDraw();
  };
  image.src = layer.props.image;
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
}

function syncSelection() {
  const node = selectedId ? nodes.get(selectedId) : null;
  const layer = selectedId ? findLayer(selectedId) : null;
  transformer.nodes(node && layer && !layer.locked ? [node] : []);
  transformer.rotateEnabled(Boolean(layer && layer.type === "sfx"));
  transformer.moveToTop();
  pageLayer.batchDraw();
  renderProps();
  renderLayerList();
  document.getElementById("generate").disabled = !(layer && layer.type === "panel");
}

function select(id) {
  selectedId = id;
  syncSelection();
  if (id) {
    document.querySelectorAll(".dock-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".dock-page").forEach((p) => p.classList.remove("active"));
    const target = findLayer(id).type === "panel" ? "props" : "layers";
    document.querySelector(`.dock-tab[data-page="${target}"]`).classList.add("active");
    document.querySelector(`.dock-page[data-page="${target}"]`).classList.add("active");
  }
}

stage.on("click tap", (event) => { if (event.target === stage || event.target === pageRect) select(null); });

transformer.on("transformend", () => {
  const node = transformer.nodes()[0];
  if (!node) return;
  const layer = findLayer(node.id());
  if (layer.type === "sfx") layer.props.rot = Math.round(node.rotation());
  const scaleX = node.scaleX(), scaleY = node.scaleY();
  node.scale({ x: 1, y: 1 });
  layer.w = Math.round(Math.max(24, layer.w * scaleX));
  layer.h = Math.round(Math.max(24, layer.h * scaleY));
  layer.x = Math.round(node.x());
  layer.y = Math.round(node.y());
  renderCanvas();
  select(layer.id);
});

// --------------------------------------------------------------- layers --
function addLayer(type, geometry) {
  layerSeq += 1;
  const defaults = {
    panel: { w: 380, h: 380, props: { prompt: "", seed: null, image: null } },
    balloon: { w: 210, h: 0, props: { text: "SPEECH HERE!", fontSize: 20 } },
    caption: { w: 300, h: 0, props: { text: "Narration caption.", fontSize: 16 } },
    text: { w: 340, h: 0, props: { text: "TITLE", fontSize: 44, fill: "#111111" } },
    rect: { w: 200, h: 120, props: { fill: "#e8e8ee" } },
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
    props: { ...defaults.props },
  };
  currentPage().layers.push(layer);
  renderCanvas();
  select(layer.id);
  return layer;
}

function deleteSelected() {
  if (!selectedId) return;
  const page = currentPage();
  page.layers = page.layers.filter((l) => l.id !== selectedId);
  selectedId = null;
  renderCanvas();
}

function renderLayerList() {
  const list = document.getElementById("layer-list");
  list.innerHTML = "";
  [...currentPage().layers].reverse().forEach((layer) => {
    const row = document.createElement("div");
    row.className = "layer-row" + (layer.id === selectedId ? " sel" : "");
    row.draggable = true;
    row.innerHTML =
      `<span class="glyph">${ICONS[layer.type] || ""}</span>` +
      `<span class="name">${escapeHtml(layer.name)}</span>` +
      `<span class="mini vis ${layer.visible ? "" : "engaged"}" title="show / hide">${layer.visible ? "👁" : "–"}</span>` +
      `<span class="mini lock ${layer.locked ? "engaged" : ""}" title="lock">${layer.locked ? "🔒" : "○"}</span>`;
    row.addEventListener("click", (event) => {
      if (event.target.classList.contains("vis")) { layer.visible = !layer.visible; renderCanvas(); return; }
      if (event.target.classList.contains("lock")) { layer.locked = !layer.locked; renderCanvas(); return; }
      select(layer.id);
    });
    row.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", layer.id));
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData("text/plain");
      if (!draggedId || draggedId === layer.id) return;
      const arr = currentPage().layers;
      const from = arr.findIndex((l) => l.id === draggedId);
      const to = arr.findIndex((l) => l.id === layer.id);
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      renderCanvas();
    });
    list.appendChild(row);
  });
}

// ----------------------------------------------------------- properties --
function propField(label, inputHtml) { return `<label>${label}</label>${inputHtml}`; }

function renderProps() {
  const body = document.getElementById("props-body");
  const layer = selectedId ? findLayer(selectedId) : null;
  if (!layer) {
    body.innerHTML = '<div class="dock-empty">Select an element to edit<br />its properties.</div>';
    return;
  }
  let html = '<div class="prop-grid">';
  html += propField("Name", `<input data-k="name" value="${escapeHtml(layer.name)}">`);
  html += propField("X / Y", `<input data-k="xy" value="${layer.x}, ${layer.y}">`);
  html += propField("W / H", `<input data-k="wh" value="${layer.w}, ${layer.h}">`);
  if (layer.type === "panel") {
    html += `<textarea data-k="prompt" placeholder="Describe this panel's art — subject, action, angle, style…">${escapeHtml(layer.props.prompt || "")}</textarea>`;
    html += propField("Seed", `<input data-k="seed" type="number" value="${layer.props.seed ?? ""}" placeholder="random">`);
    html += `<div class="prop-note">Art renders into this frame with the engine picked in the top bar. Lettering lives in balloons and captions — vector, always exact.</div>`;
    if (layer.props.engineUsed) html += `<div class="prop-note">last render: ${layer.props.engineUsed} · seed ${layer.props.seedUsed}</div>`;
  }
  if (["balloon", "caption", "text", "sfx"].includes(layer.type)) {
    html += `<textarea data-k="text">${escapeHtml(layer.props.text)}</textarea>`;
    const fontOptions = FONTS.map((f) =>
      `<option value="${f}" ${fontOf(layer) === f ? "selected" : ""}>${f}</option>`).join("");
    html += propField("Font", `<select data-k="font">${fontOptions}</select>`);
    html += propField("Text size", `<input data-k="fontSize" type="number" value="${layer.props.fontSize}">`);
  }
  if (["text", "sfx"].includes(layer.type)) html += propField("Color", `<input data-k="fill" value="${layer.props.fill}">`);
  if (layer.type === "sfx") {
    html += propField("Outline", `<input data-k="stroke" value="${layer.props.stroke}">`);
    html += propField("Outline px", `<input data-k="strokeWidth" type="number" value="${layer.props.strokeWidth}">`);
    html += propField("Rotation", `<input data-k="rot" type="number" value="${layer.props.rot || 0}">`);
    html += `<div class="prop-note">Onomatopoeia: rotate with the corner handle; the outline keeps it readable over any art.</div>`;
  }
  if (layer.type === "rect") html += propField("Fill", `<input data-k="fill" value="${layer.props.fill}">`);
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
      else if (key === "font") layer.props.font = input.value;
      else if (key === "fill") layer.props.fill = input.value;
      else if (key === "stroke") layer.props.stroke = input.value;
      else if (key === "strokeWidth") layer.props.strokeWidth = parseInt(input.value, 10) || 0;
      else if (key === "rot") layer.props.rot = parseInt(input.value, 10) || 0;
      renderCanvas();
      select(layer.id);
    });
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
  const commit = () => {
    layer.props.text = input.value;
    input.remove();
    renderCanvas();
    select(layer.id);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") input.remove();
  });
}

// ----------------------------------------------------------------- tools --
function setTool(name) {
  tool = name;
  document.querySelectorAll(".tool").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === name));
  stage.container().style.cursor = name === "select" ? "" : "crosshair";
}

let drawStart = null;
let ghost = null;
stage.on("mousedown", (event) => {
  const pointer = stage.getPointerPosition();
  if (spaceDown) { panStart = { ...pointer, wx: world.x(), wy: world.y() }; return; }
  if (tool === "select") return;
  if (event.target !== stage && event.target !== pageRect) return;
  drawStart = toWorld(pointer);
  if (["panel", "rect"].includes(tool)) {
    ghost = new Konva.Rect({
      x: drawStart.x, y: drawStart.y, width: 1, height: 1,
      stroke: "#5b8def", dash: [6, 4], strokeWidth: 1.5 / zoom,
      listening: false,
    });
    world.add(ghost);
  }
});
stage.on("mousemove", () => {
  const pointer = stage.getPointerPosition();
  if (panStart) {
    world.position({ x: panStart.wx + pointer.x - panStart.x, y: panStart.wy + pointer.y - panStart.y });
    applyView();
    return;
  }
  if (!ghost || !drawStart) return;
  const world_ = toWorld(pointer);
  ghost.width(world_.x - drawStart.x);
  ghost.height(world_.y - drawStart.y);
  pageLayer.batchDraw();
});
stage.on("mouseup", () => {
  if (panStart) { panStart = null; return; }
  if (!drawStart) return;
  const world_ = toWorld(stage.getPointerPosition());
  const geometry = {
    x: Math.round(Math.min(drawStart.x, world_.x)),
    y: Math.round(Math.min(drawStart.y, world_.y)),
    w: Math.round(Math.abs(world_.x - drawStart.x)),
    h: Math.round(Math.abs(world_.y - drawStart.y)),
  };
  if (ghost) { ghost.destroy(); ghost = null; pageLayer.batchDraw(); }
  if (["panel", "rect"].includes(tool)) {
    if (geometry.w > 30 && geometry.h > 30) addLayer(tool, geometry);
  } else if (["balloon", "caption", "text", "sfx"].includes(tool)) {
    addLayer(tool, { x: geometry.x, y: geometry.y });
  }
  drawStart = null;
  setTool("select");
});

document.addEventListener("keydown", (event) => {
  if (["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)) return;
  const map = { v: "select", p: "panel", b: "balloon", c: "caption", t: "text", s: "sfx", r: "rect" };
  if (map[event.key.toLowerCase()]) setTool(map[event.key.toLowerCase()]);
  if (event.key === "Delete") deleteSelected();
});

// ----------------------------------------------------------------- pages --
function renderPageLabel() {
  document.getElementById("page-label").textContent = `Page ${pageIndex + 1}/${doc.pages.length}`;
}
document.getElementById("page-add").onclick = () => {
  doc.pages.push({ id: uid(), name: `Page ${doc.pages.length + 1}`, layers: [] });
  pageIndex = doc.pages.length - 1;
  selectedId = null;
  renderCanvas();
};
document.getElementById("page-prev").onclick = () => {
  if (pageIndex > 0) { pageIndex -= 1; selectedId = null; renderCanvas(); }
};
document.getElementById("page-next").onclick = () => {
  if (pageIndex < doc.pages.length - 1) { pageIndex += 1; selectedId = null; renderCanvas(); }
};

// ------------------------------------------------------------ generation --
async function loadEngines() {
  const select = document.getElementById("engine");
  try {
    const response = await fetch(`${SERVER}/engines`);
    const { engines } = await response.json();
    select.innerHTML = "";
    engines.forEach((engine) => {
      const option = document.createElement("option");
      option.value = engine.id;
      option.textContent = engine.label + (engine.available ? "" : " — needs key");
      option.disabled = !engine.available;
      select.appendChild(option);
    });
  } catch {
    select.innerHTML = "<option>server offline</option>";
  }
}

document.getElementById("generate").onclick = async () => {
  const layer = findLayer(selectedId);
  if (!layer || layer.type !== "panel") return;
  if (!layer.props.prompt || !layer.props.prompt.trim()) {
    toast("Write a prompt in Properties first");
    return;
  }
  const engine = document.getElementById("engine").value;
  const button = document.getElementById("generate");
  button.disabled = true;
  button.textContent = "Generating…";
  try {
    const response = await fetch(`${SERVER}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine, prompt: layer.props.prompt, seed: layer.props.seed,
        width: 1024, height: 1024, no_text: true,
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "generation failed");
    layer.props.image = "data:image/png;base64," + result.image_base64;
    layer.props.engineUsed = result.engine;
    layer.props.seedUsed = result.seed;
    renderCanvas();
    select(layer.id);
    toast(`${layer.name} · ${result.engine} · ${(result.latency_ms / 1000).toFixed(1)}s`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Generate";
  }
};

// ----------------------------------------------------------------- story --
document.getElementById("story-analyze").onclick = async () => {
  const button = document.getElementById("story-analyze");
  button.disabled = true;
  button.textContent = "Analyzing…";
  try {
    const pages = doc.pages.map((page, index) => ({
      index: index + 1,
      panels: page.layers.filter((l) => l.type === "panel").map((l) => l.props.prompt || ""),
      dialogue: page.layers.filter((l) => ["balloon", "caption", "text"].includes(l.type))
        .map((l) => l.props.text || ""),
    }));
    const response = await fetch(`${SERVER}/story/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: doc.name, kind: doc.kind, pages, previous: doc.story }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "story engine failed");
    doc.story = { chapter: result.chapter, overall: result.overall, flags: result.flags };
    renderStory();
  } catch (error) {
    toast(error.message, true);
  } finally {
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
    if (!savePath) return;
  }
  const payload = { ...project, name: doc.name, document: doc };
  delete payload._path;
  await window.studio.writeFile(savePath, JSON.stringify(payload));
  toast("Saved");
};

document.getElementById("export").onclick = async () => {
  transformer.nodes([]);
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
  const saved = await window.studio.exportPngDialog(`${doc.name}-p${pageIndex + 1}.png`, dataUrl);
  if (saved) toast("Exported " + saved);
};

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
    const response = await fetch(`${SERVER}/health`);
    const health = await response.json();
    setEngineDot("eng-local", health.local);
    setEngineDot("eng-pod", health.pod);
    setEngineDot("eng-api", health.apis);
    setEngineDot("eng-story", health.story);
  } catch {
    ["eng-local", "eng-pod", "eng-api", "eng-story"].forEach((id) => setEngineDot(id, false));
  }
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

const chatHistory = [];
async function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMsg("user", text);
  chatHistory.push({ role: "user", content: text });
  const thinking = appendMsg("agent", "…");
  try {
    const pages = doc.pages.map((page, index) => ({
      index: index + 1,
      panels: page.layers.filter((l) => l.type === "panel").map((l) => l.props.prompt || ""),
      dialogue: page.layers.filter((l) => ["balloon", "caption", "text", "sfx"].includes(l.type))
        .map((l) => l.props.text || ""),
    }));
    const response = await fetch(`${SERVER}/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.slice(-16), project: doc.name, kind: doc.kind, pages }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "agent unavailable");
    thinking.textContent = result.reply;
    chatHistory.push({ role: "assistant", content: result.reply });
  } catch (error) {
    thinking.textContent = "Yoru is offline: " + error.message;
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
document.getElementById("chat-send").onclick = sendChat;
document.getElementById("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); }
});

// ------------------------------------------------------------------ init --
document.getElementById("project-title").textContent = doc.name;
document.getElementById("project-kind").textContent = `${doc.kind} project`;
document.title = `${doc.name} — prod-imagen studio`;
document.querySelectorAll(".dock-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".dock-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".dock-page").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.dock-page[data-page="${tab.dataset.page}"]`).classList.add("active");
  });
});
fitPage();
renderCanvas();
renderStory();
loadEngines();
pollHealth();
