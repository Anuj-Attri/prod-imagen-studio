# Firestarter

Firestarter is a desktop drawing app for comics and illustration. You get a
layered canvas with the usual tools (brush, shapes, image import, guides,
undo history) and an agent panel where you describe what you want. Ask for a
scene and it lays out the panels and writes the dialogue into them. Ask for an
eight page chapter and it plans the chapter first, shows you the plan, then
draws every page. Speech balloons and captions stay editable text, so you can
rewrite a line without regenerating the art. It also does coloring books,
posters, greeting cards and system diagrams, and exports a finished chapter as
one PDF.

## Install

Download the installer from [Releases](../../releases):

- **Windows**: `Firestarter-<version>-win-x64.exe`
- **Mac, Apple silicon**: `Firestarter-<version>-mac-arm64.dmg`
- **Mac, Intel**: `Firestarter-<version>-mac-x64.dmg`

Run it. On Windows, SmartScreen will warn you the publisher is unknown:
click **More info**, then **Run anyway**. On macOS, right-click the app and
choose **Open** the first time, because the build is not signed with a paid
Apple certificate.

Firestarter needs an internet connection and an access token. Open
**Settings** and paste the token under *Advanced*. Ask Anuj for one.

That is the whole setup. There is nothing to install for Python, no model
weights to download, and no API keys to buy. Generation runs on a shared
backend.

Updates install themselves. When a new version is out, a notice appears in
the app.

## Running your own backend

Only needed if you would rather not use the shared one. The server is a
single Python file with no dependencies outside the standard library:

    docker build -t firestarter-server server/
    docker run -p 8787:8787 \
      -e STUDIO_HOST=0.0.0.0 \
      -e OPENROUTER_API_KEY=<your key> \
      -e STUDIO_AUTH_TOKEN=<any strong string> \
      firestarter-server

Then point the app at `http://localhost:8787` in Settings, with the same
token. Generation is billed to your [OpenRouter](https://openrouter.ai) key.
`server/routing.py` decides which model runs which step.

## Building from source

Node 22+ and Python 3.12+.

    git clone <this repository>
    cd firestarter/studio && npm install && cd ..

Windows: `start-studio.cmd` · macOS and Linux: `./start-studio.sh`

Checks:

    node verify.js

## Licence

Source-available under the PolyForm Noncommercial License 1.0.0. Free for
personal and noncommercial use; commercial licensing is reserved by the
author. See [LICENSE](LICENSE).
