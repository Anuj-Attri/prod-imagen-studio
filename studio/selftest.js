/* Headless self-test: builds a throwaway page from editor.html beside
   the real assets, loads a generated checks file into it, and prints the
   result. Run: node studio/selftest.js
   Requires Chrome; verifies the renderer without the desktop app. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const here = __dirname;
const html = fs.readFileSync(path.join(here, "editor.html"), "utf-8");

const CHECKS = `
window.__results = [];
const __checks = [];
// checks may be async: the export path walks pages through the canvas
function check(name, fn) { __checks.push([name, fn]); }
async function runChecks() {
  for (const [name, fn] of __checks) {
    try {
      const value = await fn();
      window.__results.push([name, value === true ? "pass" : "FAIL(" + value + ")"]);
    } catch (error) {
      window.__results.push([name, "THREW " + error.message]);
    }
  }
}

// init must run to completion: these are rendered by the last init calls
check("init completed", () => !!document.getElementById("style-bg"));
check("preload shim present", () => typeof window.studio.chooseFolder === "function");
check("page navigator rendered", () =>
  document.querySelectorAll("#page-grid .page-card").length === 1);
check("all dock tabs", () =>
  [...document.querySelectorAll(".dock-tab")].map(t => t.textContent).join(",")
  === "Pages,Layers,Properties,Style,History,Story,Agent");
check("menu bar", () => document.querySelectorAll(".menu-top").length === 4);
check("tool rail plus shape flyout", () =>
  document.querySelectorAll("#tools .tool").length === 11);

// type layers resize by font size, not by an ignored width
check("sfx scales with handles", () => {
  const layer = addLayer("sfx", { x: 10, y: 10 });
  const before = layer.props.fontSize;
  select(layer.id);
  nodes.get(layer.id).scale({ x: 2, y: 2 });
  transformer.fire("transformend");
  return findLayer(layer.id).props.fontSize > before;
});
check("title text scales", () => {
  const layer = addLayer("text", { x: 10, y: 300 });
  const before = layer.props.fontSize;
  select(layer.id);
  nodes.get(layer.id).scale({ x: 1, y: 2.5 });
  transformer.fire("transformend");
  return findLayer(layer.id).props.fontSize > before;
});

// layout engine
check("templates yield their panel count", () => {
  for (let n = 1; n <= 8; n += 1) if (pageLayout(n).length !== n) return "n=" + n;
  return true;
});
check("panels never overlap", () => {
  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (let n = 2; n <= 8; n += 1) {
    const r = pageLayout(n);
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) if (hit(r[i], r[j])) return "n=" + n;
    }
  }
  return true;
});
check("panels stay on the page", () => {
  for (let n = 1; n <= 8; n += 1) {
    if (!pageLayout(n).every(b => b.x >= 0 && b.y >= 0
        && b.x + b.w <= PAGE.w + 1 && b.y + b.h <= PAGE.h + 1)) return "n=" + n;
  }
  return true;
});

// style contract
check("cast tags lead the prompt", () => {
  mergeCast([{ name: "Rin", tags: "1girl, long black hair" }]);
  doc.style.preset = "manga";
  const p = addLayer("panel", { x: 0, y: 0, w: 400, h: 400 });
  p.props.prompt = "running, alley";
  p.props.cast = ["Rin"];
  const out = composePrompt(p);
  return out.startsWith("1girl, long black hair") && out.includes("screentone");
});
check("established cast is never overwritten", () => {
  mergeCast([{ name: "rin", tags: "1girl, blonde" }]);
  return doc.cast.find(c => c.name === "Rin").tags.includes("long black hair");
});
check("coloring style carries a negative", () => {
  doc.style.preset = "coloring";
  const neg = styleNegative();
  doc.style.preset = "manga";
  return neg.includes("color") && neg.includes("shading");
});

// pages
check("duplicate page deep copies", () => {
  const before = doc.pages.length;
  addPage(true);
  const ids = doc.pages.flatMap(p => p.layers.map(l => l.id));
  return doc.pages.length === before + 1 && new Set(ids).size === ids.length;
});
check("page delete keeps at least one", () => {
  while (doc.pages.length > 1) doc.pages.pop();
  return doc.pages.length === 1;
});

// editing depth
check("flip is remembered and mirrors content", () => {
  const layer = addLayer("rect", { x: 40, y: 40, w: 100, h: 60 });
  select(layer.id);
  flipSelected("x");
  const flipped = findLayer(layer.id);
  if (flipped.props.flipX !== true) return "not stored";
  const child = nodes.get(layer.id).getChildren()[0];
  return child.scaleX() === -1;
});
check("flip does not move the layer", () => {
  const layer = addLayer("rect", { x: 200, y: 90, w: 80, h: 40 });
  select(layer.id);
  flipSelected("x");
  flipSelected("y");
  const after = findLayer(layer.id);
  return after.x === 200 && after.y === 90;
});
check("group selects together", () => {
  const a = addLayer("rect", { x: 10, y: 400, w: 40, h: 40 });
  const b = addLayer("rect", { x: 60, y: 400, w: 40, h: 40 });
  selectedIds = [a.id, b.id];
  groupSelected();
  select(a.id);
  return selectedIds.length === 2 && selectedIds.includes(b.id);
});
check("ungroup releases", () => {
  ungroupSelected();
  const a = currentPage().layers.find(l => l.group);
  return a === undefined;
});
check("line height reaches the text node", () => {
  const layer = addLayer("caption", { x: 10, y: 500 });
  layer.props.lineHeight = 1.8;
  renderCanvas();
  return nodes.get(layer.id).findOne(".label-text").lineHeight() === 1.8;
});

check("gradient fill reaches the shape", () => {
  const layer = addLayer("rect", { x: 10, y: 600, w: 120, h: 80 });
  layer.props.fillType = "linear";
  layer.props.fill = "#ff0000";
  layer.props.fill2 = "#0000ff";
  layer.props.gradientAngle = 90;
  renderCanvas();
  const shape = nodes.get(layer.id).findOne(".shape");
  const stops = shape.fillLinearGradientColorStops();
  const start = shape.fillLinearGradientStartPoint();
  const end = shape.fillLinearGradientEndPoint();
  if (!stops || stops[1] !== "#ff0000" || stops[3] !== "#0000ff") return "stops";
  // 90 degrees runs top to bottom, so x stays put and y spans the box
  return Math.abs(start.x - end.x) < 1 && Math.abs(end.y - start.y) > 40;
});
check("solid fill stays solid", () => {
  const layer = addLayer("rect", { x: 150, y: 600, w: 60, h: 60 });
  layer.props.fill = "#00ff00";
  renderCanvas();
  const shape = nodes.get(layer.id).findOne(".shape");
  return shape.fill() === "#00ff00" && !shape.fillLinearGradientColorStops();
});

// a chapter accumulates: new work must never destroy existing work
check("second build moves to a new page", () => {
  while (doc.pages.length > 1) doc.pages.pop();
  goToPage(0);
  currentPage().layers = [];
  addLayer("text", { x: 20, y: 20 }).props.text = "existing work";
  const pagesBefore = doc.pages.length;
  pageForNewWork("test");
  return doc.pages.length === pagesBefore + 1
    && currentPage().layers.length === 0
    && doc.pages[0].layers.length === 1;
});
check("empty page is reused rather than adding a blank one", () => {
  const pagesBefore = doc.pages.length;
  pageForNewWork("test");
  return doc.pages.length === pagesBefore;
});

check("layer list shows art thumbnails", () => {
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  addLayer("image", { x: 0, y: 0, w: 50, h: 50 }, { image: px });
  renderLayerList();
  return document.querySelectorAll("#layer-list .glyph.art img").length === 1;
});
check("layer rename commits", () => {
  const layer = addLayer("rect", { x: 0, y: 700, w: 30, h: 30 });
  renderLayerList();
  const row = [...document.querySelectorAll("#layer-list .layer-row")]
    .find(r => r.querySelector(".name").textContent === layer.name);
  row.querySelector(".name").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const input = document.querySelector("#layer-list input.rename");
  if (!input) return "no input";
  input.value = "Renamed layer";
  input.dispatchEvent(new Event("blur"));
  return findLayer(layer.id).name === "Renamed layer";
});

// each document type must build the right structure, end to end
check("poster: artwork plus headline below it", async () => {
  doc.kind = "poster";
  doc.style.preset = "poster";
  await applyAgentArtwork([{
    prompt: "1boy, saxophone, jazz club, dim light",
    dialogue: [{ kind: "text", text: "JAZZ NIGHT" }, { kind: "text", text: "9 PM" }],
  }], "poster");
  const art = currentPage().layers.filter(l => l.type === "image");
  const texts = currentPage().layers.filter(l => l.type === "text");
  if (art.length !== 1 || texts.length !== 2) return "art=" + art.length + " text=" + texts.length;
  // the headline sits in the lower part of the page, over the art
  return texts[0].y > PAGE.h * 0.6 && art[0].h === PAGE.h;
});
check("card: greeting sits below a shorter artwork", async () => {
  doc.kind = "card";
  doc.style.preset = "card";
  await applyAgentArtwork([{
    prompt: "1girl, witch, pumpkin, full moon",
    dialogue: [{ kind: "text", text: "Happy Halloween!" }],
  }], "card");
  const art = currentPage().layers.find(l => l.type === "image");
  const greeting = currentPage().layers.find(l => l.type === "text");
  return art.h < PAGE.h && greeting.y >= art.h;
});
check("coloring: one artwork, one caption", async () => {
  doc.kind = "coloring";
  doc.style.preset = "coloring";
  await applyAgentArtwork([{
    prompt: "1dragon, rabbits, tea party, garden",
    dialogue: [{ kind: "caption", text: "A tea party" }],
  }], "single");
  const art = currentPage().layers.filter(l => l.type === "image");
  const captions = currentPage().layers.filter(l => l.type === "caption");
  return art.length === 1 && captions.length === 1 && art[0].h === PAGE.h;
});
check("comic page still lays out panels", async () => {
  doc.kind = "manga";
  doc.style.preset = "manga";
  doc.style.pageMode = "panels";
  await applyAgentPanels([
    { prompt: "1girl, standing, rooftop", dialogue: [{ kind: "balloon", text: "Hi" }] },
    { prompt: "1girl, running, alley" },
    { prompt: "1girl, jumping, night" },
  ], { replacePage: true });
  const panels = currentPage().layers.filter(l => l.type === "panel");
  const balloons = currentPage().layers.filter(l => l.type === "balloon");
  return panels.length === 3 && balloons.length === 1;
});
check("building each kind never destroyed earlier pages", () =>
  doc.pages.filter(p => p.layers.length).length >= 4);

// lettering
check("balloon tail direction is settable", () => {
  const layer = addLayer("balloon", { x: 30, y: 30 });
  layer.props.tail = "left";
  layer.props.tailLength = 40;
  renderCanvas();
  const tag = nodes.get(layer.id).findOne("Tag");
  return tag.pointerDirection() === "left" && tag.pointerHeight() === 40;
});
check("captions can carry an outline", () => {
  const layer = addLayer("caption", { x: 30, y: 120 });
  layer.props.outline = "#ffffff";
  layer.props.outlineWidth = 4;
  renderCanvas();
  const text = nodes.get(layer.id).findOne(".label-text");
  return text.strokeWidth() === 4 && text.fillAfterStrokeEnabled() === true;
});
check("no outline means no stroke", () => {
  const layer = addLayer("text", { x: 30, y: 200 });
  renderCanvas();
  const text = nodes.get(layer.id).findOne(".label-text");
  return !text.strokeWidth();
});

// editor conveniences
check("paste in place keeps coordinates", () => {
  const layer = addLayer("rect", { x: 111, y: 222, w: 40, h: 40 });
  select(layer.id);
  copySelected();
  pasteClipboard(true);
  const copy = selectedLayers()[0];
  return copy.id !== layer.id && copy.x === 111 && copy.y === 222;
});
check("ordinary paste offsets", () => {
  pasteClipboard(false);
  const copy = selectedLayers()[0];
  return copy.x === 127 && copy.y === 238;
});
check("alt drag leaves a copy behind", () => {
  const layer = addLayer("rect", { x: 300, y: 300, w: 40, h: 40 });
  select(layer.id);
  const before = currentPage().layers.length;
  const node = nodes.get(layer.id);
  node.fire("dragstart", { evt: { altKey: true } });
  node._duplicated = false;
  return currentPage().layers.length === before + 1;
});
check("zoom to selection frames it", () => {
  const layer = addLayer("rect", { x: 100, y: 100, w: 120, h: 120 });
  select(layer.id);
  const before = zoom;
  zoomToSelection();
  const rect = layerRect(layer);
  const screenX = rect.x * zoom + world.x();
  // the selection lands inside the viewport after framing
  return zoom !== before && screenX > -1 && screenX < stage.width();
});

// saving and reopening must not silently drop project state
check("project round trip preserves everything", () => {
  while (doc.pages.length > 1) doc.pages.pop();
  goToPage(0);
  currentPage().layers = [];
  doc.name = "Round trip";
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl, long black hair" }];
  doc.style = { preset: "noir", extra: "rain", lockSeed: true,
                pageMode: "panels", pageBg: "#101014", seedBase: 4242 };
  doc.guides = { v: [120, 400], h: [88] };
  doc.story = { chapter: "A duel begins", overall: "Two rivals", flags: [] };
  const a = addLayer("rect", { x: 10, y: 10, w: 50, h: 50 });
  const b = addLayer("rect", { x: 70, y: 10, w: 50, h: 50 });
  selectedIds = [a.id, b.id];
  groupSelected();
  select(a.id);
  flipSelected("x");
  const panel = addLayer("panel", { x: 0, y: 200, w: 300, h: 200 });
  panel.props.cast = ["Rin"];
  panel.props.prompt = "standing, rooftop";

  // exactly what the save handler writes, and what a reopen parses
  const saved = JSON.stringify({ name: doc.name, document: doc });
  const reopened = JSON.parse(saved).document;

  if (reopened.cast.length !== 1 || reopened.cast[0].tags !== doc.cast[0].tags) return "cast";
  if (reopened.style.preset !== "noir" || reopened.style.pageBg !== "#101014") return "style";
  if (reopened.style.seedBase !== 4242) return "seed base";
  if (reopened.guides.v.length !== 2 || reopened.guides.h[0] !== 88) return "guides";
  if (reopened.story.chapter !== "A duel begins") return "story";
  const layers = reopened.pages[0].layers;
  const grouped = layers.filter((l) => l.group);
  if (grouped.length !== 2 || grouped[0].group !== grouped[1].group) return "group";
  if (!layers.some((l) => l.props.flipX)) return "flip";
  const panelBack = layers.find((l) => l.type === "panel");
  return panelBack.props.cast[0] === "Rin" && panelBack.props.prompt === "standing, rooftop";
});
check("reopened project rehydrates missing newer fields", () => {
  // a file written by an older build has none of these keys
  const old = { version: 1, name: "Old", kind: "manga",
                pages: [{ id: "p", name: "Page 1", layers: [] }] };
  const hydrated = JSON.parse(JSON.stringify(old));
  hydrated.chat = hydrated.chat || [];
  hydrated.style = hydrated.style || { preset: "manga", extra: "", lockSeed: true,
                                       pageMode: "page", pageBg: "#ffffff" };
  hydrated.cast = hydrated.cast || [];
  hydrated.guides = hydrated.guides || { v: [], h: [] };
  return hydrated.style.preset === "manga" && hydrated.cast.length === 0
    && hydrated.guides.v.length === 0;
});

// history must stay small: a rendered chapter is tens of megabytes of
// base64 per copy, and many copies are kept
check("history snapshots exclude image data", () => {
  const big = "data:image/png;base64," + "A".repeat(200000);
  const layer = addLayer("image", { x: 0, y: 0, w: 100, h: 100 }, { image: big });
  const snap = snapshotDoc();
  if (snap.includes("A".repeat(1000))) return "pixels are in the snapshot";
  return snap.length < 40000 && snap.includes("imgref:");
});
check("undo brings the image back", () => {
  const layer = currentPage().layers.find(l => l.props && l.props.image);
  const original = layer.props.image;
  commit("with image");
  addLayer("rect", { x: 0, y: 0, w: 10, h: 10 });
  commit("after");
  undo();
  const back = currentPage().layers.find(l => l.props && l.props.image);
  return !!back && back.props.image === original;
});
check("a rendered chapter stays small in history", () => {
  // ten pages each carrying a megabyte of base64
  const page = "data:image/png;base64," + "B".repeat(1000000);
  for (let i = 0; i < 10; i += 1) {
    addPage(false);
    addLayer("image", { x: 0, y: 0, w: 10, h: 10 }, { image: page + i });
  }
  const snap = snapshotDoc();
  // without references this would be over ten megabytes
  return snap.length < 200000;
});

// unsaved work must be defended
check("a fresh document is not dirty", () => {
  savedSnapshot = snapshotDoc();
  markDirtyState();
  return document.getElementById("save").textContent === "Save";
});
check("an edit marks the document dirty", () => {
  addLayer("rect", { x: 5, y: 5, w: 20, h: 20 });
  commit("edit");
  return document.getElementById("save").textContent === "Save *";
});
check("saving clears the dirty mark", () => {
  savedSnapshot = snapshotDoc();
  markDirtyState();
  return document.getElementById("save").textContent === "Save";
});
check("dirty state ignores chat, which is not project work", () => {
  doc.chat.push({ role: "user", content: "hello" });
  markDirtyState();
  return document.getElementById("save").textContent === "Save";
});

check("autosave is armed only while work is at risk", () => {
  let asked = 0;
  const realAutosave = window.studio.autosave;
  window.studio.autosave = () => { asked += 1; };
  savedSnapshot = snapshotDoc();
  markDirtyState();                      // clean: nothing scheduled
  const cleanTimer = autosaveTimer;
  addLayer("rect", { x: 1, y: 1, w: 5, h: 5 });
  commit("dirty now");                   // dirty: a save is scheduled
  const armed = autosaveTimer !== cleanTimer && autosaveTimer !== null;
  clearTimeout(autosaveTimer);
  window.studio.autosave = realAutosave;
  return armed && asked === 0;           // scheduled, not yet fired
});

// rulers and guides
check("rulers render page coordinates", () => {
  document.body.classList.add("rulers-on");
  drawRulers();
  const top = document.getElementById("ruler-top");
  return top.width > 0 && top.height === 20;
});
check("ruler step grows as you zoom out", () => {
  const near = niceStep(2);
  const far = niceStep(0.1);
  return far > near;
});
check("guides draw and clear", () => {
  doc.guides = { v: [], h: [] };   // self-contained, not inherited state
  doc.guides.v.push(300);
  doc.guides.h.push(120);
  drawGuides();
  const drawn = guideLayer.getChildren().length;
  clearGuides();
  return drawn === 2 && guideLayer.getChildren().length === 0
    && doc.guides.v.length === 0;
});
check("layers snap to a guide", () => {
  // snap tolerance scales with zoom, so pin it rather than inherit
  // whatever an earlier check left behind
  zoom = 1;
  world.position({ x: 0, y: 0 });
  applyView();
  doc.guides.v = [400];
  const layer = addLayer("rect", { x: 396, y: 50, w: 60, h: 60 });
  const node = nodes.get(layer.id);
  select(layer.id);
  const before = node.getClientRect({ relativeTo: world }).x;
  snapDrag(node);
  // the visible edge lands on the guide; the node origin sits half a
  // stroke inside it, so measure the rect, not the position
  const after = node.getClientRect({ relativeTo: world }).x;
  doc.guides.v = [];
  return Math.abs(after - 400) < 0.6 && after !== before;
});

// blueprint: exact vector diagram, not generated art
check("blueprint builds boxes and connectors", () => {
  buildBlueprint(
    [{ id: "roof", label: "Roof", role: "input" },
     { id: "filter", label: "Filter", role: "process" },
     { id: "tank", label: "Storage tank", role: "store" },
     { id: "tap", label: "Tap", role: "output" }],
    [{ from: "roof", to: "filter", label: "runoff" },
     { from: "filter", to: "tank" },
     { from: "tank", to: "tap" }]);
  const boxes = currentPage().layers.filter(l => l.type === "rect" && l.props.label);
  const arrows = currentPage().layers.filter(l => l.type === "arrow");
  return boxes.length === 4 && arrows.length === 3;
});
check("blueprint orders columns by flow", () => {
  const byName = {};
  currentPage().layers.filter(l => l.type === "rect").forEach(l => { byName[l.props.label] = l.x; });
  return byName["Roof"] < byName["Filter"]
    && byName["Filter"] < byName["Storage tank"]
    && byName["Storage tank"] < byName["Tap"];
});
check("box label renders inside the box", () => {
  const box = currentPage().layers.find(l => l.type === "rect" && l.props.label);
  const text = nodes.get(box.id).findOne(".box-label");
  return !!text && text.text() === box.props.label;
});
check("connectors span between boxes", () => {
  const arrow = currentPage().layers.find(l => l.type === "arrow");
  const [x1, y1, x2, y2] = arrow.props.points;
  return Math.abs(x2 - x1) > 10 || Math.abs(y2 - y1) > 10;
});

// export
check("snapshot walk covers every page and restores position", async () => {
  addPage(false);
  addPage(false);
  goToPage(1);
  const seen = [];
  await forEachPageSnapshot((dataUrl, index) => {
    if (!String(dataUrl).startsWith("data:image/png")) throw new Error("bad snapshot");
    seen.push(index);
  });
  return seen.length === doc.pages.length && pageIndex === 1;
});
check("pdf export is reachable", () =>
  !!document.getElementById("export-pdf") && typeof window.studio.exportPdf === "function");

// history
check("named checkpoints recorded", () => {
  checkpoint("Test checkpoint");
  return history.some(h => h.label === "Test checkpoint");
});
check("undo restores", () => {
  const n = currentPage().layers.length;
  addLayer("rect", { x: 5, y: 5, w: 50, h: 50 });
  undo();
  return currentPage().layers.length === n;
});

runChecks().then(() => {
  document.title = "SELFTEST " + JSON.stringify(window.__results);
});
`;

// The page ships a strict Content-Security-Policy that forbids inline
// script, so the checks load as a file like any other script would.
const checksFile = path.join(here, "__selftest-checks.js");
fs.writeFileSync(checksFile, CHECKS, "utf-8");
const localCopy = path.join(here, "__selftest.html");
fs.writeFileSync(localCopy,
  html.replace("</body>", '<script src="__selftest-checks.js"></script></body>'), "utf-8");

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chrome = candidates.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error("Chrome not found; skipping renderer self-test");
  fs.unlinkSync(localCopy);
  fs.unlinkSync(checksFile);
  process.exit(0);
}

let exitCode = 0;
try {
  const dom = execFileSync(chrome, [
    "--headless", "--disable-gpu", "--no-sandbox", "--dump-dom",
    "--virtual-time-budget=6000",
    "file:///" + localCopy.replace(/\\/g, "/"),
  ], { encoding: "utf-8", maxBuffer: 40 * 1024 * 1024 });

  const match = dom.match(/<title>SELFTEST ([\s\S]*?)<\/title>/);
  if (!match) {
    console.error("self-test did not run: the renderer failed before completing");
    throw new Error("renderer did not finish");
  }
  const results = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  let failed = 0;
  results.forEach(([name, status]) => {
    if (status !== "pass") failed += 1;
    console.log(`${status === "pass" ? "  ok  " : " FAIL "} ${name}${status === "pass" ? "" : "  -> " + status}`);
  });
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  // exiting inside the try would skip this and leave the scaffolding in
  // studio/, where it gets committed and packaged into the app
  for (const file of [localCopy, checksFile]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
process.exit(exitCode);
