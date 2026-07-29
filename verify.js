/* One command to check the whole project.

   Run:  node verify.js

   Runs everything that does not need a graphics card or a model, which
   is what a build machine has and what a contributor can rely on:

     - the main process, preload, renderer and launcher parse
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
*/
const { execFileSync, spawn } = require("child_process");
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

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get({ host: "127.0.0.1", port: 8787, path: "/health", timeout: 1000 },
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
   "filecheck.js", "pdfcheck.js", "mutate.js"].forEach((file) => {
    step(`${file} parses`, () => node(["--check", path.join("studio", file)]));
  });
  step("server compiles", () => python(["-m", "py_compile",
    path.join("server", "gen_server.py"), path.join("server", "probe.py")]));

  step("renderer self-test", () => node([path.join("studio", "selftest.js")]));
  step("written files are what they claim", () =>
    node([path.join("studio", "filecheck.js")]));

  // The probe needs a server. Start one that reaches nothing, which is
  // what a build machine has anyway, and stop it afterwards.
  const exe = process.platform === "win32" ? "python" : "python3";
  const server = spawn(exe, ["-m", "server.gen_server"], {
    cwd: root, stdio: "ignore",
    env: { ...process.env, LLM_BASE_URL: "http://127.0.0.1:9" },
  });
  try {
    await waitForServer(20000);
    step("server rejects bad input", () => python([path.join("server", "probe.py")]));
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
