/* The order work happens in, and what survives when it is redone.

   A workflow is a list of steps that turns an idea into a document. The
   engine here decides what to run, what to leave alone, and what to warn
   about. It holds no state of its own: a run is a plain object that
   lives in the document, so closing the application and opening it again
   resumes exactly where it stopped.

   Two rules shape everything else.

   The first is that a step is only stale if something it depends on
   actually changed. Redoing the lettering should not redraw the art.

   The second is that work a person touched is never quietly thrown away.
   An automated pipeline that regenerates everything from the top is
   fine for a build and useless for a drawing, because the parts worth
   keeping are exactly the parts someone corrected by hand. Edited steps
   are kept and reported as needing attention, and discarding one has to
   be asked for. */

const STATUS = {
  PENDING: "pending",   // never run
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  STALE: "stale",       // ran, but something upstream changed since
};

// Which step feeds which. A step is stale when any of its sources has
// been rerun more recently than it has.
const TEMPLATES = {
  manga: [
    { id: "story", needs: [], label: "Read the premise" },
    { id: "page_plan", needs: ["story"], label: "Plan the pages" },
    { id: "beats", needs: ["page_plan"], label: "Break into panels" },
    { id: "art_prompt", needs: ["beats"], label: "Describe each panel" },
    { id: "art", needs: ["art_prompt"], label: "Draw the panels" },
    { id: "dialogue", needs: ["beats"], label: "Write the dialogue" },
    { id: "letter", needs: ["dialogue", "art"], label: "Place the lettering" },
  ],
  coloring: [
    { id: "story", needs: [], label: "Read the premise" },
    { id: "page_plan", needs: ["story"], label: "Plan the pages" },
    { id: "art_prompt", needs: ["page_plan"], label: "Describe each page" },
    { id: "art", needs: ["art_prompt"], label: "Draw the line art" },
  ],
  poster: [
    { id: "story", needs: [], label: "Read the brief" },
    { id: "art_prompt", needs: ["story"], label: "Describe the image" },
    { id: "art", needs: ["art_prompt"], label: "Make the image" },
    { id: "dialogue", needs: ["story"], label: "Write the words" },
    { id: "letter", needs: ["dialogue", "art"], label: "Set the type" },
  ],
  blueprint: [
    { id: "story", needs: [], label: "Read the brief" },
    { id: "page_plan", needs: ["story"], label: "Identify the parts" },
    { id: "diagram", needs: ["page_plan"], label: "Draw the diagram" },
    { id: "letter", needs: ["diagram"], label: "Label it" },
  ],
  card: [
    { id: "story", needs: [], label: "Read the brief" },
    { id: "art_prompt", needs: ["story"], label: "Describe the front" },
    { id: "art", needs: ["art_prompt"], label: "Make the front" },
    { id: "dialogue", needs: ["story"], label: "Write the greeting" },
    { id: "letter", needs: ["dialogue", "art"], label: "Set the greeting" },
  ],
};

function templateFor(kind) {
  return TEMPLATES[kind] || TEMPLATES.manga;
}

// A fresh run: every step pending, nothing done, nothing owned.
function startRun(kind, brief) {
  return {
    kind,
    brief: brief || "",
    clock: 0,                 // counts reruns, so order can be compared
    steps: templateFor(kind).map((step) => ({
      id: step.id,
      label: step.label,
      needs: step.needs.slice(),
      status: STATUS.PENDING,
      output: null,
      model: null,
      cost: null,
      edited: false,          // a person changed this by hand
      ranAt: null,            // value of clock when it last produced output
    })),
  };
}

function stepOf(run, id) {
  return run.steps.find((step) => step.id === id) || null;
}

/* Whether a step's sources have moved on since it last ran.

   Compared by the run's own counter rather than by wall clock: two steps
   finishing in the same millisecond is common, and a clock that only
   advances when something is actually redone cannot drift. */
function isStale(run, step, seen) {
  if (step.ranAt === null) return false;         // never ran; pending, not stale
  const visited = seen || new Set();
  if (visited.has(step.id)) return false;        // a cycle cannot make itself stale
  visited.add(step.id);
  return step.needs.some((id) => {
    const source = stepOf(run, id);
    if (!source || source.ranAt === null) return false;
    if (source.ranAt > step.ranAt) return true;
    // Staleness carries. If the panel descriptions are out of date then
    // so is the art drawn from them, even though the descriptions have
    // not been rewritten yet and so still look older than the art. Only
    // comparing against immediate sources left the far end of the chain
    // reporting itself as current while resting on stale work.
    return isStale(run, source, visited);
  });
}

// The live view: pending and stale are both "wants running", but only
// one of them has work to lose.
function statusOf(run, step) {
  if (step.status === STATUS.RUNNING || step.status === STATUS.FAILED) {
    return step.status;
  }
  if (isStale(run, step)) return STATUS.STALE;
  return step.status;
}

/* What to run next, and what running it would disturb.

   Returns the first step whose sources are all satisfied and which has
   not produced current output. Nothing is started whose inputs are not
   ready, so a run can be resumed from any point without checking by
   hand what happened to be finished. */
function nextStep(run) {
  for (const step of run.steps) {
    const state = statusOf(run, step);
    if (state === STATUS.DONE || state === STATUS.RUNNING) continue;
    const ready = step.needs.every((id) => {
      const source = stepOf(run, id);
      return source && source.ranAt !== null && statusOf(run, source) !== STATUS.FAILED;
    });
    if (ready) return step;
  }
  return null;
}

/* Everything downstream of a step, in order.

   Used to answer "what does redoing this affect" before it is redone
   rather than after, which is the difference between a warning and an
   apology. */
function downstreamOf(run, id) {
  const affected = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.shift();
    for (const step of run.steps) {
      if (step.needs.includes(current) && !affected.includes(step.id)) {
        affected.push(step.id);
        queue.push(step.id);
      }
    }
  }
  return affected;
}

/* Work that a person edited and that redoing this step would strand.

   This is the question the interface has to ask before it starts, and
   the reason the engine reports it separately from the plain downstream
   list: losing generated output costs a rerun, losing edited output
   costs the person their work. */
function editedDownstream(run, id) {
  return downstreamOf(run, id)
    .map((each) => stepOf(run, each))
    .filter((step) => step && step.edited && step.ranAt !== null)
    .map((step) => step.id);
}

// Record that a step produced output. The clock advances here and only
// here, which is what makes staleness comparable.
function recordRun(run, id, { output, model, cost }) {
  const step = stepOf(run, id);
  if (!step) throw new Error("no step called " + id);
  run.clock += 1;
  step.output = output;
  step.model = model || null;
  step.cost = typeof cost === "number" ? cost : null;
  step.status = STATUS.DONE;
  step.ranAt = run.clock;
  step.edited = false;        // regenerated output is no longer hand-made
  return step;
}

function recordFailure(run, id, message) {
  const step = stepOf(run, id);
  if (!step) throw new Error("no step called " + id);
  step.status = STATUS.FAILED;
  step.error = String(message || "failed");
  return step;
}

/* A person changed this step's output by hand.

   The clock advances so that anything downstream is correctly stale
   against the edit: a hand-written line of dialogue should send the
   lettering back for placement just as a regenerated one would. */
function recordEdit(run, id, output) {
  const step = stepOf(run, id);
  if (!step) throw new Error("no step called " + id);
  run.clock += 1;
  step.output = output;
  step.status = STATUS.DONE;
  step.ranAt = run.clock;
  step.edited = true;
  return step;
}

// How far along, for something honest to show while it works.
function progress(run) {
  const total = run.steps.length;
  const done = run.steps.filter((step) => statusOf(run, step) === STATUS.DONE).length;
  const spent = run.steps.reduce((sum, step) => sum + (step.cost || 0), 0);
  return { done, total, spent: Math.round(spent * 10000) / 10000 };
}

/* Reopen a run saved in a document.

   Anything caught mid-flight when the application closed is put back to
   pending: a step that claims to be running is lying, because nothing is
   running. Its output was never recorded, so there is nothing to lose. */
function resume(run) {
  if (!run || !Array.isArray(run.steps)) return null;
  const restored = {
    kind: run.kind || "manga",
    brief: run.brief || "",
    clock: typeof run.clock === "number" ? run.clock : 0,
    steps: run.steps.map((step) => ({
      id: step.id,
      label: step.label || step.id,
      needs: Array.isArray(step.needs) ? step.needs.slice() : [],
      status: step.status === STATUS.RUNNING ? STATUS.PENDING : (step.status || STATUS.PENDING),
      output: step.output === undefined ? null : step.output,
      model: step.model || null,
      cost: typeof step.cost === "number" ? step.cost : null,
      edited: Boolean(step.edited),
      ranAt: typeof step.ranAt === "number" ? step.ranAt : null,
    })),
  };
  // A clock behind its own steps would make everything look current
  // forever, which is the one way staleness can fail silently.
  const highest = restored.steps.reduce(
    (top, step) => Math.max(top, step.ranAt === null ? 0 : step.ranAt), 0);
  if (restored.clock < highest) restored.clock = highest;
  return restored;
}

const api = {
  STATUS, TEMPLATES, templateFor, startRun, stepOf, statusOf, isStale,
  nextStep, downstreamOf, editedDownstream, recordRun, recordFailure,
  recordEdit, progress, resume,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.workflow = api;
