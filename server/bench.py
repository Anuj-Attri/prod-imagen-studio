"""Run one step across several models and compare what comes back.

    python -m server.bench --step dialogue --input a-scene.txt
    python -m server.bench --step dialogue --input a-scene.txt --reveal

Choosing a model by reputation is choosing by marketing. This runs the
same step on the same input across candidates and reports what each one
produced, what it cost, and how long it took, so the choice rests on the
work rather than on a name.

Results are labelled A, B, C with the names held back until --reveal is
passed. A blind comparison is the point: brand recognition moves a
judgement more than most people expect, including mine.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from .routing import TIER_PREFERENCES, STEP_TIERS, fetch_catalogue

OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"
OUT_DIR = Path(__file__).resolve().parent.parent / "bench-output"

# What each step is actually asked to do, so a bench run measures the
# job the application performs rather than a generic chat reply.
STEP_TASKS = {
    "dialogue": (
        "You write manga dialogue. Given a scene, return the spoken lines "
        "only, one per panel, no narration and no scene description. Keep "
        "each line under 14 words."
    ),
    "beats": (
        "You break a scene into panel beats. Return one line per panel: a "
        "short visual description of what is shown. No dialogue."
    ),
    "page_plan": (
        "You plan manga page layouts. Given a scene, return the number of "
        "panels and a one-word shape for each (wide, tall, square, inset)."
    ),
    "art_prompt": (
        "You write danbooru-style tag prompts for an anime image model. "
        "Return comma-separated tags only. No prose, no sentences."
    ),
}


def candidates_for(step: str) -> list:
    """Who is on the ballot for a step: its own tier, plus the tier below.

    Comparing only within a tier cannot answer the question worth asking,
    which is whether the cheaper tier is already good enough.
    """
    tier = STEP_TIERS.get(step, "balanced")
    order = ["fast", "balanced", "deep"]
    below = order[max(0, order.index(tier) - 1)]
    names = list(TIER_PREFERENCES[tier])
    for name in TIER_PREFERENCES[below]:
        if name not in names:
            names.append(name)
    return names


def ask(model: str, system: str, user: str, key: str, timeout: int = 120) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "max_tokens": 2500,
    }).encode()
    request = urllib.request.Request(OPENROUTER_CHAT, data=body, headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "prod-imagen studio bench",
    })
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read())
    seconds = time.perf_counter() - started
    usage = payload.get("usage") or {}
    message = (payload.get("choices") or [{}])[0].get("message") or {}
    # A reasoning model can answer with an empty content field and put the
    # words somewhere else, or spend the whole reply on reasoning and send
    # back nothing at all. Reading only content scored those as crashes,
    # which blamed the model for a fault in the reading.
    text = (message.get("content") or message.get("reasoning") or "").strip()
    return {
        "text": text,
        "empty": not text,
        "in_tokens": usage.get("prompt_tokens", 0),
        "out_tokens": usage.get("completion_tokens", 0),
        "seconds": round(seconds, 2),
    }


def cost_of(model: str, result: dict, catalogue: dict) -> float | None:
    price = catalogue.get(model)
    if not price:
        return None
    return round((price["in"] * result["in_tokens"]
                  + price["out"] * result["out_tokens"]) / 1_000_000, 6)


def run(step: str, text: str, key: str, models: list | None = None) -> dict:
    system = STEP_TASKS.get(step)
    if not system:
        raise SystemExit(f"no task defined for step {step!r}; "
                         f"known: {', '.join(sorted(STEP_TASKS))}")
    catalogue = fetch_catalogue()
    names = models or candidates_for(step)
    entries = []
    for index, model in enumerate(names):
        label = chr(ord("A") + index)
        try:
            result = ask(model, system, text, key)
            entries.append({
                "label": label, "model": model, "ok": True,
                "text": result["text"], "empty": result["empty"],
                "seconds": result["seconds"],
                "in_tokens": result["in_tokens"], "out_tokens": result["out_tokens"],
                "cost": cost_of(model, result, catalogue),
            })
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read().decode()[:160]
            except Exception:
                pass
            entries.append({"label": label, "model": model, "ok": False,
                            "error": f"HTTP {error.code} {detail}"})
        except Exception as error:
            entries.append({"label": label, "model": model, "ok": False,
                            "error": str(error)})
    return {"step": step, "input": text, "entries": entries}


def report(run_data: dict, reveal: bool) -> str:
    lines = [f"# bench: {run_data['step']}", ""]
    if not reveal:
        lines += ["Names are withheld. Read the output, pick a letter, then "
                  "run again with --reveal.", ""]
    for entry in run_data["entries"]:
        name = entry["model"] if reveal else "(withheld)"
        lines.append(f"## {entry['label']}   {name}")
        if not entry["ok"]:
            lines += ["", "did not run: " + entry["error"], ""]
            continue
        if entry.get("empty"):
            # tokens spent with nothing to show is a result, not a crash:
            # it says this model cannot do this step at this prompt
            lines += ["", f"answered with nothing, after {entry['out_tokens']} "
                      f"tokens of reasoning. Not usable for this step.", ""]
            continue
        cost = entry["cost"]
        # a page is not one call; the run rate is what a chapter costs
        per_100 = f"${cost * 100:.2f}" if cost is not None else "unknown"
        lines += ["",
                  f"{entry['seconds']}s, {entry['out_tokens']} tokens out, "
                  f"{per_100} per 100 calls", "",
                  "```", entry["text"], "```", ""]
    return "\n".join(lines)


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--step", required=True, choices=sorted(STEP_TASKS))
    parser.add_argument("--input", required=True,
                        help="file holding the scene or page to run against")
    parser.add_argument("--models", help="comma separated, overrides the tier")
    parser.add_argument("--reveal", action="store_true",
                        help="show which model produced which answer")
    args = parser.parse_args(argv)

    source = Path(args.input)
    if not source.exists():
        print(f"no such file: {source}", file=sys.stderr)
        return 2

    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        keys = Path(__file__).with_name("keys.json")
        if keys.exists():
            key = (json.loads(keys.read_text()).get("openrouter") or "").strip()
    if not key:
        print("no OpenRouter key. Set OPENROUTER_API_KEY, or add an "
              "\"openrouter\" entry to server/keys.json.", file=sys.stderr)
        return 2

    models = [m.strip() for m in args.models.split(",")] if args.models else None
    run_data = run(args.step, source.read_text(encoding="utf-8"), key, models)

    OUT_DIR.mkdir(exist_ok=True)
    stamp = str(int(time.time()))
    (OUT_DIR / f"{args.step}-{stamp}.json").write_text(
        json.dumps(run_data, indent=2), encoding="utf-8")
    text = report(run_data, args.reveal)
    (OUT_DIR / f"{args.step}-{stamp}.md").write_text(text, encoding="utf-8")
    print(text)
    print(f"saved to {OUT_DIR / (args.step + '-' + stamp + '.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
