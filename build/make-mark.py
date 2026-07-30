"""Ask a frontier image model for the Firestarter mark.

    python build/make-mark.py                 one attempt per candidate
    python build/make-mark.py --variants 3    three of each, to choose from

Writes build/candidates/*.png. Nothing is installed as the icon by this
script: choosing is a judgement, and a script that silently overwrites the
mark would make that judgement for you.

Drawing this by hand from primitives produced, in order, a leaf, a
hurricane and a flower. Irezumi lives on deliberate asymmetry, which is
exactly what a parametric loop cannot supply, so the drawing is asked of
something that can draw.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.review import read_key                        # noqa: E402

OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"
OUT = Path(__file__).resolve().parent / "candidates"

# Named rather than discovered, because only a handful of models return
# images at all and the right one is a matter of taste, not of price.
CANDIDATES = [
    "google/gemini-3-pro-image",
    "openai/gpt-5-image",
    "google/gemini-2.5-flash-image",
]

# Written for an icon rather than for a picture. The constraints matter
# more than the adjectives: one shape, flat colour, no text, and a
# transparent or plain field, because anything busy dies at 16 pixels.
PROMPT = (
    "A bold app icon mark: Japanese irezumi tattoo style flame-clouds "
    "curling around an empty circular void in the centre. Thick confident "
    "brush strokes with curled hooked tips, like traditional ukiyo-e fire. "
    "Flat vector silhouette, solid ember orange and deep red, on a pure "
    "white background. Centred, symmetrical overall balance but with "
    "irregular hand-drawn tongues. Heavy line weight, high contrast, no "
    "gradients, no text, no letters, no border, no drop shadow. The centre "
    "circle must be completely empty white. Simple enough to read clearly "
    "at 16 pixels."
)


def ask(model: str, key: str, timeout: int = 240) -> list:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT}],
        "modalities": ["image", "text"],
    }).encode()
    request = urllib.request.Request(OPENROUTER_CHAT, data=body, headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "Firestarter mark",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read())

    message = (payload.get("choices") or [{}])[0].get("message") or {}
    found = []
    # Providers disagree about where an image goes, so look where they put
    # them rather than insisting on one shape.
    for item in (message.get("images") or []):
        url = ((item or {}).get("image_url") or {}).get("url") or ""
        if url.startswith("data:"):
            found.append(base64.b64decode(url.split(",", 1)[1]))
    if not found and isinstance(message.get("content"), list):
        for part in message["content"]:
            url = ((part or {}).get("image_url") or {}).get("url") or ""
            if url.startswith("data:"):
                found.append(base64.b64decode(url.split(",", 1)[1]))
    if not found:
        raise RuntimeError(
            "no image in the reply; keys were " + ", ".join(sorted(message))
        )
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variants", type=int, default=1)
    parser.add_argument("--models", help="comma separated, overrides the list")
    args = parser.parse_args()

    key = read_key()
    if not key:
        print("no OpenRouter key; set OPENROUTER_API_KEY or add it to "
              "server/keys.json", file=sys.stderr)
        return 2

    OUT.mkdir(exist_ok=True)
    models = ([m.strip() for m in args.models.split(",")] if args.models
              else CANDIDATES)
    written = 0
    for model in models:
        for attempt in range(args.variants):
            label = model.replace("/", "-")
            try:
                for index, blob in enumerate(ask(model, key)):
                    name = f"{label}-{attempt + 1}-{index + 1}.png"
                    (OUT / name).write_bytes(blob)
                    print(f"  wrote candidates/{name}  {len(blob) // 1024}KB")
                    written += 1
            except urllib.error.HTTPError as error:
                detail = ""
                try:
                    detail = error.read().decode()[:140]
                except Exception:
                    pass
                print(f"  {model}: HTTP {error.code} {detail}")
            except Exception as error:
                print(f"  {model}: {error}")
    print(f"\n{written} candidate(s). Nothing installed as the icon: "
          f"pick one, then run build/make-icon.py to cut the sizes.")
    return 0 if written else 1


if __name__ == "__main__":
    raise SystemExit(main())
