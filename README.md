# prod-imagen studio

Layered canvas studio for AI-assisted visual stories: manga pages, anime
illustrations, posters, and diagrams. Figma-style layers, exact vector
lettering (balloons, captions, onomatopoeia), multi-engine AI art
generation, and a continuity-tracking story engine.

> Source-available under the PolyForm Noncommercial License 1.0.0.
> Personal and noncommercial use is free; commercial licensing is
> reserved by the author. See [LICENSE](LICENSE).

## Features

- Project launcher: Image projects (manga page, anime illustration,
  poster/cover, diagram/graph, freeform); Video mode arrives in phase 2
- Layered editor: draw-to-place AI panels, speech balloons, captions,
  title text, SFX/onomatopoeia with outline and rotation, shapes
- Every element stays editable: fonts, text size, colors, geometry
- Layers dock with drag reordering, visibility, and locking
- Multi-engine generation behind one dropdown: Ideogram, OpenAI image,
  FLUX (bring your own API keys); local dev engine for contributors
- Story dock: chapter summary, whole-story digest, and continuity flags
  computed from every page's panels and dialogue
- Multi-page documents, .dimg project files, 2x PNG export

## Install

Grab the installer for Windows (.exe) or macOS (.dmg) from the
[Releases](../../releases) page.

## Run from source

Requirements: Node 22+, Python 3.12+.

1. Backend: `python server/gen_server.py`
   - Put API keys in `server/keys.json` (see `server/keys.example.json`)
     or export `IDEOGRAM_API_KEY` / `OPENAI_API_KEY` / `BFL_API_KEY` /
     `ANTHROPIC_API_KEY`.
2. App: `cd studio && npm install && npm start`

## Deploying the backend (24x7)

The server is a single stdlib-only Python file, containerized:

    docker build -t prod-imagen-server server/
    docker run -p 8787:8787 \
      -e STUDIO_HOST=0.0.0.0 \
      -e STUDIO_AUTH_TOKEN=<random-strong-token> \
      -e IDEOGRAM_API_KEY=... -e ANTHROPIC_API_KEY=... \
      prod-imagen-server

With `STUDIO_AUTH_TOKEN` set, every endpoint except `/health` requires
`Authorization: Bearer <token>`. Point the app at your server URL and
token from the editor settings. Any container host works (Fly.io,
Railway, a $5 VPS); GPU is not required because generation runs through
hosted APIs.

## Security

- API keys are never committed: `server/keys.json` is gitignored and CI
  fails on secret-looking strings.
- The public build contains no model weights and no training code.

## Releases

Tag a version to build installers automatically:

    git tag v0.3.0 && git push --tags

CI builds Windows and macOS installers and attaches them to a draft
GitHub release.
