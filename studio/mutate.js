/* Does the self-test actually have teeth?

   Run:  node studio/mutate.js

   Breaks the renderer on purpose, one behaviour at a time, and expects
   the suite to go red. A mutation nothing notices means the checks
   covering it are decorative: they would pass whether the code worked or
   not. The file is always restored, including on failure.
*/
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const target = path.join(__dirname, "editor.js");
// While this runs, editor.js on disk is deliberately broken. Anything
// else reading it would be measuring damage rather than the code, and a
// concurrent edit would be wiped by the restore. The lock makes that
// impossible rather than merely documented.
const lock = path.join(__dirname, ".mutating");

// Signal 0 asks whether a process exists without disturbing it, so a
// lock left behind by a killed run does not block every later run.
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

if (fs.existsSync(lock) && running(fs.readFileSync(lock, "utf-8").trim())) {
  console.error("a mutation run is already in progress. Wait for it to finish.");
  process.exit(1);
}

// A run that is killed outright cannot restore what it broke, and on
// Windows a forced stop gives no warning to act on. Keeping the intact
// copy on disk means the damage outlives only until the next run, which
// puts it back rather than measuring it.
const spare = path.join(__dirname, ".editor.original");
if (fs.existsSync(lock) && fs.existsSync(spare)) {
  fs.writeFileSync(target, fs.readFileSync(spare, "utf-8"), "utf-8");
  console.log("a previous run was killed before it could undo its damage;"
    + " editor.js has been put back\n");
}
fs.writeFileSync(lock, String(process.pid), "utf-8");

const original = fs.readFileSync(target, "utf-8");
fs.writeFileSync(spare, original, "utf-8");

// A killed run cannot reach its own cleanup, which is how editor.js was
// once left mutated on disk. Releasing on the way out covers the ways a
// process can be stopped from outside.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      fs.writeFileSync(target, original, "utf-8");
      if (fs.existsSync(lock)) fs.unlinkSync(lock);
    } catch (error) { /* going down anyway */ }
    process.exit(1);
  });
}

// Each mutation names the behaviour it destroys and the check that
// should therefore fail.
const MUTATIONS = [
  {
    what: "panels overlap",
    expect: "panels never overlap",
    from: "const usableW = innerW - GUTTER_X * (cols.length - 1);",
    to: "const usableW = innerW * 2;",
  },
  {
    what: "the project style is dropped from prompts",
    expect: "cast tags lead the prompt",
    from: "return [castTags(layer.props.cast), layer.props.prompt, styleTags()]",
    to: "return [castTags(layer.props.cast), layer.props.prompt]",
  },
  {
    what: "type layers stop scaling",
    expect: "sfx scales with handles",
    from: "layer.props.fontSize = Math.max(8, Math.round(layer.props.fontSize * uniform));",
    to: "layer.props.fontSize = layer.props.fontSize;",
  },
  {
    what: "art is applied to a panel that has gone",
    expect: "a render that finishes after its panel is gone",
    from: "  return doc.pages.some((page) => page.layers.includes(layer));",
    to: "  return true;",
  },
  {
    what: "damaged projects are trusted as they are",
    expect: "a layer with no props",
    from: "      if (!layer.props || typeof layer.props !== \"object\") layer.props = {};",
    to: "      if (false) layer.props = {};",
  },
  {
    what: "images are re-decoded on every rebuild",
    expect: "art survives a rebuild",
    from: "  const ready = decodedImages.get(source);",
    to: "  const ready = null;",
  },
  {
    what: "a multiple selection is moved twice",
    expect: "dragging one of a selection moves them all",
    from: "    if (selectedIds.length === 1) snapDrag(node);",
    to: "    if (selectedIds.length === 1) snapDrag(node);\n    else selectedLayers().forEach((l) => { const n = nodes.get(l.id); if (n && n !== node) n.move({ x: 5, y: 5 }); });",
  },
  {
    what: "the pdf is written at a fixed size, not the page's",
    expect: "the pdf carries every page at the document's own size",
    from: "    const widthIn = PAGE.inW || PAGE.w / 96;",
    to: "    const widthIn = 8.5;",
  },
  {
    what: "the pdf silently drops all but the first page",
    expect: "the pdf carries every page",
    from: "    await forEachPageSnapshot((dataUrl) => { images.push(dataUrl); });",
    to: "    await forEachPageSnapshot((dataUrl) => { if (!images.length) images.push(dataUrl); });",
  },
  {
    what: "the balloon body ignores its own position",
    expect: "a balloon sits where it says it does",
    from: "    node = new Konva.Group(common);\n    const padding = 13;",
    to: "    node = new Konva.Group({ ...common, y: common.y - 90 });\n    const padding = 13;",
  },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, "selftest.js")],
      // This run is the one the lock exists to permit. Naming the owner
      // lets the suite tell a sanctioned run from a bystander.
      { encoding: "utf-8", stdio: "pipe",
        env: { ...process.env, MUTATION_OWNER: String(process.pid) } });
    return null;                       // everything passed
  } catch (error) {
    const output = String(error.stdout || "");
    // A red suite says which checks failed. A red suite that says nothing
    // never ran, and counting that as a caught fault would let a broken
    // harness report a clean sweep.
    if (!/checks passed/.test(output)) {
      throw new Error("the suite did not run: "
        + (String(error.stderr || "").trim() || "no output")
          .split(String.fromCharCode(10))[0]);
    }
    return output;                      // the suite went red
  }
}

let survived = 0;
try {
  console.log("checking that the suite notices deliberate damage\n");
  for (const mutation of MUTATIONS) {
    if (!original.includes(mutation.from)) {
      console.log(` STALE   ${mutation.what}: the code it patches has moved`);
      survived += 1;
      continue;
    }
    fs.writeFileSync(target, original.replace(mutation.from, mutation.to), "utf-8");
    const output = runSuite();
    if (!output) {
      console.log(` MISSED  ${mutation.what}: nothing failed`);
      survived += 1;
    } else if (!output.includes(mutation.expect)) {
      const failed = output.split("\n").filter((l) => l.includes("FAIL"))
        .map((l) => l.trim().split("  ")[1]).join(", ");
      console.log(` WRONG   ${mutation.what}: expected "${mutation.expect}", got ${failed}`);
      survived += 1;
    } else {
      console.log(`  ok     ${mutation.what}`);
    }
  }
} finally {
  fs.writeFileSync(target, original, "utf-8");
  for (const file of [lock, spare]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} deliberate faults were caught`);
process.exit(survived ? 1 : 0);
