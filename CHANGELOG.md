# Changelog

## v0.2.0
- **Runs completely inside the AI application, like Claude Artifacts.** The server no longer has a workspace, temp folder, npm, Vite, build output or preview server; projects, documents and history are RAM-only. The window fetches the sources, compiles them in the browser (Sucrase + Tailwind, inline module registry) and runs the app in a sandboxed iframe. Errors are reported back so `forge_check` still works.
- Bundled libraries: react, react-dom, react-router-dom (HashRouter), lucide-react, recharts, clsx, framer-motion. Other imports give a clear error.
- The window opens in the host's preview panel when the AI starts writing; the chat card shows the app name ("Forge live preview").
- Docs tab shows generated files as cards (type badge, download, click to preview).
- Removed `template/`, `workspace/`, `FORGE_PERSIST`, `FORGE_WORKSPACE`, preview ports. Docker image no longer needs Node at run time.

## v0.1.2
- **Nothing is stored (security).** Like Claude Artifacts, everything the AI generates now lives in a private temporary folder (owner-only permissions) that is deleted when the server stops, including a build that is still running. Nothing from an earlier run is ever shown. Folders left by a killed run are removed at the next start. Set `FORGE_PERSIST=1` (keep `workspace/` and `projects/` on disk) or `FORGE_WORKSPACE` / `FORGE_PROJECTS_DIR` to opt out.
- Opening Forge never jumps to an old stored project by itself. The window only follows a project the AI wrote to in the last two minutes; otherwise an empty workspace shows an empty page.
- Like Claude Artifacts, the window shows only what was generated: package.json, configs, `forge-inspector.ts`, `index.html` and untouched starter files are no longer listed in Files, Code, search or Layers, and the project dropdown is gone. The AI tools and the downloaded .zip still include everything, so the project runs.
- Multi-page apps now work in the preview. Fixed: crash on start-up ("Failed to construct 'URL'"), buttons/links that left a blank frame, forms whose `onSubmit` never ran (the sandbox blocked forms), `BrowserRouter` apps not rendering (the preview now maps them to a hash router; your source is unchanged), `#anchor` links, external links (opened through the host), and the page dropdown not following in-app navigation.
- Draw annotation always appears in the host chat box, with one chip per marked element (`✎ h1 ✎ button`) and the wireframe picture. The chat box is updated once, after you stop drawing.
- Selecting an element no longer pushes a chip into the host's chat box by default, so Claude no longer asks "Replace current text?". The selected element still reaches the model as context. Turn the chip back on under More → "Post selection to chat".
- Fixed "Request timed out" / "Build failed" on the first preview. The first build installs packages and can outlast the host's ~60 s request limit. Builds now run in the background; the window polls until they finish, and a timed-out poll no longer shows as an error.
- No stale "no package.json" error while a project is empty or its first build is running.
- Packages are installed in the background as soon as the first file is written, so the first preview is faster.
- If a build is running when files change, one more build is run automatically.

## Empty by default
- Nothing is shipped or stored: the `workspace/` folder starts empty, there is no sample page, no `my-app` project and no default files. The Files, Code and Preview tabs are empty until the AI generates something.
- The starter files (package.json, Vite config, inspector, entry files) live in `template/` and are copied into a project only on its first write.
- The preview does not build or start a dev server for an empty project; it shows an empty page.
- AI tools default to the main workspace (`default`) instead of creating a `my-app` project; the project dropdown only shows when extra projects exist.
- `forge_ui_state` reports `blank: true|false` (true while the project has no files).

## Universal Preview
- The preview card now shows after ANY change the AI makes, including edits made with write_file, delete_file, update_component, undo/redo, run_command and forge_check (they all link the workbench window now), so it is no longer missing after a select-and-edit round.
- Toolbar position: Auto (top inside an AI app, bottom in the browser), Top, Bottom, Left or Right from More → Position, or drag the toolbar to any edge. Remembered between sessions.
- Inside an AI app, Draw annotation now lands in the host chat box as a short `✎ tag` marker (with the wireframe image), like Select; no box of our own. Details go to the model as context.
- Inside an AI app all controls (toolbar, menu, draw bar) sit at the top so the host chat box never hides them when expanded; tighter layout in the small inline window.
- Inside an AI app Forge now shows a small card under the AI's message once generation finishes (title + "Open"). Nothing opens by itself; clicking the card opens the workbench and asks the host for its large view.
- The Preview tab now works for every generated file (documents, images, charts, slides, sheets, notebooks, archives), not only web apps.
- Select, Draw annotation and Comment work on those files; the selection goes to the host chat as a `⬚ tag` chip. Text edits in place where the file has its own editor.
- Markdown renders inline so its paragraphs and headings can be picked.

## v0.1.0

First numbered release of Bitsophia Forge: a Lovable-style workbench delivered through MCP (MCP Apps, spec 2026-01-26).

### Window
- **Editing on the element (Lovable-style):** Select shows a compact bar at the element (text/background colour, font size, bold, padding,
  Edit text) with live updates; **Edit text** and the **Text** tool edit the text right on the page (Enter saves, Esc cancels);
  **Comment** drops numbered pins at the click point, with a popover on the element and a tray to send them all.
- **Files tab redesigned** as downloadable file cards (type badge, folder, type, size), grouped by folder.
- **Search bars** in the top bar for Files (fuzzy path search like VS Code, highlighted), Code (file names and text inside files, with
  line numbers) and Layers (element, text, class, component name). `/` focuses the search.
- **Expand icon** always available (host full screen, browser full screen, or a taller window).
- **Preview** tab: the app in a sandboxed iframe, device sizes, page selector, rebuild, open in a new tab.
- **Files** tab: the project's files and folders **for download**: everything (.zip), one folder (.zip) or a single file, plus copy.
- **Code** tab: folder tree + editor with manual edits (Ctrl/Cmd+S) and conflict handling. The AI's code **streams in here live**
  while it is being generated. A default file opens automatically, so the tab is never empty.
- **Layers** tab: outline of the elements in the preview.
- **Floating toolbar:** Select, Text and Comment are always visible; **More** and the **minimize arrow** appear only while the
  cursor is on the toolbar. Minimize slides the toolbar to the side, where a **Dock** button brings it back. Menu: Dock, Minimize,
  Hide, Auto/Light/Dark theme, keyboard shortcuts, version label.
- Select an element: edit text, colors, padding, font size, weight (changes only that element's source), or prompt the AI;
  the prompt arrives in the host's chat with the exact file and line. Escape closes the panel, even while typing in it.
- Claude-style extras: **version history with restore** (who changed what, when), copy file, download, fullscreen, "fix with AI"
  on build/runtime errors, theme follows the host, selection shared with the model.

### Layers, Docs and preview (this build)
- **Layers** has three views: Elements, **Structure** (tree, roles, summary, problems) and **Diagrams** (architecture, workflow, sequence,
  data flow, lifecycle) that follow the code, with hand-editing, *Keep my edits*, *Regenerate* and a stale-edit warning.
- **Docs** tab: upload or create Word, Excel, PowerPoint, PDF, Markdown, text, HTML, CSV, JSON, SVG, PNG/JPEG, charts and diagrams;
  view and edit all of them (block editor, windowed spreadsheet grid, slides editor, SVG shape editor, image crop/rotate/draw/select-area,
  8 chart types with a data grid, node/edge diagram editor); select a section and ask the AI to change just that; versions with restore,
  optimistic-conflict detection, convert, download one or all; AI-created documents open automatically.
- **Preview toolbar** like Lovable's: device buttons, a path pill (page + reload), open in tab. Zoom, rotate, copy HTML, status chip, project picker, undo/redo/history removed from Preview; each tab shows only its own controls.
- **Chat chip:** inside an AI app, selecting an element puts only a short chip (`⬚ a`) in the chat box (like Lovable); file, line and text go as model context. The host may ask "replace current text?" when its box already has text: that guard is the host's and cannot be turned off by an app.
- **Layers** shows Structure and Diagrams only (the Elements list is removed).
- **More file types preview:** code files in many languages, any unknown-extension file that is plainly text (editable), Jupyter notebooks (cells and outputs) and ZIP contents (view only); the README now lists what opens as what.
- **Docs list like Claude's files:** no New / Upload buttons, no filter chips, no drag-and-drop; a quiet "Files" header with a count, a tinted type tile per file and "Document · 2m ago". Files come from Claude (or the API); search stays in the top bar.
- **Docs like Claude's docs:** clean centred page, title renamed in place, autosave with a Saved / Saving… status (no Save button), Export menu (download, convert), Markdown opens as a reading page with an Edit toggle.
- **Draw annotation** (pencil, `D`) added to the floating toolbar, which is now Select / Text / Draw / Comment. Marks are turned into the elements underneath (via a new `forge:probe` message in `forge-inspector.ts`) and sent with a wireframe PNG.
- **Device switch like Lovable's:** one icon button with a Desktop/Tablet/Mobile menu; the page pill is `[reload  /path v]`.
- **Select is only select:** the on-element edit bar (colour, size, bold, padding, Edit text) is removed; changes are made by asking Claude. The Text tool still edits text in place.
- **Window follows what the AI made:** an app shows Preview/Code/Files/Layers; a generated document, image, chart or diagram opens alone with only its own options.
- **Selection goes to the host's chat:** inside an MCP host a selected element is posted into the host's own chat and shared as model context; no prompt box of our own (toggle: More → Post selection to chat). Document sections are shared as context only. Standalone keeps a prompt box.
- (earlier in this release) **Prompt box for the selected element:** the selection appears as a chip; the instruction goes to Claude with file, line and element. The edit bar no longer has an Ask-AI button.
- New model tools: `forge_create_document`, `forge_create_chart`, `forge_create_diagram`, `forge_create_image`, `forge_update_document`,
  `forge_replace_in_document`, `forge_library_list`, `forge_library_read`, `forge_get_doc_selection`, `forge_project_map` (49 tools in total).
- Hardening: Host-header (DNS-rebinding) guard, constant-time API-key comparison with failure throttling, request-size limit, security
  headers and a CSP on `/ui`, scrubbed environment for npm/vite, `--ignore-scripts`, SVG sanitising on server and client, undo-stack memory cap.
- Fallback for hosts without MCP Apps: tool results carry a browser link; the standalone window follows the AI's file changes and rebuilds live.
- Tests: 83 Python, 16 front-end unit, 60 new browser checks.

### Server
- MCP tools for the AI: `forge_write_files`, `forge_open`, `forge_check`, plus `list_files`, `read_file`, `write_file`, `delete_file`,
  `run_command`, `get_preview_url`, `get_preview_errors`, `get_selected_component`, `update_component`, `undo`, `redo`.
- Window-only tools (`forge_ui_*`, hidden from the model): state, read, save, preview build, describe, visual edit, history
  (undo / redo / list / restore), export (project / folder / file), projects.
- Preview build: Vite -> one self-contained HTML file (works under the MCP Apps default CSP).
- REST mirror of the window tools (`/api/tool/<name>`) so the same window runs standalone at `/ui`.
- Optional `FORGE_API_KEY`, `FORGE_PUBLIC_URL` (enables "open in browser" from a host), `FORGE_CORS`.

### Known limits
See "NOT tested / known limits" in the README.
