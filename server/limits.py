"""Who may call the server, and how often.

A deployment pays for every request it serves, so the two questions this
answers are the same question: an unbounded caller and an unknown caller
both cost the same money.

Tokens are per person rather than one shared secret. A shared secret
cannot be withdrawn from one person without withdrawing it from
everybody, and a secret shipped inside an application is on somebody's
disk and will eventually be read off it. Per-person tokens make a leak
something you revoke rather than something you rebuild around.

Limits are counted in memory, which is right for one instance and wrong
for several. Said plainly here so that nobody deploys four copies and
believes the daily figure.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from pathlib import Path

# Per token. Generous enough that ordinary work never notices, mean
# enough that a leaked token cannot empty an account overnight.
PER_MINUTE = int(os.environ.get("STUDIO_PER_MINUTE", "20"))
PER_DAY = int(os.environ.get("STUDIO_PER_DAY", "400"))

_history = {}          # token -> deque of timestamps
_lock = threading.Lock()


def load_tokens() -> dict:
    """token -> label, from the environment or a file beside this one.

    Three ways in, so a container, a compose file and a laptop can each
    use whichever is natural:

      STUDIO_TOKENS   "abc:alice,def:bob"  or just "abc,def"
      STUDIO_AUTH_TOKEN  one token, kept working for older deployments
      server/tokens.json   {"abc": "alice"}   (never committed)
    """
    tokens = {}

    listed = os.environ.get("STUDIO_TOKENS", "").strip()
    for entry in listed.split(","):
        entry = entry.strip()
        if not entry:
            continue
        token, _, label = entry.partition(":")
        token = token.strip()
        if token:
            tokens[token] = (label.strip() or "unnamed")

    single = os.environ.get("STUDIO_AUTH_TOKEN", "").strip()
    if single:
        tokens.setdefault(single, "shared")

    path = Path(__file__).with_name("tokens.json")
    if path.exists():
        try:
            for token, label in (json.loads(path.read_text()) or {}).items():
                if str(token).strip():
                    tokens.setdefault(str(token).strip(), str(label or "unnamed"))
        except Exception:
            pass                       # a damaged file must not lock everyone out

    return tokens


def label_for(token: str, tokens: dict) -> str | None:
    """Who this token belongs to, or None if it belongs to nobody.

    Compared in full rather than by prefix: a check that accepted any
    token starting with a known one would accept every guess that got the
    first character right.
    """
    if not token:
        return None
    return tokens.get(token)


def check(token: str, now: float | None = None) -> dict:
    """Whether this token may make one more request right now.

    Returns what happened rather than raising, because the caller has to
    put a number and a retry hint into an http response either way.
    """
    moment = time.time() if now is None else now
    with _lock:
        seen = _history.setdefault(token, deque())
        # anything older than a day cannot count against either window
        while seen and moment - seen[0] > 86400:
            seen.popleft()

        day = len(seen)
        minute = sum(1 for stamp in seen if moment - stamp <= 60)

        if minute >= PER_MINUTE:
            oldest_in_minute = next(s for s in seen if moment - s <= 60)
            return {"ok": False, "reason": "per-minute",
                    "retry_after": max(1, int(61 - (moment - oldest_in_minute))),
                    "minute": minute, "day": day}
        if day >= PER_DAY:
            return {"ok": False, "reason": "per-day",
                    "retry_after": max(1, int(86401 - (moment - seen[0]))),
                    "minute": minute, "day": day}

        seen.append(moment)
        return {"ok": True, "reason": None, "retry_after": 0,
                "minute": minute + 1, "day": day + 1}


def usage(token: str, now: float | None = None) -> dict:
    """What this token has spent, without spending any of it."""
    moment = time.time() if now is None else now
    with _lock:
        seen = _history.get(token) or deque()
        day = sum(1 for stamp in seen if moment - stamp <= 86400)
        minute = sum(1 for stamp in seen if moment - stamp <= 60)
    return {"minute": minute, "per_minute": PER_MINUTE,
            "day": day, "per_day": PER_DAY}


def forget(token: str | None = None) -> None:
    """Drop counts, for tests and for revoking somebody cleanly."""
    with _lock:
        if token is None:
            _history.clear()
        else:
            _history.pop(token, None)
