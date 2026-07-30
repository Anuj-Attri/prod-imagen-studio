"""Turn a panel into a few seconds of motion.

There is no free path to this. Video models are billed by the second of
output and nobody hosts them for nothing, so the feature stays switched
off until a key exists rather than pretending otherwise: an engine that
appears available and fails on use is worse than one that says it is not
configured.

The provider and the model are both configuration rather than code. Video
models are replaced faster than any other kind, and a name written into
a source file is a name that will be wrong within months.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

# Where to send the work. fal exposes a synchronous endpoint that returns
# the finished video, which suits a desktop application making one clip
# at a time; Replicate prefers a poll and is supported the same way.
PROVIDERS = {
    "fal": {
        "url": "https://fal.run/",
        "auth": lambda key: {"Authorization": "Key " + key},
        "model": os.environ.get("STUDIO_VIDEO_MODEL", "fal-ai/wan-i2v"),
    },
    "replicate": {
        "url": "https://api.replicate.com/v1/models/",
        "auth": lambda key: {"Authorization": "Bearer " + key},
        "model": os.environ.get("STUDIO_VIDEO_MODEL_REPLICATE", ""),
    },
}

KNOWN_VIDEO_ENGINES = tuple(PROVIDERS)
MAX_SECONDS = int(os.environ.get("STUDIO_VIDEO_SECONDS", "5"))


def available(keys: dict) -> list:
    """Which video engines can actually run, given the keys present.

    Reported rather than assumed, so the interface can grey out what it
    cannot do instead of offering it and failing.
    """
    ready = []
    for name in PROVIDERS:
        if (keys.get(name) or "").strip():
            ready.append(name)
    return ready


def describe(keys: dict) -> list:
    """The engine table, including the ones that are switched off and why."""
    rows = []
    for name, provider in PROVIDERS.items():
        has_key = bool((keys.get(name) or "").strip())
        rows.append({
            "id": name,
            "label": f"{name} video",
            "available": has_key and bool(provider["model"]),
            "why": ("ready" if has_key and provider["model"]
                    else "no key configured" if not has_key
                    else "no model configured for this provider"),
        })
    return rows


def generate(provider_name: str, prompt: str, key: str,
             image_url: str | None = None, seconds: int | None = None,
             timeout: int = 600) -> dict:
    """One clip. Returns where to find it, or why there is nothing.

    Long by the standards of the rest of this server: a few seconds of
    video takes minutes to make, and a timeout shorter than the work is
    a failure that looks like a fault.
    """
    provider = PROVIDERS.get(provider_name)
    if not provider:
        return {"ok": False, "error": f"unknown video engine: {provider_name}"}
    if not (key or "").strip():
        return {"ok": False, "error": f"no {provider_name} key configured"}
    model = provider["model"]
    if not model:
        return {"ok": False,
                "error": f"no model configured for {provider_name}; "
                         f"set STUDIO_VIDEO_MODEL"}

    wanted = min(max(1, int(seconds or MAX_SECONDS)), MAX_SECONDS)
    body = {"prompt": prompt, "num_frames": wanted * 16}
    if image_url:
        # image to video: the panel already drawn is the first frame, which
        # keeps the clip in the style of the page rather than inventing a
        # second look for the same scene
        body["image_url"] = image_url

    request = urllib.request.Request(
        provider["url"] + model,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **provider["auth"](key)},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode()[:200]
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {error.code} from {provider_name}: {detail}"}
    except Exception as error:
        return {"ok": False, "error": f"{provider_name} did not answer: {error}"}

    # Providers disagree about where the result goes, so look in the
    # places they use rather than insisting on one shape.
    url = None
    for path in (("video", "url"), ("output", "url"), ("url",), ("output",)):
        node = payload
        for part in path:
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                break
        if isinstance(node, str) and node.startswith("http"):
            url = node
            break
        if isinstance(node, list) and node and isinstance(node[0], str):
            url = node[0]
            break
    if not url:
        return {"ok": False,
                "error": "the provider answered without a video; "
                         f"keys were {sorted(payload)[:6]}"}
    return {"ok": True, "url": url, "seconds": wanted, "model": model}
