"""Find out what a style actually looks like, instead of guessing.

Asked to draw "in the register of The Climber", a model that has never
been told what that means produces generic manga and the brief is wasted.
Naming a work is the most natural way for somebody to describe what they
want, and it is exactly the thing a language model cannot do from the name
alone.

Two ways in:

  by name   research the work on the web and return usable features
  by image  look at a reference and describe what is on it

Both return the same shape, so a project's style contract can be built from
either and the rest of the application does not care which was used.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from . import routing

OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"

# Written to be pasted into an image prompt, not read as an essay. A
# description of a style is only useful here if it survives being
# concatenated onto a panel brief.
SYSTEM = """You describe visual styles so that another model can reproduce
them. Answer only as JSON, with these keys:

  "linework"    how lines are drawn: weight, density, hatching, texture
  "rendering"   light, shadow, screentone, contrast, level of detail
  "composition" framing, perspective, scale, page rhythm
  "palette"     colour or monochrome, and how tone is carried
  "avoid"       what would break the style if it appeared
  "tags"        8 to 14 short comma-separated phrases for an image prompt
  "confidence"  "high" if you know this work, "low" if you are inferring

Be concrete. "Dense crosshatching, almost no flat areas" is usable;
"beautiful detailed art" is not. If you do not know the work, say so in
confidence rather than inventing a plausible answer: a made-up style
description is worse than none, because it will be believed."""


def _ask(model: str, messages: list, key: str, timeout: int = 240) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM}] + messages,
        "max_tokens": 1400,
    }).encode()
    request = urllib.request.Request(OPENROUTER_CHAT, data=body, headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "Firestarter reference",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read())

    message = (payload.get("choices") or [{}])[0].get("message") or {}
    # Strip before choosing: a content field of whitespace is truthy, and
    # picking it discards an answer sitting in the reasoning field.
    text = ""
    for field in ("content", "reasoning"):
        candidate = (message.get(field) or "").strip()
        if candidate:
            text = candidate
            break
    if not text:
        raise RuntimeError(f"{model} replied with nothing")

    # Models wrap json in prose or in a fence often enough that insisting
    # on a bare object would fail on answers that are otherwise fine.
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError(f"{model} did not answer with JSON")
    return json.loads(text[start:end + 1])


def style_from_name(name: str, key: str) -> dict:
    """Research a named work and describe how it looks.

    Uses a model with web access, because the whole point is the part the
    model does not already know. OpenRouter exposes that by suffixing a
    model with :online.
    """
    base = routing.model_for("critique")["model"] or "openai/gpt-5-mini"
    model = base if base.endswith(":online") else base + ":online"
    found = _ask(model, [{"role": "user", "content":
        f"Research the visual style of: {name}. Look it up rather than "
        f"recalling it. If it is a manga, comic, film or artist, find what "
        f"is specifically said about how it is drawn."}], key)
    found["source"] = f"researched: {name}"
    found["model"] = model
    return found


def style_from_image(data_url: str, key: str, note: str = "") -> dict:
    """Describe the style of a reference image.

    For when somebody has the picture but not the name for it, which is
    the more common case: people know what they want to look at long
    before they know what to call it.
    """
    model = routing.image_reader()
    content = [{"type": "text", "text":
                "Describe the visual style of this image so another model "
                "could draw in it." + (f" Context: {note}" if note else "")},
               {"type": "image_url", "image_url": {"url": data_url}}]
    found = _ask(model, [{"role": "user", "content": content}], key)
    found["source"] = "from a reference image"
    found["model"] = model
    return found


def as_tags(found: dict) -> str:
    """The part that goes into an image prompt.

    Everything else is for a person to read. This is what actually reaches
    the model that draws, so it is kept short: a prompt carrying five
    paragraphs of style notes loses the subject of the panel.
    """
    tags = found.get("tags")
    if isinstance(tags, list):
        return ", ".join(str(t).strip() for t in tags if str(t).strip())
    return str(tags or "").strip()


def as_negative(found: dict) -> str:
    avoid = found.get("avoid")
    if isinstance(avoid, list):
        return ", ".join(str(a).strip() for a in avoid if str(a).strip())
    return str(avoid or "").strip()
