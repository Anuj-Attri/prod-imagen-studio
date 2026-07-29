# prod-imagen studio: agent onboarding

Rules for any coding agent working on this repository.

## Architecture

- `studio/`: Electron app, plain JS, no build step. `main.js` (windows,
  IPC, auto-update), `preload.js` (bridge), `launcher.html` (project
  picker), `editor.html` + `editor.js` (canvas editor: Konva stage,
  layers model, dock panels, agent chat).
- `server/gen_server.py`: stdlib-only Python HTTP server, port 8787.
  Image engines: local GPU (diffusers, free) plus Ideogram / OpenAI /
  FLUX (key-gated) and an optional local dev engine. Language backend
  for agent + story: local OpenAI-compatible endpoint first
  (Ollama/vLLM), Anthropic fallback. `/health` reports `build`.
- `.venv-image/`: CUDA interpreter for the local GPU engine. The
  launcher prefers it so `torch.cuda` is visible to the server. It is
  gitignored; contributors without a GPU simply do not get that engine.
- Privacy first: everything runs locally by default. No telemetry.
  Keys and chats never leave the machine except to call a provider the
  user explicitly configured.

## Hard rules

- The layers array in the document model is the source of truth; the
  Konva canvas only renders it.
- Konva Stage CLEARS its container element: overlay UI lives in
  `#canvas-overlay`, never inside `#canvas-wrap`.
- The Transformer must share the container of the nodes it transforms.
- All lettering is vector text on the canvas. Never rely on a model to
  render text.
- Panel geometry belongs to `pageLayout()` in editor.js, never to the
  language model: models have no spatial sense and produce overlapping
  pages. The model returns beats (prompt + dialogue) only.
- Art prompts for anime/manga checkpoints must be comma-separated
  danbooru tags, not prose. Prose loses the subject entirely. The
  agent system prompt enforces this and the server appends the style
  and quality tag block per project kind.
- A diffusers pipeline is not thread safe; generation is serialized
  behind `_gpu_run_lock`. Concurrent calls corrupt scheduler state.
- Never leave a stale server on 8787: it silently serves old code.
  Check `build` on `/health` when behaviour does not match the source.
- No emoji in UI copy or code. No long dashes in copy. Accent color is
  used sparingly: focus, active-tab underline, primary button border.
- Never commit secrets. `server/keys.json` is gitignored; CI fails on
  secret-looking strings.
- Electron `loadFile` query values are auto-encoded; do not encode
  again. `parseProject()` in editor.js is the reference decoder.

## Verify before any commit

    node --check studio/main.js studio/preload.js studio/editor.js
    python -m py_compile server/gen_server.py

Then load `studio/editor.html` in headless Chrome and confirm no
uncaught console errors.

## Release flow

Maintainer tags `vX.Y.Z`; CI builds Windows and macOS installers into a
draft GitHub release. Maintainer tests, then publishes the release;
packaged apps pick it up via electron-updater. Never publish a release
yourself; never bump the version without being asked.
