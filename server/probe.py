"""Hostile input probe for the generation server.

Run:  python server/probe.py

This server is meant to be deployable, so a bad request must be answered
plainly, must never drop the connection, and must never hand back the
name of an internal error.
"""
import json
import os
import sys
import urllib.error
import urllib.request

# The port is not fixed. A checking run starts its own server on a free
# port so that it never collides with one already open on the machine,
# which used to make the whole run hang with no explanation.
BASE = "http://127.0.0.1:" + os.environ.get("STUDIO_PORT", "8787")


def call(path, body=None, raw=None, method="POST"):
    data = raw if raw is not None else (
        json.dumps(body).encode() if body is not None else b"")
    request = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()[:200].decode(errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read()[:200].decode(errors="replace")
    except Exception as error:                      # connection dropped
        return None, str(error)[:150]


# Rejected before any engine or model is consulted, so these hold
# anywhere, including a continuous integration machine with neither.
VALIDATION_CASES = [
    ("malformed JSON body", "/generate", None, b"{ not json at all", 400),
    ("empty body", "/generate", None, b"", 400),
    ("missing prompt", "/generate", {"engine": "local-gpu"}, None, 400),
    ("unknown engine", "/generate", {"engine": "nonesuch", "prompt": "x"}, None, 400),
    ("prompt far too long", "/generate",
     {"engine": "local-gpu", "prompt": "a " * 60000}, None, 400),
    ("unknown endpoint", "/nope", {}, None, 404),
]

# These reach the language backend, so they need one to be configured.
BACKEND_CASES = [
    ("agent: no messages", "/agent/chat", {}, None, 200),
    ("agent: messages not a list", "/agent/chat", {"messages": "hello"}, None, 200),
    ("agent: entries not objects", "/agent/chat", {"messages": ["hi", 3]}, None, 200),
    ("agent: only junk roles", "/agent/chat",
     {"messages": [{"role": "system", "content": "x"}]}, None, 200),
    ("story: empty payload", "/story/analyze", {}, None, 200),
]


def language_backend_present():
    status, detail = call("/health", method="GET")
    if status != 200:
        return False
    try:
        return bool(json.loads(detail).get("story"))
    except Exception:
        return False


# Checks that need no server and no model, so they run everywhere and cost
# nothing. Every one of these is a defect that reached an installed copy and
# was found by the person using it rather than by anything here.
def offline_checks():
    problems = []
    # Run as a script (python server/probe.py), so there is no package context
    # and "server.gen_server" cannot resolve on its own. The repository root
    # is the directory above this file.
    import importlib
    import pathlib
    root = str(pathlib.Path(__file__).resolve().parent.parent)
    if root not in sys.path:
        sys.path.insert(0, root)
    gen = importlib.import_module("server.gen_server")

    # A page's token budget must grow with the page. A flat 1400 could not
    # hold six panels of dialogue: the reply stopped mid-string with
    # finish_reason "length", the JSON would not parse, and what reached the
    # chat log was a wall of broken text with no page drawn.
    budget = gen.page_token_budget
    if budget(9) < budget(1) * 2:
        problems.append("the page token budget barely grows with panel count")
    if budget(6) < 4000:
        problems.append(f"a six panel page is budgeted {budget(6)} tokens; "
                        "that is the size that produced truncated replies")

    # A reply that did not parse must be flagged, never passed off as the
    # agent's own words.
    truncated = gen.parse_agent_json('{"reply":"Built page 1","cast":[{"name":"Ka')
    if not truncated.get("unparsed"):
        problems.append("a truncated reply was not flagged as unparsed")
    reasoning = gen.parse_agent_json(
        "**Planning panel setup** I need to create a page with 2 to 6 panels.")
    if not reasoning.get("unparsed"):
        problems.append("a reasoning model's thinking was accepted as a reply")
    good = gen.parse_agent_json('{"reply":"Built it.","panels":[]}')
    if good.get("unparsed"):
        problems.append("a valid reply was wrongly flagged as unparsed")
    if good.get("reply") != "Built it.":
        problems.append("a valid reply did not survive parsing")

    # Analysing a story with no pages must not call a model at all: it was
    # buying the deep tier to be told there is no story yet.
    empty = gen.analyze_story({"pages": []}, {})
    if empty.get("chapter") or empty.get("flags"):
        problems.append("an empty story analysis invented content")

    return problems


def main():
    print("offline checks (no server, no model):")
    problems = offline_checks()
    for problem in problems:
        print(f" FAIL     {problem}")
    print("  ok      page budget scales; unusable replies are flagged\n"
          if not problems else "")

    cases = list(VALIDATION_CASES)
    if language_backend_present():
        cases += BACKEND_CASES
    else:
        print("no language backend configured: checking input validation only\n")

    failures = 0
    for name, path, body, raw, expected in cases:
        status, detail = call(path, body, raw)
        if status is None:
            print(f" DROPPED  {name}: {detail}")
            failures += 1
            continue
        # an internal error name reaching a client is a leak, not a message
        leaked = any(word in detail for word in
                     ("Error:", "Exception", "Traceback", "object has no attribute"))
        if status != expected or leaked:
            print(f" FAIL     {name}: {status} (wanted {expected}) {detail[:110]}")
            failures += 1
        else:
            print(f"  ok      {name}: {status}")

    status, _ = call("/health", method="GET")
    alive = status == 200
    print(f"\nserver alive afterwards: {alive}")
    if not alive:
        failures += 1
    print(f"{len(cases) - failures}/{len(cases)} handled as intended")
    return 1 if (failures or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
