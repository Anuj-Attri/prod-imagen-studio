"""Hostile input probe for the generation server.

Run:  python server/probe.py

This server is meant to be deployable, so a bad request must be answered
plainly, must never drop the connection, and must never hand back the
name of an internal error.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787"


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


CASES = [
    ("malformed JSON body", "/generate", None, b"{ not json at all", 400),
    ("empty body", "/generate", None, b"", 400),
    ("missing prompt", "/generate", {"engine": "local-gpu"}, None, 400),
    ("unknown engine", "/generate", {"engine": "nonesuch", "prompt": "x"}, None, 400),
    ("prompt far too long", "/generate",
     {"engine": "local-gpu", "prompt": "a " * 60000}, None, 400),
    ("agent: no messages", "/agent/chat", {}, None, 200),
    ("agent: messages not a list", "/agent/chat", {"messages": "hello"}, None, 200),
    ("agent: entries not objects", "/agent/chat", {"messages": ["hi", 3]}, None, 200),
    ("agent: only junk roles", "/agent/chat",
     {"messages": [{"role": "system", "content": "x"}]}, None, 200),
    ("story: empty payload", "/story/analyze", {}, None, 200),
    ("unknown endpoint", "/nope", {}, None, 404),
]


def main():
    failures = 0
    for name, path, body, raw, expected in CASES:
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
    print(f"{len(CASES) - failures}/{len(CASES)} handled as intended")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
