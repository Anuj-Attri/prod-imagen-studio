"""prod-imagen studio generation server (public build).

One generation interface, multiple engines:
  ideogram      - Ideogram API (typography-strong hosted engine)
  openai-image  - OpenAI image API
  bfl-flux      - Black Forest Labs FLUX API
  local-dev     - optional local research engine (only when the private
                  research repo is present on the developer machine)

Engines activate only when their API key exists in the environment or in
server/keys.json (never committed). Optional bearer auth for public
deployments: set STUDIO_AUTH_TOKEN and every endpoint except /health
requires "Authorization: Bearer <token>".

Run:  python -m server.gen_server   (or: python server/gen_server.py)
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("STUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("STUDIO_PORT", "8787"))
KEYS_PATH = Path(__file__).with_name("keys.json")
AUTH_TOKEN = os.environ.get("STUDIO_AUTH_TOKEN")
DISTILL_REPO = os.environ.get("DISTILL_REPO")  # private research repo (dev only)

NO_TEXT_SUFFIX = ", no text, no letters, no speech balloons, no captions, no watermarks"


def keys() -> dict:
    data = {}
    if KEYS_PATH.is_file():
        try:
            data = json.loads(KEYS_PATH.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    return {
        "ideogram": data.get("ideogram") or os.environ.get("IDEOGRAM_API_KEY"),
        "openai": data.get("openai") or os.environ.get("OPENAI_API_KEY"),
        "bfl": data.get("bfl") or os.environ.get("BFL_API_KEY"),
        "anthropic": data.get("anthropic") or os.environ.get("ANTHROPIC_API_KEY"),
    }


def http_json(url: str, payload: dict, headers: dict, timeout: int = 300) -> dict:
    request = urllib.request.Request(
        url, method="POST", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **headers},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def http_get_bytes(url: str, timeout: int = 300) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


# ------------------------------------------------------- optional dev engine --
_local = None
_local_lock = threading.Lock()
_case_counter = int(time.time()) % 100000


def local_available() -> bool:
    return bool(DISTILL_REPO and Path(DISTILL_REPO, "benchmarks", "lab", "runner.py").is_file())


def generate_local(prompt: str, seed: int) -> bytes:
    global _local, _case_counter
    if not local_available():
        raise RuntimeError("local dev engine requires DISTILL_REPO to point at the research checkout")
    if DISTILL_REPO not in sys.path:
        sys.path.insert(0, DISTILL_REPO)
    with _local_lock:
        if _local is None:
            from benchmarks.lab.runner import provider_from_name
            _local = provider_from_name("distill-pulse-hybrid-v0.6")
            _local.prepare()
    from benchmarks.lab.contracts import GenerationRequest
    _case_counter += 1
    request = GenerationRequest(
        case_id=_case_counter, prompt=prompt, width=1024, height=1024, steps=4, seed=seed,
    )
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "panel.png"
        _local.generate(request, out)
        return out.read_bytes()


# ------------------------------------------------------------ hosted engines --
def generate_ideogram(prompt: str, seed: int, api_key: str) -> bytes:
    result = http_json(
        "https://api.ideogram.ai/v1/ideogram-v3/generate",
        {"prompt": prompt, "seed": seed, "rendering_speed": "QUALITY", "resolution": "1024x1024"},
        {"Api-Key": api_key},
    )
    return http_get_bytes(result["data"][0]["url"])


def generate_openai(prompt: str, api_key: str) -> bytes:
    model = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1")
    result = http_json(
        "https://api.openai.com/v1/images/generations",
        {"model": model, "prompt": prompt, "size": "1024x1024", "quality": "high"},
        {"Authorization": f"Bearer {api_key}"},
    )
    return base64.b64decode(result["data"][0]["b64_json"])


def generate_bfl(prompt: str, seed: int, api_key: str) -> bytes:
    submit = http_json(
        "https://api.bfl.ai/v1/flux-pro-1.1",
        {"prompt": prompt, "seed": seed, "width": 1024, "height": 1024},
        {"x-key": api_key},
    )
    poll_url = submit.get("polling_url") or ("https://api.bfl.ai/v1/get_result?id=" + submit["id"])
    for _ in range(120):
        time.sleep(2)
        request = urllib.request.Request(poll_url, headers={"x-key": api_key})
        with urllib.request.urlopen(request, timeout=60) as response:
            status = json.loads(response.read())
        if status.get("status") == "Ready":
            return http_get_bytes(status["result"]["sample"])
        if status.get("status") in ("Error", "Content Moderated", "Request Moderated"):
            raise RuntimeError(f"FLUX API: {status.get('status')}")
    raise TimeoutError("FLUX API polling timed out")


# ------------------------------------------------------------- story engine --
STORY_SYSTEM = (
    "You are the continuity editor for a visual story project. Given the "
    "panel descriptions and dialogue of every page so far, respond with "
    "STRICT JSON: {\"chapter\": one-paragraph summary of the current "
    "chapter as developed so far, \"overall\": one-paragraph whole-story "
    "digest, \"flags\": [{\"title\": short name, \"detail\": one sentence, "
    "\"severity\": \"low\"|\"high\"}]}. Flags are genuine continuity "
    "problems only: contradicted facts, identity changes, timeline breaks, "
    "dropped plot threads. No markdown, JSON only."
)


def analyze_story(payload: dict, api_key: str) -> dict:
    content = json.dumps({
        "project": payload.get("project"),
        "kind": payload.get("kind"),
        "pages": payload.get("pages", []),
        "previous_analysis": payload.get("previous", {}),
    })
    result = http_json(
        "https://api.anthropic.com/v1/messages",
        {
            "model": os.environ.get("STORY_MODEL", "claude-sonnet-5"),
            "max_tokens": 1200,
            "system": STORY_SYSTEM,
            "messages": [{"role": "user", "content": content}],
        },
        {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        timeout=120,
    )
    text = "".join(block.get("text", "") for block in result.get("content", [])).strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    parsed = json.loads(text)
    return {
        "chapter": str(parsed.get("chapter", "")),
        "overall": str(parsed.get("overall", "")),
        "flags": [
            {
                "title": str(flag.get("title", "")),
                "detail": str(flag.get("detail", "")),
                "severity": "high" if flag.get("severity") == "high" else "low",
            }
            for flag in parsed.get("flags", [])
        ],
    }


# -------------------------------------------------------------------- server --
def engine_table(current: dict) -> list:
    table = [
        {"id": "ideogram", "label": "Ideogram (hosted API)", "available": bool(current["ideogram"])},
        {"id": "openai-image", "label": "OpenAI image (hosted API)", "available": bool(current["openai"])},
        {"id": "bfl-flux", "label": "FLUX (hosted API)", "available": bool(current["bfl"])},
    ]
    if local_available():
        table.insert(0, {"id": "local-dev", "label": "Local dev engine", "available": True})
    return table


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not AUTH_TOKEN:
            return True
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {AUTH_TOKEN}"

    def do_OPTIONS(self):  # noqa: N802
        self._json(200, {"ok": True})

    def do_GET(self):  # noqa: N802
        current = keys()
        if self.path == "/health":
            self._json(200, {
                "ok": True,
                "auth": bool(AUTH_TOKEN),
                "local": local_available(),
                "apis": any([current["ideogram"], current["openai"], current["bfl"]]),
                "story": bool(current["anthropic"]),
            })
            return
        if not self._authorized():
            self._json(401, {"error": "missing or invalid bearer token"})
            return
        if self.path == "/engines":
            self._json(200, {"engines": engine_table(current)})
        else:
            self._json(404, {"error": "unknown endpoint"})

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            self._json(401, {"error": "missing or invalid bearer token"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid JSON"})
            return
        if self.path == "/generate":
            self._generate(payload)
        elif self.path == "/story/analyze":
            self._story(payload)
        else:
            self._json(404, {"error": "unknown endpoint"})

    def _generate(self, payload: dict) -> None:
        current = keys()
        engine = payload.get("engine", "ideogram")
        prompt = str(payload.get("prompt", "")).strip()
        if not prompt:
            self._json(400, {"error": "prompt is required"})
            return
        if payload.get("no_text"):
            prompt = prompt + NO_TEXT_SUFFIX
        seed = payload.get("seed")
        seed = int(seed) if seed is not None else int(time.time() * 997) % 2_000_000
        started = time.perf_counter()
        try:
            if engine == "local-dev":
                image = generate_local(prompt, seed)
            elif engine == "ideogram":
                if not current["ideogram"]:
                    raise RuntimeError("Ideogram key missing")
                image = generate_ideogram(prompt, seed, current["ideogram"])
            elif engine == "openai-image":
                if not current["openai"]:
                    raise RuntimeError("OpenAI key missing")
                image = generate_openai(prompt, current["openai"])
            elif engine == "bfl-flux":
                if not current["bfl"]:
                    raise RuntimeError("BFL key missing")
                image = generate_bfl(prompt, seed, current["bfl"])
            else:
                raise RuntimeError(f"unknown engine: {engine}")
            self._json(200, {
                "ok": True, "engine": engine, "seed": seed,
                "latency_ms": round((time.perf_counter() - started) * 1000),
                "image_base64": base64.b64encode(image).decode(),
            })
        except Exception as error:
            self._json(500, {"error": f"{type(error).__name__}: {error}"})

    def _story(self, payload: dict) -> None:
        current = keys()
        if not current["anthropic"]:
            self._json(500, {"error": "Story engine needs an Anthropic key"})
            return
        try:
            result = analyze_story(payload, current["anthropic"])
            self._json(200, {"ok": True, **result})
        except Exception as error:
            self._json(500, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, fmt, *args):
        print("[gen-server]", fmt % args)


def main() -> None:
    print(f"prod-imagen gen server on http://{HOST}:{PORT}")
    print(f"auth: {'bearer token required' if AUTH_TOKEN else 'open (set STUDIO_AUTH_TOKEN for public deployments)'}")
    current = keys()
    for engine in engine_table(current):
        print(f"  [{'on ' if engine['available'] else 'off'}] {engine['label']}")
    print(f"  [{'on ' if current['anthropic'] else 'off'}] story engine (Anthropic)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
