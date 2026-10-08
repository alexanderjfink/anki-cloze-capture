# Anki Cloze Capture

A Firefox extension that turns things you read on the web into high-quality Anki
cards — without leaving the page. Highlight text, click or press a shortcut, and
an LLM generates concise cloze cards, routes them to the most relevant deck, and
shows them in an editable preview. It also marks the pages you've captured from,
so you can always find your way back to where a card came from.

## Features

- **Highlight → cloze cards.** Select text and trigger capture via an in-page
  floating button, the right-click menu, or a configurable keyboard shortcut
  (default `Alt+Shift+A`). An LLM converts the selection (plus surrounding
  context) into 1–5 cloze deletion cards using a strict quality ruleset.
- **Editable preview.** Nothing is added until you confirm. Edit cloze text,
  Back Extra, and the target deck inline. Editors auto-grow so you scroll through
  cards instead of inside tiny text boxes.
- **Two workflows.**
  - *Immediate*: a notification card per highlight.
  - *Collect*: every highlight accumulates in a single bottom-right **review
    board**, so you can read in one flow and review everything at the end. The
    board has a "send all cards to" deck selector.
- **Smart deck routing.** Cards are routed to the best-matching deck by
  embedding similarity against your deck names, with a configurable fallback deck
  and an LLM-based fallback if embeddings are unavailable.
- **Page markers.** Every card is anchored back to the exact passage (or image)
  on the page. An inline badge and a bottom-right floater let you view and edit
  the notes attached to a page; clicking outside the editor closes it.
- **Image cards.** Click or right-click an image to create a Basic-style note
  (image on one side, identifier on the other), with fuzzy identification from
  alt text/captions, an optional vision model, and user reuse of existing models.
- **Autogenerate from a page.** A shortcut (default `Alt+Shift+G`) or popup
  button asks how many cards you want, reads the page, and generates the most
  useful facts into the review board.
- **Hypothes.is integration.** Optionally watch Hypothes.is highlights on a page
  (DOM mode) or poll the Hypothes.is API with a personal token (API mode) and
  auto-generate cards as you annotate.
- **Provider strategy.** Choose between remote (e.g. OpenCode Go) and local
  (Ollama / vLLM) LLMs, with token-saving, charging-only, and offline-fallback
  rules.
- **Offline queue.** If Anki is closed, confirmed cards are queued locally and
  synced automatically.
- **Configurable shortcuts** for capture, edit, markers, and autogen.

## Requirements

- **Firefox** (desktop; the extension is Manifest V2 with a Firefox 102+
  minimum).
- **Anki** running with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
  add-on (code `2055492159`), reachable at `http://127.0.0.1:8765`.
- An **LLM provider** for card generation, configured in Settings:
  - **OpenCode Go** (remote; a personal API key), and/or
  - **Ollama** or **vLLM** (local; OpenAI-compatible endpoints).
- Optional: **Ollama / vLLM / custom embeddings** for deck routing (falls back to
  LLM routing or a default deck if unavailable).
- Optional: a **Hypothes.is** account and API token for the Hypothes.is
  integration.

## Install (development)

Requires [Bun](https://bun.sh/) (and Node for tooling).

```bash
bun install
bun run build            # bundles to dist/
```

Then in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** and select `dist/manifest.json`.

The add-on loads until Firefox restarts. For a live-reloading workflow:

```bash
bun run dev              # rebuild on change
bunx web-ext run         # launch Firefox with the extension
```

To produce a distributable archive:

```bash
bun run package          # writes web-ext-artifacts/*.zip (unsigned)
```

## Usage

1. Open the extension's **Settings** and configure at least one LLM provider and
   your AnkiConnect endpoint. Set the target note model and (for image cards) the
   Basic-style model.
2. On any page, highlight a passage and:
   - click the floating **＋ Anki cloze** button, or
   - right-click → **Create Anki cloze card**, or
   - press `Alt+Shift+A`.
3. Review the generated cards in the notification/review board, tweak as needed,
   and click **Add to Anki**.

Other entry points:

- **Right-click an image → Create Anki image card** (or click an image and use
  the floating button).
- **Autogen**: `Alt+Shift+G` or the popup's **Autogen from page** button.
- **Hypothes.is**: enable in Settings, then new highlights generate cards
  automatically (or use the popup's **Import Hypothes.is highlights**).
- **Page markers**: markers and the bottom-right floater appear on pages you've
  captured from; toggle them in Settings, the popup, or `Alt+Shift+M`.

## Configuration reference

Settings are grouped in the options page:

- **Active LLM provider** — OpenCode Go / Ollama / vLLM, with per-provider base
  URL, model (loaded from the server as a dropdown), and API key.
- **Provider strategy** — prefer local to save tokens, only while charging, fall
  back to local when offline, and max concurrent requests.
- **Deck routing (embeddings)** — embedding provider, model, threshold, fallback
  deck, excluded decks, and optional per-deck descriptions.
- **Card generation** — max cards per highlight, Bloom level, temperature, max
  words per cloze, reasoning effort (OpenCode Go), and default autogen count.
- **Image cards** — note models, field mapping, default side/direction, image
  size cap, optional downscale, and optional vision naming.
- **Page markers** — show markers; normalize URLs (ignore `#hash` and tracking
  parameters).
- **Hypothes.is** — mode (off / automatic / API / page watch), API token, poll
  interval, and whether to include note text.
- **Anki & triggers** — AnkiConnect endpoint, note model and fields, floating
  button, source-line behavior, and the unsaved-cards close warning.
- **Shortcuts** — record/apply keyboard shortcuts for capture, edit, markers, and
  autogen.

## Project layout

```
build.ts                 # Bun bundler -> dist/
public/                  # manifest.json, options.html, popup.html, icons
src/
  background/            # event page: orchestration, queues, AnkiConnect, routing
  content/               # selection capture, floating button, page markers
  preview/               # preview panel, review board, autosize helper
  options/               # settings page controller
  popup/                 # toolbar popup controller
  lib/                   # anki, llm, embeddings, decks, prompt, quality,
                         # media, annotations, anchor, hypothesis, shortcuts,
                         # strategy, storage, types
tests/                   # Bun unit tests
```

## Development

```bash
bun run typecheck        # tsc --noEmit
bun test                 # unit tests
bun run build            # bundle
bun run lint             # web-ext lint
bun run package          # build an unsigned .zip
```

## How cards are built

The card-generation prompt encodes a strict quality ruleset: at most 2 words per
cloze deletion, one discrete fact per cloze, at most 3 clozes per card, category
hints only when needed, list formatting for sequences, and a pre-flight check for
targeting, ambiguity, context, novelty, concision, and answer giveaways. Image,
Anki, and Hypothes.is cards all flow through the same deck routing, preview, and
queue.

## Notes and limitations

- AnkiConnect must be reachable (`http://127.0.0.1:8765`) while Anki is running;
  otherwise cards are queued.
- Reading your own Hypothes.is highlights via the API requires a personal token
  (hypothes.is/account/developer); those annotations are private by default.
- Page markers/anchors are stored locally in the browser profile; they are not
  written into your cards.
- The extension is developed against Firefox desktop. Firefox for Android
  supports a subset of the WebExtension APIs (no context menu or keyboard
  shortcuts), so some triggers and shortcuts are desktop-only.
