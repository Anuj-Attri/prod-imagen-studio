/* prod-imagen studio — editor core (v0.3)
   Model: document -> pages -> layers. The layers list is the source of
   truth; the Konva canvas renders it. All lettering is vector text.
   v0.3: brush + eraser, shapes, image import + crop, multi-select,
   marquee, snap guides, align/distribute, undo/redo, clipboard,
   opacity + blend modes, image adjustments. */

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
doc.chat = doc.chat || [];
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
function currentPage() { return doc.pages[pageIndex]; }
function findLayer(id) { return currentPage().layers.find((l) => l.id === id); }
function primaryLayer() { return selectedIds.length === 1 ? findLayer(selectedIds[0]) : null; }
function selectedLayers() { return selectedIds.map(findLayer).filter(Boolean); }

// -------------------------------------------------------------- history --
let history = [];
let historyIndex = -1;
function snapshotDoc() {
  return JSON.stringify(doc, (key, value) => (key === "chat" ? undefined : value));
}
function commit() {
  const snap = snapshotDoc();
  if (history[historyIndex] === snap) return; // no-op change
  history = history.slice(0, historyIndex + 1);
  history.push(snap);
  if (history.length > 80) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
}
function restore(json) {
  const chat = doc.chat;
  doc = JSON.parse(json);
  doc.chat = chat;
  if (pageIndex >= doc.pages.length) pageIndex = doc.pages.length - 1;
  selectedIds = selectedIds.filter((id) => currentPage().layers.some((l) => l.id === id));
  renderCanvas();
  renderStory();
  updateHistoryButtons();
}
function undo() { if (historyIndex > 0) { historyIndex -= 1; restore(history[historyIndex]); } }
function redo() { if (historyIndex < history.length - 1) { historyIndex += 1; restore(history[historyIndex]); } }
function updateHistoryButtons() {
  document.getElementById("undo").disabled = historyIndex <= 0;
  document.getElementById("redo").disabled = historyIndex >= history.length - 1;
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
  ["rect", "Rectangle", "R"],
  ["ellipse", "Ellipse", "O"],
  ["line", "Line", "L"],
  ["arrow", "Arrow", "A"],
  ["star", "Star", "W"],
];
const SHAPE_TOOLS = ["rect", "ellipse", "star"];
const STROKE_TOOLS = ["line", "arrow"];
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
const guides = new Konva.Group({ listening: false });
world.add(guides);

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
      fill: layer.props.fill, stroke: layer.props.stroke,
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
    node = new Konva.Label(common);
    node.add(new Konva.Tag({
      fill: layer.props.bg || "#fff", stroke: "#111", strokeWidth: 2.5, cornerRadius: 18,
      pointerDirection: "down", pointerWidth: 22, pointerHeight: 26,
    }));
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontStyle: "600",
      fontSize: layer.props.fontSize, fill: layer.props.color || "#111", padding: 13,
      width: layer.w, align: "center", wrap: "word", name: "label-text",
    }));
  } else if (layer.type === "caption") {
    node = new Konva.Group(common);
    const text = new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer), fontSize: layer.props.fontSize,
      fill: layer.props.color || "#111", padding: 9, width: layer.w, name: "label-text",
      align: layer.props.align || "left",
    });
    node.add(new Konva.Rect({
      width: layer.w, height: text.height(), name: "frame",
      fill: layer.props.bg || "#fdf6de", stroke: "#111", strokeWidth: 2,
    }));
    node.add(text);
  } else if (layer.type === "text") {
    node = new Konva.Group(common);
    node.add(new Konva.Text({
      text: layer.props.text, fontFamily: fontOf(layer),
      fontStyle: layer.props.style || "700",
      fontSize: layer.props.fontSize, fill: layer.props.fill, width: layer.w,
      align: layer.props.align || "left", name: "label-text",
    }));
  } else if (layer.type === "sfx") {
    node = new Konva.Group(common);
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
      width: layer.w, height: layer.h, name: "shape",
      fill: layer.props.fill, stroke: layer.props.stroke || "#111",
      strokeWidth: layer.props.strokeWidth != null ? layer.props.strokeWidth : 2,
      cornerRadius: layer.props.radius || 0,
    }));
  }
  node.opacity((layer.props.opacity != null ? layer.props.opacity : 100) / 100);
  if (layer.props.blend && layer.props.blend !== "normal") {
    node.globalCompositeOperation(layer.props.blend);
  }

  let dragSiblings = null; // id -> start position, for group drags
  node.on("dragstart", () => {
    if (!selectedIds.includes(layer.id)) select(layer.id);
    dragSiblings = {};
    selectedIds.forEach((id) => {
      const other = nodes.get(id);
      if (other) dragSiblings[id] = { x: other.x(), y: other.y(), self: other === node };
    });
  });
  node.on("dragmove", () => {
    if (dragSiblings && selectedIds.length > 1) {
      const start = dragSiblings[layer.id];
      const dx = node.x() - start.x, dy = node.y() - start.y;
      selectedIds.forEach((id) => {
        if (id === layer.id) return;
        const other = nodes.get(id);
        const s = dragSiblings[id];
        if (other && s) other.position({ x: s.x + dx, y: s.y + dy });
      });
    } else {
      snapDrag(node);
    }
    pageLayer.batchDraw();
  });
  node.on("dragend", () => {
    guides.destroyChildren();
    dragSiblings = null;
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

function attachImage(group, layer) {
  const image = new window.Image();
  image.onload = () => {
    const old = group.findOne(".art");
    if (old) old.destroy();
    const art = new Konva.Image({
      image, width: layer.w, height: layer.h, name: "art", listening: false,
    });
    const c = layer.props.crop;
    if (c) {
      art.crop({
        x: c.x * image.naturalWidth, y: c.y * image.naturalHeight,
        width: c.w * image.naturalWidth, height: c.h * image.naturalHeight,
      });
    }
    group.add(art);
    const frame = group.findOne(".frame");
    if (frame) {
      frame.fillEnabled(false);
      frame.moveToTop();
      if (layer.type === "image") frame.visible(false);
    }
    const placeholder = group.findOne(".placeholder");
    if (placeholder) placeholder.visible(false);
    applyAdjust(group, layer);
    pageLayer.batchDraw();
  };
  image.src = layer.props.image;
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

// -------------------------------------------------------------- snapping --
function snapDrag(node) {
  guides.destroyChildren();
  const tol = 6 / zoom;
  const r = node.getClientRect({ relativeTo: world });
  const xs = [0, PAGE.w / 2, PAGE.w];
  const ys = [0, PAGE.h / 2, PAGE.h];
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
function pasteClipboard() {
  if (!clipboard.length) return;
  const fresh = clipboard.map((l) => {
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid();
    copy.x += 16;
    copy.y += 16;
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
    row.innerHTML =
      `<span class="glyph">${ICONS[layer.type] || ICONS.rect}</span>` +
      `<span class="name">${escapeHtml(layer.name)}</span>` +
      `<span class="mini vis ${layer.visible ? "" : "engaged"}" title="show or hide">${layer.visible ? "●" : "○"}</span>` +
      `<span class="mini lock ${layer.locked ? "engaged" : ""}" title="lock">${layer.locked ? "L" : "U"}</span>`;
    row.addEventListener("click", (event) => {
      if (event.target.classList.contains("vis")) { layer.visible = !layer.visible; renderCanvas(); commit(); return; }
      if (event.target.classList.contains("lock")) { layer.locked = !layer.locked; renderCanvas(); commit(); return; }
      select(layer.id, { toggle: event.shiftKey || event.ctrlKey });
    });
    row.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", layer.id));
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const draggedId = event.dataTransfer.getData("text/plain");
      if (!draggedId || draggedId === layer.id) return;
      const arr = currentPage().layers;
      const from = arr.findIndex((l) => l.id === draggedId);
      const to = arr.findIndex((l) => l.id === layer.id);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
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
    html += `<textarea data-k="prompt" placeholder="Describe this panel's art — subject, action, angle, style…">${escapeHtml(layer.props.prompt || "")}</textarea>`;
    html += propField("Seed", `<input data-k="seed" type="number" value="${layer.props.seed ?? ""}" placeholder="random">`);
    if (layer.props.engineUsed) html += `<div class="prop-note">last render: ${layer.props.engineUsed} · seed ${layer.props.seedUsed}</div>`;
  }
  if (["balloon", "caption", "text", "sfx"].includes(layer.type)) {
    html += `<textarea data-k="text">${escapeHtml(layer.props.text)}</textarea>`;
    const fontOptions = FONTS.map((f) =>
      `<option value="${f}" ${fontOf(layer) === f ? "selected" : ""}>${f}</option>`).join("");
    html += propField("Font", `<select data-k="font">${fontOptions}</select>`);
    html += propField("Text size", `<input data-k="fontSize" type="number" value="${layer.props.fontSize}">`);
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
  }
  if (ROTATABLE.includes(layer.type)) {
    html += propField("Rotation", `<input data-k="rot" type="number" value="${layer.props.rot || 0}">`);
  }
  if (["rect", "ellipse", "star"].includes(layer.type)) {
    html += propField("Fill", `<input data-k="fill" type="color" value="${layer.props.fill}">`);
    html += propField("Stroke", `<input data-k="stroke" type="color" value="${layer.props.stroke || "#111111"}">`);
    html += propField("Stroke px", `<input data-k="strokeWidth" type="number" value="${layer.props.strokeWidth != null ? layer.props.strokeWidth : 2}">`);
    if (layer.type === "rect") html += propField("Corner", `<input data-k="radius" type="number" value="${layer.props.radius || 0}">`);
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
      else if (["strokeWidth", "rot", "radius"].includes(key)) layer.props[key] = parseInt(input.value, 10) || 0;
      else layer.props[key] = input.value;
      renderCanvas();
      select(layer.id);
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
  document.querySelectorAll(".tool").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === name));
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
  if (spaceDown) { panStart = { ...pointer, wx: world.x(), wy: world.y() }; return; }
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
  if (panStart) { panStart = null; return; }
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
function placeImageFiles(files) {
  files.filter((f) => f.type.startsWith("image/")).forEach((file, index) => {
    const reader = new FileReader();
    reader.onload = () => {
      const probe = new window.Image();
      probe.onload = () => {
        const maxW = PAGE.w * 0.6, maxH = PAGE.h * 0.6;
        const scale = Math.min(maxW / probe.naturalWidth, maxH / probe.naturalHeight, 1);
        addLayer("image", {
          x: 80 + index * 24, y: 80 + index * 24,
          w: Math.round(probe.naturalWidth * scale),
          h: Math.round(probe.naturalHeight * scale),
        }, { image: reader.result });
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
    if (key === "c") { event.preventDefault(); copySelected(); return; }
    if (key === "x") { event.preventDefault(); copySelected(); deleteSelected(); return; }
    if (key === "v") { event.preventDefault(); pasteClipboard(); return; }
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
document.getElementById("page-add").onclick = () => {
  doc.pages.push({ id: uid(), name: `Page ${doc.pages.length + 1}`, layers: [] });
  pageIndex = doc.pages.length - 1;
  selectedIds = [];
  renderCanvas();
  commit();
};
document.getElementById("page-prev").onclick = () => {
  if (pageIndex > 0) { pageIndex -= 1; selectedIds = []; renderCanvas(); }
};
document.getElementById("page-next").onclick = () => {
  if (pageIndex < doc.pages.length - 1) { pageIndex += 1; selectedIds = []; renderCanvas(); }
};

// ------------------------------------------------------------ generation --
async function loadEngines() {
  const select_ = document.getElementById("engine");
  try {
    const response = await fetch(`${SERVER}/engines`);
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
}

document.getElementById("generate").onclick = async () => {
  const layer = primaryLayer();
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
    delete layer.props.crop;
    renderCanvas();
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
    commit();
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

async function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMsg("user", text);
  doc.chat.push({ role: "user", content: text });
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
      body: JSON.stringify({ messages: doc.chat.slice(-16), project: doc.name, kind: doc.kind, pages }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "agent unavailable");
    thinking.textContent = result.reply;
    doc.chat.push({ role: "assistant", content: result.reply });
  } catch (error) {
    thinking.textContent = "Agent offline: " + error.message;
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
  settingsModal.style.display = "none";
  toast("Saved. Engines refresh in a few seconds.");
  loadEngines();
};

doc.chat.forEach((m) => appendMsg(m.role === "user" ? "user" : "agent", m.content));
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
commit();
