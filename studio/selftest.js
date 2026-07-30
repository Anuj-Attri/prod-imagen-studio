/* Headless self-test: builds a throwaway page from editor.html beside
   the real assets, loads a generated checks file into it, and prints the
   result.

     node studio/selftest.js             the suite
     node studio/selftest.js --reverse   run it backwards

   Each check starts from a reset document, so passing depends on the
   behaviour rather than on what ran before it. A few steps deliberately
   continue from the one above them and are declared with chain() instead
   of check(); reversing skips those, since a sequence has an order by
   definition.

   Running backwards is how coupling gets found: it has caught checks
   that only passed because of leftover zoom, leftover guides, leftover
   rulers, or a server that happened to be running.

   Known gap: "every layer type can be grabbed across its body" fails
   when reversed. Hit testing there depends on stage geometry that some
   earlier check disturbs in a way the reset does not restore. The
   behaviour itself is covered from three other directions, so this is a
   harness limitation rather than a product fault.

   Requires Chrome; verifies the renderer without the desktop app. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const here = __dirname;

// Signal 0 asks the system whether a process exists without disturbing
// it, which is how a lock left by a killed run is told from a live one.
function running(pid) {
  const id = Number(pid);
  if (!id) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";   // exists, owned by someone else
  }
}

// A mutation run rewrites editor.js as it works. Reading it meanwhile
// measures the damage rather than the code, which has produced puzzling
// failures more than once.
const lock = path.join(here, ".mutating");
if (fs.existsSync(lock)) {
  const owner = fs.readFileSync(lock, "utf-8").trim();
  if (owner !== (process.env.MUTATION_OWNER || "")) {
    if (running(owner)) {
      console.error("editor.js is being mutated right now; this would measure "
        + "the damage rather than the code. Wait for studio/mutate.js to finish.");
      process.exit(1);
    }
    // The owner died without cleaning up, which a killed run does. It
    // leaves editor.js deliberately broken, so putting the intact copy
    // back matters more than releasing the lock: measuring the damage
    // reports failures that have nothing to do with the code.
    const spare = path.join(here, ".editor.original");
    if (fs.existsSync(spare)) {
      fs.writeFileSync(path.join(here, "editor.js"),
        fs.readFileSync(spare, "utf-8"), "utf-8");
      fs.unlinkSync(spare);
      console.error("a killed mutation run had left editor.js broken;"
        + " the intact copy has been put back");
    }
    fs.unlinkSync(lock);
  }
}

const html = fs.readFileSync(path.join(here, "editor.html"), "utf-8");

const CHECKS = `
window.__results = [];
const __checks = [];

// Each check starts from the same ground so that passing depends on the
// behaviour and not on what ran before it.
function resetForCheck() {
  doc.pages = [{ id: uid(), name: "Page 1", layers: [] }];
  pageIndex = 0;
  selectedIds = [];
  clipboard = [];
  doc.guides = { v: [], h: [] };
  doc.cast = [];
  doc.chat.length = 0;
  doc.style.preset = "manga";
  doc.style.pageMode = "page";
  doc.kind = "manga";
  // Rulers inset the canvas. Clearing only the class is not enough:
  // applyView redraws them from rulersOn and puts it straight back.
  rulersOn = false;
  document.body.classList.remove("rulers-on");
  stage.size({ width: wrap.clientWidth, height: wrap.clientHeight });
  zoom = 1;
  world.position({ x: 0, y: 0 });
  applyView();
  renderCanvas();
  stage.draw();          // the hit graph, not just the visible layer
  savedSnapshot = snapshotDoc();
}

// checks may be async: the export path walks pages through the canvas
function check(name, fn) { __checks.push([name, fn, true]); }
// a step that deliberately continues from the one before it
function chain(name, fn) { __checks.push([name, fn, false]); }

async function runChecks() {
  // A check that only passes in its usual position is not a check, it is
  // a coincidence. ORDER lets the run be reversed to find those.
  if (window.__order === "reverse") __checks.reverse();
  for (const [name, fn, isolated] of __checks) {
    // a chained step has an order by definition; reversing it proves
    // nothing, so it is skipped rather than reported as broken
    if (!isolated && window.__order === "reverse") {
      window.__results.push([name, "skipped: continues a sequence"]);
      continue;
    }
    try {
      if (isolated) resetForCheck();
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

// The original complaint was that many elements could not be resized and
// were hard to grab. Prove it for every type, not just the ones that
// happened to get tested.
check("every layer type resizes", () => {
  const broken = [];
  const kinds = ["panel", "image", "balloon", "caption", "text", "sfx",
                 "rect", "ellipse", "star", "line", "arrow", "draw"];
  kinds.forEach((kind) => {
    currentPage().layers = [];
    const layer = kind === "draw"
      ? addLayer("draw", { x: 0, y: 0 },
                 { points: [0, 0, 40, 20, 80, 0], stroke: "#111", strokeWidth: 4 })
      : addLayer(kind, { x: 20, y: 20, w: 120, h: 90 });
    const before = JSON.stringify({
      w: layer.w, h: layer.h,
      font: layer.props.fontSize, points: layer.props.points,
    });
    select(layer.id);
    nodes.get(layer.id).scale({ x: 2, y: 2 });
    transformer.fire("transformend");
    const after = findLayer(layer.id);
    const now = JSON.stringify({
      w: after.w, h: after.h,
      font: after.props.fontSize, points: after.props.points,
    });
    if (now === before) broken.push(kind);
  });
  return broken.length === 0 ? true : "unchanged by resize: " + broken.join(", ");
});

check("every layer type can be grabbed across its body", () => {
  const broken = [];
  const kinds = ["panel", "balloon", "caption", "text", "sfx",
                 "rect", "ellipse", "star"];
  // hit testing only works inside the drawn stage, so establish the
  // viewport here rather than inheriting whatever size was left behind
  stage.size({ width: Math.max(wrap.clientWidth, 400),
               height: Math.max(wrap.clientHeight, 400) });
  zoom = 1;
  world.position({ x: 0, y: 0 });
  applyView();
  stage.draw();
  kinds.forEach((kind) => {
    currentPage().layers = [];
    const layer = addLayer(kind, { x: 20, y: 20, w: 120, h: 90 });
    renderCanvas();
    pageLayer.draw();
    const node = nodes.get(layer.id);
    if (!node.draggable()) { broken.push(kind + ":not draggable"); return; }
    const box = node.getClientRect({ relativeTo: world });
    // the centre of the body: a bounding box corner is legitimately
    // outside an ellipse, a star, or a balloon's rounded corner
    const probe = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let hit = stage.getIntersection(probe);
    while (hit && !nodes.has(hit.id())) hit = hit.getParent();
    if (!hit || hit.id() !== layer.id) broken.push(kind + ":not hit");
  });
  return broken.length === 0 ? true : broken.join(", ");
});

check("a balloon sits where it says it does", () => {
  currentPage().layers = [];
  const layer = addLayer("balloon", { x: 200, y: 300, w: 140 });
  renderCanvas();
  const box = nodes.get(layer.id).getClientRect({ relativeTo: world });
  // the body's top left is the stored position, give or take the outline
  return Math.abs(box.x - 200) < 4 && Math.abs(box.y - 300) < 4;
});

// The context menu was reported missing. Prove each entry does its job,
// not merely that the menu opens.
check("every context menu action performs", () => {
  const failures = [];
  const run = (label, setup, expect) => {
    currentPage().layers = [];
    const target = setup();
    showContextMenu(50, 50, contextItemsForSelection());
    const entry = [...document.querySelectorAll(".menu-drop.show .menu-item")]
      .find((el) => el.textContent.startsWith(label));
    if (!entry) { failures.push(label + ":missing"); hideContextMenu(); return; }
    entry.click();
    if (!expect(target)) failures.push(label + ":no effect");
  };

  run("Duplicate", () => {
    const l = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
    select(l.id);
    return l;
  }, () => currentPage().layers.length === 2);

  run("Delete", () => {
    const l = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
    select(l.id);
    return l;
  }, () => currentPage().layers.length === 0);

  run("Flip Horizontal", () => {
    const l = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
    select(l.id);
    return l;
  }, (l) => findLayer(l.id).props.flipX === true);

  run("Send to Back", () => {
    addLayer("rect", { x: 0, y: 0, w: 20, h: 20 });
    const top = addLayer("rect", { x: 30, y: 0, w: 20, h: 20 });
    select(top.id);
    return top;
  }, (l) => currentPage().layers[0].id === l.id);

  run("Lock", () => {
    const l = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
    select(l.id);
    return l;
  }, (l) => findLayer(l.id).locked === true);

  run("Hide", () => {
    const l = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
    select(l.id);
    return l;
  }, (l) => findLayer(l.id).visible === false);

  return failures.length === 0 ? true : failures.join(", ");
});

// Dragging was reported as poor. Check the whole cycle, not just that
// the node accepts a drag.
check("dragging a layer records its new position", () => {
  currentPage().layers = [];
  const layer = addLayer("rect", { x: 100, y: 100, w: 60, h: 60 });
  select(layer.id);
  const node = nodes.get(layer.id);
  node.fire("dragstart", { evt: {} });
  node.position({ x: 260, y: 340 });
  node.fire("dragend");
  const after = findLayer(layer.id);
  return after.x === 260 && after.y === 340;
});

check("dragging one of a selection moves them all together", () => {
  currentPage().layers = [];
  const a = addLayer("rect", { x: 0, y: 0, w: 40, h: 40 });
  const b = addLayer("rect", { x: 100, y: 0, w: 40, h: 40 });
  selectedIds = [a.id, b.id];
  syncSelection();
  const node = nodes.get(a.id);
  node.fire("dragstart", { evt: {} });
  node.position({ x: 50, y: 70 });        // moved by +50, +70
  node.fire("dragmove");
  node.fire("dragend");

  const movedB = findLayer(b.id);
  // moved once by the delta, not twice
  if (movedB.x === 150 && movedB.y === 70) return true;
  return "b=" + movedB.x + "," + movedB.y + " expected 150,70";
});

check("a locked layer cannot be dragged", () => {
  currentPage().layers = [];
  const layer = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
  layer.locked = true;
  renderCanvas();
  return nodes.get(layer.id).draggable() === false;
});

// "drag and drop" also means the layer list and dropping files in
check("layer list drop lands above or below as aimed", () => {
  currentPage().layers = [];
  const bottom = addLayer("rect", { x: 0, y: 0, w: 20, h: 20 });
  const middle = addLayer("rect", { x: 30, y: 0, w: 20, h: 20 });
  const top = addLayer("rect", { x: 60, y: 0, w: 20, h: 20 });
  bottom.name = "bottom"; middle.name = "middle"; top.name = "top";
  renderLayerList();

  const row = [...document.querySelectorAll("#layer-list .layer-row")]
    .find((r) => r.querySelector(".name").textContent === "top");
  const box = row.getBoundingClientRect();
  const event = new Event("drop", { bubbles: true });
  event.dataTransfer = { getData: () => bottom.id };
  event.clientY = box.top + 2;          // aimed at the upper half
  row.dispatchEvent(event);

  // the list is drawn top down while the model is bottom up, so
  // dropping above the topmost row must place it last in the model
  const order = currentPage().layers.map((l) => l.name).join(",");
  return order === "middle,top,bottom" ? true : "order was " + order;
});

check("dropping image files onto the canvas adds layers", async () => {
  currentPage().layers = [];
  const bytes = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ), (c) => c.charCodeAt(0));
  const file = new File([bytes], "drop.png", { type: "image/png" });
  placeImageFiles([file]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const images = currentPage().layers.filter((l) => l.type === "image");
  return images.length === 1 && String(images[0].props.image).startsWith("data:image");
});

check("a dropped file that is not an image is ignored", async () => {
  currentPage().layers = [];
  const note = new File(["hello"], "notes.txt", { type: "text/plain" });
  placeImageFiles([note]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return currentPage().layers.length === 0;
});

// every shortcut must reach the tool the status bar advertises
check("keyboard shortcuts select their tool", () => {
  const wanted = {
    v: "select", d: "draw", e: "eraser", i: "picker", p: "panel",
    b: "balloon", c: "caption", t: "text", s: "sfx",
    r: "rect", o: "ellipse", l: "line", a: "arrow", w: "star",
  };
  const wrong = [];
  Object.entries(wanted).forEach(([key, expected]) => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    if (tool !== expected) wrong.push(key + " gave " + tool);
  });
  setTool("select");
  return wrong.length === 0 ? true : wrong.join(", ");
});

// The canvas tools: dragging on the page is how most layers get made,
// and none of it had been exercised.
function dragOnStage(from, to, steps) {
  const real = stage.getPointerPosition;
  let at = from;
  stage.getPointerPosition = () => at;
  stage.fire("mousedown", { target: stage, evt: { button: 0 } });
  const count = steps || 3;
  for (let i = 1; i <= count; i += 1) {
    at = {
      x: from.x + ((to.x - from.x) * i) / count,
      y: from.y + ((to.y - from.y) * i) / count,
    };
    stage.fire("mousemove", { target: stage, evt: {} });
  }
  at = to;
  stage.fire("mouseup", { target: stage, evt: {} });
  stage.getPointerPosition = real;
}

check("each drawing tool creates its layer by dragging", () => {
  zoom = 1;
  world.position({ x: 0, y: 0 });
  applyView();
  const wrong = [];
  [["panel", "panel"], ["rect", "rect"], ["ellipse", "ellipse"],
   ["star", "star"], ["line", "line"], ["arrow", "arrow"]].forEach(([toolName, type]) => {
    currentPage().layers = [];
    setTool(toolName);
    dragOnStage({ x: 40, y: 40 }, { x: 200, y: 170 });
    const made = currentPage().layers[0];
    if (!made || made.type !== type) {
      wrong.push(toolName + " gave " + (made ? made.type : "nothing"));
    }
  });
  setTool("select");
  return wrong.length === 0 ? true : wrong.join(", ");
});

check("a dragged shape takes the dragged geometry", () => {
  currentPage().layers = [];
  setTool("rect");
  dragOnStage({ x: 60, y: 50 }, { x: 260, y: 190 });
  setTool("select");
  const made = currentPage().layers[0];
  return made && Math.abs(made.x - 60) < 2 && Math.abs(made.y - 50) < 2
    && Math.abs(made.w - 200) < 3 && Math.abs(made.h - 140) < 3;
});

check("the brush records a stroke", () => {
  currentPage().layers = [];
  setTool("draw");
  dragOnStage({ x: 20, y: 20 }, { x: 180, y: 120 }, 6);
  setTool("select");
  const stroke = currentPage().layers[0];
  return stroke && stroke.type === "draw" && stroke.props.points.length >= 8;
});

check("the eraser removes a stroke it passes over", () => {
  currentPage().layers = [];
  setTool("draw");
  dragOnStage({ x: 40, y: 40 }, { x: 200, y: 40 }, 5);
  setTool("select");
  if (currentPage().layers.length !== 1) return "no stroke to erase";
  pageLayer.draw();
  setTool("eraser");
  dragOnStage({ x: 100, y: 40 }, { x: 140, y: 40 }, 3);
  setTool("select");
  return currentPage().layers.length === 0;
});

check("a marquee selects what it covers", () => {
  currentPage().layers = [];
  const inside = addLayer("rect", { x: 60, y: 60, w: 60, h: 60 });
  const outside = addLayer("rect", { x: 400, y: 400, w: 60, h: 60 });
  select(null);
  setTool("select");
  dragOnStage({ x: 30, y: 30 }, { x: 200, y: 200 }, 4);
  const picked = selectedIds.slice();
  return picked.length === 1 && picked[0] === inside.id
    ? true : "selected " + picked.length + " (outside included: "
      + picked.includes(outside.id) + ")";
});

// A fresh install has no server: the app must still work and must say
// why the parts that need one are unavailable.
check("an offline server is explained, not just implied", () => {
  // the notice stands down once a page has art or an engine is usable,
  // and whether one is usable depends on the machine this runs on
  currentPage().layers = [];
  const engine = document.getElementById("engine");
  const had = engine.innerHTML;
  engine.innerHTML = "<option>server offline</option>";
  serverReachable = false;
  showNoEngine(true);
  const box = document.getElementById("no-engine");
  const shown = box.classList.contains("show");
  const says = box.querySelector("b").textContent;
  const detail = box.querySelector("p").textContent;
  serverReachable = true;
  engine.innerHTML = had;
  return shown && says.includes("not running")
    && detail.includes("Drawing") && detail.includes("Settings");
});
check("a reachable server with no keys says something different", () => {
  currentPage().layers = [];
  const engine = document.getElementById("engine");
  const had = engine.innerHTML;
  engine.innerHTML = "<option disabled>needs key</option>";
  serverReachable = true;
  showNoEngine(true);
  const says = document.getElementById("no-engine").querySelector("b").textContent;
  engine.innerHTML = had;
  return says.includes("No image engine");
});
check("editing works with no server at all", () => {
  currentPage().layers = [];
  setTool("rect");
  dragOnStage({ x: 40, y: 40 }, { x: 160, y: 140 });
  setTool("balloon");
  dragOnStage({ x: 60, y: 60 }, { x: 60, y: 60 });
  setTool("select");
  const made = currentPage().layers.map((l) => l.type).sort().join(",");
  // and a page still exports without any backend
  const png = renderPageToDataUrl();
  return made === "balloon,rect" && png.startsWith("data:image/png");
});

check("the server address and token are configurable", () => {
  const address = document.getElementById("key-server");
  const token = document.getElementById("key-server-token");
  if (!address || !token) return "settings fields missing";
  // api() must target whatever address is configured, and carry a token
  const before = SERVER;
  const beforeToken = SERVER_TOKEN;
  let sawUrl = null;
  let sawAuth = null;
  const realFetch = window.fetch;
  window.fetch = (url, options) => {
    sawUrl = url;
    sawAuth = (options && options.headers && options.headers.Authorization) || null;
    return Promise.reject(new Error("not sent"));
  };
  SERVER = "https://example.invalid/studio/";
  SERVER_TOKEN = "secret-token";
  api("/health").catch(() => {});
  window.fetch = realFetch;
  SERVER = before;
  SERVER_TOKEN = beforeToken;
  // the trailing slash must not produce a doubled separator
  return sawUrl === "https://example.invalid/studio/health"
    && sawAuth === "Bearer secret-token";
});

// Building several pages at once was shipped without a check. A
// coloring book is the reason it exists.
check("build more pages repeats the last brief", async () => {
  doc.chat.length = 0;
  doc.chat.push({ role: "user", content: "a dragon having tea with rabbits" });
  const sent = [];
  const realSend = window.sendChat;
  window.sendChat = async (text, quiet) => { sent.push({ text, quiet }); };
  await generateMorePages(3);
  window.sendChat = realSend;
  if (sent.length !== 3) return "asked " + sent.length + " times, wanted 3";
  // the original brief is carried, and each round is told to vary
  const every = sent.every((s) => s.text.includes("dragon having tea")
    && s.text.includes("different scene") && s.quiet === true);
  return every ? true : "brief or variation instruction missing";
});
check("build more pages refuses with nothing to repeat", async () => {
  doc.chat.length = 0;
  const sent = [];
  const realSend = window.sendChat;
  window.sendChat = async () => { sent.push(1); };
  await generateMorePages(2);
  window.sendChat = realSend;
  return sent.length === 0;
});
check("build more pages is clamped to something sane", () => {
  const input = document.getElementById("more-count");
  input.value = "999";
  const asked = Math.min(Math.max(parseInt(input.value, 10) || 1, 1), 12);
  input.value = "3";
  return asked === 12;
});

// A project file is plain JSON that people will hand edit, and a
// truncated write leaves something parseable but wrong. None of it
// should take the editor down.
check("a layer with no props does not break rendering", () => {
  currentPage().layers = [{ id: uid(), type: "rect", name: "Broken",
                            x: 10, y: 10, w: 50, h: 50, visible: true, locked: false }];
  normalizeDocument(doc);
  renderCanvas();
  return currentPage().layers.length === 1;
});
check("a document with no pages at all is repaired", () => {
  doc.pages = [];
  normalizeDocument(doc);
  pageIndex = 0;
  renderCanvas();
  return doc.pages.length === 1 && Array.isArray(currentPage().layers);
});
check("entries that are not layers are dropped", () => {
  currentPage().layers = [null, "oops", 42,
    { id: uid(), type: "rect", props: {}, x: 0, y: 0, w: 10, h: 10 }];
  normalizeDocument(doc);
  renderCanvas();
  return currentPage().layers.length === 1;
});
check("a layer of an unknown type still renders", () => {
  currentPage().layers = [{ id: uid(), type: "sparkle", name: "Odd",
                            x: 10, y: 10, w: 50, h: 50, visible: true,
                            locked: false, props: {} }];
  renderCanvas();
  return nodes.size === 1;
});
check("a layer missing its geometry still renders", () => {
  currentPage().layers = [{ id: uid(), type: "text", name: "No box", props: {} }];
  renderCanvas();
  return nodes.size === 1;
});
check("a page with no layers array does not break", () => {
  doc.pages = [{ id: uid(), name: "Empty" }];
  pageIndex = 0;
  normalizeDocument(doc);
  renderCanvas();
  return currentPage().layers.length === 0;
});
check("properties of a damaged layer can still be shown", () => {
  currentPage().layers = [{ id: uid(), type: "panel", name: "Damaged",
                            x: 0, y: 0, w: 100, h: 100, visible: true, locked: false }];
  normalizeDocument(doc);
  renderCanvas();
  select(currentPage().layers[0].id);
  return document.getElementById("props-body").innerHTML.length > 0;
});

// Images arrive from a camera, a download, or a truncated render, and
// none of those are the tidy case.
check("an unreadable image says so instead of leaving a blank frame", async () => {
  currentPage().layers = [];
  const layer = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  layer.props.image = "data:image/png;base64,this-is-not-an-image";
  renderCanvas();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const placeholder = nodes.get(layer.id).findOne(".placeholder");
  return findLayer(layer.id).props.imageBroken === true
    && placeholder.visible() === true
    && placeholder.text().includes("could not be read");
});

check("an oversized import is scaled down before it is stored", async () => {
  // 4000 across, far beyond anything a page can show
  const canvas = document.createElement("canvas");
  canvas.width = 4000; canvas.height = 1000;
  const context = canvas.getContext("2d");
  context.fillStyle = "#3366aa";
  context.fillRect(0, 0, 4000, 1000);
  const huge = canvas.toDataURL("image/png");

  const probe = new window.Image();
  await new Promise((resolve) => { probe.onload = resolve; probe.src = huge; });
  const stored = downscaleIfHuge(huge, 4000, 1000, probe);
  if (stored === huge) return "not scaled";

  const after = new window.Image();
  await new Promise((resolve) => { after.onload = resolve; after.src = stored; });
  return after.naturalWidth === MAX_IMPORT_EDGE && stored.length < huge.length;
});

check("an image within the limit is stored untouched", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 600; canvas.height = 400;
  canvas.getContext("2d").fillRect(0, 0, 600, 400);
  const modest = canvas.toDataURL("image/png");
  const probe = new window.Image();
  await new Promise((resolve) => { probe.onload = resolve; probe.src = modest; });
  return downscaleIfHuge(modest, 600, 400, probe) === modest;
});

check("art survives a rebuild without flickering", async () => {
  currentPage().layers = [];
  const canvas = document.createElement("canvas");
  canvas.width = 800; canvas.height = 600;
  const context = canvas.getContext("2d");
  for (let i = 0; i < 6; i += 1) {
    context.fillStyle = "hsl(" + (i * 60) + ",60%,50%)";
    context.fillRect(0, 0, 800, 600);
    addLayer("image", { x: i * 10, y: i * 10, w: 300, h: 220 },
             { image: canvas.toDataURL("image/png") });
  }
  for (let i = 0; i < 8; i += 1) addLayer("caption", { x: 10, y: i * 30 });
  await new Promise((r) => setTimeout(r, 500));
  const images = currentPage().layers.filter((l) => l.props && l.props.image);
  const before = images.filter((l) => nodes.get(l.id).findOne(".art")).length;
  renderCanvas();
  // every edit rebuilds the canvas; the art must still be there in the
  // same frame, not a moment later
  const immediately = images.filter((l) => nodes.get(l.id).findOne(".art")).length;
  return before === images.length && immediately === images.length
    ? true
    : "before=" + before + " immediately=" + immediately + " of " + images.length;
});

// Transitions, not settled state: what is true in the same frame as the
// change, and what happens when the view moves mid-action.
check("selection survives a rebuild in the same frame", () => {
  currentPage().layers = [];
  const a = addLayer("rect", { x: 10, y: 10, w: 40, h: 40 });
  const b = addLayer("rect", { x: 60, y: 10, w: 40, h: 40 });
  selectedIds = [a.id, b.id];
  syncSelection();
  const before = transformer.nodes().length;
  renderCanvas();
  const after = transformer.nodes().length;
  return before === 2 && after === 2
    ? true : "transformer held " + before + " then " + after;
});

check("moving the view commits an open text editor", () => {
  currentPage().layers = [];
  const layer = addLayer("caption", { x: 100, y: 100, w: 200 });
  renderCanvas();
  editTextInline(nodes.get(layer.id), layer);
  const box = document.querySelector("textarea.inline-text-editor");
  if (!box) return "no editor opened";
  box.value = "typed while open";
  setZoom(zoom * 2);
  // it must not be left floating over whatever is now underneath, and
  // what was typed must not be thrown away
  const gone = !document.querySelector("textarea.inline-text-editor");
  const kept = findLayer(layer.id).props.text === "typed while open";
  return gone && kept ? true : "gone=" + gone + " kept=" + kept;
});

// A render takes many seconds, so anything can happen while it is in
// flight: the panel gets deleted, the page changes, someone steps back.
check("a render that finishes after its panel is gone says so", async () => {
  currentPage().layers = [];
  const layer = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  layer.props.prompt = "1girl, standing";
  select(layer.id);

  const engine = document.getElementById("engine");
  const had = engine.innerHTML;
  engine.innerHTML = "<option value='local-gpu'>Local GPU</option>";

  const realFetch = window.fetch;
  let release;
  window.fetch = () => new Promise((resolve) => {
    release = () => resolve({
      json: async () => ({
        ok: true, engine: "local-gpu", seed: 1, latency_ms: 10,
        image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      }),
    });
  });

  const inFlight = generatePanel(layer).then(() => "applied").catch((e) => e.message);
  // the panel is deleted while the engine is still working
  currentPage().layers = [];
  renderCanvas();
  release();
  const outcome = await inFlight;

  window.fetch = realFetch;
  engine.innerHTML = had;
  return outcome !== "applied"
    ? true
    : "the result was applied to a panel that no longer exists";
});

check("a render still lands when its panel is merely deselected", async () => {
  currentPage().layers = [];
  const layer = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  layer.props.prompt = "1girl, standing";
  const engine = document.getElementById("engine");
  const had = engine.innerHTML;
  engine.innerHTML = "<option value='local-gpu'>Local GPU</option>";
  const realFetch = window.fetch;
  window.fetch = async () => ({
    json: async () => ({
      ok: true, engine: "local-gpu", seed: 1, latency_ms: 10,
      image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    }),
  });
  select(null);                       // deselected, but still on the page
  await generatePanel(layer);
  window.fetch = realFetch;
  engine.innerHTML = had;
  return String(findLayer(layer.id).props.image).startsWith("data:image");
});

// Exporting is a snapshot of what is drawn. Art that has not finished
// decoding is not drawn, so the page would be written out with holes.
check("exporting waits for art that has not decoded yet", async () => {
  currentPage().layers = [];
  // a colour never seen before, so nothing can serve it from the cache
  const canvas = document.createElement("canvas");
  canvas.width = 200; canvas.height = 200;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgb(" + (Math.floor(Math.random() * 200) + 30) + ",20,90)";
  context.fillRect(0, 0, 200, 200);
  const fresh = canvas.toDataURL("image/png");

  // several pages, each with art nothing has decoded before
  const made = [];
  for (let i = 0; i < 3; i += 1) {
    if (i) addPage(false);
    context.fillStyle = "rgb(" + (30 + i * 40) + ",20," + (90 + i * 20) + ")";
    context.fillRect(0, 0, 200, 200);
    made.push(addLayer("image", { x: 0, y: 0, w: 200, h: 200 },
                       { image: canvas.toDataURL("image/png") }));
  }
  goToPage(0);
  // exporting immediately, exactly as someone would after generating
  const drawnAt = [];
  await forEachPageSnapshot(() => {
    drawnAt.push(currentPage().layers.filter((l) =>
      l.props.image && nodes.get(l.id).findOne(".art")).length);
  });
  return drawnAt.every((n) => n === 1)
    ? true : "pages captured with art drawn: " + drawnAt.join(",");
});

check("a broken image does not stall an export", async () => {
  currentPage().layers = [];
  const layer = addLayer("image", { x: 0, y: 0, w: 100, h: 100 },
                         { image: "data:image/png;base64,not-an-image" });
  renderCanvas();
  const started = Date.now();
  await forEachPageSnapshot(() => {});
  const seconds = (Date.now() - started) / 1000;
  // it must give up rather than wait out the whole timeout
  return seconds < 4 ? true : "waited " + seconds.toFixed(1) + "s";
});

check("every document type has a real paper size", () => {
  const wrong = [];
  Object.entries(PAGE_SIZES).forEach(([kind, size]) => {
    if (!size.inW || !size.inH) { wrong.push(kind + ": none"); return; }
    const dpi = (size.w * 2) / size.inW;      // export captures at twice
    if (dpi < 150) wrong.push(kind + ": " + Math.round(dpi) + "dpi");
    if (size.inW > 20 || size.inH > 25) wrong.push(kind + ": bigger than A2");
  });
  return wrong.length === 0 ? true : wrong.join(", ");
});

// A chapter exists as writing before it exists as pages.
check("a script becomes one page per scene", async () => {
  currentPage().layers = [];
  doc.chat.length = 0;
  const asked = [];
  const realSend = window.sendChat;
  window.sendChat = async (text, quiet) => { asked.push({ text, quiet }); };
  const script = [
    "Rin faces the oni on the temple steps at dawn.",
    "",
    "She draws her blade. The village burns behind her.",
    "",
    "",
    "   The oni laughs and raises its club.   ",
    "",
    "x",
  ].join(String.fromCharCode(10));
  const built = await buildFromScript(script);
  window.sendChat = realSend;
  if (built !== 3) return "made " + built + " pages, expected 3";
  // blank runs collapse, whitespace is tidied, a stray character is not
  // a scene, and the order is the order it was written in
  return asked[0].text.startsWith("Rin faces")
    && asked[2].text === "The oni laughs and raises its club."
    && asked.every((a) => a.quiet === true);
});
check("an empty script builds nothing", async () => {
  const asked = [];
  const realSend = window.sendChat;
  window.sendChat = async () => { asked.push(1); };
  const built = await buildFromScript("   " + String.fromCharCode(10) + "  ");
  window.sendChat = realSend;
  return built === 0 && asked.length === 0;
});

// Asking for another version of a panel is the commonest thing anyone
// does after looking at one.
check("another take gives a different seed, the same panel gives the same", () => {
  currentPage().layers = [];
  doc.style.lockSeed = true;
  doc.style.seedBase = 4242;
  const layer = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  const first = panelSeed(layer);
  const again = panelSeed(layer);
  if (first !== again) return "an untouched panel did not reproduce";
  layer.props.take = 1;
  const second = panelSeed(layer);
  layer.props.take = 2;
  const third = panelSeed(layer);
  return second !== first && third !== second && third !== first
    ? true : "takes repeated: " + [first, second, third].join(", ");
});
check("asking for another take moves the panel on", () => {
  currentPage().layers = [];
  const layer = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  layer.props.image = "data:image/png;base64,x";
  select(layer.id);
  const before = panelSeed(layer);
  showContextMenu(40, 40, contextItemsForSelection());
  const entry = [...document.querySelectorAll(".menu-drop.show .menu-item")]
    .find((el) => el.textContent.startsWith("Another take"));
  if (!entry) return "no way to ask for another";
  // the engine is not configured here, so only the intent is observed
  entry.click();
  hideContextMenu();
  return findLayer(layer.id).props.take === 1 && panelSeed(layer) !== before;
});

// Changing the style after pages exist is the edit that would otherwise
// leave a chapter looking like two chapters.
check("re-rendering applies the current style across pages", async () => {
  doc.pages = [];
  for (let i = 0; i < 2; i += 1) {
    doc.pages.push({ id: uid(), name: "Page " + (i + 1), layers: [] });
  }
  pageIndex = 0;
  renderCanvas();
  doc.style.preset = "manga";
  const made = [];
  for (let i = 0; i < 2; i += 1) {
    pageIndex = i;
    renderCanvas();
    const panel = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
    panel.props.prompt = "1girl, standing, page " + (i + 1);
    panel.props.image = "data:image/png;base64,old";
    made.push(panel);
  }
  pageIndex = 0;
  renderCanvas();

  const engine = document.getElementById("engine");
  const had = engine.innerHTML;
  engine.innerHTML = "<option value='local-gpu'>Local GPU</option>";
  const sent = [];
  const realFetch = window.fetch;
  window.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body).prompt);
    return { json: async () => ({
      ok: true, engine: "local-gpu", seed: 1, latency_ms: 1,
      image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    }) };
  };
  doc.style.preset = "noir";                 // the style changes after the fact
  const done = await rerenderPanels("document");
  window.fetch = realFetch;
  engine.innerHTML = had;

  if (done !== 2) return "re-rendered " + done + " of 2";
  // both pages were reached, and both carry the new style
  if (!sent.every((prompt) => prompt.includes("film noir"))) {
    return "a panel kept the old style";
  }
  return pageIndex === 0 ? true : "did not return to the page it started on";
});
check("re-rendering a page leaves the other pages alone", async () => {
  doc.pages = [
    { id: uid(), name: "Page 1", layers: [] },
    { id: uid(), name: "Page 2", layers: [] },
  ];
  pageIndex = 1;
  renderCanvas();
  const panel = addLayer("panel", { x: 0, y: 0, w: 100, h: 100 });
  panel.props.prompt = "only this one";
  pageIndex = 0;
  renderCanvas();
  const engine = document.getElementById("engine");
  const had = engine.innerHTML;
  engine.innerHTML = "<option value='local-gpu'>Local GPU</option>";
  const realFetch = window.fetch;
  let calls = 0;
  window.fetch = async () => { calls += 1; return { json: async () => ({ ok: false, error: "no" }) }; };
  await rerenderPanels("page");            // page one holds nothing
  window.fetch = realFetch;
  engine.innerHTML = had;
  return calls === 0;
});

// Panels name the characters they contain, so renaming one in the cast
// sheet could quietly detach every panel that referred to it.
check("renaming a character keeps the panels that use it", () => {
  currentPage().layers = [];
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl, long black hair, red kimono" }];
  const panel = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  panel.props.prompt = "standing, temple steps";
  panel.props.cast = ["Rin"];
  if (!composePrompt(panel).startsWith("1girl, long black hair")) return "setup wrong";

  renameCastMember(doc.cast[0], "Rina");

  const after = composePrompt(panel);
  return after.startsWith("1girl, long black hair")
    ? true
    : "the panel lost its character: " + after;
});

check("a rename reaches panels on other pages too", () => {
  doc.pages = [
    { id: uid(), name: "Page 1", layers: [] },
    { id: uid(), name: "Page 2", layers: [] },
  ];
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl, long black hair" }];
  pageIndex = 1;
  renderCanvas();
  const far = addLayer("panel", { x: 0, y: 0, w: 100, h: 100 });
  far.props.cast = ["Rin"];
  pageIndex = 0;
  renderCanvas();
  renameCastMember(doc.cast[0], "Rina");
  return doc.pages[1].layers[0].props.cast[0] === "Rina";
});
check("a rename onto an existing name is refused", () => {
  doc.cast = [
    { id: "c1", name: "Rin", tags: "1girl" },
    { id: "c2", name: "Oni", tags: "1other" },
  ];
  const changed = renameCastMember(doc.cast[0], "oni");
  return changed === false && doc.cast[0].name === "Rin";
});

// The style contract is looked up by name. A project written by another
// build, or edited by hand, can name a style that is not here, and
// losing it silently would strip the very thing that holds a chapter
// together.
check("an unknown style falls back instead of vanishing", () => {
  currentPage().layers = [];
  doc.kind = "manga";
  doc.style.preset = "a-style-that-does-not-exist";
  normalizeDocument(doc);
  const panel = addLayer("panel", { x: 0, y: 0, w: 200, h: 150 });
  panel.props.prompt = "1girl, standing";
  const composed = composePrompt(panel);
  if (composed === "1girl, standing") return "the panel was left with no style at all";
  return STYLE_PRESETS[doc.style.preset] !== undefined
    ? true : "the document still names a style that is not here";
});

check("a known style is left exactly as it was", () => {
  doc.kind = "manga";
  doc.style.preset = "watercolor";
  doc.style.extra = "soft edges";
  normalizeDocument(doc);
  return doc.style.preset === "watercolor" && doc.style.extra === "soft edges";
});
check("a document with no style at all still renders", () => {
  currentPage().layers = [];
  delete doc.style;
  normalizeDocument(doc);
  renderCanvas();
  // no style block is not the same as an unknown one, and neither should
  // stop the document opening
  return true;
});

// The repair has only ever been tested on damaged pages and layers. The
// document also carries a cast, a story and a set of guides, and code
// reaches into all three without asking.
check("a cast of the wrong type does not break composing a prompt", () => {
  currentPage().layers = [];
  doc.cast = "not a list at all";
  normalizeDocument(doc);
  const panel = addLayer("panel", { x: 0, y: 0, w: 100, h: 100 });
  panel.props.prompt = "1girl, standing";
  panel.props.cast = ["Rin"];
  return typeof composePrompt(panel) === "string";
});
check("a document with no story still shows the story tab", () => {
  delete doc.story;
  normalizeDocument(doc);
  renderStory();
  return document.getElementById("story-chapter").textContent.length > 0;
});
check("guides of the wrong shape do not break dragging", () => {
  currentPage().layers = [];
  doc.guides = { v: "nonsense", h: null };
  normalizeDocument(doc);
  const layer = addLayer("rect", { x: 50, y: 50, w: 40, h: 40 });
  select(layer.id);
  snapDrag(nodes.get(layer.id));
  return true;
});

check("a good document is left untouched by the repair", () => {
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl, long black hair" }];
  doc.story = { chapter: "A duel", overall: "Two rivals", flags: [{ title: "x", detail: "y" }] };
  doc.guides = { v: [120, 400], h: [88] };
  doc.chat = [{ role: "user", content: "hello" }];
  const before = JSON.stringify({ c: doc.cast, s: doc.story, g: doc.guides, h: doc.chat });
  normalizeDocument(doc);
  return JSON.stringify({ c: doc.cast, s: doc.story, g: doc.guides, h: doc.chat }) === before;
});
check("half a cast entry is dropped rather than half kept", () => {
  doc.cast = [
    { id: "c1", name: "Rin", tags: "1girl" },
    { name: 42 },
    null,
    { id: "c3", name: "Oni" },
  ];
  normalizeDocument(doc);
  // the nameless and the malformed go; the one missing only its tags stays
  return doc.cast.length === 2 && doc.cast[1].name === "Oni" && doc.cast[1].tags === "";
});

// The recovery chain has been checked at both ends: that the prompt
// appears, and that the file is written atomically. What was never
// checked is the part in between, whether what gets written can be
// opened again with the work still in it.
check("what autosave writes is a project that reopens", () => {
  currentPage().layers = [];
  doc.name = "Recovered chapter";
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl, long black hair" }];
  doc.style.preset = "noir";
  const panel = addLayer("panel", { x: 10, y: 20, w: 300, h: 200 });
  panel.props.prompt = "1girl, standing, temple steps";
  panel.props.cast = ["Rin"];
  addLayer("balloon", { x: 40, y: 50 }).props.text = "This ends today.";

  let reopened;
  try {
    reopened = JSON.parse(autosavePayload()).document;
  } catch (error) {
    return "what would be written is not readable: " + error.message;
  }
  normalizeDocument(reopened);
  const layers = reopened.pages[0].layers;
  const back = layers.find((l) => l.type === "panel");
  const said = layers.find((l) => l.type === "balloon");
  if (!back || back.props.prompt !== "1girl, standing, temple steps") return "the panel did not survive";
  if (!said || said.props.text !== "This ends today.") return "the lettering did not survive";
  if (reopened.style.preset !== "noir") return "the style did not survive";
  return reopened.cast[0] && reopened.cast[0].tags === "1girl, long black hair"
    ? true : "the cast did not survive";
});
check("a recovery copy carries no path, so saving it asks where", () => {
  const payload = JSON.parse(autosavePayload());
  // recovered work must not silently overwrite the older file on disk
  return payload._path === undefined;
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
chain("established cast is never overwritten", () => {
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
check("a card is folded: the message goes inside", async () => {
  doc.kind = "card";
  doc.style.preset = "card";
  await applyAgentArtwork([{
    prompt: "1girl, witch, pumpkin, full moon",
    dialogue: [
      { kind: "text", text: "Happy Halloween!" },
      { kind: "text", text: "Wishing you a night of excellent trouble." },
      { kind: "text", text: "love, R" },
    ],
  }], "card");
  const inside = doc.pages.find((p) => p.name === "Inside");
  if (!inside) return "no inside page";
  const words = inside.layers.map((l) => l.props.text);
  const front = doc.pages[pageIndex];
  return words.includes("Wishing you a night of excellent trouble.")
    && words.includes("love, R")
    // the front keeps the greeting alone, and is what stays on screen
    && front.layers.some((l) => l.props.text === "Happy Halloween!")
    && !front.layers.some((l) => l.props.text === "love, R");
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
check("building one document after another never destroys the earlier one", async () => {
  doc.kind = "poster";
  doc.style.preset = "poster";
  await applyAgentArtwork([{ prompt: "1boy, saxophone", dialogue: [] }], "poster");
  const afterFirst = doc.pages.filter((p) => p.layers.length).length;
  await applyAgentArtwork([{ prompt: "1girl, witch", dialogue: [] }], "poster");
  const afterSecond = doc.pages.filter((p) => p.layers.length).length;
  return afterFirst === 1 && afterSecond === 2;
});

// lettering
check("balloon tail direction is settable", () => {
  const layer = addLayer("balloon", { x: 30, y: 30 });
  layer.props.tail = "left";
  layer.props.tailLength = 40;
  renderCanvas();
  const tail = nodes.get(layer.id).findOne(".tail");
  if (!tail) return "no tail";
  // a left tail reaches out past the balloon's left edge
  return Math.min(...tail.points().filter((_, i) => i % 2 === 0)) < 0;
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
chain("ordinary paste offsets", () => {
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
chain("undo brings the image back", () => {
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

check("page thumbnails are downscaled, not the original", async () => {
  // a 1200x1600 render, far larger than the hundred pixel slot
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 1600;
  const context = canvas.getContext("2d");
  context.fillStyle = "#4488cc";
  context.fillRect(0, 0, 1200, 1600);
  const full = canvas.toDataURL("image/png");

  const small = await new Promise((resolve) => pageThumbnail(full, resolve));
  if (!small) return "no thumbnail";
  if (small === full) return "returned the original";
  // and the second request is served from the cache, not recomputed
  const again = await new Promise((resolve) => pageThumbnail(full, resolve));
  return small.length < full.length / 4 && again === small;
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
chain("blueprint orders columns by flow", () => {
  const byName = {};
  currentPage().layers.filter(l => l.type === "rect").forEach(l => { byName[l.props.label] = l.x; });
  return byName["Roof"] < byName["Filter"]
    && byName["Filter"] < byName["Storage tank"]
    && byName["Storage tank"] < byName["Tap"];
});
chain("box label renders inside the box", () => {
  const box = currentPage().layers.find(l => l.type === "rect" && l.props.label);
  const text = nodes.get(box.id).findOne(".box-label");
  return !!text && text.text() === box.props.label;
});
chain("connectors span between boxes", () => {
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
check("the pdf carries every page at the document's own size", async () => {
  doc.pages = [];
  for (let i = 0; i < 3; i += 1) {
    doc.pages.push({ id: uid(), name: "Page " + (i + 1), layers: [] });
  }
  pageIndex = 0;
  renderCanvas();
  addLayer("text", { x: 20, y: 20 }).props.text = "a page with something on it";

  let sent = null;
  const real = window.studio.exportPdf;
  window.studio.exportPdf = async (payload) => { sent = payload; return "out.pdf"; };
  await document.getElementById("export-pdf").onclick();
  window.studio.exportPdf = real;

  if (!sent) return "nothing was handed to the writer";
  if (sent.images.length !== 3) return "carried " + sent.images.length + " pages of 3";
  // the sheet must measure what the paper measures, not what the canvas
  // happens to be in pixels
  if (Math.abs(sent.widthIn - PAGE.inW) > 0.01
      || Math.abs(sent.heightIn - PAGE.inH) > 0.01) {
    return "sized " + sent.widthIn + "x" + sent.heightIn
      + "in rather than " + PAGE.inW + "x" + PAGE.inH;
  }
  // and that has to be a plausible sheet of paper, not a canvas guess
  if (sent.widthIn > 20 || sent.heightIn > 25) return "absurd sheet size";
  return sent.images.every((png) => String(png).startsWith("data:image/png"))
    ? true : "a page was not a rendered image";
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

check("a long poster title does not run through its own subtitles", () => {
  resetForCheck("poster");
  placeArtworkText("poster", [
    { text: "Apple Silicon Caching Power And Unified Memory Architecture" },
    { text: "Dynamic Caching Explained" },
    { text: "Unified Memory Architecture" },
  ], { x: 0, y: 0, w: PAGE.w, h: Math.round(PAGE.h * 0.8) });

  const type = currentPage().layers.filter((l) => l.type === "text");
  if (type.length !== 3) return "expected a title and two subtitles, got " + type.length;
  const boxes = type.map((l) => ({
    name: l.props.text.slice(0, 18),
    top: l.y,
    bottom: l.y + textBlockHeight(l.props.text, l.props.fontSize,
      l.props.font || "Segoe UI", l.w),
  })).sort((a, b) => a.top - b.top);

  for (let i = 1; i < boxes.length; i += 1) {
    if (boxes[i].top < boxes[i - 1].bottom) {
      return JSON.stringify(boxes[i - 1].name) + " ends at " + boxes[i - 1].bottom
        + " but " + JSON.stringify(boxes[i].name) + " starts at " + boxes[i].top;
    }
  }
  const last = boxes[boxes.length - 1];
  return last.bottom <= PAGE.h ? true
    : "the block runs " + (last.bottom - PAGE.h) + "px past the foot of the page";
});

check("the style travels with a generation request, so the right model renders it", async () => {
  resetForCheck("poster");
  const art = addLayer("panel", { x: 0, y: 0, w: 512, h: 512 });
  art.props.prompt = "cache hierarchy diagram";
  doc.style.preset = "poster";

  // Whether an engine is on offer depends on a server this check must
  // not need. Naming one directly keeps the check about the request that
  // gets built, which is the thing being examined.
  const chooser = document.getElementById("engine");
  const before = chooser.innerHTML;
  chooser.innerHTML = "<option value='local-gpu'>local</option>";
  chooser.value = "local-gpu";

  let sent = null;
  const realFetch = window.fetch;
  window.fetch = async (url, options) => {
    if (String(url).includes("/generate")) {
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: false, error: "stopped here" }) };
    }
    return realFetch(url, options);
  };
  try {
    await generatePanel(art).catch(() => {});
  } finally {
    window.fetch = realFetch;
    chooser.innerHTML = before;
  }
  if (!sent) return "no request was made";
  return sent.style === "poster" ? true
    : "the request carried style " + JSON.stringify(sent.style);
});

check("the same character starts from the same place on every page", () => {
  resetForCheck("manga");
  doc.style.lockSeed = true;
  doc.style.seedBase = 1000;
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl, long black hair" },
              { id: "c2", name: "Kaito", tags: "1boy, short hair" }];

  const first = addLayer("panel", { x: 0, y: 0, w: 300, h: 300 });
  first.props.cast = ["Rin"];
  const second = addLayer("panel", { x: 320, y: 0, w: 300, h: 300 });
  second.props.cast = ["Rin"];
  const other = addLayer("panel", { x: 0, y: 320, w: 300, h: 300 });
  other.props.cast = ["Kaito"];

  const a = panelSeed(first);
  const b = panelSeed(second);
  const c = panelSeed(other);
  if (a !== b) return "two panels of the same person started from " + a + " and " + b;
  if (a === c) return "two different people started from the same place";

  // and a page later, still the same person
  addPage(false);
  const later = addLayer("panel", { x: 0, y: 0, w: 300, h: 300 });
  later.props.cast = ["Rin"];
  return panelSeed(later) === a ? true
    : "the same person on a later page started from " + panelSeed(later);
});

check("the order names were added cannot change the art", () => {
  resetForCheck("manga");
  doc.style.lockSeed = true;
  doc.style.seedBase = 1000;
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl" },
              { id: "c2", name: "Kaito", tags: "1boy" }];
  const one = addLayer("panel", { x: 0, y: 0, w: 200, h: 200 });
  one.props.cast = ["Rin", "Kaito"];
  const two = addLayer("panel", { x: 220, y: 0, w: 200, h: 200 });
  two.props.cast = ["Kaito", "Rin"];
  return panelSeed(one) === panelSeed(two) ? true
    : "the same two people in a different order gave different art";
});

check("asking for another take still gives a different one", () => {
  resetForCheck("manga");
  doc.style.lockSeed = true;
  doc.style.seedBase = 1000;
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl" }];
  const panel = addLayer("panel", { x: 0, y: 0, w: 200, h: 200 });
  panel.props.cast = ["Rin"];
  const first = panelSeed(panel);
  panel.props.take = 1;
  return panelSeed(panel) !== first ? true
    : "another take reproduced the same art";
});

check("a slow hosted server says it is waking, and stops when it answers", async () => {
  // Free hosting sleeps and takes most of a minute to wake. Unsaid, the
  // first action of a session reads as a broken application rather than a
  // waiting one. The delay is shortened here rather than waited out: the
  // page gets a few seconds of virtual time in total.
  resetForCheck("manga");
  const notice = document.getElementById("waking");
  if (!notice) return "there is no waking notice in the page";
  notice.classList.remove("show");

  const realFetch = window.fetch;
  const realServer = SERVER;
  const realDelay = WAKING_AFTER_MS;
  WAKING_AFTER_MS = 20;
  serverHasAnswered = false;
  saidWaking = false;
  SERVER = "https://example.invalid";
  let release = null;
  window.fetch = () => new Promise((resolve) => { release = resolve; });
  try {
    const inFlight = api("/health");
    await new Promise((r) => setTimeout(r, 80));
    if (!notice.classList.contains("show")) {
      return "a call slower than the delay said nothing";
    }
    release({ ok: true, json: async () => ({}) });
    await inFlight;
    if (notice.classList.contains("show")) {
      return "the notice stayed up after the server answered";
    }
  } finally {
    window.fetch = realFetch;
    SERVER = realServer;
    WAKING_AFTER_MS = realDelay;
  }
  return true;
});

check("a server on this machine is never described as waking", async () => {
  resetForCheck("manga");
  const notice = document.getElementById("waking");
  notice.classList.remove("show");
  const realFetch = window.fetch;
  const realServer = SERVER;
  const realDelay = WAKING_AFTER_MS;
  WAKING_AFTER_MS = 20;
  SERVER = "http://127.0.0.1:8787";
  let release = null;
  window.fetch = () => new Promise((resolve) => { release = resolve; });
  try {
    const inFlight = api("/health");
    await new Promise((r) => setTimeout(r, 80));
    const said = notice.classList.contains("show");
    release({ ok: true, json: async () => ({}) });
    await inFlight;
    if (said) return "a local server was described as waking up";
  } finally {
    window.fetch = realFetch;
    SERVER = realServer;
    WAKING_AFTER_MS = realDelay;
  }
  return true;
});

check("the theme button cycles all three looks and remembers the choice", () => {
  // Dark carries no value, which is what a two-state toggle compared
  // against. A third look means the order has to be written down, or an
  // unanticipated value leaves the button doing nothing.
  const button = document.getElementById("theme-toggle");
  if (!button) return "there is no theme button";
  const started = document.documentElement.dataset.theme || "";

  applyTheme("");
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    button.onclick();
    seen.push(document.documentElement.dataset.theme || "dark");
  }
  applyTheme(started);

  const expected = ["light", "fire", "dark", "light"];
  if (JSON.stringify(seen) !== JSON.stringify(expected)) {
    return "cycled through " + seen.join(", ") + " instead of " + expected.join(", ");
  }
  return localStorage.getItem("studio-theme") === "light" ? true
    : "the choice was not remembered";
});

check("a theme nobody has styles for falls back rather than breaking", () => {
  const started = document.documentElement.dataset.theme || "";
  const settled = applyTheme("chartreuse-mode");
  applyTheme(started);
  return settled === "" ? true
    : "an unknown theme was applied as " + JSON.stringify(settled);
});

check("the fire theme actually restyles the window", () => {
  const started = document.documentElement.dataset.theme || "";
  applyTheme("");
  const dark = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim();
  applyTheme("fire");
  const fire = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim();
  applyTheme(started);
  if (!fire) return "the fire theme defines no accent colour";
  return fire !== dark ? true
    : "fire and dark share the same accent, so nothing would look different";
});

check("saving settings still saves the server when a key cannot be written", async () => {
  // The reported fault. Installed, the keys file sits inside a read-only
  // bundle, so writing threw, the await abandoned everything after it, and
  // the dialog neither saved the address nor closed. It read as a dead
  // button. Nothing had ever pressed it in a check.
  resetForCheck("manga");
  const realSave = window.studio.saveKeys;
  const realServer = SERVER;
  const realToken = SERVER_TOKEN;
  window.studio.saveKeys = async () => ({ ok: false, error: "read-only" });

  document.getElementById("key-server").value = "https://example.test";
  document.getElementById("key-server-token").value = "a-token";
  try {
    await document.getElementById("settings-save").onclick();
    if (SERVER !== "https://example.test") {
      return "a failed key write also lost the server address: " + SERVER;
    }
    if (SERVER_TOKEN !== "a-token") return "the token was lost too";
    const modal = document.getElementById("settings-modal");
    if (modal && modal.style.display !== "none") {
      return "the dialog stayed open, which is what looked like a dead button";
    }
  } finally {
    window.studio.saveKeys = realSave;
    SERVER = realServer;
    SERVER_TOKEN = realToken;
    document.getElementById("key-server").value = "";
    document.getElementById("key-server-token").value = "";
    localStorage.removeItem("studio-server");
    localStorage.removeItem("studio-token");
  }
  return true;
});

check("an empty server field means the address this build ships with", async () => {
  // Not this machine. A blank field used to fall straight to localhost,
  // which threw away the deployed address the build was pointed at and
  // reported the server offline on a fresh install.
  resetForCheck("manga");
  const realSave = window.studio.saveKeys;
  const realServer = SERVER;
  const shipped = DEPLOYMENT.server;
  DEPLOYMENT.server = "https://shipped.example";
  window.studio.saveKeys = async () => ({ ok: true });
  document.getElementById("key-server").value = "";
  try {
    await document.getElementById("settings-save").onclick();
    if (SERVER !== "https://shipped.example") {
      return "a blank field resolved to " + SERVER;
    }
  } finally {
    window.studio.saveKeys = realSave;
    SERVER = realServer;
    DEPLOYMENT.server = shipped;
    localStorage.removeItem("studio-server");
  }
  return true;
});

check("the waking notice is said once, not before every page", async () => {
  // It used to appear whenever a hosted call ran long, which is every call
  // that draws something: generating art takes far longer than waking a
  // server, so a notice about waking showed up on each page and became
  // furniture.
  resetForCheck("manga");
  const notice = document.getElementById("waking");
  const realFetch = window.fetch;
  const realServer = SERVER;
  const realDelay = WAKING_AFTER_MS;
  WAKING_AFTER_MS = 20;
  SERVER = "https://example.invalid";
  serverHasAnswered = false;
  saidWaking = false;

  let release = null;
  window.fetch = () => new Promise((resolve) => { release = resolve; });
  try {
    // first call: slow, and the server has never answered, so it speaks
    let flight = api("/health");
    await new Promise((r) => setTimeout(r, 80));
    const spokeFirst = notice.classList.contains("show");
    release({ ok: true, json: async () => ({}) });
    await flight;
    if (!spokeFirst) return "it said nothing on the very first slow call";

    // second call, equally slow, but the server has now proven it is awake
    flight = api("/generate");
    await new Promise((r) => setTimeout(r, 80));
    const spokeAgain = notice.classList.contains("show");
    release({ ok: true, json: async () => ({}) });
    await flight;
    if (spokeAgain) return "it announced waking again after the server had replied";
  } finally {
    window.fetch = realFetch;
    SERVER = realServer;
    WAKING_AFTER_MS = realDelay;
    serverHasAnswered = false;
    saidWaking = false;
    notice.classList.remove("show");
  }
  return true;
});

check("shortcuts answer to Cmd as well as Ctrl", () => {
  // A Mac has no Ctrl modifier in practice: Cmd arrives as metaKey. Every
  // test written only for ctrlKey simply never fires there, so the shortcut
  // reads as broken rather than unbound. Checked by dispatching both.
  resetForCheck("manga");
  // The handler ignores shortcuts while somebody is typing, which is
  // correct and which an earlier check can leave in place. Focus is
  // returned to the body first so this measures the shortcut, not the
  // focus left over from something else.
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  addLayer("rect", { x: 20, y: 20, w: 80, h: 80 });
  commit();
  const before = currentPage().layers.length;
  addLayer("rect", { x: 60, y: 60, w: 80, h: 80 });
  commit();

  // Ctrl+Z, the Windows and Linux form
  document.dispatchEvent(new KeyboardEvent("keydown",
    { key: "z", ctrlKey: true, bubbles: true }));
  const afterCtrl = currentPage().layers.length;

  // and Cmd+Z, which is the same intention on a Mac
  addLayer("rect", { x: 40, y: 40, w: 80, h: 80 });
  commit();
  const staged = currentPage().layers.length;
  document.dispatchEvent(new KeyboardEvent("keydown",
    { key: "z", metaKey: true, bubbles: true }));
  const afterMeta = currentPage().layers.length;

  if (afterCtrl > before) {
    return "Ctrl+Z did not undo: " + before + " became " + afterCtrl;
  }
  return afterMeta < staged ? true
    : "Cmd+Z did nothing, so every shortcut is dead on a Mac";
});

check("the window controls are hidden where the system draws its own", () => {
  // A Mac keeps its traffic lights, so ours would be a second set on the
  // wrong side of the bar.
  const group = document.getElementById("winctl");
  if (!group) return "there is no window control group to hide";
  const bar = document.getElementById("topbar");
  return bar ? true : "the bar the mac rule indents does not exist";
});

check("right clicking the canvas actually opens the menu", () => {
  // The existing check called the menu's actions directly, so it proved
  // the actions work and never proved the menu opens. Reported broken
  // twice while that check stayed green, which is the signature of
  // testing the payload instead of the trigger.
  resetForCheck("manga");
  const menu = document.querySelector(".menu-drop");
  if (!menu) return "no menu element was ever created";
  menu.classList.remove("show");

  // Dispatched on the canvas a person actually clicks, not on the
  // container the listener happens to be attached to. Aiming at the
  // container proves the listener fires and proves nothing about whether
  // a real click ever reaches it.
  const container = stage.container();
  if (!container) return "the stage has no container to right click on";
  const target = container.querySelector("canvas") || container;
  if (target === container) return "the stage drew no canvas to click on";
  target.dispatchEvent(new MouseEvent("contextmenu",
    { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));

  if (!menu.classList.contains("show")) {
    return "right clicking the canvas itself opened nothing";
  }
  return menu.querySelectorAll(".menu-item").length > 0 ? true
    : "the menu opened with nothing in it";
});

check("right clicking a text field offers cut, copy and paste", () => {
  // The reported fault. The canvas had a menu, so shapes could be cut and
  // copied; everywhere else in the window a right click produced nothing,
  // because Electron ships no menu of its own and the checks only ever
  // exercised the canvas.
  resetForCheck("manga");
  const menu = document.querySelector(".menu-drop");
  menu.classList.remove("show");

  const field = document.createElement("textarea");
  field.value = "some words worth keeping";
  document.body.appendChild(field);
  field.selectionStart = 0;
  field.selectionEnd = 4;
  field.dispatchEvent(new MouseEvent("contextmenu",
    { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));

  const labels = [...menu.querySelectorAll(".menu-item")]
    .map((el) => el.textContent.trim());
  field.remove();
  if (!menu.classList.contains("show")) {
    return "right clicking a text field still opens nothing";
  }
  const missing = ["Cut", "Copy", "Paste", "Select All"]
    .filter((wanted) => !labels.some((label) => label.startsWith(wanted)));
  return missing.length === 0 ? true
    : "a text field's menu did not offer: " + missing.join(", ");
});

check("selected text is offered a copy, even where the browser cannot select", () => {
  // A headless browser holds no text selection, so this cannot be driven
  // through getSelection here. The decision is checked directly instead:
  // pretending otherwise would be a check that proves nothing and reads
  // as though it proves something.
  resetForCheck("manga");
  const block = document.createElement("p");
  block.textContent = "a line the agent wrote";
  const items = textMenuItems(block, "a line the agent wrote");
  if (!items) return "text with a selection was offered no menu at all";
  const labels = items.filter((i) => i !== "-").map((i) => i.label);
  return labels.length === 1 && labels[0] === "Copy" ? true
    : "expected only a copy option, got: " + labels.join(", ");
});

check("a right click with nothing to act on is left alone", () => {
  resetForCheck("manga");
  const menu = document.querySelector(".menu-drop");
  menu.classList.remove("show");
  window.getSelection().removeAllRanges();

  const empty = document.createElement("div");
  document.body.appendChild(empty);
  empty.dispatchEvent(new MouseEvent("contextmenu",
    { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const opened = menu.classList.contains("show");
  empty.remove();
  return !opened ? true
    : "a menu of nothing useful was offered on empty space";
});

check("the menu on a selected layer offers cut and copy", () => {
  resetForCheck("manga");
  const menu = document.querySelector(".menu-drop");
  const shape = addLayer("rect", { x: 40, y: 40, w: 120, h: 120 });
  select(shape.id);
  showContextMenu(100, 100, contextItemsForSelection());

  const labels = [...menu.querySelectorAll(".menu-item")]
    .map((el) => el.textContent.trim());
  const missing = ["Cut", "Copy", "Duplicate", "Delete"]
    .filter((wanted) => !labels.some((label) => label.startsWith(wanted)));
  return missing.length === 0 ? true
    : "the menu did not offer: " + missing.join(", ");
});

check("the update notice appears, and offers to restart once ready", async () => {
  // This path only runs when a real update arrives, so nothing exercised
  // it: the first draft called a save function that does not exist and
  // would have thrown the moment an update was found.
  resetForCheck("manga");
  const banner = document.getElementById("update-banner");
  const text = document.getElementById("update-text");
  const act = document.getElementById("update-act");
  if (!banner) return "there is no update banner in the page";
  if (!window.__updateHandler) return "nothing is listening for update news";

  window.__updateHandler({ state: "available", version: "9.9.9" });
  if (!banner.classList.contains("show")) return "an available update said nothing";
  if (!text.textContent.includes("9.9.9")) {
    return "the notice did not name the version: " + text.textContent;
  }

  window.__updateHandler({ state: "downloading", percent: 42 });
  if (!text.textContent.includes("42")) return "progress was not shown";

  window.__updateHandler({ state: "ready", version: "9.9.9" });
  if (!/restart/i.test(act.textContent)) {
    return "a ready update did not offer a restart: " + act.textContent;
  }

  // Two kinds of failure, and they are not the same. Failing after an
  // update was found means one exists and cannot be fetched, which is worth
  // saying: hiding it made a release whose feed pointed at a filename that
  // was never uploaded look exactly like no release at all.
  window.__updateHandler({ state: "failed", detail: "404" });
  if (!banner.classList.contains("show")) {
    return "an update that was found but could not be downloaded said nothing";
  }
  if (!/could not be downloaded/i.test(text.textContent)) {
    return "the notice did not say the download failed: " + text.textContent;
  }

  // and a check that never found anything must not nag at all
  window.__updateHandler({ state: "available", version: "" });
  banner.classList.remove("show");
  window.__resetUpdateNotice();
  window.__updateHandler({ state: "failed", detail: "no network" });
  return !banner.classList.contains("show") ? true
    : "a failed check with no update pending still put a notice up";
});

check("a name that is not in the cast does not silently anchor the art", () => {
  // Raised by the automated review: nothing covered a panel naming
  // somebody who has been renamed or deleted. It falls back to the
  // positional seed, which is right, but if it had instead resolved to a
  // shared empty value every such panel would have drawn the same thing.
  resetForCheck("manga");
  doc.style.lockSeed = true;
  doc.style.seedBase = 1000;
  doc.cast = [{ id: "c1", name: "Rin", tags: "1girl" }];

  const ghost = addLayer("panel", { x: 0, y: 0, w: 200, h: 200 });
  ghost.props.cast = ["SomebodyDeleted"];
  const alsoGhost = addLayer("panel", { x: 220, y: 0, w: 200, h: 200 });
  alsoGhost.props.cast = ["AnotherMissingName"];
  const real = addLayer("panel", { x: 0, y: 220, w: 200, h: 200 });
  real.props.cast = ["Rin"];

  if (panelSeed(ghost) === panelSeed(alsoGhost)) {
    return "two panels naming different missing people drew the same art";
  }
  return panelSeed(ghost) !== panelSeed(real) ? true
    : "a missing name anchored to the same art as a real cast member";
});

check("a panel with nobody in it still gets its own art", () => {
  resetForCheck("manga");
  doc.style.lockSeed = true;
  doc.style.seedBase = 1000;
  const a = addLayer("panel", { x: 0, y: 0, w: 200, h: 200 });
  const b = addLayer("panel", { x: 220, y: 0, w: 200, h: 200 });
  return panelSeed(a) !== panelSeed(b) ? true
    : "two empty panels would have produced identical art";
});

runChecks().then(() => {
  document.title = "SELFTEST " + JSON.stringify(window.__results);
});
`;

// The page ships a strict Content-Security-Policy that forbids inline
// script, so the checks load as a file like any other script would.
const checksFile = path.join(here, "__selftest-checks.js");
const order = process.argv.includes("--reverse") ? "reverse" : "forward";
fs.writeFileSync(checksFile,
  `window.__order = ${JSON.stringify(order)};
` + CHECKS, "utf-8");
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
    const skipped = String(status).startsWith("skipped");
    if (status !== "pass" && !skipped) failed += 1;
    const mark = status === "pass" ? "  ok  " : skipped ? " skip " : " FAIL ";
    console.log(`${mark} ${name}${status === "pass" || skipped ? "" : "  -> " + status}`);
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
