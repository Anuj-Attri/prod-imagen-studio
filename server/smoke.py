"""Drive the real endpoints over HTTP, the way the application does.

Run:  python server/smoke.py            (against a local server)
      STUDIO_SMOKE_URL=https://... python server/smoke.py

This exists because of a release that passed every check and did not work.
The checks in verify.js cover parsing, contracts, layout and hostile input,
and none of them ever sent a real brief to a real model — so a page of six
panels with dialogue overran its token budget, came back truncated, and put
broken JSON in the chat log where an answer belonged. Twenty checks green,
application unusable, found by the person using it.

So this does the one thing those cannot: it asks for the thing somebody
actually asks for, over the wire, and looks at what comes back. It costs
money and takes a couple of minutes, which is why it is not in verify.js and
is run before a release instead.

What it insists on, for each endpoint:

  the request succeeds
  the answer is the shape the renderer expects
  nothing that is not a message is presented as one
  the work asked for is the work returned
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("STUDIO_SMOKE_URL",
                      "http://127.0.0.1:" + os.environ.get("STUDIO_PORT", "8787"))
TOKEN = os.environ.get("STUDIO_SMOKE_TOKEN", "")

BRIEF = (
    "An 8-page manga chapter: the page where a fighter who has been losing "
    "all chapter stops losing. In the register of The Climber by Shinichi "
    "Sakamoto, staged with the aura of Onigashima. No names, no character "
    "designs: refer to people by role. Talk: two or three balloons in most "
    "panels, full sentences, the crowd shouting over itself."
)


def post(path, body, timeout=420):
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    request = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def looks_like_a_message(text):
    """Whether this is something a person was meant to read.

    Raw JSON and a reasoning model's thinking both used to reach the chat
    log. Neither is a message, and both made the application look as though
    it were talking nonsense to itself.
    """
    stripped = str(text or "").strip()
    if not stripped:
        return False, "empty"
    if stripped.startswith(("{", "[")):
        return False, "raw JSON"
    if stripped.startswith("**"):
        return False, "a model's internal reasoning"
    if len(stripped) > 400:
        return False, f"{len(stripped)} characters, which is not a reply"
    return True, ""


def main():
    failures = []
    print(f"smoke: {BASE}\n")

    # ---------------------------------------------------------------- health --
    try:
        with urllib.request.urlopen(BASE + "/health", timeout=120) as response:
            health = json.loads(response.read())
        print(f"  ok      health: build {health.get('build')} "
              f"story={health.get('story')} apis={health.get('apis')}")
        if not health.get("story"):
            print("\nno language backend: nothing below can run")
            return 1
    except Exception as error:
        print(f" FAIL     health: {type(error).__name__}: {error}")
        return 1

    # ------------------------------------------------------------ the plan --
    started = time.time()
    try:
        plan = post("/agent/plan", {
            "messages": [{"role": "user", "content": BRIEF}],
            "kind": "manga", "art_style": "Manga (black and white)",
            "layout": "panels", "pages_wanted": 8, "cast": [], "pages": [],
        })
        elapsed = time.time() - started
        pages = plan.get("pages") or []
        counts = [p.get("panels") for p in pages]
        print(f"  ok      plan: {len(pages)} pages in {elapsed:.0f}s, "
              f"panels {counts}")
        print(f"          researched: {plan.get('researched')} "
              f"({plan.get('style_confidence') or 'none'})")

        if len(pages) < 2:
            failures.append(f"the plan came back with {len(pages)} pages")
        # Every page must say what happens and what changes. A blank one is
        # the "nothing happens" failure, visible before anything is drawn.
        for index, page in enumerate(pages, 1):
            if len(str(page.get("beat", ""))) < 40:
                failures.append(f"page {index}'s beat is too thin to draw from")
            if not str(page.get("changes", "")).strip():
                failures.append(f"page {index} changes nothing")
        if len(set(counts)) < 3:
            failures.append(f"panel counts barely vary: {counts}")
    except Exception as error:
        failures.append(f"plan: {type(error).__name__}: {error}")
        print(f" FAIL     plan: {type(error).__name__}: {error}")
        pages = []

    # -------------------------------------------------------------- a page --
    # Six panels with dialogue: exactly the request that used to overrun its
    # budget and come back as broken JSON.
    started = time.time()
    try:
        page = post("/agent/chat", {
            "messages": [{"role": "user", "content":
                "Draw page 1 of 8. What happens: the enemy walks the fighter "
                "backward with short clean strikes like routine paperwork, "
                "knocks him down, pins him with a boot. Use exactly 6 panels."
                "\n\nThe brief: " + BRIEF}],
            "kind": "manga", "art_style": "Manga (black and white)",
            "layout": "panels", "panels_wanted": 6, "cast": [], "pages": [],
        })
        elapsed = time.time() - started
        panels = page.get("panels") or []
        balloons = sum(len(p.get("dialogue") or []) for p in panels)
        reply = page.get("reply", "")
        print(f"  ok      page: {len(panels)} panels, {balloons} balloons "
              f"in {elapsed:.0f}s")
        print(f"          reply: {reply[:90]}")

        readable, why = looks_like_a_message(reply)
        if not readable:
            failures.append(f"the reply is not a message: {why}")
        if len(panels) != 6:
            failures.append(f"asked for 6 panels, got {len(panels)}")
        if balloons < 6:
            failures.append(f"only {balloons} balloons across the page, which "
                            f"is the sparse dialogue this was meant to fix")
        if any(not str(p.get("prompt", "")).strip() for p in panels):
            failures.append("a panel came back with no prompt, so it cannot "
                            "be drawn")
    except Exception as error:
        failures.append(f"page: {type(error).__name__}: {error}")
        print(f" FAIL     page: {type(error).__name__}: {error}")

    print()
    for problem in failures:
        print(f" FAIL     {problem}")
    print("smoke passed" if not failures else f"{len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
