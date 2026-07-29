/* Write a pdf through the same path the application uses and measure
   what came out.

   Run:  npx electron studio/pdfcheck.js

   The export claims a particular sheet size. This produces one and reads
   the page box back out of the file, because a claim about millimetres
   is worth nothing unless something has measured it.
*/
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Same sheets the editor declares.
const SHEETS = [
  ["manga", 6.93, 9.84],
  ["coloring", 8.5, 11],
  ["card", 5.83, 4.13],
];

function sheetHtml(widthIn, heightIn, pages) {
  const body = pages.map((colour) =>
    `<div class="sheet" style="background:${colour}"></div>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    @page { size: ${widthIn}in ${heightIn}in; margin: 0; }
    html, body { margin: 0; padding: 0; }
    .sheet { width: ${widthIn}in; height: ${heightIn}in; page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
  </style>${body}`;
}

// A pdf states each page box in points, 72 to the inch.
function pageBoxes(buffer) {
  const text = buffer.toString("latin1");
  const boxes = [];
  if (process.env.PDFCHECK_RAW) {
    const sample = text.match(/MediaBox[^\]]*\]/);
    console.log("    raw:", sample ? sample[0] : "no MediaBox in plain text");
  }
  const pattern = /MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g;
  let found = pattern.exec(text);
  while (found) {
    boxes.push({
      widthIn: (Number(found[3]) - Number(found[1])) / 72,
      heightIn: (Number(found[4]) - Number(found[2])) / 72,
    });
    found = pattern.exec(text);
  }
  return boxes;
}

app.whenReady().then(async () => {
  let failed = 0;
  const window_ = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  for (const [name, widthIn, heightIn] of SHEETS) {
    try {
      // a file is more reliable than a long data url, which failed to
      // load at all on the second window
      const page = path.join(os.tmpdir(), `pdfcheck-${name}.html`);
      fs.writeFileSync(page, sheetHtml(widthIn, heightIn,
        ["#eeeeee", "#dddddd", "#cccccc"]), "utf-8");
      await window_.loadFile(page);
      const pdf = await window_.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: widthIn, height: heightIn },
        margins: { marginType: "none" },
      });
      const file = path.join(os.tmpdir(), `pdfcheck-${name}.pdf`);
      fs.writeFileSync(file, pdf);

      const boxes = pageBoxes(pdf);
      const wrong = boxes.filter((b) =>
        Math.abs(b.widthIn - widthIn) > 0.02 || Math.abs(b.heightIn - heightIn) > 0.02);
      if (boxes.length !== 3) {
        console.log(` FAIL  ${name}: ${boxes.length} pages, expected 3`);
        failed += 1;
      } else if (wrong.length) {
        console.log(` FAIL  ${name}: measured ${wrong[0].widthIn.toFixed(2)}`
          + ` x ${wrong[0].heightIn.toFixed(2)}in, declared ${widthIn} x ${heightIn}`);
        failed += 1;
      } else {
        console.log(`  ok   ${name}: 3 pages at ${boxes[0].widthIn.toFixed(2)}`
          + ` x ${boxes[0].heightIn.toFixed(2)}in`);
      }
    } catch (error) {
      console.log(` FAIL  ${name}: ${error.message}`);
      failed += 1;
    }
  }
  window_.destroy();
  console.log(`\n${SHEETS.length - failed}/${SHEETS.length} sheets measured as declared`);
  app.exit(failed ? 1 : 0);
});
