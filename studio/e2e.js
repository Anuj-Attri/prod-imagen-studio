/* End to end check of the product claim: for each document type, ask the
   real agent for a build and render it on the real engine, then write the
   art out to look at.

   Run:  node studio/e2e.js [outputDir]
   Needs the server on 8787 and an available image engine. Slow by
   nature: every image is really generated.

   This covers the server half of the chain. The client half, layout and
   lettering, is covered by selftest.js. */
const fs = require("fs");
const path = require("path");
const http = require("http");

const SERVER = { host: "127.0.0.1", port: 8787 };
const outDir = process.argv[2] || path.join(__dirname, "..", "e2e-output");

// The same style contract the editor applies, kept in step with
// STYLE_PRESETS in editor.js.
const STYLES = {
  manga: { tags: "monochrome, greyscale, manga, screentone, halftone shading, sharp ink linework, high contrast", negative: "" },
  coloring: {
    tags: "lineart, monochrome, coloring book page, thick clean outlines, white background, flat, uncoloured, simple shapes",
    negative: "color, colored, colorful, shading, shadow, gradient, greyscale, screentone, painting, photorealistic, texture, detailed background",
  },
  poster: {
    tags: "poster illustration, clear focal subject, bold composition, dramatic lighting, limited palette, uncluttered background",
    negative: "abstract, cluttered, busy background, text, letters",
  },
  card: { tags: "greeting card illustration, charming, warm, decorative border, centred composition, cheerful palette", negative: "" },
  blueprint: { tags: "", negative: "" },   // drawn as vectors, never generated
};

const CASES = [
  ["manga", "panels", "Build a page: a lone samurai girl faces a giant oni in a burning village at night.", { w: 832, h: 1216 }],
  ["coloring", "single", "A friendly dragon having a tea party with three rabbits in a garden.", { w: 1024, h: 1280 }],
  ["poster", "poster", "A poster for a jazz night at a basement club, moody and smoky.", { w: 896, h: 1152 }],
  ["card", "card", "A halloween card: a cute witch sitting on a pumpkin under a full moon.", { w: 1216, h: 832 }],
  ["blueprint", "blueprint", "A systems blueprint of a rainwater harvesting system for a house.", null],
];

function post(pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      ...SERVER, path: pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (error) { reject(new Error("bad response: " + error.message)); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;

  for (const [kind, layout, brief, size] of CASES) {
    const started = Date.now();
    try {
      const plan = await post("/agent/chat", {
        messages: [{ role: "user", content: brief }],
        project: "e2e", kind, layout, cast: [], pages: [],
      }, 400000);
      if (!plan.ok) throw new Error(plan.error || "agent failed");

      // A diagram is drawn from a graph, never generated
      if (layout === "blueprint") {
        const nodes = plan.nodes || [];
        const edges = plan.edges || [];
        if (nodes.length < 3) throw new Error(`only ${nodes.length} components`);
        const known = new Set(nodes.map((n) => n.id));
        const dangling = edges.filter((e) => !known.has(e.from) || !known.has(e.to));
        if (dangling.length) throw new Error("edges reference unknown components");
        fs.writeFileSync(path.join(outDir, "blueprint.json"),
          JSON.stringify({ nodes, edges }, null, 2));
        console.log(`  ok   blueprint: ${nodes.length} components, ${edges.length} flows, `
          + `${Math.round((Date.now() - started) / 1000)}s`);
        continue;
      }

      const panels = plan.panels || [];
      if (!panels.length) throw new Error("agent returned no panels");
      const cast = (plan.cast || []).map((c) => c.tags).join(", ");
      const style = STYLES[kind];
      const prompt = [cast, panels[0].prompt, style.tags].filter(Boolean).join(", ");

      const art = await post("/generate", {
        engine: "local-gpu", prompt, negative: style.negative,
        seed: 4242, width: size.w, height: size.h, no_text: true,
      }, 600000);
      if (!art.ok) throw new Error(art.error || "generation failed");

      fs.writeFileSync(path.join(outDir, `${kind}.png`),
        Buffer.from(art.image_base64, "base64"));
      const lines = panels.flatMap((p) => p.dialogue || []).length;
      console.log(`  ok   ${kind}: ${panels.length} panel(s), ${lines} lettering line(s), `
        + `${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
      console.log(` FAIL  ${kind}: ${error.message}`);
      failed += 1;
    }
  }

  console.log(`\n${CASES.length - failed}/${CASES.length} document types produced into ${outDir}`);
  process.exit(failed ? 1 : 0);
})();
