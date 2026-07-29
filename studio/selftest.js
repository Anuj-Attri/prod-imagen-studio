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
function check(name, fn) {
  try {
    const value = fn();
    window.__results.push([name, value === true ? "pass" : "FAIL(" + value + ")"]);
  } catch (error) {
    window.__results.push([name, "THREW " + error.message]);
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

document.title = "SELFTEST " + JSON.stringify(window.__results);
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
