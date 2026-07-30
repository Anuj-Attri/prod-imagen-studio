"""Which model runs which step, and what that costs.

Model names go stale faster than anything else in this project, so nothing
here hard-codes a single answer. The catalogue is read from the provider at
run time and the preference lists below are consulted against it: the first
listed model that actually exists is used, and if none of them do, the
cheapest model that meets the tier's bar is. A model retired upstream costs
a fallback, not an outage.

Steps differ in what they need. Planning a page is structural work a small
fast model does well; writing dialogue that a person will read is not.
Paying top rates for every step spends money on the ones nobody can see the
difference in, so each step names a tier and the tier names the model.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.request

OPENROUTER_URL = "https://openrouter.ai/api/v1"

# Candidates per tier, ordered by what a call actually costs rather than
# by the quoted price per token. Those are not the same number and the
# gap is not small: on a dialogue scene, a model listed at $2.08 per
# million spent 18,762 tokens reasoning and cost $3.91 per hundred calls,
# while one listed at $25 per million answered in 455 tokens for $1.04.
# Sorting by sticker price would have picked the more expensive one and
# called it thrift.
#
# The comments give measured cost per hundred calls where a bench run
# exists (server/bench.py), and the list price otherwise. Anything
# missing from the live catalogue is skipped.
TIER_PREFERENCES = {
    "fast": [
        "qwen/qwen3.5-flash-02-23",       # 0.26
        "deepseek/deepseek-v4-flash",     # 0.28
        "google/gemini-2.5-flash",        # 1.20
    ],
    "balanced": [
        "z-ai/glm-4.6",                   # measured $0.36/100 on dialogue
        "openai/gpt-5-mini",              # measured $0.47/100
        "anthropic/claude-sonnet-5",      # 10.00 list
        # qwen/qwen3.5-122b-a10b is deliberately absent: cheap per token,
        # $3.91 per hundred calls in practice, from runaway reasoning.
    ],
    "deep": [
        "openai/gpt-5.2",                 # measured $0.31/100, 5.5s, best
                                          # adherence to the scene brief
        "anthropic/claude-opus-5",        # measured $1.04/100, distinctive
                                          # prose, three times the cost
        "moonshotai/kimi-k3",             # measured $1.12/100
        # google/gemini-3.1-pro-preview truncated the scene on two runs
    ],
}

# The bar a fallback must clear, in dollars per million output tokens. A
# tier that finds none of its preferred models takes the cheapest model
# priced inside its band, which keeps a fallback from quietly costing ten
# times what the step was worth.
TIER_CEILING = {"fast": 2.0, "balanced": 20.0, "deep": 80.0}
# And the bar it must not fall below. Without a floor, a tier that means
# "this step is worth paying for" could be answered by the cheapest model
# in the catalogue, which is how a fallback turns into a silent downgrade.
TIER_FLOOR = {"fast": 0.0, "balanced": 3.0, "deep": 8.0}

# Every step the orchestrator can run, and how much model it deserves.
STEP_TIERS = {
    "page_plan": "fast",         # how many panels, what shape
    "cast_tags": "fast",         # turning a description into tags
    "classify": "fast",
    "beats": "balanced",         # what happens in each panel
    "art_prompt": "balanced",
    "critique": "balanced",
    "dialogue": "deep",          # the words a reader actually reads
    "story": "deep",
}

# Image models, best first. Not specialists: these are frontier
# generalists, which for a poster or a page beats a general local
# checkpoint and, unlike a local checkpoint, works for somebody who has
# only installed the application. A specialist anime model through fal
# would still be better for manga panels specifically, and can be added
# alongside rather than instead.
IMAGE_MODELS = [
    "google/gemini-3-pro-image",
    "openai/gpt-5-image",
    "google/gemini-2.5-flash-image",
]


# Models that can look at a picture and say what is in it. Distinct from
# the ones that draw: reading and drawing are different jobs and the good
# models for each are not the same.
IMAGE_READERS = [
    "google/gemini-3.1-pro-preview",
    "openai/gpt-5.2",
    "anthropic/claude-opus-5",
]


def image_reader(catalogue: dict | None = None) -> str:
    """The first vision model the provider currently lists."""
    models = catalogue if catalogue is not None else fetch_catalogue()
    for identifier in IMAGE_READERS:
        if identifier in models:
            return identifier
    return IMAGE_READERS[0]


def image_model(catalogue: dict | None = None) -> str | None:
    """The first image model that the provider currently lists."""
    models = catalogue if catalogue is not None else fetch_catalogue()
    for identifier in IMAGE_MODELS:
        if identifier in models:
            return identifier
    return IMAGE_MODELS[0] if not models else None


_catalogue = {"at": 0.0, "models": {}, "error": None}
_lock = threading.Lock()
CATALOGUE_TTL = 3600


def fetch_catalogue(timeout: int = 10) -> dict:
    """Model id -> dollars per million tokens, read from the provider.

    Cached for an hour: the list changes on the provider's schedule, not
    on ours, and a page of art should not wait on it.
    """
    now = time.time()
    with _lock:
        if _catalogue["models"] and now - _catalogue["at"] < CATALOGUE_TTL:
            return _catalogue["models"]
    try:
        request = urllib.request.Request(OPENROUTER_URL + "/models",
                                         headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read())
        models = {}
        for entry in data.get("data", []):
            identifier = entry.get("id")
            pricing = entry.get("pricing") or {}
            if not identifier:
                continue
            try:
                # the provider quotes dollars per token; per million reads
                # better and is what the interface shows
                models[identifier] = {
                    "in": float(pricing.get("prompt") or 0) * 1_000_000,
                    "out": float(pricing.get("completion") or 0) * 1_000_000,
                    "context": entry.get("context_length"),
                }
            except (TypeError, ValueError):
                continue
        with _lock:
            _catalogue.update({"at": now, "models": models, "error": None})
        return models
    except Exception as error:                      # offline, blocked, down
        with _lock:
            _catalogue["error"] = str(error)
        return _catalogue["models"]


def model_for(step: str, catalogue: dict | None = None) -> dict:
    """The model to run one step on, with why it was chosen.

    Returns the tier, the model, its price, and whether the choice came
    from the preference list or from falling back, so the interface can
    say what it is about to spend rather than only what it spent.
    """
    tier = STEP_TIERS.get(step, "balanced")
    models = catalogue if catalogue is not None else fetch_catalogue()
    for identifier in TIER_PREFERENCES[tier]:
        if identifier in models:
            return {"step": step, "tier": tier, "model": identifier,
                    "price": models[identifier], "chosen": "preferred"}

    # Nothing preferred survives, so the tier picks from what is left.
    # Which end of the range to take depends on the tier: a cheap tier
    # wants the cheapest thing that works, while an expensive tier exists
    # precisely because the step is worth paying for. Taking the cheapest
    # for every tier would quietly answer "write the dialogue" with the
    # weakest model on offer, which is the opposite of what the tier means.
    ceiling = TIER_CEILING[tier]
    floor = TIER_FLOOR[tier]
    affordable = [(price["out"], identifier)
                  for identifier, price in models.items()
                  if floor <= price["out"] <= ceiling]
    if affordable:
        affordable.sort()
        identifier = (affordable[0] if tier == "fast" else affordable[-1])[1]
        return {"step": step, "tier": tier, "model": identifier,
                "price": models[identifier], "chosen": "fallback"}
    return {"step": step, "tier": tier, "model": None, "price": None,
            "chosen": "none"}


def estimate(steps: list, tokens_per_step: int = 2000,
             catalogue: dict | None = None) -> dict:
    """What a run of these steps is likely to cost, before it runs.

    A rough number shown in advance is worth more than an exact one shown
    afterwards, which is a receipt rather than a decision.
    """
    models = catalogue if catalogue is not None else fetch_catalogue()
    lines = []
    total = 0.0
    for step in steps:
        choice = model_for(step, models)
        if not choice["price"]:
            lines.append({**choice, "cost": None})
            continue
        # a step reads about twice what it writes
        cost = (choice["price"]["in"] * tokens_per_step * 2
                + choice["price"]["out"] * tokens_per_step) / 1_000_000
        total += cost
        lines.append({**choice, "cost": round(cost, 5)})
    return {"steps": lines, "total": round(total, 4)}
