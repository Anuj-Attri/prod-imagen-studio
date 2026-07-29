/* prod-imagen studio: project launcher.
   Kept out of the HTML so the page can run under a strict
   Content-Security-Policy that forbids inline script. */
// the footer states the running version rather than a number that
// drifts out of step with the manifest
if (window.studio && window.studio.version) {
  window.studio.version().then((v) => {
    if (v) document.getElementById("version").textContent = "prod-imagen studio " + v;
  });
}

let mode = "image";
let kind = "manga";
document.getElementById("win-close").onclick = () => window.studio.win("close");
document.getElementById("win-min").onclick = () => window.studio.win("min");

document.querySelectorAll(".tile").forEach((tile) => {
  tile.addEventListener("click", () => {
    document.querySelectorAll(".tile").forEach((t) => t.classList.remove("sel"));
    tile.classList.add("sel");
    mode = tile.dataset.mode;
  });
});
document.querySelectorAll(".kind").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".kind").forEach((c) => c.classList.remove("sel"));
    chip.classList.add("sel");
    kind = chip.dataset.kind;
    const names = {
      manga: "Untitled manga", anime: "Untitled illustration",
      coloring: "Untitled coloring book", poster: "Untitled poster",
      card: "Untitled card", blueprint: "Untitled blueprint",
      free: "Untitled canvas",
    };
    const input = document.getElementById("project-name");
    if (input.value.startsWith("Untitled")) input.value = names[kind];
  });
});

document.getElementById("create").addEventListener("click", () => {
  if (mode === "video") return alert("Video projects arrive in phase 2. Start with an Image project.");
  window.studio.openProject({
    name: document.getElementById("project-name").value.trim() || "Untitled",
    mode, kind, created: new Date().toISOString(),
  });
});
document.getElementById("open-existing").addEventListener("click", async () => {
  const file = await window.studio.readFileDialog();
  if (!file) return;
  const project = JSON.parse(file.contents);
  project._path = file.path;
  window.studio.openProject(project);
});
