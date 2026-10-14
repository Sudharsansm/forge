"""MCP Apps layer: the Forge workbench (Lovable-style window) as a `ui://` resource plus its tools.

Model-visible tools (the AI calls these):  forge_write_files, forge_open, forge_check
App-only tools (hidden from the AI, called by the window):  forge_ui_*
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import mimetypes
import json
import re
import time
import zipfile
from pathlib import Path
from typing import Any

from mcp.types import CallToolResult, TextContent
from pydantic import BaseModel

from . import __version__, config, visual_edit
from .core import core
from .errors import ConflictError, EditError, ForgeError
from .files import content_hash
from .mcp_tools import mcp
from .routes import detect_routes
from .starter import starter_files

UI_URI = "ui://forge/workbench"
STATIC_HTML = Path(__file__).parent / "static" / "workbench.html"
MIME = "text/html;profile=mcp-app"
LANGUAGES = {".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".json": "json",
             ".css": "css", ".html": "html", ".md": "markdown", ".svg": "xml"}

SHOW = {"ui": {"resourceUri": UI_URI, "visibility": ["model", "app"]}}
APP_ONLY = {"ui": {"resourceUri": UI_URI, "visibility": ["app"]}}

STACK_GUIDE = (
    "The app is compiled and previewed INSIDE the Forge window (like Claude Artifacts): nothing is installed or built on a server, "
    "so do NOT write package.json, vite.config, index.html or main.tsx. Write src/App.tsx with a default-exported React component "
    "(React 19 + TypeScript + Tailwind CSS v4 utility classes, no config) and put other components in src/components/. "
    "Allowed imports: react, react-dom, react-router-dom, lucide-react, recharts, clsx, framer-motion, and your own files. "
    "No other npm packages. The preview is sandboxed with NO network (fetch/XHR/WebSocket are blocked), so use local mock data and "
    "inline SVG/data URIs for images. For several pages use react-router-dom (BrowserRouter is shown as a hash router "
    "automatically, your code stays as written). Links, buttons, forms and in-page anchors all work. Optional src/index.css for custom CSS."
)


class FileSpec(BaseModel):
    path: str
    content: str


def _res(text: str, data: dict | None = None, error: bool = False) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], structuredContent=data, isError=error)


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", name.strip().lower()).strip("-")[:40]
    return s or "default"


def _ensure(project: str) -> str:
    """Return a usable project id, creating it when it does not exist yet."""
    project = _slug(project) if project and project.strip() else "default"
    if project != "default":
        try:
            core.projects.get(project)
        except ForgeError:
            core.projects.create(project)
    core.state(project)
    return project


def is_blank(listing: list[str]) -> bool:
    """True while the project has no files at all: the UI shows an empty page and nothing is stored."""
    return not listing


SUGGEST_WINDOW_S = 120  # only a project the AI wrote to just now; an old stored project must never pop up by itself


def _suggest(project: str, listing: list[str]) -> str | None:
    """When this project is empty, the other project that received files within the last couple of minutes (so the
    window does not sit on an empty page while the AI's app lives in a project with another name). Older projects
    are never suggested: opening Forge fresh shows an empty page."""
    if listing:
        return None
    try:
        if core.library(project).list():  # a project that holds documents is not "empty": stay on it
            return None
    except ForgeError:
        pass
    best, best_ts = None, 0.0
    for p in core.projects.list():
        if p.id == project:
            continue
        try:
            svc = core.files(p.id)
            ts = max((svc.mtime(f) for f in svc.list_files()), default=0.0)
        except ForgeError:
            continue
        if ts > best_ts:
            best, best_ts = p.id, ts
    return best if best and time.time() - best_ts <= SUGGEST_WINDOW_S else None


def _zip_name(text: str, fallback: str) -> str:
    """File-name-safe version of the app name for the downloaded .zip ("Brew & Co Billing" -> "brew-co-billing")."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or fallback


def _title(project: str, files, sources: dict[str, str]) -> str:
    """A readable name for the app: the page <title>, else the first heading on the page, else the project id. Shown on the chat card."""
    import html
    import re
    try:
        m = re.search(r"<title>\s*([^<]+?)\s*</title>", files.read("index.html")["content"], re.I)
        if m and m.group(1).strip().lower() not in ("forge app", "vite + react + ts", "vite + react"):
            return html.unescape(m.group(1).strip())[:60]
    except ForgeError:
        pass
    try:
        pj = json.loads(files.read("package.json")["content"])
        nm = str(pj.get("name", "")).strip()
        if nm and nm.lower() not in ("forge-app", "vite-react-ts", "app", "my-app", "vite-project"):
            return nm.replace("-", " ").replace("_", " ").title()[:60]
    except (ForgeError, ValueError, AttributeError):
        pass
    for p in sorted(sources):
        m = re.search(r"<h1[^>]*>\s*([^<{][^<{]*?)\s*</h1>", sources[p])
        if m and len(m.group(1)) > 1:
            return html.unescape(m.group(1).strip())[:60]
    return "" if project == "default" else project.replace("-", " ").replace("_", " ").title()


def _state(project: str) -> dict:
    files = core.files(project)
    listing = files.list_files(visible=True)  # what the window shows; the AI tools and the .zip still see everything
    sources = {}
    for p in listing:
        if p.endswith((".tsx", ".jsx", ".ts", ".js")) and len(sources) < 80:
            try:
                sources[p] = files.read(p)["content"]
            except ForgeError:
                pass
    sizes, rev = {}, 0
    for p in listing:
        text = files.project.files.get(p, "")
        sizes[p] = len(text.encode("utf-8"))
        rev = (rev * 31 + int.from_bytes(hashlib.sha1(text.encode("utf-8")).digest()[:6], "big") + len(p)) & 0xFFFFFFFFFFFF
    return {"project": project, "title": _title(project, files, sources), "projects": [p.id for p in core.projects.list()], "files": listing, "sizes": sizes,
            "routes": detect_routes(sources), "history": files.history_info(), "build_error": core.state(project).build_error,
            "blank": is_blank(listing), "suggest": _suggest(project, listing),
            "version": __version__, "public_url": config.PUBLIC_URL, "rev": rev}


def preview_link(project: str, tab: str = "preview") -> str:
    """Where the same workbench can be opened in a browser (used when a host does not render the in-chat window)."""
    base = config.PUBLIC_URL or f"http://{'127.0.0.1' if config.HOST in ('0.0.0.0', '::') else config.HOST}:{config.PORT}"
    return f"{base}/ui?project={project}" + (f"&tab={tab}" if tab != "preview" else "")


# ----------------------------------------------------------------------------- the UI resource
@mcp.resource(UI_URI, name="forge_workbench", title="Forge Workbench", mime_type=MIME,
              description="Interactive preview / code / files / visual editor for a Forge project.",
              meta={"ui": {"prefersBorder": False}})
def workbench_html() -> str:
    if not STATIC_HTML.is_file():
        return ("<!doctype html><meta charset=utf-8><body style='font:14px system-ui;padding:24px'>"
                "The Forge workbench has not been built yet. Run <code>npm run build:ui</code>.</body>")
    return STATIC_HTML.read_text(encoding="utf-8")


# ----------------------------------------------------------------------------- model-visible tools
@mcp.tool(name="forge_write_files", meta=SHOW, title="Write app files (shows live preview)",
          description=(
              "Create or update a web app: write ALL the files you want in one call. The user sees the code being "
              "written, a live preview, and can select any element and ask for changes. Do not paste code into the "
              "chat; call this tool instead. To change an existing app, send only the files that change. After calling it, "
              "tell the user the preview is in the Forge window, or at the link in the result if no window is shown. "
              + STACK_GUIDE))
async def forge_write_files(files: list[FileSpec], project: str = "default") -> CallToolResult:
    if not files:
        return _res("No files were provided.", error=True)
    pid = await asyncio.to_thread(_ensure, project)
    svc = core.files(pid)
    written, errors = [], []
    for spec in files:
        try:
            r = svc.write(spec.path, spec.content, source="ai")
            written.append({"path": r["path"], "created": r["created"], "changed": r["changed"]})
        except ForgeError as exc:
            errors.append(f"{spec.path}: {exc}")
    data = {"project": pid, "written": written, "errors": errors, "autoBuild": True}
    text = (f"Wrote {len(written)} file(s) to project '{pid}'." + (f" Errors: {'; '.join(errors)}" if errors else "")
            + f" Live preview (updates as the code changes): {preview_link(pid)}")
    return _res(text, data, error=bool(errors) and not written)


@mcp.tool(name="forge_open", meta=SHOW, title="Open the Forge workbench",
          description="Open the live preview / code / files workbench for an existing project.")
async def forge_open(project: str = "default", tab: str = "preview") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    st = await asyncio.to_thread(_state, pid)
    return _res(f"Opened project '{pid}' with {len(st['files'])} files. Browser link: {preview_link(pid, tab)}", {**st, "tab": tab})


@mcp.tool(name="forge_check", meta=SHOW, title="Check that the app compiles",
          description="Report whether the app compiled in the Forge window, with the compile error if it did not. The app is compiled "
                      "inside the window as soon as the files are written, so call this after writing files and fix anything it reports.")
async def forge_check(project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    st = core.state(pid)
    if st.build_error:
        return _res("Build FAILED:\n" + st.build_error, error=True)
    if not core.files(pid).list_files():
        return _res("The project has no files yet.", error=True)
    errs = core.errors(pid)["runtime"]
    if errs:
        return _res("The app compiled but threw errors in the preview:\n" + "\n".join(e["message"] for e in errs[-5:]), error=True)
    return _res("No compile or runtime errors reported by the Forge window (it compiles on every change; if it is closed, open it to check).")


# ----------------------------------------------------------------------------- app-only tools (the window)
@mcp.tool(name="forge_ui_state", meta=APP_ONLY, description="Window: project overview (files, pages, history).")
async def forge_ui_state(project: str = "default") -> dict[str, Any]:
    return await asyncio.to_thread(_state, _ensure(project))


@mcp.tool(name="forge_ui_read", meta=APP_ONLY, description="Window: read one file.")
def forge_ui_read(path: str, project: str = "default") -> dict[str, Any]:
    f = core.files(project).read(path)
    return {**f, "language": LANGUAGES.get(Path(path).suffix.lower(), "text")}


@mcp.tool(name="forge_ui_save", meta=APP_ONLY, description="Window: save a manual edit (refused if the file changed meanwhile).")
def forge_ui_save(path: str, content: str, base_hash: str | None = None, project: str = "default") -> dict[str, Any]:
    try:
        r = core.files(project).write(path, content, source="user", base_hash=base_hash)
        return {"ok": True, **r}
    except ConflictError as exc:
        return {"ok": False, "conflict": True, "current_hash": exc.current_hash, "error": str(exc)}
    except ForgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool(name="forge_ui_sources", meta=APP_ONLY, description="Window: every source file of the project; the window compiles them in the browser.")
def forge_ui_sources(project: str = "default") -> dict[str, Any]:
    files = core.files(_ensure(project))
    with files.project.lock:
        snapshot = dict(files.project.files)
    rev = 0
    for p, text in snapshot.items():
        rev = (rev * 31 + int.from_bytes(hashlib.sha1((p + "\0" + text).encode("utf-8")).digest()[:6], "big")) & 0xFFFFFFFFFFFF
    return {"files": snapshot, "rev": rev}


@mcp.tool(name="forge_ui_report", meta=APP_ONLY, description="Window: report the result of compiling the app in the browser, or an error thrown in the preview (so the AI can read them).")
def forge_ui_report(build_error: str | None = None, rev: int | None = None, runtime_error: str | None = None, project: str = "default") -> dict[str, Any]:
    st = core.state(_ensure(project))
    if runtime_error:
        msg = runtime_error.strip()[:2000]
        if msg and not any(e["message"] == msg for e in st.runtime_errors):
            st.runtime_errors.append({"message": msg, "stack": "", "kind": "runtime", "ts": time.time()})
            del st.runtime_errors[:-20]
    else:
        st.build_error = (build_error or "").strip()[:4000] or None
        st.compiled_rev = rev
        st.runtime_errors.clear()  # a fresh compile starts a fresh run
    core.bus.publish({"type": "errors_updated", "project": project})
    return {"ok": True}


@mcp.tool(name="forge_ui_describe", meta=APP_ONLY, description="Window: what can be edited on an element.")
def forge_ui_describe(path: str, line: int, col: int, project: str = "default") -> dict[str, Any]:
    try:
        return {"ok": True, **visual_edit.describe(core.files(project).read(path)["content"], line, col)}
    except ForgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool(name="forge_ui_edit", meta=APP_ONLY, description="Window: visual edit of one element (text, colors, padding...).")
def forge_ui_edit(path: str, line: int, col: int, changes: dict[str, Any], project: str = "default") -> dict[str, Any]:
    files = core.files(project)
    try:
        cur = files.read(path)
        new = visual_edit.apply_changes(cur["content"], line, col, changes)
        return {"ok": True, **files.write(path, new, source="visual", base_hash=cur["hash"])}
    except (EditError, ConflictError, ForgeError) as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool(name="forge_ui_history", meta=APP_ONLY, description="Window: undo / redo / list versions / restore to a version.")
def forge_ui_history(action: str = "info", keep: int | None = None, project: str = "default") -> dict[str, Any]:
    files = core.files(project)
    try:
        if action == "undo":
            return {"ok": True, **files.undo()}
        if action == "redo":
            return {"ok": True, **files.redo()}
        if action == "list":
            return {"ok": True, "entries": files.history_entries(), **files.history_info()}
        if action == "restore":
            if keep is None:
                return {"ok": False, "error": "restore needs 'keep'"}
            return {"ok": True, **files.restore_to(keep)}
    except ForgeError as exc:
        return {"ok": False, "error": str(exc), **files.history_info()}
    return {"ok": True, **files.history_info()}


@mcp.tool(name="forge_ui_export", meta=APP_ONLY,
          description="Window: download the whole project (zip, with the files needed to run it with npm), one folder (zip) or one file. Result is base64.")
def forge_ui_export(project: str = "default", path: str | None = None) -> dict[str, Any]:
    files = core.files(project)

    def pack(data: bytes, name: str, mime: str) -> dict[str, Any]:
        return {"filename": name, "mimeType": mime, "base64": base64.b64encode(data).decode()}

    if path:
        rel = files.norm(path)
        if files.exists(rel):
            return pack(files.read(rel)["content"].encode("utf-8"), Path(rel).name, mimetypes.guess_type(rel)[0] or "text/plain")
        rels = files.list_files(rel)
        if not rels:
            raise ForgeError(f"'{path}' does not exist")
        root_name = Path(rel).name
        entries = {r: files.read(r)["content"] for r in rels}
        base = rel.rsplit("/", 1)[0] + "/" if "/" in rel else ""
        arcs = {r.removeprefix(base): c for r, c in entries.items()}
    else:
        sources = {r: files.read(r)["content"] for r in files.list_files() if r.endswith((".tsx", ".jsx"))}
        root_name = _zip_name(_title(project, files, sources), project)
        entries = {r: files.read(r)["content"] for r in files.list_files()}
        entries.update(starter_files(project, set(entries)))
        arcs = {f"{root_name}/{r}": c for r, c in entries.items()}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for arc, content in sorted(arcs.items()):
            zf.writestr(arc, content)
    return pack(buf.getvalue(), f"{root_name}.zip", "application/zip")


@mcp.tool(name="forge_ui_search", meta=APP_ONLY, description="Window: search the project's code (case-insensitive text search).")
def forge_ui_search(query: str, project: str = "default", limit: int = 200) -> dict[str, Any]:
    q = query.strip()
    if len(q) < 2:
        return {"matches": [], "truncated": False, "files": 0}
    files = core.files(project)
    needle, matches, hit_files, truncated = q.lower(), [], set(), False
    for rel in files.list_files(visible=True):
        try:
            text = files.read(rel)["content"]
        except ForgeError:
            continue  # binary or too large
        for i, line in enumerate(text.splitlines(), start=1):
            idx = line.lower().find(needle)
            if idx == -1:
                continue
            if len(matches) >= limit:
                truncated = True
                break
            start = max(0, idx - 40)
            matches.append({"path": rel, "line": i, "col": idx - start, "len": len(q), "text": line[start:start + 200]})
            hit_files.add(rel)
        if truncated:
            break
    return {"matches": matches, "truncated": truncated, "files": len(hit_files)}


@mcp.tool(name="forge_ui_projects", meta=APP_ONLY, description="Window: list or create projects.")
def forge_ui_projects(create: str | None = None) -> dict[str, Any]:
    if create:
        _ensure(create)
    return {"projects": [p.id for p in core.projects.list()]}


# every ui tool above is callable from the standalone web page too (POST /api/tool/<name>)
STANDALONE_TOOLS = {"forge_write_files", "forge_open", "forge_check", "forge_ui_state", "forge_ui_read", "forge_ui_save",
                    "forge_ui_sources", "forge_ui_report", "forge_ui_describe", "forge_ui_edit", "forge_ui_history", "forge_ui_export",
                    "forge_ui_projects", "forge_ui_search"}
_ = content_hash  # re-export for tests