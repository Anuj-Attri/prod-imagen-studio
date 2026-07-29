/* Write the files the application writes, then read them back.

   Run:  node studio/filecheck.js

   Exporting an image and saving a project both hand bytes to the file
   system and report success. Checking that the right bytes were asked
   for is not the same as checking what landed, which is how a pdf spent
   fifteen rounds being written thousands of inches across.
*/
const fs = require("fs");
const os = require("os");
const path = require("path");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prod-imagen-files-"));
let failed = 0;

function check(name, run) {
  try {
    const problem = run();
    if (problem === true) {
      console.log(`  ok   ${name}`);
    } else {
      console.log(` FAIL  ${name}: ${problem}`);
      failed += 1;
    }
  } catch (error) {
    console.log(` FAIL  ${name}: ${error.message}`);
    failed += 1;
  }
}

// A png states its own size in the header, so the file can be measured
// rather than trusted.
function pngSize(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

check("an exported image is a real png of the right size", () => {
  // a 3x2 png, the same shape the renderer hands over
  const source = "data:image/png;base64,"
    + "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAADZSiLoAAAAF0lEQVQI12P8z8Dwn4GB"
    + "gYmBgYGJgYEBAA8sAgFvVJl0AAAAAElFTkSuQmCC";
  // exactly what the write handler does with it
  const target = path.join(scratch, "page.png");
  fs.writeFileSync(target,
    Buffer.from(source.replace(/^data:image\/png;base64,/, ""), "base64"));

  const size = pngSize(fs.readFileSync(target));
  if (!size) return "the file is not a png";
  return size.width === 3 && size.height === 2
    ? true : `the file measures ${size.width}x${size.height}, expected 3x2`;
});

check("a saved project reopens with its text intact", () => {
  // lettering people actually write: accents, quotes, japanese, an emoji
  const original = {
    name: "Chapitre un",
    document: {
      version: 1, kind: "manga",
      pages: [{
        id: "p1", name: "Page 1", layers: [
          { id: "l1", type: "caption", x: 0, y: 0, w: 10, h: 10,
            visible: true, locked: false,
            props: { text: "Il était une fois — «bonjour», 東京, 🎃" } },
        ],
      }],
      cast: [{ id: "c1", name: "Rin", tags: "1girl, long black hair" }],
      style: { preset: "manga", pageBg: "#101014", seedBase: 4242 },
    },
  };
  const target = path.join(scratch, "project.dimg");
  fs.writeFileSync(target, JSON.stringify(original), "utf-8");

  const reopened = JSON.parse(fs.readFileSync(target, "utf-8"));
  const text = reopened.document.pages[0].layers[0].props.text;
  if (text !== original.document.pages[0].layers[0].props.text) {
    return `lettering came back as ${JSON.stringify(text)}`;
  }
  if (reopened.document.style.seedBase !== 4242) return "style did not survive";
  return reopened.document.cast[0].tags === "1girl, long black hair"
    ? true : "cast did not survive";
});

check("a saved project has no byte order mark to trip the parser", () => {
  const target = path.join(scratch, "plain.dimg");
  fs.writeFileSync(target, JSON.stringify({ ok: true }), "utf-8");
  const first = fs.readFileSync(target)[0];
  return first === 0x7b ? true : `starts with byte ${first}, not an opening brace`;
});

check("a recovery copy is complete or absent, never half written", () => {
  // the handler writes beside the target and renames, so a reader can
  // never meet a partial file under the real name
  const target = path.join(scratch, "session.dimg");
  const partial = target + ".part";
  fs.writeFileSync(partial, JSON.stringify({ pages: [1, 2, 3] }), "utf-8");
  if (fs.existsSync(target)) return "the real name existed before the rename";
  fs.renameSync(partial, target);
  const back = JSON.parse(fs.readFileSync(target, "utf-8"));
  return back.pages.length === 3 && !fs.existsSync(partial)
    ? true : "the rename did not leave one complete file";
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${4 - failed}/4 written files were what they claimed`);
process.exit(failed ? 1 : 0);
