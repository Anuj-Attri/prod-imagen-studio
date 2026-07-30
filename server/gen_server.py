"""Firestarter generation server.

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

from . import limits, reference, routing, video
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("STUDIO_HOST", "127.0.0.1")
# PORT first, because that is the name a hosting platform sets and it is
# not negotiable there: bind anything else and the deployment is marked
# unhealthy without ever having been reached. STUDIO_PORT stays for local
# use and for the checks, which claim a free port so a run cannot collide
# with a server the developer already has open.
PORT = int(os.environ.get("PORT") or os.environ.get("STUDIO_PORT") or "8787")
# Reported by /health so a stale server left running on the port is
# obvious instead of silently serving old code.
BUILD = "0.6.4"
KEYS_PATH = Path(__file__).with_name("keys.json")
AUTH_TOKEN = os.environ.get("STUDIO_AUTH_TOKEN")

NO_TEXT_SUFFIX = ", no text, no letters, no speech balloons, no captions, no watermarks"
# This server is meant to be deployable, so requests are bounded and a
# bad one is answered plainly rather than with an internal error.
MAX_PROMPT = 8000
KNOWN_ENGINES = ("openrouter-image", "local-gpu", "ideogram",
                 "openai-image", "bfl-flux")


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
        "openrouter": data.get("openrouter") or os.environ.get("OPENROUTER_API_KEY"),
        "fal": data.get("fal") or os.environ.get("FAL_KEY"),
        "replicate": data.get("replicate") or os.environ.get("REPLICATE_API_TOKEN"),
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
# Two checkpoints, because no single one does both jobs. An anime SDXL
# is tag-driven and renders everything as character illustration, which
# is right for a manga page and wrong for a technical poster: asked for
# a caching diagram it produces a person standing in a corridor. A
# general SDXL takes plain description and holds photographic, graphic
# and diagrammatic subjects.
GPU_MODELS = {
    "anime": os.environ.get("LOCAL_IMAGE_MODEL", "cagliostrolab/animagine-xl-4.0"),
    "general": os.environ.get("LOCAL_IMAGE_MODEL_GENERAL",
                              "stabilityai/stable-diffusion-xl-base-1.0"),
}
GPU_MODEL = GPU_MODELS["anime"]      # the drawn family, named for callers

# Styles that want the drawn checkpoint. Anything unlisted is general,
# so a style added later cannot silently inherit an anime model.
ANIME_STYLES = {"manga", "anime", "manhwa", "noir", "sketch"}


def family_for(style: str) -> str:
    return "anime" if str(style or "").strip().lower() in ANIME_STYLES else "general"


# Anime SDXL checkpoints are tag-driven and expect a trailing quality
# block; without it the same prompt renders flat and often loses the
# subject entirely. A general checkpoint wants none of that vocabulary.
GPU_QUALITY_TAGS = "masterpiece, best quality, very aesthetic, absurdres"
GPU_QUALITY = {
    "anime": GPU_QUALITY_TAGS,
    "general": "high detail, sharp focus, professional lighting",
}
GPU_NEGATIVE = os.environ.get(
    "LOCAL_IMAGE_NEGATIVE",
    "lowres, worst quality, low quality, bad anatomy, bad hands, extra digits, "
    "fewer digits, jpeg artifacts, signature, watermark, username, text, "
    "speech bubble, caption, letters, blurry",
)
# A general checkpoint still drifts towards illustration unless told not
# to, which is what made every poster look drawn.
GPU_NEGATIVE_FAMILY = {
    "anime": "",
    "general": "anime, manga, cartoon, comic, cel shading, chibi, "
               "character illustration",
}
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


def gpu_model_present(family: str = "anime") -> bool:
    # Weights are cached by huggingface_hub; presence means no surprise
    # multi-gigabyte download on the first click.
    try:
        from huggingface_hub import try_to_load_from_cache
        hit = try_to_load_from_cache(GPU_MODELS.get(family, GPU_MODEL),
                                     "model_index.json")
        return isinstance(hit, str)
    except Exception:
        return False


def gpu_available() -> bool:
    return gpu_capable() and any(gpu_model_present(f) for f in GPU_MODELS)


def gpu_pipeline(family: str = "anime"):
    """The pipeline for one family, keeping only that one on the card.

    Both checkpoints together do not fit beside the activations on a
    16 GB card, so switching family evicts the resident one rather than
    holding both and failing partway through a page.
    """
    global _gpu_pipe
    if family not in GPU_MODELS:
        family = "anime"
    with _gpu_lock:
        if _gpu_pipe is not None and _gpu_state.get("family") == family:
            return _gpu_pipe
        import torch
        from diffusers import StableDiffusionXLPipeline
        _gpu_state["loading"] = True
        try:
            if _gpu_pipe is not None:
                _gpu_pipe = None
                torch.cuda.empty_cache()
            # diffusers ignores a bare dtype= kwarg: torch_dtype is
            # the one that actually takes effect
            pipe = StableDiffusionXLPipeline.from_pretrained(
                GPU_MODELS[family], torch_dtype=torch.float16,
                use_safetensors=True, add_watermarker=False,
            )
            pipe = pipe.to("cuda")
            pipe.set_progress_bar_config(disable=True)
            # keeps peak VRAM well inside a 16 GB card at 1024 px
            pipe.vae.enable_tiling()
            if pipe.dtype != torch.float16:
                raise RuntimeError(f"expected fp16 pipeline, got {pipe.dtype}")
            _gpu_pipe = pipe
            _gpu_state["family"] = family
            _gpu_state["error"] = None
        except Exception as error:
            _gpu_state["family"] = None
            _gpu_state["error"] = str(error)
            raise
        finally:
            _gpu_state["loading"] = False
        return _gpu_pipe


def snap64(value: int, lo: int = 512, hi: int = 1536) -> int:
    # SDXL latents require multiples of 8; 64 keeps composition sane too
    return max(lo, min(hi, round(value / 64) * 64))


def gpu_prompt(prompt: str, family: str = "anime") -> str:
    # The project supplies cast and style tags; only the checkpoint's own
    # quality block belongs here, and the two families want different
    # vocabulary entirely.
    return ", ".join([prompt.rstrip(" ,"),
                      GPU_QUALITY.get(family, GPU_QUALITY_TAGS)])


def generate_gpu(prompt: str, seed: int, width: int, height: int,
                 negative: str = "", family: str = "anime") -> bytes:
    import io
    import torch
    pipe = gpu_pipeline(family)
    full_negative = ", ".join(p for p in (
        negative.strip(" ,"), GPU_NEGATIVE,
        GPU_NEGATIVE_FAMILY.get(family, "")) if p)
    with _gpu_run_lock:  # one generation at a time: the pipeline is stateful
        generator = torch.Generator("cuda").manual_seed(seed)
        try:
            image = pipe(
                prompt=prompt,
                negative_prompt=full_negative,
                width=snap64(width), height=snap64(height),
                num_inference_steps=int(os.environ.get("LOCAL_IMAGE_STEPS", "28")),
                guidance_scale=float(os.environ.get("LOCAL_IMAGE_CFG", "5.0")),
                generator=generator,
            ).images[0]
        except torch.cuda.OutOfMemoryError:
            # a half finished run leaves the allocator fragmented, and
            # every later request would fail too unless it is released
            torch.cuda.empty_cache()
            free, total = torch.cuda.mem_get_info()
            raise RuntimeError(
                "The GPU ran out of memory at "
                f"{snap64(width)}x{snap64(height)}. "
                f"{free // (1024 ** 2)} MB free of {total // (1024 ** 2)} MB. "
                "Close other GPU applications, or use a smaller panel."
            ) from None
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
             json_mode: bool = False, step: str | None = None) -> str:
    # A hosted key wins over a local model, every time.
    #
    # This was the other way round, and it quietly undid the entire routing
    # layer: any machine with Ollama running got its chapter planned by
    # whatever 8B model happened to be installed, while the tier table sat
    # there choosing gpt-5.2 for a call that was never made. It looked like
    # the planner being bad at planning. Every chapter plan tested on this
    # desktop was local, dropped a page, ignored the numbered beats it was
    # given, and answered "what changes" with nothing — and the deployed
    # server, having no Ollama, was meanwhile behaving completely
    # differently from the machine it was being developed on.
    #
    # Local generation stays reachable for somebody with no key at all,
    # which is the only situation where it is the best available answer
    # rather than a silent downgrade from one.
    if not current.get("openrouter") and local_llm_reachable(current):
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
    if current.get("openrouter"):
        # The routing layer decides which model does which job, so a
        # deployment gets a cheap one for structure and a better one for
        # anything a person reads. Adding the key to the table without
        # this taught the server it had a backend it could not actually
        # use: every request failed saying there was no language backend
        # while a working key sat in the file.
        # Guessing the step from the token budget is a rough proxy and was
        # the only one available; a caller that knows what it is doing says
        # so, and gets the tier that step is worth rather than the tier its
        # length implies.
        step = step or ("story" if max_tokens > 1200 else "beats")
        choice = routing.model_for(step)
        model = choice["model"] or "openai/gpt-5-mini"

        # An answer that ran out of room is retried with more of it, once.
        #
        # This is the failure that made the application look broken. A page of
        # six panels, each with two or three lines of dialogue, plus the cast
        # entries, does not fit in 1400 tokens — the reply stopped mid-string
        # with finish_reason "length", the JSON would not parse, and the
        # fallback path put the raw truncated text into the chat log as
        # though the model had said it. So the user saw a wall of broken JSON
        # beginning {"reply":"Built page 1..." and got no page at all.
        #
        # Worse, it was self-inflicted: the dialogue guidance was rewritten to
        # ask for two to three balloons a panel without ever raising the
        # ceiling that output had to fit inside. Asking for more while
        # allowing the same is how a working feature turns into a broken one.
        #
        # Retried at the transport, so every caller is covered rather than
        # whichever one is remembered.
        attempts = [max_tokens, min(max_tokens * 3, 16000)]
        last = ""
        for index, budget in enumerate(attempts):
            request = {
                "model": model,
                "max_tokens": budget,
                "messages": [{"role": "system", "content": system}] + messages,
            }
            if json_mode:
                request["response_format"] = {"type": "json_object"}
            result = http_json(
                "https://openrouter.ai/api/v1/chat/completions",
                request,
                {"Authorization": f"Bearer {current['openrouter']}",
                 "X-Title": "Firestarter"},
                timeout=300,
            )
            choice_out = (result.get("choices") or [{}])[0]
            message = choice_out.get("message") or {}
            # Strip before choosing. A content field holding only whitespace
            # is truthy, so picking it discards an answer sitting in the
            # reasoning field; that mistake threw away a working review once
            # already.
            answer = ""
            for field in ("content", "reasoning"):
                candidate = strip_reasoning(str(message.get(field) or "")).strip()
                if candidate:
                    answer = candidate
                    break

            cut_off = choice_out.get("finish_reason") == "length"
            if answer and not cut_off:
                return answer
            last = answer or last
            # Empty for some reason other than running out of room. Asking
            # again with a bigger budget cannot fix that.
            if not cut_off:
                break
        if last and json_mode:
            # Still truncated after the larger budget. Said plainly, because
            # handing a half-finished object to a parser produces a message
            # about delimiters that means nothing to anybody.
            raise RuntimeError(
                f"{model} ran out of room before finishing the answer, even "
                f"at {attempts[-1]} tokens. Ask for fewer panels on this "
                f"page."
            )
        if last:
            return last
        raise RuntimeError(
            f"{model} replied without an answer. Send it again, or name a "
            f"different model for this step in server/routing.py."
        )
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
    # Nothing to analyse is answered here rather than by a model. This step
    # runs on the deep tier, so an empty request was buying the most
    # expensive model available in order to be told there was no story yet.
    # It also took long enough to do it that the check for this endpoint
    # would intermittently time out, which is how it was noticed.
    pages = payload.get("pages") or []
    has_content = any(
        (page.get("panels") or page.get("dialogue"))
        for page in pages if isinstance(page, dict)
    )
    if not has_content:
        return {"chapter": "", "overall": "", "flags": []}

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
    "You are the page director inside Firestarter, a layered "
    "canvas tool for manga, anime, posters and illustration. You BUILD "
    "pages; you never write essays. Answer with raw JSON only, no "
    "markdown, no code fences, in exactly this shape: "
    '{"reply": "at most 15 words", "cast": [{"name": "Rin", "tags": '
    '"1girl, long black hair, red kimono, scar on cheek"}], "panels": '
    '[{"prompt": "art tags for the shot", "cast": ["Rin"], "dialogue": '
    '[{"kind": "balloon", "text": "a real spoken line, usually 8 to 30 '
    'words", "speaker": "left"}, {"kind": "balloon", "text": "the reply, '
    'or the same speaker continuing", "speaker": "right"}]}]}. '
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
    "Write the scene as it would actually be scripted. Most panels of a "
    "conversation carry two or three balloons, not one: people interrupt, "
    "answer, evade, repeat themselves and talk past each other. A page of "
    "single-line panels reads as a storyboard rather than a comic, and a "
    "page where nobody says anything for six panels reads as an art book. "
    "A balloon of fifteen to thirty words is normal; a whole page of "
    "four-word lines is not. Let a character finish a thought across two "
    "balloons in the same panel when that is how they would say it. "
    "Reserve wordless panels for the ones that are carrying weight, and "
    "make sure something in the story changes in them. "
    "If the context carries a researched_style, it was looked up for this "
    "request and describes how the named works are actually drawn. Treat it "
    "as fact and put its tags_to_use into every panel prompt; prefer it over "
    "your own impression of those works, and never contradict its avoid "
    "list. If its confidence is low, lean on the user's own words instead. "
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
        "This project is a greeting card, which has a front and an "
        "inside. Return exactly ONE panel describing a charming, "
        "uncluttered illustration for the front. The dialogue list is "
        "the lettering, all of kind text, in this order: the greeting "
        "that goes on the front, then the message written inside, which "
        "may be a sentence or two, then optionally a sign off such as a "
        "name or a wish. The front stays short; the inside carries the "
        "words."
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

DIAGRAM_HINT = (
    "You returned panels. This project is a diagram, which must be exact, "
    "so panels cannot be used. Return the JSON with a nodes list and an "
    "edges list now, 4 to 12 components, reply at most 15 words."
)

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
                    "unparsed": False,
                }
        except Exception:
            pass
    # The contract was not met. Flagged rather than passed off as something
    # the agent said: this branch used to return the raw text as the reply,
    # which meant a truncated object went into the chat log verbatim and the
    # user read half a JSON document where an answer should have been.
    return {"reply": text, "panels": [], "cast": [], "nodes": [], "edges": [],
            "unparsed": True}


def page_token_budget(panels: int) -> int:
    """How much room a page of this many panels needs to come back whole.

    A named function rather than an expression inside agent_chat, so the
    check for it can measure the real thing instead of a copy of the
    formula that would keep passing after the real one changed.

    A flat 1400 was what shipped, and a six panel page with two or three
    balloons each does not fit in it: the reply stopped mid-string, the JSON
    would not parse, and the chat log filled with broken text while the page
    stayed empty.
    """
    return min(1200 + 520 * max(1, panels), 12000)


def agent_chat(payload: dict, current: dict) -> dict:
    """Build pages from a brief, having first found out what it refers to.

    Naming a work is how people describe what they want to see, and it is
    the one thing a model cannot supply from the name alone. So whatever the
    brief points at is looked up before any panel is written, and what comes
    back is handed over as fact rather than left to recollection.

    Bounded, and never fatal. A lookup that overruns is abandoned for this
    page and finishes in the background, so the next page of the chapter has
    it. A page that is slightly less faithful beats a page that never
    arrives.
    """
    latest = ""
    for message in reversed(payload.get("messages") or []):
        if isinstance(message, dict) and message.get("role") == "user":
            latest = str(message.get("content", ""))
            break
    studied = None
    if current.get("openrouter") and latest:
        try:
            studied = reference.research_for_bounded(latest, current["openrouter"])
        except Exception:
            studied = None          # never at the cost of the page itself

    context = json.dumps({
        "project": payload.get("project"),
        "kind": payload.get("kind"),
        "art_style": payload.get("art_style"),
        "existing_cast": payload.get("cast", []),
        "story_so_far": payload.get("story"),
        "pages": payload.get("pages", []),
        # Only present when something was actually found, so the model is
        # never handed an empty field to read meaning into.
        **({"researched_style": {
            "works": studied.get("names"),
            "confidence": studied.get("confidence"),
            "how_it_is_drawn": studied.get("notes"),
            "tags_to_use": studied.get("tags"),
            "avoid": studied.get("avoid"),
        }} if studied else {}),
    })
    # Anything may arrive over the wire: a string where a list belongs, or
    # entries that are not objects. Neither should become a 500.
    raw_messages = payload.get("messages")
    if not isinstance(raw_messages, list):
        raw_messages = []
    messages = [
        {"role": m.get("role", "user"), "content": str(m.get("content", ""))[:MAX_PROMPT]}
        for m in raw_messages
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
    ] or [{"role": "user", "content": "hello"}]
    directive = LAYOUT_DIRECTIVES.get(payload.get("layout") or "panels", "")
    system = AGENT_SYSTEM + " " + directive + " Current project context: " + context
    layout = payload.get("layout") or "panels"

    # A planned page is told how many panels it has, because the plan decided
    # the chapter's rhythm and a page that quietly returns five panels every
    # time flattens it back out.
    try:
        wanted_panels = int(payload.get("panels_wanted") or 0)
    except (TypeError, ValueError):
        wanted_panels = 0
    wanted_panels = max(0, min(wanted_panels, 9))
    if wanted_panels:
        system += (f" This page has exactly {wanted_panels} panels. Not more,"
                   f" not fewer.")
    # Room enough for the page that was actually asked for.
    #
    # A flat 1400 was fine for terse panels and nowhere near enough once the
    # dialogue guidance started asking for two or three balloons each: a six
    # panel page needs the cast list, six prompts and up to eighteen lines of
    # speech, and it stopped mid-string every time. Budgeted from the number
    # of panels instead, so the ceiling grows with the request rather than
    # being a number that happened to be enough once.
    page_budget = page_token_budget(wanted_panels or 6)
    result = parse_agent_json(llm_chat(current, system, messages,
                                       max_tokens=page_budget, json_mode=True))
    # A diagram project that came back as comic panels means the model
    # dropped the contract; ask once more before giving up on it.
    if layout == "blueprint" and not result.get("nodes"):
        result = parse_agent_json(llm_chat(
            current, system, messages + [{"role": "user", "content": DIAGRAM_HINT}],
            max_tokens=page_budget, json_mode=True))
    if layout != "blueprint" and not result["panels"] and looks_like_build_request(messages):
        # the model lapsed into prose: demand the page once more
        result = parse_agent_json(llm_chat(
            current, system, messages + [{"role": "user", "content": BUILD_HINT}],
            max_tokens=page_budget, json_mode=True))
    panels = []
    for panel in result["panels"][:(wanted_panels or 8)]:
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

    # Never hand a diagram project a comic page: wrong output entirely,
    # and silently so.
    if layout == "blueprint":
        panels = []

    # A poster, a card or a single illustration is one artwork. If the
    # model returns several beats anyway, keep the first as the subject
    # and carry every line of lettering, rather than merging four scene
    # descriptions into one prompt and rendering the average of them.
    if layout in ("single", "poster", "card") and len(panels) > 1:
        merged = dict(panels[0])
        merged["dialogue"] = [d for p in panels for d in p["dialogue"]][:5]
        panels = [merged]

    reply = short_reply(result["reply"])
    if panels and (len(reply) > 160 or not reply):
        reply = f"Built a {len(panels)} panel page."
    if nodes and not reply:
        reply = f"Diagram with {len(nodes)} components."

    # Whatever goes out is something a person can read.
    #
    # Two things used to escape into the chat log. A reply that failed to
    # parse was sent verbatim, so a truncated object arrived as a wall of
    # {"reply":"Built page 1...","cast":[{"name":"Kade". And a reasoning model
    # that spent its budget thinking returned that thinking instead of an
    # answer, so the log filled with "**Planning panel setup** I need to
    # create a page with 2 to 6 panels". Neither is a message; both looked
    # like the application talking nonsense to itself, because that is
    # exactly what it was doing.
    if result.get("unparsed") or reply.lstrip().startswith(("{", "[")) \
            or reply.lstrip().startswith("**"):
        reply = ("The model did not answer in the form this expects, so "
                 "nothing was built. Send it again — it usually works on the "
                 "second try.")
        if panels:
            reply = f"Built a {len(panels)} panel page."

    return {"reply": reply, "panels": panels, "cast": cast,
            "nodes": nodes, "edges": edges}


# ------------------------------------------------------------ chapter plans --
# A chapter is not a page repeated. Every page had been asked for on its own,
# with no idea of the shape it sat inside, and the result read exactly like
# that: eight pages of things looking dramatic and nothing happening, which
# is what a page written without knowing what it has to accomplish looks
# like.
#
# So the shape is decided once, in one cheap call, before any page is drawn.
# Each page then gets told what it is for. It is the difference between "draw
# a fight" eight times and "this is the page where he stops losing".
PLAN_SYSTEM = """You plan the pages of a comic chapter before any of them are
drawn. Answer only as JSON:

{"title": "...",
 "chapter": "what happens in this chapter, one paragraph",
 "pages": [{"beat": "...", "changes": "...", "panels": 5}, ...]}

For every page:

  "beat"     what actually happens on it, in two to four sentences. Physical
             events and what is said, not mood. "He gets up and walks into
             the swing" is a beat; "tension builds" is not. One short line is
             not enough to draw a page from: "the enemy sighs" describes a
             panel, and you are describing a page that has to hold several.
  "changes"  what is true in the world after this page that was not true
             before it. A fact, not a feeling. "His guard hand is broken" is
             a change; "he feels renewed confidence" is not, and neither is
             anything about pride, determination, doubt or an inner fire.
             If you cannot name a change, the page should not exist: delete
             it and give its space to a page that earns one.
  "panels"   how many panels, 1 to 9. Vary this hard between pages: a page of
             nine small panels next to a page of two is what gives a chapter
             its rhythm, and every page the same size reads flat. Do not let
             the numbers climb or fall in order either — 1,2,3,4,5 is as
             mechanical as 5,5,5,5,5. Few panels means a big moment, many
             panels means fast exchange, so let the beat decide and check
             afterwards that no two neighbours match.

Rules:

If the request already says what happens on which page, that is the plan.
Follow it page for page and do not substitute an arc of your own. Given eight
numbered beats, return those eight beats. You are being asked to break the
work into pages, not to rewrite what somebody has already decided.

Each page must move the situation. A page that could be removed without the
reader losing anything is the wrong page.

The aftermath is not the chapter. If the request builds to something, the
build is the chapter and the moment lands at the end of it. Do not spend the
back half on people reacting to what already happened: a page of someone
standing in the wreckage feeling changed is the most common way a chapter
turns into nothing happening.

Escalate, and let it cost something. A reversal the reader saw coming is
still a reversal, but it must be paid for.

Spend the full-page moment once, on the page whose "changes" is the largest,
and nowhere else.

Do not invent character names unless the request gives them. Refer to people
by role: the fighter, the one watching, the crowd.

The pages array must hold exactly the number of pages asked for. Count the
entries before you answer. A plan one page short is a plan for a different
chapter, and the page it dropped is usually the one that mattered."""


PLAN_RESEARCH_SECONDS = float(
    os.environ.get("STUDIO_PLAN_RESEARCH_SECONDS", "200"))


def plan_chapter(payload: dict, current: dict) -> dict:
    """The shape of the whole chapter, decided once and cheaply.

    Uses the fast tier: this is structure, not prose, and it is one call
    against a request that is about to pay for a page of art per entry. The
    expensive models are for the words and pictures a person actually reads.
    """
    wanted = payload.get("pages_wanted")
    try:
        wanted = int(wanted)
    except (TypeError, ValueError):
        wanted = 6
    wanted = max(2, min(wanted, 24))
    started = time.time()

    brief = ""
    for message in reversed(payload.get("messages") or []):
        if isinstance(message, dict) and message.get("role") == "user":
            brief = str(message.get("content", ""))[:MAX_PROMPT]
            break
    if not brief:
        raise RuntimeError("a brief is required to plan a chapter")

    # The lookup runs alongside the planning, not before it.
    #
    # Measured: forty-five seconds to work out which works are named, then
    # about two minutes to research three of them. Waited for in sequence
    # that is three minutes of nothing before a plan appears, and on a
    # hundred and fifty second budget it was simply abandoned every time, so
    # every chapter was planned and drawn knowing nothing about the work the
    # request was mostly about.
    #
    # They do not need to be sequential. A plan is story structure — which
    # page carries which beat — and that comes from the brief. It is the
    # drawing that needs to know how the work is drawn. So the lookup starts
    # here, the plan is written while it runs, and whatever has arrived by
    # the time the plan is finished goes into the answer. Anything still in
    # flight keeps going and lands in the cache, which is where every page
    # of this chapter reads it from.
    studied = {}
    research = None
    if current.get("openrouter"):
        def look_up():
            try:
                studied["found"] = reference.research_for(
                    brief, current["openrouter"])
            except Exception:
                pass
        research = threading.Thread(target=look_up, daemon=True)
        research.start()

    context = json.dumps({
        "kind": payload.get("kind"),
        "art_style": payload.get("art_style"),
        "existing_cast": payload.get("cast", []),
        "story_so_far": payload.get("story"),
        "pages_already_drawn": len(payload.get("pages") or []),
    })

    system = (PLAN_SYSTEM + f"\n\nPlan exactly {wanted} pages."
              + " Project context: " + context)
    # Budgeted per page, not as one flat number. A fixed 1800 was enough for
    # terse beats and not enough for the two-to-four sentences the planner is
    # now asked for: at eight pages the answer was cut off mid-string, and a
    # truncated object is a JSON error rather than a short plan.
    budget = min(900 + 320 * wanted, 8000)
    raw = llm_chat(current, system, [{"role": "user", "content": brief}],
                   max_tokens=budget, json_mode=True, step="page_plan")

    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("the planner did not answer with JSON")
    try:
        plan = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as error:
        # Said plainly, because the two causes need different responses and a
        # decoder's "expecting ',' delimiter" tells nobody which one it is.
        raise RuntimeError(
            f"the plan came back incomplete ({error.msg}). It was cut off at "
            f"{len(raw)} characters against a {budget} token budget. Ask for "
            f"fewer pages, or raise the budget in plan_chapter."
        ) from error

    # A field asked for as a string comes back as a list about a third of the
    # time, and as null when the model has nothing to say. str() on those
    # produces "['The crowd loses interest']" and the literal word "None",
    # and both went straight into the page listing a person reads before
    # deciding whether to spend eight image generations on it.
    def as_text(value: object) -> str:
        if value is None:
            return ""
        if isinstance(value, (list, tuple)):
            return "; ".join(as_text(item) for item in value if item is not None)
        if isinstance(value, dict):
            return "; ".join(as_text(item) for item in value.values())
        return str(value).strip()

    pages = []
    for page in (plan.get("pages") or []):
        if not isinstance(page, dict):
            continue
        beat = as_text(page.get("beat"))
        if not beat:
            continue
        try:
            panels = int(page.get("panels") or 5)
        except (TypeError, ValueError):
            panels = 5
        pages.append({
            "beat": beat[:600],
            "changes": as_text(page.get("changes"))[:300],
            "panels": max(1, min(panels, 9)),
        })
    if not pages:
        raise RuntimeError("the planner returned no pages")

    # Give the lookup the rest of its budget now that the plan is written.
    # Whatever is not ready keeps running and lands in the cache, so a page
    # asked for a minute from now gets it even though this response could
    # not.
    if research is not None:
        research.join(max(0.0, PLAN_RESEARCH_SECONDS - (time.time() - started)))
    found = studied.get("found") or {}

    # Asked for eight and given five is a plan for a different chapter. Short
    # is reported rather than padded: inventing the missing pages here would
    # produce exactly the empty pages the plan exists to prevent.
    return {
        "title": as_text(plan.get("title"))[:120],
        "chapter": as_text(plan.get("chapter"))[:1200],
        "pages": pages[:wanted],
        "wanted": wanted,
        "researched": found.get("names") or [],
        "style_confidence": found.get("confidence") or "",
        # True when the lookup is still going. Not the same as having found
        # nothing, and the difference matters to somebody deciding whether to
        # press draw now or wait: still running means the pages will have it.
        "still_researching": bool(research is not None and research.is_alive()),
    }


# -------------------------------------------------------------------- server --
def generate_openrouter_image(prompt: str, width: int, height: int,
                             key: str, negative: str = "") -> bytes:
    """An image from a frontier model, through the key already configured.

    This is the engine somebody who only installed the application can
    actually use. A local checkpoint is free and private and needs a
    graphics card, a CUDA build of torch and thirteen gigabytes of weights,
    none of which a person who was sent an installer has.

    These models take a description rather than a tag list, and refuse a
    negative prompt outright, so what would have been a negative is folded
    into the description as something to avoid.
    """
    model = routing.image_model()
    if not model:
        raise RuntimeError("no image model available from the provider")

    brief = prompt.rstrip(" ,")
    if negative.strip(" ,"):
        brief += f". Avoid: {negative.strip(' ,')}."
    brief += (f" Aspect ratio about {width}:{height}."
              f" No text, letters, watermarks or speech balloons anywhere"
              f" in the image.")

    result = http_json(
        "https://openrouter.ai/api/v1/chat/completions",
        {"model": model,
         "messages": [{"role": "user", "content": brief}],
         "modalities": ["image", "text"]},
        {"Authorization": f"Bearer {key}", "X-Title": "Firestarter"},
        timeout=300,
    )
    message = (result.get("choices") or [{}])[0].get("message") or {}

    # Providers disagree about where an image goes, so look where they put
    # them rather than insisting on one shape.
    places = list(message.get("images") or [])
    if isinstance(message.get("content"), list):
        places += message["content"]
    for item in places:
        url = ((item or {}).get("image_url") or {}).get("url") or ""
        if url.startswith("data:"):
            return base64.b64decode(url.split(",", 1)[1])
    raise RuntimeError(
        f"{model} answered without an image. Keys in the reply: "
        + ", ".join(sorted(message))
    )


def engine_table(current: dict) -> list:
    table = [
        {"id": "openrouter-image",
         "label": "Frontier image model (hosted)",
         "available": bool(current.get("openrouter"))},
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

    def _bearer(self) -> str:
        header = self.headers.get("Authorization", "")
        return header[7:].strip() if header.startswith("Bearer ") else ""

    def _authorized(self) -> bool:
        """Who is calling, and may they call again yet.

        A deployment pays for every request it serves, so an unknown
        caller and an unbounded one are the same problem. Answers the
        response itself, because the two refusals differ: one is
        permanent and one asks the caller to wait.
        """
        tokens = limits.load_tokens()
        if not tokens:
            return True                      # unprotected, as on a laptop
        token = self._bearer()
        who = limits.label_for(token, tokens)
        if not who:
            self._json(401, {"error": "missing or invalid bearer token"})
            return False
        verdict = limits.check(token)
        if not verdict["ok"]:
            self.send_response(429)
            self.send_header("Retry-After", str(verdict["retry_after"]))
            self.send_header("Content-Type", "application/json")
            body = json.dumps({
                "error": f"too many requests ({verdict['reason']} limit)",
                "retry_after": verdict["retry_after"],
                "used_today": verdict["day"],
                "allowed_per_day": limits.PER_DAY,
            }).encode()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return False
        return True

    def do_OPTIONS(self):  # noqa: N802
        self._json(200, {"ok": True})

    def do_GET(self):  # noqa: N802
        current = keys()
        if self.path == "/health":
            self._json(200, {
                "ok": True,
                "build": BUILD,
                "auth": bool(limits.load_tokens()),
                "local": gpu_available(),
                "apis": any([current.get("openrouter"), current["ideogram"],
                             current["openai"], current["bfl"]]),
                "story": bool(current["anthropic"]) or local_llm_reachable(current)
                         or bool(current.get("openrouter")),
                "video": video.available(current),
            })
            return
        if not self._authorized():
            return                       # already answered, with a reason
        if self.path == "/usage":
            self._json(200, limits.usage(self._bearer()))
            return
        if self.path == "/engines":
            self._json(200, {"engines": engine_table(current),
                             "video": video.describe(current)})
        else:
            self._json(404, {"error": "unknown endpoint"})

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            return                       # already answered, with a reason
        current = keys()                 # the video branch needs these
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid JSON"})
            return
        if self.path == "/generate":
            self._generate(payload)
        elif self.path == "/reference/style":
            name = str(payload.get("name", "")).strip()
            if not name:
                self._json(400, {"error": "a name to research is required"})
                return
            if not current.get("openrouter"):
                self._json(400, {"error": "researching a style needs an "
                                          "OpenRouter key"})
                return
            try:
                self._json(200, {"ok": True, **reference.style_from_name(
                    name, current["openrouter"])})
            except Exception as error:
                self._json(400, {"error": f"{type(error).__name__}: {error}"})
        elif self.path == "/reference/image":
            source = str(payload.get("image_url", "")).strip()
            if not source.startswith("data:") and not source.startswith("http"):
                self._json(400, {"error": "an image is required, as a data "
                                          "url or an http url"})
                return
            if not current.get("openrouter"):
                self._json(400, {"error": "reading a reference needs an "
                                          "OpenRouter key"})
                return
            try:
                self._json(200, {"ok": True, **reference.style_from_image(
                    source, current["openrouter"],
                    str(payload.get("note", "")))})
            except Exception as error:
                self._json(400, {"error": f"{type(error).__name__}: {error}"})
        elif self.path == "/generate/video":
            engine = str(payload.get("engine", "fal"))
            prompt = str(payload.get("prompt", "")).strip()
            if not prompt:
                self._json(400, {"error": "a prompt is required"})
                return
            if len(prompt) > MAX_PROMPT:
                self._json(400, {"error": f"prompt longer than {MAX_PROMPT}"})
                return
            result = video.generate(
                engine, prompt, current.get(engine) or "",
                image_url=payload.get("image_url"),
                seconds=payload.get("seconds"),
            )
            self._json(200 if result["ok"] else 400, result)
        elif self.path == "/story/analyze":
            self._story(payload)
        elif self.path == "/agent/chat":
            self._chat(payload)
        elif self.path == "/agent/plan":
            self._plan(payload)
        else:
            self._json(404, {"error": "unknown endpoint"})

    def _generate(self, payload: dict) -> None:
        current = keys()
        engine = str(payload.get("engine", "ideogram"))
        prompt = str(payload.get("prompt", "")).strip()
        if not prompt:
            self._json(400, {"error": "prompt is required"})
            return
        if len(prompt) > MAX_PROMPT:
            self._json(400, {"error": f"prompt is longer than {MAX_PROMPT} characters"})
            return
        if engine not in KNOWN_ENGINES:
            self._json(400, {"error": f"unknown engine: {engine}"})
            return
        family = family_for(payload.get("style"))
        if engine == "local-gpu":
            # tag-driven checkpoint: the negative prompt already bars
            # lettering, so the prose no-text clause would only dilute it
            prompt = gpu_prompt(prompt, family)
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
                                     str(payload.get("negative", "")),
                                     family)
            elif engine == "openrouter-image":
                if not current.get("openrouter"):
                    raise RuntimeError("OpenRouter key missing")
                image = generate_openrouter_image(
                    prompt, int(payload.get("width", 1024)),
                    int(payload.get("height", 1024)),
                    current["openrouter"], str(payload.get("negative", "")))
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

    def _plan(self, payload: dict) -> None:
        current = keys()
        try:
            self._json(200, {"ok": True, **plan_chapter(payload, current)})
        except Exception as error:
            self._json(400, {"error": f"{type(error).__name__}: {error}"})

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
