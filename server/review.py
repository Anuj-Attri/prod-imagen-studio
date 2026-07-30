"""Read a change and say what is wrong with it.

    python -m server.review --diff changes.patch --out review.md

Written for the pull request workflow, and useful by hand before opening
one. It sends the change to a model through the same routing the
application uses, so there is one place where models are chosen rather
than two that drift apart.

A review that says everything is fine is worth nothing, and a review that
invents problems to look thorough is worth less than nothing. The prompt
asks for specific defects with a file and a line, and for silence when
there is nothing to report.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .routing import model_for

OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"

# Kept deliberately narrow. A model asked for "anything you notice" will
# supply opinions about naming and indentation forever; asked for defects
# it looks for defects.
SYSTEM = """You review changes to a desktop drawing application. Report
defects, not preferences.

Look for, in this order of importance:
- Logic that is wrong: an off-by-one, an inverted condition, a case the
  code cannot handle, state left inconsistent when something fails.
- Data loss: work that can be destroyed or overwritten without asking.
- A promise the code does not keep: a comment or name that says one thing
  while the code does another.
- Something checked in a test that the test cannot actually detect.
- Resources not released on the failing path.

Do not report: formatting, naming preferences, missing comments, style
choices consistent with the surrounding file, or hypothetical problems
that need a caller that does not exist.

For each finding give the file, the line if you can, one sentence on what
breaks, and one sentence on the input or sequence that breaks it. If you
find nothing, say exactly "No defects found." and stop. Saying that is a
valid and useful answer; padding is not."""

MAX_DIFF = 120_000        # about 30k tokens, comfortably inside context


def pick_text(message: dict) -> str:
    """The answer, wherever the model decided to put it.

    Some models answer in the content field, some put the answer in the
    reasoning field and leave content holding a single newline. Falling
    back on truthiness reads that newline as an answer and then strips it
    to nothing, so a full review is discarded and reported as silence.
    Strip first, then choose.
    """
    for field in ("content", "reasoning"):
        value = (message.get(field) or "").strip()
        if value:
            return value
    return ""


def read_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if key:
        return key
    local = Path(__file__).with_name("keys.json")
    if local.exists():
        try:
            return (json.loads(local.read_text()).get("openrouter") or "").strip()
        except Exception:
            return ""
    return ""


def review(diff: str, key: str, step: str = "critique") -> dict:
    choice = model_for(step)
    if not choice["model"]:
        return {"ok": False, "text": "No model available to review with.",
                "model": None}
    if len(diff) > MAX_DIFF:
        # Truncating silently would let a large change be reviewed as if
        # it were small, and report a clean result for code nobody read.
        diff = diff[:MAX_DIFF]
        note = (f"\n\n[The change was larger than {MAX_DIFF} characters and "
                f"was cut off here. Everything after this point is unreviewed.]")
    else:
        note = ""

    body = json.dumps({
        "model": choice["model"],
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": "Review this change:\n\n" + diff}],
        "max_tokens": 2000,
    }).encode()
    request = urllib.request.Request(OPENROUTER_CHAT, data=body, headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "Firestarter review",
    })
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode()[:200]
        except Exception:
            pass
        return {"ok": False, "model": choice["model"],
                "text": f"The review could not run: HTTP {error.code} {detail}"}
    except Exception as error:
        return {"ok": False, "model": choice["model"],
                "text": f"The review could not run: {error}"}

    message = (payload.get("choices") or [{}])[0].get("message") or {}
    text = pick_text(message)
    usage = payload.get("usage") or {}
    price = choice["price"] or {}
    cost = None
    if price:
        cost = round((price.get("in", 0) * usage.get("prompt_tokens", 0)
                      + price.get("out", 0) * usage.get("completion_tokens", 0))
                     / 1_000_000, 5)
    return {"ok": bool(text), "model": choice["model"], "cost": cost,
            "text": (text or "The model returned nothing to report.") + note}


def say(text: str) -> None:
    """Print text that may contain anything a model wrote.

    A Windows console defaults to an encoding that cannot represent most
    of what comes back, and the failure is an exception rather than a
    mangled character: the review ran, cost money, and was then thrown
    away by the act of displaying it.
    """
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        print(text)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "ascii"
        print(text.encode(encoding, errors="replace").decode(encoding))


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diff", required=True, help="file holding the diff")
    parser.add_argument("--out", help="write the review here as well as to stdout")
    args = parser.parse_args(argv)

    source = Path(args.diff)
    if not source.exists():
        print(f"no such file: {source}", file=sys.stderr)
        return 2
    diff = source.read_text(encoding="utf-8", errors="replace").strip()
    if not diff:
        say("Nothing to review: the change is empty.")
        return 0

    key = read_key()
    if not key:
        # Not a failure of the change under review, so this must not read
        # as one. The workflow reports it and carries on.
        message = ("The review did not run: no OpenRouter key is configured. "
                   "Add OPENROUTER_API_KEY to the repository secrets.")
        say(message)
        if args.out:
            Path(args.out).write_text(message + "\n", encoding="utf-8")
        return 0

    result = review(diff, key)
    header = f"Reviewed by `{result['model']}`"
    if result.get("cost") is not None:
        header += f", costing ${result['cost']:.4f}"
    text = f"{header}.\n\n{result['text']}\n"
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
