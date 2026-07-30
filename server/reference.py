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
import threading
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


def _ask(model: str, messages: list, key: str, timeout: int = 240,
         blunt: bool = False) -> dict:
    system = SYSTEM
    if blunt:
        # A second attempt, for a model that answered in prose. Asking
        # again more plainly is cheaper and more reliable than parsing
        # around whatever it decided to write.
        system += (
            "\n\nYour previous answer was not JSON. Reply with a single "
            "JSON object and nothing else: no preamble, no explanation, "
            "no code fence.")
    request = {
        "model": model,
        "messages": [{"role": "system", "content": system}] + messages,
        "max_tokens": 1400,
        # Asked for at the protocol level as well as in words. A model with
        # web access narrates what it found unless told plainly not to.
        "response_format": {"type": "json_object"},
    }
    body = json.dumps(request).encode()
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


def _ask_twice(model: str, messages: list, key: str) -> dict:
    """One retry, phrased more bluntly.

    A model with web access likes to narrate what it found, and research
    queries provoke that more than plain ones do. Failing the whole lookup
    over presentation would mean the feature works on simple names and not
    on the descriptive ones people actually type.
    """
    try:
        return _ask(model, messages, key)
    except Exception:
        return _ask(model, messages, key, blunt=True)


def style_from_name(name: str, key: str) -> dict:
    """Research a named work and describe how it looks.

    Uses a model with web access, because the whole point is the part the
    model does not already know. OpenRouter exposes that by suffixing a
    model with :online.
    """
    base = routing.model_for("critique")["model"] or "openai/gpt-5-mini"
    model = base if base.endswith(":online") else base + ":online"
    found = _ask_twice(model, [{"role": "user", "content":
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
    found = _ask_twice(model, [{"role": "user", "content": content}], key)
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


# ---------------------------------------------------------- automatic use --
# Researched styles, kept for the life of the process. The same chapter asks
# about the same reference on every page, and researching it each time would
# be slow and would be paid for repeatedly.
_known = {}
_asked = {}                 # message text -> the names found in it
_known_lock = threading.Lock()

# How long a page will wait for research before going ahead without it.
# Looking two references up took over two minutes, and nobody should watch
# a blank page for that. Whatever arrives late is cached, so the next page
# in the same chapter gets it: the first page is a little less faithful and
# every page after it is right, which is a better trade than a page that
# never appears.
BUDGET_SECONDS = float(os.environ.get("STUDIO_RESEARCH_SECONDS", "40"))

# Phrases people actually use when they mean "look like this". Checked
# before spending anything: most messages name no reference at all, and a
# model call to establish that would be a charge for nothing.
CUES = (
    "style of", "styled like", "in the register of", "register of",
    "art of", "drawn like", "looks like", "look of", "aesthetic of",
    "vibe of", "vibes of", "meets", "reminiscent of", "inspired by",
    "like the manga", "like the anime", "similar to",
)


def looks_like_a_reference(text: str) -> bool:
    """Whether this message mentions something worth looking up.

    A cheap gate in front of a paid call. Two signals: an explicit cue, or a
    run of capitalised words in the middle of a sentence, which is how a
    title appears in prose.
    """
    lowered = str(text or "").lower()
    if any(cue in lowered for cue in CUES):
        return True

    # Any proper noun mid-sentence is enough. Requiring two in a row missed
    # the ordinary way people write it, as in "with the Climber surrealism",
    # where the title is one word among lower-case ones.
    #
    # Deliberately generous. It cannot tell a work from a character, and it
    # should not try: that is what the cheap model behind it decides, and
    # the research that actually costs something only runs on what that
    # model returns. A gate that guesses wrong here costs a fraction of a
    # penny; a gate that stays shut costs the whole feature.
    for word in str(text or "").split()[1:]:    # skip the first, always capital
        stripped = word.strip(".,;:!?\"'()[]")
        if len(stripped) > 2 and stripped[:1].isupper() and stripped.lower() != "i":
            return True
    return False


def _names_in(text: str, key: str) -> list:
    """The works, artists or styles this message is pointing at.

    Cached by the message itself. Without this, asking for a second page of
    the same chapter paid to establish the same names again, which is why a
    supposedly cached lookup still took most of a minute.
    """
    memo = str(text or "").strip().lower()[:400]
    with _known_lock:
        if memo in _asked:
            return list(_asked[memo])
    model = routing.model_for("classify")["model"] or "openai/gpt-5-mini"
    try:
        found = _ask(model, [{"role": "user", "content":
            "List any specific manga, comic, film, artist or named visual "
            "style this request wants the art to resemble. Answer as JSON: "
            '{"names": ["..."]}. An empty list if none are named. Do not '
            "include generic words like manga, anime or realistic.\n\n"
            + str(text or "")[:2000]}], key)
    except Exception:
        return []
    names = found.get("names")
    if not isinstance(names, list):
        names = []
    names = [str(n).strip() for n in names if str(n).strip()][:3]
    with _known_lock:
        _asked[memo] = list(names)
    return names


def research_for_bounded(text: str, key: str,
                         seconds: float | None = None) -> dict | None:
    """Research, but never for longer than a page should wait.

    Runs on its own thread and is abandoned if it overruns. Abandoned rather
    than cancelled: it keeps going and fills the cache, so the work is not
    wasted, it merely arrives in time for the next page instead of this one.
    """
    budget = BUDGET_SECONDS if seconds is None else seconds
    box = {}

    def work():
        try:
            box["found"] = research_for(text, key)
        except Exception:
            box["found"] = None

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    worker.join(budget)
    return box.get("found")


def research_for(text: str, key: str) -> dict | None:
    """Everything worth knowing about the styles this message names.

    Returns None when there is nothing to look up, which is the common
    case. Never raises: a failed lookup must leave the page still being
    drawn, because a chapter that arrives in the wrong style is worth more
    than an error message.
    """
    if not key or not looks_like_a_reference(text):
        return None
    try:
        names = _names_in(text, key)
    except Exception:
        return None
    if not names:
        return None

    styles = []
    for name in names:
        cached = name.strip().lower()
        with _known_lock:
            hit = _known.get(cached)
        if hit is not None:
            if hit:
                styles.append(hit)
            continue
        try:
            found = style_from_name(name, key)
        except Exception:
            with _known_lock:
                _known[cached] = {}       # remembered as fruitless, not retried
            continue
        with _known_lock:
            _known[cached] = found
        styles.append(found)

    if not styles:
        return None
    return {
        "names": names,
        "tags": ", ".join(filter(None, (as_tags(s) for s in styles))),
        "avoid": ", ".join(filter(None, (as_negative(s) for s in styles))),
        "notes": " ".join(
            f"{s.get('source', '')}: linework, {s.get('linework', '')} "
            f"rendering, {s.get('rendering', '')} "
            f"composition, {s.get('composition', '')}"
            for s in styles)[:1800],
        "confidence": min((str(s.get("confidence", "low")) for s in styles),
                          key=lambda c: 0 if c == "low" else 1),
    }
