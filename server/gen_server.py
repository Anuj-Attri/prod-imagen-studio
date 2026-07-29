"""prod-imagen studio generation server.

One generation interface, multiple engines:
  local-gpu     - diffusers on the local GPU, free and offline
  ideogram      - Ideogram API (typography-strong hosted engine)
  openai-image  - OpenAI image API
  bfl-flux      - Black Forest Labs FLUX API

The local engine needs a CUDA build of torch and cached weights. Hosted
engines activate only when their API key exists in the environment or in
server/keys.json (never committed). Optional bearer auth for public
deployments: set STUDIO_AUTH_TOKEN and every endpoint except /health
requires "Authorization: Bearer <token>".

Run:  python -m server.gen_server   (or: python server/gen_server.py)
"""
from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("STUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("STUDIO_PORT", "8787"))
# Reported by /health so a stale server left running on the port is
# obvious instead of silently serving old code.
BUILD = "0.4.0"
KEYS_PATH = Path(__file__).with_name("keys.json")
AUTH_TOKEN = os.environ.get("STUDIO_AUTH_TOKEN")

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
        "llm_url": data.get("llm_url"),
        "llm_model": data.get("llm_model"),
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


# --------------------------------------------------------- local gpu engine --
# Free, private, offline image generation on the user's own GPU through
# diffusers. Requires the server to run under an interpreter with a CUDA
# build of torch (see .venv-image); otherwise it stays unavailable and
# the hosted engines are used instead.
GPU_MODEL = os.environ.get("LOCAL_IMAGE_MODEL", "cagliostrolab/animagine-xl-4.0")
# Anime SDXL checkpoints are tag-driven and expect a trailing quality
# block; without it the same prompt renders flat and often loses the
# subject entirely.
GPU_QUALITY_TAGS = "masterpiece, best quality, very aesthetic, absurdres"
GPU_NEGATIVE = os.environ.get(
    "LOCAL_IMAGE_NEGATIVE",
    "lowres, worst quality, low quality, bad anatomy, bad hands, extra digits, "
    "fewer digits, jpeg artifacts, signature, watermark, username, text, "
    "speech bubble, caption, letters, blurry",
)
_gpu_pipe = None
_gpu_lock = threading.Lock()
# A diffusers pipeline is NOT thread safe: concurrent calls share the
# scheduler's step state and blow up with an out-of-range sigma index.
# The server is threaded, so generation is serialized here.
_gpu_run_lock = threading.Lock()
_gpu_state = {"loading": False, "error": None}


def gpu_capable() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def gpu_model_present() -> bool:
    # Weights are cached by huggingface_hub; presence means no surprise
    # multi-gigabyte download on the first click.
    try:
        from huggingface_hub import try_to_load_from_cache
        hit = try_to_load_from_cache(GPU_MODEL, "model_index.json")
        return isinstance(hit, str)
    except Exception:
        return False


def gpu_available() -> bool:
    return gpu_capable() and gpu_model_present()


def gpu_pipeline():
    global _gpu_pipe
    with _gpu_lock:
        if _gpu_pipe is None:
            import torch
            from diffusers import StableDiffusionXLPipeline
            _gpu_state["loading"] = True
            try:
                # diffusers ignores a bare dtype= kwarg: torch_dtype is
                # the one that actually takes effect
                pipe = StableDiffusionXLPipeline.from_pretrained(
                    GPU_MODEL, torch_dtype=torch.float16, use_safetensors=True,
                    add_watermarker=False,
                )
                pipe = pipe.to("cuda")
                pipe.set_progress_bar_config(disable=True)
                # keeps peak VRAM well inside a 16 GB card at 1024 px
                pipe.vae.enable_tiling()
                if pipe.dtype != torch.float16:
                    raise RuntimeError(f"expected fp16 pipeline, got {pipe.dtype}")
                _gpu_pipe = pipe
                _gpu_state["error"] = None
            except Exception as error:
                _gpu_state["error"] = str(error)
                raise
            finally:
                _gpu_state["loading"] = False
        return _gpu_pipe


def snap64(value: int, lo: int = 512, hi: int = 1536) -> int:
    # SDXL latents require multiples of 8; 64 keeps composition sane too
    return max(lo, min(hi, round(value / 64) * 64))


def gpu_prompt(prompt: str) -> str:
    # The project supplies cast and style tags; only the checkpoint's own
    # quality block belongs here.
    return ", ".join([prompt.rstrip(" ,"), GPU_QUALITY_TAGS])


def generate_gpu(prompt: str, seed: int, width: int, height: int,
                 negative: str = "") -> bytes:
    import io
    import torch
    pipe = gpu_pipeline()
    full_negative = ", ".join(p for p in (negative.strip(" ,"), GPU_NEGATIVE) if p)
    with _gpu_run_lock:  # one generation at a time: the pipeline is stateful
        generator = torch.Generator("cuda").manual_seed(seed)
        image = pipe(
            prompt=prompt,
            negative_prompt=full_negative,
            width=snap64(width), height=snap64(height),
            num_inference_steps=int(os.environ.get("LOCAL_IMAGE_STEPS", "28")),
            guidance_scale=float(os.environ.get("LOCAL_IMAGE_CFG", "5.0")),
            generator=generator,
        ).images[0]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


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



# ------------------------------------------------------------ llm backends --
# Priority: local OpenAI-compatible endpoint (Ollama, vLLM, LM Studio,
# llama.cpp server) with an open model, then Anthropic if a key exists.
import time as _time
_llm_probe = {"at": 0.0, "ok": False}


def llm_config(current: dict) -> dict:
    return {
        "url": (current.get("llm_url") or os.environ.get("LLM_BASE_URL")
                or "http://127.0.0.1:11434/v1").rstrip("/"),
        "model": current.get("llm_model") or os.environ.get("LLM_MODEL") or "qwen3:8b",
    }


def local_llm_reachable(current: dict) -> bool:
    now = _time.time()
    if now - _llm_probe["at"] < 30:
        return _llm_probe["ok"]
    _llm_probe["at"] = now
    try:
        cfg = llm_config(current)
        req = urllib.request.Request(cfg["url"] + "/models")
        with urllib.request.urlopen(req, timeout=2) as r:
            _llm_probe["ok"] = r.status == 200
    except Exception:
        _llm_probe["ok"] = False
    return _llm_probe["ok"]


def local_models(cfg: dict) -> list:
    try:
        req = urllib.request.Request(cfg["url"] + "/models")
        with urllib.request.urlopen(req, timeout=4) as r:
            data = json.loads(r.read())
        return [m.get("id") for m in data.get("data", []) if m.get("id")]
    except Exception:
        return []


def strip_reasoning(text: str) -> str:
    # Reasoning models (Qwen3, DeepSeek-R1) emit chain-of-thought in
    # <think> tags; the user must never see it. Handles complete blocks
    # and orphaned open/close tags from truncated or pre-stripped output.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    if "<think>" in text:
        text = text.split("<think>", 1)[0]
    return text.strip()


def ollama_base(cfg: dict):
    # Ollama's native API enforces JSON output at the grammar level; the
    # OpenAI-compat endpoint silently ignores response_format on many
    # versions. Returns the native base URL if this endpoint is Ollama.
    url = cfg["url"]
    if not url.endswith("/v1"):
        return None
    base = url[:-3].rstrip("/")
    try:
        req = urllib.request.Request(base + "/api/version")
        with urllib.request.urlopen(req, timeout=2) as r:
            return base if r.status == 200 else None
    except Exception:
        return None


def llm_chat(current: dict, system: str, messages: list, max_tokens: int = 900,
             json_mode: bool = False) -> str:
    if local_llm_reachable(current):
        cfg = llm_config(current)
        available = local_models(cfg)
        model = cfg["model"]
        if available and model not in available:
            # closest usable substitute: same family first (qwen3:8b ->
            # qwen3:14b), never an embedding model
            chat_capable = [m for m in available if "embed" not in m.lower()]
            family = model.split(":")[0].lower()
            same_family = [m for m in chat_capable if m.lower().startswith(family)]
            model = (same_family or chat_capable or available)[0]
        if "qwen3" in model.lower():
            system = system + " /no_think"
        full_messages = [{"role": "system", "content": system}] + messages
        try:
            native = ollama_base(cfg) if json_mode else None
            if native:
                native_req = {
                    "model": model, "stream": False, "format": "json",
                    "think": False,  # skip reasoning: json needs speed, not deliberation
                    "messages": full_messages,
                    # thinking is off here, so the budget is the answer
                    # itself: no 4000-token floor to grind through
                    "options": {"num_predict": max_tokens},
                }
                try:
                    result = http_json(native + "/api/chat", native_req, {}, timeout=300)
                except urllib.error.HTTPError:
                    native_req.pop("think", None)  # model rejects the think switch
                    result = http_json(native + "/api/chat", native_req, {}, timeout=300)
                raw = result.get("message", {}).get("content", "")
            else:
                request = {
                    "model": model,
                    # local is free; headroom so reasoning cannot eat the reply
                    "max_tokens": max(max_tokens, 4000),
                    "messages": full_messages,
                }
                if json_mode:
                    request["response_format"] = {"type": "json_object"}
                try:
                    result = http_json(cfg["url"] + "/chat/completions", request, {}, timeout=180)
                except urllib.error.HTTPError as error:
                    if json_mode and error.code == 400:
                        request.pop("response_format", None)  # server lacks json mode
                        result = http_json(cfg["url"] + "/chat/completions", request, {}, timeout=180)
                    else:
                        raise
                raw = result["choices"][0]["message"]["content"]
            reply = strip_reasoning(raw)
            if not reply:
                raise RuntimeError(
                    "The local model spent its whole reply on internal "
                    "reasoning. Send the message again, or switch to a "
                    "non-thinking model in Settings."
                )
            return reply
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read().decode()[:200]
            except Exception:
                pass
            if not available:
                raise RuntimeError(
                    "Local endpoint is up but has no models installed. "
                    "Run: ollama pull qwen3:8b (or set your model in Settings)."
                )
            raise RuntimeError(f"Local model call failed ({error.code}): {detail}")
    if current.get("anthropic"):
        result = http_json(
            "https://api.anthropic.com/v1/messages",
            {
                "model": os.environ.get("STORY_MODEL", "claude-sonnet-5"),
                "max_tokens": max_tokens,
                "system": system,
                "messages": messages,
            },
            {"x-api-key": current["anthropic"], "anthropic-version": "2023-06-01"},
            timeout=120,
        )
        return "".join(b.get("text", "") for b in result.get("content", [])).strip()
    raise RuntimeError(
        "No language backend. Run a local model (Ollama: 'ollama pull qwen3:8b', "
        "or vLLM) or add an Anthropic key in Settings."
    )


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


def analyze_story(payload: dict, current: dict) -> dict:
    content = json.dumps({
        "project": payload.get("project"),
        "kind": payload.get("kind"),
        "pages": payload.get("pages", []),
        "previous_analysis": payload.get("previous", {}),
    })
    text = llm_chat(current, STORY_SYSTEM,
                    [{"role": "user", "content": content}],
                    max_tokens=1200, json_mode=True)
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



AGENT_SYSTEM = (
    "You are the page director inside prod-imagen studio, a layered "
    "canvas tool for manga, anime, posters and illustration. You BUILD "
    "pages; you never write essays. Answer with raw JSON only, no "
    "markdown, no code fences, in exactly this shape: "
    '{"reply": "at most 15 words", "cast": [{"name": "Rin", "tags": '
    '"1girl, long black hair, red kimono, scar on cheek"}], "panels": '
    '[{"prompt": "art tags for the shot", "cast": ["Rin"], "dialogue": '
    '[{"kind": "balloon", "text": "SHORT line", "speaker": "left"}]}]}. '
    "The application places every panel on the page for you: never "
    "output coordinates, sizes, panel numbers or layout instructions. "
    "Panel order is reading order. "
    "PROMPT STYLE IS CRITICAL. The art model is tag-driven, not prose. "
    "Write each prompt as 8 to 18 comma-separated danbooru style tags, "
    "never sentences. Start with the subject count tag (1girl, 1boy, "
    "2boys, 1girl 1boy, no humans), then appearance, then clothing, "
    "then pose or action, then setting, then camera framing tags such "
    "as close-up, upper body, full body, from below, from above, dutch "
    "angle, wide shot, then lighting and mood tags. Example of the "
    "required style: 2boys, ninja, black bodysuit, katana, fighting "
    "stance, rooftop, night, rain, from below, dutch angle, dramatic "
    "shadows. "
    "CAST. Every named character gets one entry in cast with permanent "
    "appearance tags only: count tag, hair, eyes, build, signature "
    "clothing, distinguishing marks. Never put pose, action, camera or "
    "setting in cast tags. "
    "When the user names a character from a published work, the art "
    "model already knows that character by name: lead the cast tags "
    "with the full canonical name in lowercase followed by the series, "
    "for example \"monkey d. luffy, one piece, straw hat, red vest, "
    "scar under eye\". Describing such a character with generic "
    "features instead produces an entirely different person. Invent "
    "appearance tags only for characters the user made up. "
    "Reuse the exact same tags for a character "
    "that already exists in the project context, and list the "
    "characters appearing in each panel by name in that panel's cast "
    "field. The application prepends those tags, so a panel prompt "
    "must describe only pose, action, setting, framing and lighting, "
    "never the character's appearance again. The project also applies "
    "its own art style tags to every panel: never include style, "
    "medium, colour or quality tags in a prompt. "
    "Each prompt describes ONLY what the art shows and must never ask "
    "for lettering, captions, speech balloons or any written words in "
    "the image; the words go in the dialogue list, which the app draws "
    "as real text. dialogue kind is balloon, caption or sfx; speaker is "
    "left or right. sfx is one or two loud words. "
    "If the context carries a story_so_far, this work already has a "
    "narrative: continue it rather than restarting, keep established "
    "facts intact, and do not contradict anything already on the pages. "
    "When the user describes a scene, page or story beat, return 2 to 6 "
    "panels that stage it with strong pacing. Only when they ask a "
    "plain factual question, return \"panels\": [] and answer in the "
    "reply. The reply is a status line, never the content itself: say "
    "what you built, nothing more. Never put panel descriptions, "
    "dialogue or lists in the reply."
)

# The JSON contract is the same for every document type; what changes is
# how many entries to return and what the dialogue list is used for.
LAYOUT_DIRECTIVES = {
    "panels": (
        "This project is a comic page. Return 2 to 6 panels in reading "
        "order. dialogue is speech and narration."
    ),
    "single": (
        "This project is a single illustration, not a comic. Return "
        "exactly ONE panel describing the whole picture. Use dialogue "
        "for at most one short caption, or leave it empty."
    ),
    "poster": (
        "This project is a poster. Return exactly ONE panel describing "
        "the artwork, composed with clear empty space where the title "
        "will sit. The dialogue list is the lettering: first entry is "
        "the headline in a few words, then at most two short lines such "
        "as a tagline or a date. Use kind text for all of them."
    ),
    "card": (
        "This project is a greeting card front. Return exactly ONE panel "
        "describing a charming, uncluttered illustration. The dialogue "
        "list is the lettering: first entry is the greeting itself, "
        "optionally one short line underneath. Use kind text."
    ),
    "blueprint": (
        "This project is a systems diagram. Do NOT return panels and do "
        "NOT describe artwork: a diagram must be exact, so the "
        "application draws it as real boxes and arrows. Return instead "
        '{"reply": "at most 15 words", "nodes": [{"id": "tank", '
        '"label": "Storage tank", "role": "store"}], "edges": [{"from": '
        '"roof", "to": "tank", "label": "runoff"}]}. '
        "Every id is lowercase with no spaces and every edge must "
        "reference ids that exist in nodes. role is one of input, "
        "process, store, output or decision. Labels are two or three "
        "words. Return 4 to 12 nodes covering the real components and "
        "the flow between them, in order from input to output."
    ),
}

BUILD_HINT = (
    "You returned no panels. The user wants a page built. Return the "
    "JSON with 2 to 6 panels now, reply at most 15 words."
)


def looks_like_build_request(messages: list) -> bool:
    if not messages:
        return False
    last = messages[-1].get("content", "").lower()
    if len(last.split()) < 4:
        return False
    asking = last.lstrip().startswith((
        "what", "why", "how", "when", "who", "which", "is ", "are ", "can ", "do ",
    ))
    return not asking


def short_reply(text: str, limit: int = 160) -> str:
    line = " ".join(str(text).split())
    if len(line) <= limit:
        return line
    cut = line[:limit]
    stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[:stop + 1] if stop > 40 else cut.rstrip() + "...").strip()


def parse_agent_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned[:4].lower() == "json":
            cleaned = cleaned[4:]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(cleaned[start:end + 1])
            if isinstance(data, dict) and "reply" in data:
                def as_list(key):
                    value = data.get(key)
                    return value if isinstance(value, list) else []
                return {
                    "reply": str(data["reply"]),
                    "panels": as_list("panels"),
                    "cast": as_list("cast"),
                    "nodes": as_list("nodes"),
                    "edges": as_list("edges"),
                }
        except Exception:
            pass
    # model ignored the contract: degrade to a plain text reply
    return {"reply": text, "panels": [], "cast": [], "nodes": [], "edges": []}


def agent_chat(payload: dict, current: dict) -> dict:
    context = json.dumps({
        "project": payload.get("project"),
        "kind": payload.get("kind"),
        "art_style": payload.get("art_style"),
        "existing_cast": payload.get("cast", []),
        "story_so_far": payload.get("story"),
        "pages": payload.get("pages", []),
    })
    messages = [
        {"role": m.get("role", "user"), "content": str(m.get("content", ""))}
        for m in payload.get("messages", [])
        if m.get("role") in ("user", "assistant")
    ] or [{"role": "user", "content": "hello"}]
    directive = LAYOUT_DIRECTIVES.get(payload.get("layout") or "panels", "")
    system = AGENT_SYSTEM + " " + directive + " Current project context: " + context
    result = parse_agent_json(llm_chat(current, system, messages,
                                       max_tokens=1400, json_mode=True))
    if not result["panels"] and looks_like_build_request(messages):
        # the model lapsed into prose: demand the page once more
        result = parse_agent_json(llm_chat(
            current, system, messages + [{"role": "user", "content": BUILD_HINT}],
            max_tokens=1400, json_mode=True))
    panels = []
    for panel in result["panels"][:8]:
        if not isinstance(panel, dict) or not panel.get("prompt"):
            continue
        dialogue = [
            {
                "kind": d.get("kind", "balloon"),
                "text": str(d.get("text", ""))[:300],
                "speaker": d.get("speaker"),
            }
            for d in (panel.get("dialogue") or [])
            if isinstance(d, dict) and d.get("text")
        ]
        panels.append({
            "prompt": str(panel["prompt"])[:2000],
            "cast": [str(n)[:60] for n in (panel.get("cast") or []) if n][:6],
            "dialogue": dialogue[:5],
        })
    cast = [
        {"name": str(c["name"])[:60], "tags": str(c.get("tags", ""))[:400]}
        for c in result.get("cast", [])
        if isinstance(c, dict) and c.get("name") and c.get("tags")
    ][:12]
    nodes = [
        {
            "id": str(n["id"])[:40],
            "label": str(n.get("label") or n["id"])[:60],
            "role": str(n.get("role", "process"))[:20],
        }
        for n in result.get("nodes", [])
        if isinstance(n, dict) and n.get("id")
    ][:16]
    known = {n["id"] for n in nodes}
    edges = [
        {
            "from": str(e["from"])[:40],
            "to": str(e["to"])[:40],
            "label": str(e.get("label", ""))[:40],
        }
        for e in result.get("edges", [])
        # an edge to a node that was never declared would draw into space
        if isinstance(e, dict) and str(e.get("from")) in known and str(e.get("to")) in known
    ][:32]

    reply = short_reply(result["reply"])
    if panels and (len(reply) > 160 or not reply):
        reply = f"Built a {len(panels)} panel page."
    if nodes and not reply:
        reply = f"Diagram with {len(nodes)} components."
    return {"reply": reply, "panels": panels, "cast": cast,
            "nodes": nodes, "edges": edges}


# -------------------------------------------------------------------- server --
def engine_table(current: dict) -> list:
    table = [
        {"id": "ideogram", "label": "Ideogram (hosted API)", "available": bool(current["ideogram"])},
        {"id": "openai-image", "label": "OpenAI image (hosted API)", "available": bool(current["openai"])},
        {"id": "bfl-flux", "label": "FLUX (hosted API)", "available": bool(current["bfl"])},
    ]
    if gpu_capable():
        table.insert(0, {
            "id": "local-gpu",
            "label": "Local GPU (free, private)",
            "available": gpu_model_present(),
        })
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
                "build": BUILD,
                "auth": bool(AUTH_TOKEN),
                "local": gpu_available(),
                "apis": any([current["ideogram"], current["openai"], current["bfl"]]),
                "story": bool(current["anthropic"]) or local_llm_reachable(current),
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
        elif self.path == "/agent/chat":
            self._chat(payload)
        else:
            self._json(404, {"error": "unknown endpoint"})

    def _generate(self, payload: dict) -> None:
        current = keys()
        engine = payload.get("engine", "ideogram")
        prompt = str(payload.get("prompt", "")).strip()
        if not prompt:
            self._json(400, {"error": "prompt is required"})
            return
        if engine == "local-gpu":
            # tag-driven checkpoint: the negative prompt already bars
            # lettering, so the prose no-text clause would only dilute it
            prompt = gpu_prompt(prompt)
        elif payload.get("no_text"):
            prompt = prompt + NO_TEXT_SUFFIX
        seed = payload.get("seed")
        seed = int(seed) if seed is not None else int(time.time() * 997) % 2_000_000
        started = time.perf_counter()
        try:
            if engine == "local-gpu":
                image = generate_gpu(prompt, seed,
                                     int(payload.get("width", 1024)),
                                     int(payload.get("height", 1024)),
                                     str(payload.get("negative", "")))
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

    def _chat(self, payload: dict) -> None:
        current = keys()
        try:
            self._json(200, {"ok": True, **agent_chat(payload, current)})
        except Exception as error:
            self._json(500, {"error": f"{type(error).__name__}: {error}"})

    def _story(self, payload: dict) -> None:
        current = keys()
        try:
            result = analyze_story(payload, current)
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
