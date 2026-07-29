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
const original = fs.readFileSync(target, "utf-8");

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
    what: "the balloon body ignores its own position",
    expect: "a balloon sits where it says it does",
    from: "    node = new Konva.Group(common);\n    const padding = 13;",
    to: "    node = new Konva.Group({ ...common, y: common.y - 90 });\n    const padding = 13;",
  },
];

function runSuite() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, "selftest.js")],
      { encoding: "utf-8", stdio: "pipe" });
    return null;                       // everything passed
  } catch (error) {
    return String(error.stdout || "");  // the suite went red
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
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} deliberate faults were caught`);
process.exit(survived ? 1 : 0);
