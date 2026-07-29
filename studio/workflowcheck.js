/* Does the workflow engine keep its two promises?

   Run:  node studio/workflowcheck.js

   The promises are that redoing one step does not redo the whole
   document, and that work someone edited by hand is never quietly
   thrown away. Both are easy to state, easy to believe, and easy to
   break with an ordinary sequence of edits, which is why they are
   checked here against sequences rather than single calls.
*/
const w = require("./workflow.js");

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

// Run every step of a fresh run, in the order the engine offers them.
function runAll(kind) {
  const run = w.startRun(kind || "manga", "a premise");
  let guard = 0;
  let step = w.nextStep(run);
  while (step && guard < 50) {
    w.recordRun(run, step.id, { output: step.id + " output", model: "m", cost: 0.01 });
    step = w.nextStep(run);
    guard += 1;
  }
  return run;
}

check("a fresh run offers the step that needs nothing first", () => {
  const run = w.startRun("manga", "a premise");
  const first = w.nextStep(run);
  return first && first.id === "story" ? true
    : "offered " + (first && first.id);
});

check("nothing downstream is offered before its sources exist", () => {
  const run = w.startRun("manga", "x");
  // lettering needs dialogue and art; neither has run
  const letter = w.stepOf(run, "letter");
  const ready = letter.needs.every((id) => w.stepOf(run, id).ranAt !== null);
  return ready === false && w.nextStep(run).id === "story" ? true
    : "lettering looked ready with no sources";
});

check("a run completes and reports what it spent", () => {
  const run = runAll("manga");
  const state = w.progress(run);
  return state.done === state.total && state.spent > 0 ? true
    : `finished ${state.done}/${state.total}, spent ${state.spent}`;
});

check("every template can run to completion", () => {
  const wrong = [];
  for (const kind of Object.keys(w.TEMPLATES)) {
    const run = runAll(kind);
    const state = w.progress(run);
    if (state.done !== state.total) wrong.push(`${kind} ${state.done}/${state.total}`);
  }
  return wrong.length === 0 ? true : "did not finish: " + wrong.join(", ");
});

check("redoing a step marks what follows it stale and nothing else", () => {
  const run = runAll("manga");
  w.recordRun(run, "beats", { output: "new beats", model: "m", cost: 0.01 });

  const stale = run.steps.filter((s) => w.statusOf(run, s) === w.STATUS.STALE)
    .map((s) => s.id).sort();
  // beats feeds art_prompt and dialogue; those feed art, then lettering
  const expected = ["art", "art_prompt", "dialogue", "letter"].sort();
  if (JSON.stringify(stale) !== JSON.stringify(expected)) {
    return "stale was " + stale.join(",") + " expected " + expected.join(",");
  }
  // and the things before it are untouched
  return w.statusOf(run, w.stepOf(run, "story")) === w.STATUS.DONE
    && w.statusOf(run, w.stepOf(run, "page_plan")) === w.STATUS.DONE
    ? true : "a step upstream of the change was disturbed";
});

check("redoing the last step disturbs nothing at all", () => {
  const run = runAll("manga");
  w.recordRun(run, "letter", { output: "again", model: "m", cost: 0.01 });
  const stale = run.steps.filter((s) => w.statusOf(run, s) === w.STATUS.STALE);
  return stale.length === 0 ? true
    : "disturbed " + stale.map((s) => s.id).join(",");
});

check("what a rerun would strand is knowable before it runs", () => {
  const run = runAll("manga");
  w.recordEdit(run, "dialogue", "a line someone wrote themselves");

  const atRisk = w.editedDownstream(run, "beats");
  return atRisk.includes("dialogue") ? true
    : "editing dialogue then asking about beats reported " + JSON.stringify(atRisk);
});

check("a step nobody edited is not reported as work at risk", () => {
  const run = runAll("manga");
  const atRisk = w.editedDownstream(run, "beats");
  return atRisk.length === 0 ? true
    : "reported generated output as work at risk: " + atRisk.join(",");
});

check("an edit sends what follows it back, exactly as a rerun would", () => {
  const run = runAll("manga");
  w.recordEdit(run, "dialogue", "hand written");
  // lettering places dialogue, so it must be stale after the edit
  return w.statusOf(run, w.stepOf(run, "letter")) === w.STATUS.STALE ? true
    : "lettering did not notice the dialogue changed";
});

check("an edited step is not offered again on its own", () => {
  const run = runAll("manga");
  w.recordEdit(run, "dialogue", "hand written");
  // the next thing to run is the lettering, not the dialogue just written
  const next = w.nextStep(run);
  return next && next.id === "letter" ? true
    : "offered " + (next && next.id) + " instead of the lettering";
});

check("regenerating a step clears the hand made mark", () => {
  const run = runAll("manga");
  w.recordEdit(run, "dialogue", "hand written");
  w.recordRun(run, "dialogue", { output: "machine written", model: "m", cost: 0.01 });
  return w.stepOf(run, "dialogue").edited === false ? true
    : "output from a model was still marked as someone's own work";
});

check("a failure stops what depends on it being offered", () => {
  const run = w.startRun("manga", "x");
  w.recordRun(run, "story", { output: "s", model: "m", cost: 0 });
  w.recordFailure(run, "page_plan", "the model refused");
  const next = w.nextStep(run);
  // beats needs page_plan, which failed, so there is nothing safe to run
  return next === null || next.id !== "beats" ? true
    : "offered work that depends on a step which failed";
});

check("a run reopens where it stopped", () => {
  const run = w.startRun("manga", "x");
  w.recordRun(run, "story", { output: "s", model: "m", cost: 0.02 });
  w.recordRun(run, "page_plan", { output: "p", model: "m", cost: 0.02 });

  const reopened = w.resume(JSON.parse(JSON.stringify(run)));
  const next = w.nextStep(reopened);
  const state = w.progress(reopened);
  return next && next.id === "beats" && state.done === 2 && state.spent === 0.04
    ? true : `offered ${next && next.id}, ${state.done} done, spent ${state.spent}`;
});

check("a step caught mid flight is offered again, not left running", () => {
  const run = w.startRun("manga", "x");
  w.recordRun(run, "story", { output: "s", model: "m", cost: 0 });
  const planning = w.stepOf(run, "page_plan");
  planning.status = w.STATUS.RUNNING;      // as if the power went out here

  const reopened = w.resume(JSON.parse(JSON.stringify(run)));
  const next = w.nextStep(reopened);
  return next && next.id === "page_plan" ? true
    : "after reopening, the next step was " + (next && next.id);
});

check("reopening keeps hand made work and its consequences", () => {
  const run = runAll("manga");
  w.recordEdit(run, "dialogue", "hand written");

  const reopened = w.resume(JSON.parse(JSON.stringify(run)));
  const dialogue = w.stepOf(reopened, "dialogue");
  return dialogue.edited === true
    && dialogue.output === "hand written"
    && w.statusOf(reopened, w.stepOf(reopened, "letter")) === w.STATUS.STALE
    ? true : "an edit did not survive being reopened";
});

check("a document with a clock behind its steps still detects staleness", () => {
  // the one way staleness fails silently: a saved clock lower than the
  // steps it is meant to order makes every later comparison meaningless
  const run = runAll("manga");
  w.recordRun(run, "beats", { output: "new", model: "m", cost: 0 });
  const damaged = JSON.parse(JSON.stringify(run));
  damaged.clock = 0;

  const reopened = w.resume(damaged);
  const stale = reopened.steps.filter((s) => w.statusOf(reopened, s) === w.STATUS.STALE);
  if (stale.length === 0) return "a damaged clock hid every stale step";
  // and a later rerun must still be able to move things on
  w.recordRun(reopened, "art_prompt", { output: "x", model: "m", cost: 0 });
  return w.statusOf(reopened, w.stepOf(reopened, "art")) === w.STATUS.STALE
    ? true : "after repair, a rerun no longer marked its dependants";
});

check("a document with no run in it does not crash the engine", () => {
  return w.resume(null) === null && w.resume({}) === null
    && w.resume({ steps: "not a list" }) === null ? true
    : "damaged input produced something that looked like a run";
});

check("an unknown document kind falls back rather than failing", () => {
  const run = w.startRun("something-nobody-added", "x");
  return run.steps.length > 0 && w.nextStep(run) !== null ? true
    : "an unknown kind produced a run that cannot start";
});

console.log(`\n${18 - failed}/18 workflow checks passed`);
process.exit(failed ? 1 : 0);
