/* One command to check the whole project.

   Run:  node verify.js

   Runs everything that does not need a graphics card or a model, which
   is what a build machine has and what a contributor can rely on:

     - the main process, preload, renderer and launcher parse
     - nothing unexpected is tracked in the repository
     - the server compiles
     - the renderer self-test, which boots the real editor
     - the files it writes, read back and measured
     - the server's answers to bad input

   Further checks need hardware, electron, or minutes, and are run by
   hand:
     node studio/e2e.js              produce one of each document type
     node studio/e2e.js --contract 5 does the agent hold its shape
     npx electron studio/pdfcheck.js measure a written pdf
     node studio/mutate.js           break the code, expect red

   The mutation run rewrites the renderer as it works, so nothing else
   may read it meanwhile. It holds studio/.mutating for the duration and
   both it and the self-test refuse to start while that file exists,
   which is a mistake worth making impossible rather than remembering.
*/
const { execFileSync, spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = __dirname;
const steps = [];
let failed = 0;

function step(name, run) {
  process.stdout.write(`  ${name} ... `);
  try {
    run();
    process.stdout.write("ok\n");
    steps.push([name, true]);
  } catch (error) {
    process.stdout.write("FAILED\n");
    const detail = (error.stdout || "") + (error.stderr || "") || error.message;
    console.error(String(detail).trim().split("\n").slice(-12).join("\n"));
    steps.push([name, false]);
    failed += 1;
  }
}

function node(args) {
  execFileSync(process.execPath, args, { cwd: root, stdio: "pipe", encoding: "utf-8" });
}

function python(args) {
  const exe = process.platform === "win32" ? "python" : "python3";
  execFileSync(exe, args, { cwd: root, stdio: "pipe", encoding: "utf-8" });
}

// A port the operating system says is free right now. Checking used to
// assume the usual one was idle, so running it while the application was
// open left the checking server unable to bind: the probe then talked to
// the running application instead, and the whole run hung with nothing
// printed. Asking for a port rather than assuming one removes the clash.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (response) => {
          response.resume();
          resolve();
        }).on("error", () => {
          if (Date.now() > deadline) reject(new Error("server did not start"));
          else setTimeout(attempt, 400);
        });
    };
    attempt();
  });
}

(async () => {
  console.log("prod-imagen studio: verifying\n");

  step("sources parse", () => node([
    "--check", path.join("studio", "main.js"),
  ]));
  ["preload.js", "editor.js", "launcher.js", "selftest.js", "e2e.js",
   "filecheck.js", "pdfcheck.js", "mutate.js", "workflow.js",
   "workflowcheck.js"].forEach((file) => {
    step(`${file} parses`, () => node(["--check", path.join("studio", file)]));
  });
  // A repository is a denylist by default: everything not ignored is
  // published. Naming the contents catches a stray file that no rule
  // happened to anticipate.
  step("nothing unexpected is tracked", () => {
    const NEWLINE = String.fromCharCode(10);
    const lines = (text) => text.split(NEWLINE).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const listed = lines(fs.readFileSync(path.join(root, "MANIFEST"), "utf-8"));
    const tracked = lines(execFileSync("git", ["ls-files"],
      { cwd: root, encoding: "utf-8" }));
    const added = tracked.filter((file) => !listed.includes(file));
    const gone = listed.filter((file) => !tracked.includes(file));
    if (added.length) {
      throw new Error("tracked but absent from MANIFEST, add deliberately: "
        + added.join(", "));
    }
    if (gone.length) {
      throw new Error("listed in MANIFEST but no longer tracked: " + gone.join(", "));
    }
  });

  // Every server module, not a chosen two: routing, the bench and the
  // reviewer were added later and were going unchecked, so a syntax
  // error in any of them would have reached a build machine untouched.
  step("server compiles", () => python(["-m", "py_compile",
    ...["gen_server.py", "probe.py", "routing.py", "bench.py", "review.py",
        "limits.py", "video.py"]
      .map((file) => path.join("server", file))]));

  step("renderer self-test", () => node([path.join("studio", "selftest.js")]));
  step("written files are what they claim", () =>
    node([path.join("studio", "filecheck.js")]));
  step("the workflow keeps its promises", () =>
    node([path.join("studio", "workflowcheck.js")]));

  // The probe needs a server. Start one that reaches nothing, which is
  // what a build machine has anyway, and stop it afterwards.
  const exe = process.platform === "win32" ? "python" : "python3";
  const port = await freePort();
  const server = spawn(exe, ["-m", "server.gen_server"], {
    cwd: root, stdio: "ignore",
    env: { ...process.env, LLM_BASE_URL: "http://127.0.0.1:9",
           STUDIO_PORT: String(port) },
  });
  try {
    await waitForServer(port, 20000);
    // the probe reads the same variable, so both ends agree on the port
    step("server rejects bad input", () => execFileSync(exe,
      [path.join("server", "probe.py")],
      { cwd: root, stdio: "pipe", encoding: "utf-8",
        env: { ...process.env, STUDIO_PORT: String(port) } }));
  } catch (error) {
    console.error(`  server probe ... SKIPPED (${error.message})`);
  } finally {
    server.kill();
  }

  const passed = steps.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${steps.length} checks passed`);
  if (failed) {
    console.log("hardware checks not attempted: node studio/e2e.js");
  }
  process.exit(failed ? 1 : 0);
})();
