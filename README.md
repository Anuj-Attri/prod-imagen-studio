# prod-imagen studio

A layered canvas studio for visual stories: manga pages, anime
illustrations, posters and diagrams. Figma-style layers, exact vector
lettering, generated art from a local GPU or a hosted API, and a
directing agent that lays out whole pages.

> Source-available under the PolyForm Noncommercial License 1.0.0.
> Personal and noncommercial use is free; commercial licensing is
> reserved by the author. See [LICENSE](LICENSE).

## What it does

- **Pages, not prompts.** Describe a scene and the agent returns the
  beats. The application places the panels using comics layout
  templates: tiers, proper gutters, right-to-left order for manga.
- **A style contract per project.** One art style preset plus a cast
  sheet of permanent appearance tags per character, applied to every
  panel, so a sequence reads as one artist rather than several.
- **Lettering stays vector.** Balloons, captions and onomatopoeia are
  real text objects with fonts, colours and outlines. No model is ever
  asked to render words.
- **A real editor.** Brush and eraser, shapes, image import with crop
  and adjustments, multi-select with snapping, align and distribute,
  layer opacity and blend modes, undo/redo and named version history.
- **Local by default.** Art can render on your own GPU and the agent
  runs against a local language model. Nothing leaves the machine
  unless you configure a hosted provider yourself.

## Install

Download the installer for Windows (`.exe`) or macOS (`.dmg`) from the
[Releases](../../releases) page.

## Run from source

Requirements: Node 22+, Python 3.12+.

    git clone <this repository>
    cd prod-imagen-studio
    cd studio && npm install && cd ..

Windows: `start-studio.cmd`  ·  macOS and Linux: `./start-studio.sh`

The launcher starts the backend and the app together, replacing any
server already holding port 8787.

### Optional: art generation on your own GPU

Free, offline and unlimited. Needs an NVIDIA GPU with 12 GB or more.

    python -m venv .venv-image
    .venv-image/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
    .venv-image/Scripts/python -m pip install diffusers transformers accelerate safetensors pillow

The first render downloads the model (about 7 GB, cached afterwards).
Set `LOCAL_IMAGE_MODEL` to use a different checkpoint. The launcher
prefers this interpreter automatically when it exists.

### Optional: hosted art engines

Put keys in `server/keys.json` (see `server/keys.example.json`) or
export `IDEOGRAM_API_KEY`, `OPENAI_API_KEY`, `BFL_API_KEY`. Each engine
appears in the dropdown only once its key is present.

### Optional: the directing agent

The agent and the story analysis use any OpenAI-compatible endpoint,
for example [Ollama](https://ollama.com):

    ollama pull qwen3:8b

Point it somewhere else with `LLM_BASE_URL` and `LLM_MODEL`, or in
Settings. An Anthropic key works as a fallback if you prefer it.

## Deploying the backend

The server is a single standard-library Python file, containerized:

    docker build -t prod-imagen-server server/
    docker run -p 8787:8787 \
      -e STUDIO_HOST=0.0.0.0 \
      -e STUDIO_AUTH_TOKEN=<random-strong-token> \
      prod-imagen-server

With `STUDIO_AUTH_TOKEN` set, every endpoint except `/health` requires
`Authorization: Bearer <token>`. `/health` also reports the running
build, which is the quickest way to catch a stale server.

## Security

- Keys are never committed: `server/keys.json` is gitignored and CI
  fails the build on secret-looking strings.
- No model weights and no training data are included in this repository.

## Releases

Tagging a version builds the installers:

    git tag v0.4.0 && git push --tags

CI builds Windows and macOS installers and attaches them to a draft
release for testing before publication.
