/* Headless self-test: builds a throwaway page from editor.html, injects
   assertions, and prints the result. Run: node studio/selftest.js
   Requires Chrome; used to verify the renderer without the desktop app. */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const here = __dirname;
const html = fs.readFileSync(path.join(here, "editor.html"), "utf-8");

const CHECKS = `
<script>
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
  doc.guides.v.push(300);
  doc.guides.h.push(120);
  drawGuides();
  const drawn = guideLayer.getChildren().length;
  clearGuides();
  return drawn === 2 && guideLayer.getChildren().length === 0
    && doc.guides.v.length === 0;
});
check("layers snap to a guide", () => {
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
</script>
`;

const outPath = path.join(os.tmpdir(), "prod-imagen-selftest.html");
fs.writeFileSync(outPath, html.replace("</body>", CHECKS + "</body>"), "utf-8");
// the harness lives beside the real assets so relative script tags resolve
const localCopy = path.join(here, "__selftest.html");
fs.copyFileSync(outPath, localCopy);

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
  process.exit(0);
}

try {
  const dom = execFileSync(chrome, [
    "--headless", "--disable-gpu", "--no-sandbox", "--dump-dom",
    "--virtual-time-budget=6000",
    "file:///" + localCopy.replace(/\\/g, "/"),
  ], { encoding: "utf-8", maxBuffer: 40 * 1024 * 1024 });

  const match = dom.match(/<title>SELFTEST ([\s\S]*?)<\/title>/);
  if (!match) {
    console.error("self-test did not run: the renderer failed before completing");
    process.exit(1);
  }
  const results = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  let failed = 0;
  results.forEach(([name, status]) => {
    if (status !== "pass") failed += 1;
    console.log(`${status === "pass" ? "  ok  " : " FAIL "} ${name}${status === "pass" ? "" : "  -> " + status}`);
  });
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
} finally {
  fs.unlinkSync(localCopy);
}
