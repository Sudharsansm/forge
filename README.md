# Bitsophia Forge  ·  v0.2.0

A **Lovable-style workbench delivered through MCP.** Connect Forge to any MCP client that supports
**MCP Apps** (the `ui://` extension, spec 2026-01-26), ask the AI to build an app, and a window appears
in the chat with:

| | |
|---|---|
| **Preview** | the running app with a Lovable-style toolbar: one device button (menu: desktop / tablet / mobile), a `[reload  /path v]` pill and open in a new tab. The window shows only what Claude just made: an app gets Preview / Code / Files / Layers; a generated document, image, chart or diagram opens on its own with no tabs and no library list, only that file's options (versions, convert, download, save). "← App" goes back, the documents button opens the library. Every tab shows only its own controls: undo/redo/history on Code, download on Files, search on Layers and Docs |
| **Select / Edit text / Draw / Comment** (floating toolbar) | **Draw** (pencil, `D`): draw freehand marks on the preview, type what to change and send; Forge finds the elements under each mark (file and line) and sends the request with a small wireframe picture of the marks to the host's chat (text only if the host takes no images; standalone copies the text).  **Select** only selects (green outline + chip, no edit bar); **Text** edits text in place on the page and writes it to the source; Inside Claude/ChatGPT, selecting an element **posts it into the host's own chat** (`ui/message`: `<h1> … src/App.tsx:4`) and shares it as model context, so you just type the change there; no prompt box of ours (switch it off under More → "Post selection to chat"). Standalone mode has no host chat, so it shows a small prompt box that copies the prompt. Comments become numbered pins placed where you clicked |
| **Files** | every file as a downloadable card (type badge, name, folder, type, size), grouped by folder; download everything, one folder or one file; copy |
| **Code** | folder tree + a real code editor (CodeMirror), manual edits, Ctrl/Cmd+S, conflict handling; the AI's code **streams in here live** while it is generated |
| **Layers** | two views: **Structure** (project tree with file roles, component names, sizes, an unused-file / unresolved-import / circular-import / missing-dependency check) and **Diagrams** (architecture, workflow, sequence, data flow, lifecycle, drawn from your code and re-drawn when it changes; edit them by hand and *Keep my edits*, or *Regenerate*) |
| **Docs** | a per-project **Files** list like Claude's (no New / Upload buttons): Word, Excel, PowerPoint, PDF, Markdown, text, HTML, CSV, JSON, SVG and PNG/JPEG files, plus **charts** and **diagrams**, made by Claude (or added through the API). Every one can be opened and edited; select a part (a paragraph, cells, a slide shape, a bar, a node, an image area) and ask the AI to change just that. Version history with restore, conflict detection, convert (Word, PDF, Markdown, text, Excel, CSV), download one or all (.zip) |
| **Search bars** (top bar, same place as the Preview page controls) | **Files:** fuzzy path search like VS Code (`srcapp` finds `src/App.tsx`), matches highlighted. **Code:** file names + text inside files, with line numbers. **Layers:** by element, text, class or component (file) name. Press `/` to focus |
| **Expand** | host full screen when the host supports it, browser full screen when standalone, otherwise a taller window |
| **Floating toolbar** | Select / Text / Comment always visible; **More** and the **minimize arrow** appear only while the cursor is on the toolbar; minimize slides it to the side where a **Dock** button restores it |
| **Claude-style extras** | version history with restore, copy, download, "fix with AI" on errors, theme follows the host, selection shared with the model |
| **Undo / Redo**, Dock · Minimize · Hide, Auto/Light/Dark theme, keyboard shortcuts | |

| Edit bar on the element | Edit text in place | Comment pins |
|---|---|---|
| ![edit bar](docs/edit-bar.png) | ![text in place](docs/text-in-place.png) | ![pins](docs/comment-pins.png) |

| Files (download cards) | Files search (VS Code style) | Code search |
|---|---|---|
| ![files](docs/files-download.png) | ![files search](docs/files-search.png) | ![code search](docs/code-search.png) |

| Layers search | Code (AI writing live) | Toolbar on hover |
|---|---|---|
| ![layers](docs/layers-search.png) | ![live code](docs/code-live.png) | ![hover](docs/toolbar-hover.png) |

| Minimized (Dock) | Version history |
|---|---|
| ![minimized](docs/toolbar-minimized.png) | ![versions](docs/version-history.png) |

| Layers: structure | Layers: diagrams | Preview toolbar |
|---|---|---|
| ![structure](docs/layers-structure.png) | ![diagrams](docs/layers-diagrams.png) | ![preview toolbar](docs/preview-toolbar.png) |

| Docs: Word | Docs: slides | Docs: chart |
|---|---|---|
| ![word](docs/docs-word.png) | ![slides](docs/docs-slides.png) | ![chart](docs/docs-chart.png) |

| Docs: SVG | Docs: image (select an area) |
|---|---|
| ![svg](docs/docs-svg.png) | ![image](docs/docs-image.png) |


### What the window can preview

| Opens as | File types | Editable |
|---|---|---|
| Running app (Preview tab) | the web app Claude writes | select / text / draw / comment |
| Document page | Word (.docx), Markdown, PDF made by Claude | yes (PDF uploaded: view only) |
| Spreadsheet grid | .xlsx / .xlsm, .csv, .tsv | yes |
| Slides | .pptx | yes |
| Image | PNG, JPG, GIF, WebP, BMP, ICO, SVG | yes (sections, brightness, crop...) |
| Chart / diagram | `*.chart.json`, `*.diagram.json` | yes |
| Code / text | .txt, .json, .html, .css, .js/.ts, .py, .go, .rs, .java, .c/.cpp, .sql, .yaml, .toml, .xml, .tex, ... and **any unknown extension that is plainly text** | yes |
| Notebook | .ipynb (cells and outputs) | view only |
| Archive | .zip (list of files) | view only |
| Audio / video | .mp3 .wav .ogg .m4a .flac, .mp4 .webm .mov | play |
| Anything else | shown as a file card (name, type, size) | download only |

Not previewed: legacy Office (.doc/.xls/.ppt), OpenDocument, EPUB, TIFF/HEIC, RAR/7z. Files over ~8 MB (binary) or 2 MB (text) are download-only.

## How it works

```
 MCP client (host)            Forge server (Python, RAM only)              window (web-app, one HTML file)
 ─────────────────            ───────────────────────────────              ───────────────────────────────
 AI calls forge_write_files ─▶ keeps the files in memory            ─┐
 host renders ui://forge/workbench ◀── resources/read ──────────────┤  tool-input-partial ─▶ Code tab (live)
                                                                    │  tool-result        ─▶ window fetches the sources,
                                                                    │                        compiles them IN THE BROWSER
                                                                    │                        (Sucrase) and runs the app
 user clicks / edits / prompts ◀── tools/call (app-only forge_ui_*) ── window (select, visual edit, save, undo…)
 prompt typed in the window  ──▶ ui/message ─▶ appears in the host's chat ─▶ the AI edits via the same tools
```

* Like Claude Artifacts, **the app is compiled and run inside the window**: no npm, no Vite, no build folder, no preview server.
  The compiled app runs in a nested sandboxed `srcdoc` iframe (works under the MCP Apps default CSP, no `eval`).
* Libraries available to generated apps (bundled in the window, no network): `react`, `react-dom`, `react-router-dom`
  (HashRouter), `lucide-react`, `recharts`, `clsx`, `framer-motion`, and Tailwind v4 classes. Any other import shows a clear error.
* Window-only tools (`forge_ui_*`) are marked `visibility: ["app"]`, so the AI never sees them.
* The same window also runs **standalone** in a normal browser (`/ui`), talking to a REST mirror of the same tools.
* The window opens in the host's preview panel (fullscreen display mode) as soon as the AI starts writing; the chat keeps only a
  small card titled with the app name.

## Run it

Needs Node 20+ (only to build the window), [uv](https://docs.astral.sh/uv/).

```powershell
npm install
npm run install:all
npm run dev            # Forge API + MCP on :8000, standalone workbench on :3000
```

* Standalone: http://localhost:3000 (or http://127.0.0.1:8000/ui).
* MCP endpoint (Streamable HTTP): `http://127.0.0.1:8000/mcp`. VS Code: `.vscode/mcp.json` is included.
* stdio (clients that launch a command): `uv --directory mcp-server run server.py`.
* `ANTHROPIC_API_KEY` is only needed for the *standalone* "Edit with Claude" button; inside an MCP host the prompt goes to
  the host's own AI.

Edited the window (`web-app/`)? `npm run build:ui` rebuilds it into `mcp-server/forge_core/static/workbench.html`.

### What the AI is told
`forge_write_files` carries the stack rules in its description: write `src/App.tsx` (and other `src/` files), React + TypeScript +
Tailwind classes, only the libraries above, **no network calls**, images imported or inline. `forge_check` returns the
compile and runtime errors the window reported so the AI can fix them.

## Keyboard shortcuts (toggle in the toolbar's More menu)

`V` select · `T` text · `C` comment · `Esc` leave the tool / close the bar (also while typing in it) · `/` focus the search bar · `1`-`5` tabs · `Ctrl/Cmd+Z` undo (+Shift redo) · `Ctrl/Cmd+S` save in the editor.

## Tests (what was actually run)

```powershell
npm test               # 90+ Python unit/API tests (security, analyzer, blocks, formats, library, API...)
npm --prefix web-app test   # unit tests for the layout, chart, Markdown libraries and the in-browser compiler
```
Browser tests (need `pip install playwright` + Chromium; start the server first):
`python mcp-server/scripts/ui_e2e.py` (standalone) and `python mcp-server/scripts/host_e2e.py`
(the the workbench inside an MCP host built on the official SDK's `AppBridge`; serve `web-app/dist-host`
on :3100 after `npm run build:host`, start Forge with `FORGE_CORS=http://127.0.0.1:3100` and `FORGE_PUBLIC_URL=http://127.0.0.1:8000`),
and `python mcp-server/scripts/docs_e2e.py` (69 checks: Layers structure and all five diagrams, and creating, editing, saving, versioning
and conflict handling for Markdown, CSV, Excel, Word, PDF, PowerPoint, charts, diagrams, SVG and raster images, plus the preview toolbar).
All browser tests ran in Chromium only.

## When the host does not show the window

Tool results end with a browser link, e.g. `http://127.0.0.1:8000/ui?project=default` (`&tab=docs` for documents; set `FORGE_PUBLIC_URL`
for a remote server). The browser workbench polls every few seconds and **recompiles the preview
whenever the AI writes files**, so asking Claude "use Forge to build/preview this" gives a live preview even in hosts without MCP Apps.
Code Claude only prints in the chat is not sent to Forge; ask it to "write it with Forge" (`forge_write_files`).

## NOT tested / known limits: read before relying on it

* **Documents:** editing was tested in Chromium with files created by Forge, not with a corpus of real-world Word/Excel/PowerPoint
  files. Word and PowerPoint are edited **in place** (styles, headers, images survive), but features the editor does not model
  (tracked changes, text boxes, SmartArt, charts inside Office files, macros) are kept untouched, not editable. Formulas in Excel files
  are preserved and shown with their cached values; they are not recalculated until opened in Excel. **Uploaded PDFs are view-only**
  (text per page + the original); PDFs made by Forge are editable and are rebuilt from their blocks on save. Images are capped at
  4096 px and 15 MB per upload; the image editor's brightness/contrast/saturation uses `ctx.filter` (not in older Safari).
* **Asking the AI about a selection** works inside an MCP host (the prompt goes to the chat; the AI uses `forge_get_doc_selection`,
  `forge_replace_in_document`, `forge_update_document`). In standalone mode the prompt is **copied**; the server's "Edit with Claude"
  button covers code elements only, not documents.
* **Diagrams are static analysis** (tree-sitter) of imports, components, routes, `fetch` calls and hooks. Dynamic imports,
  runtime-built routes and non-React code are not understood. Very large projects are folded into folder nodes.

* **Not tested in any real MCP host** (Claude, ChatGPT, VS Code). The host tests use a spec-conformant host built from
  the official SDK. Hosts differ in which MCP Apps features they implement (partial-input streaming, fullscreen,
  downloads, `ui/message` approval prompts). The window degrades: no fullscreen button if unsupported; if a host does
  not stream partial input, the Code tab fills when the tool finishes.
* **Never run:** the standalone "Edit with Claude" button (needs an `ANTHROPIC_API_KEY`), the Docker files, Windows, and Python 3.13 (tested on 3.12; `requires-python` is `>=3.11`).
* **Remote hosts need a reachable server.** Cloud clients cannot reach `127.0.0.1`; you need a public HTTPS URL and
  authentication your client supports. Forge accepts `Authorization: Bearer <FORGE_API_KEY>` or `X-API-Key`. **OAuth is
  not implemented.** Forge refuses to listen on a non-local address without `FORGE_API_KEY`.
* **Generated code runs in your browser**, in a sandboxed iframe with no network, never on the server (the server only holds text).
  The included `Dockerfile` / `docker-compose.yml` are **untested**. There are no user accounts; projects live in the server's memory.
* The preview cannot use the network (host CSP) or a real address, so `BrowserRouter` is replaced by a hash router (your source is unchanged), only the bundled libraries can be imported, and fonts must be `@font-face` data URIs.
* **Edit text** works on elements whose only content is text (a heading, paragraph, button label). An element that contains other elements has no
  text of its own and the window says so. Pins mark the element you clicked, at the click point; they follow it when it moves, but are lost on reload.
* Visual edits change Tailwind classes of **literal** `className` strings (not `cn(...)`/variables). Setting a
  background removes gradient classes; padding replaces all `p-*`; size/colour replace that group at every breakpoint.
* Page selector discovers `<Route path=...>` / `path: "..."` by pattern; navigation (buttons, `<Link>`, plain `<a>` links, `#anchors`, forms and the page dropdown) works with `BrowserRouter`, `HashRouter` and `MemoryRouter`.
* A hand edit and an AI edit to the same file are not merged: the second save gets a conflict banner (hash check).
* **Not built:** the pen/draw tool, GitHub push, one-click publish/deploy, accounts, OAuth, per-user sandboxes.


### Preview for every file
Select, Draw annotation, Comment (and in-place Text edit) work in the Preview tab on any generated file, not just web apps. Inside a host that supports it the window opens in the host's preview panel (fullscreen mode); otherwise it shows inline.

## Nothing is stored

Forge writes nothing to disk: projects, documents and history live in the server process's memory and are gone when it stops;
the next start is empty. The window always shows the project the AI is working on right now. The **Download .zip** button
adds a ready-to-run Vite scaffold (package.json, vite.config.ts, index.html...) around the generated files.
