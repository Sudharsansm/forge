"""MCP tools for the documents library, the project structure and the Layers diagrams.

Model-visible: forge_create_document / _chart / _diagram / _image, forge_update_document, forge_replace_in_document,
               forge_library_list, forge_library_read, forge_get_doc_selection, forge_project_map
Window-only:   forge_ui_lib_*, forge_ui_diagram*, forge_ui_structure, forge_ui_doc_selection
"""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

from mcp.types import CallToolResult

from . import analyzer, blocks as B, config, diagrams, formats
from .core import core
from .errors import ForgeError
from .library import VersionConflict
from .mcp_tools import mcp
from .workbench_tools import APP_ONLY, SHOW, STANDALONE_TOOLS, _ensure, _res

LAYERS_PREFIX = "layers-"


def _item_ref(item: dict) -> dict:
    return {"id": item["id"], "name": item["name"], "kind": item["kind"]}


def _opened(pid: str, item: dict, text: str) -> CallToolResult:
    """Result of a tool that created or changed a document: the window opens it."""
    from .workbench_tools import preview_link
    return _res(f"{text} Open it in the Forge window, or in a browser: {preview_link(pid, 'docs')}", {"project": pid, "library": _item_ref(item), "tab": "docs", "written": []})


def _as_text(content: Any) -> str | None:
    """FastMCP pre-parses JSON-looking strings ('{}' or '123'), so JSON/CSV content can arrive as a dict, list or number."""
    if content is None or isinstance(content, str):
        return content
    return json.dumps(content, indent=2, ensure_ascii=False) if isinstance(content, (dict, list)) else str(content)


def _content_kwargs(content, blocks, sheets, slides, spec, svg, png_base64) -> dict:
    return {"content": svg if svg is not None else content, "blocks": blocks, "sheets": sheets, "slides": slides, "spec": spec, "data_b64": png_base64}


# ============================================================================================= model-visible tools
@mcp.tool(name="forge_create_document", meta=SHOW, title="Create a document (shows it for viewing and editing)",
          description=(
              "Create a document the user can view, download and edit in Forge: formats md, txt, html, csv, json, docx (Word), xlsx (Excel), "
              "pptx (PowerPoint) and pdf. Use `content` (Markdown or plain text) for md/txt/html/csv/json/docx/pdf (docx and pdf convert Markdown: "
              "headings, bold/italic, lists, tables, code, quotes); `sheets` [{name, rows:[[...]]}] for xlsx (first row = header, strings starting "
              "with '=' are formulas); `slides` [{title, bullets:[...], notes}] for pptx (first slide may use {title, subtitle}). Do not paste "
              "the document into the chat; call this tool. To change it later use forge_update_document or forge_replace_in_document."))
async def forge_create_document(name: str, format: str, content: str | dict | list | int | float | None = None, sheets: list[dict] | None = None,
                                slides: list[dict] | None = None, blocks: list[dict] | None = None, project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    content = _as_text(content)

    def work():
        fname, data, side = formats.generate(format, name, content=content, blocks=blocks, sheets=sheets, slides=slides)
        return core.library(pid).add(fname, data, source="ai", sidecar=side)

    try:
        item = await asyncio.to_thread(work)
    except ForgeError as exc:
        return _res(str(exc), error=True)
    return _opened(pid, item, f"Created {item['name']} (id {item['id']}).")


@mcp.tool(name="forge_create_chart", meta=SHOW, title="Create an editable chart",
          description=(
              "Create a chart the user can see and edit (click a bar, point or slice to change its value, label or colour). spec: "
              "{type: bar|hbar|stacked|line|area|pie|donut|scatter, title, subtitle?, labels:[...], series:[{name, values:[...], color?}], "
              "xLabel?, yLabel?, showValues?, legend?}. Scatter uses series[].points [{x,y}] instead of labels/values."))
async def forge_create_chart(name: str, spec: dict, project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    try:
        fname, data, _ = formats.generate("chart", name, spec=spec)
        item = await asyncio.to_thread(core.library(pid).add, fname, data, "ai")
    except ForgeError as exc:
        return _res(str(exc), error=True)
    return _opened(pid, item, f"Created chart {item['name']} (id {item['id']}).")


@mcp.tool(name="forge_create_diagram", meta=SHOW, title="Create an editable diagram",
          description=(
              "Create a diagram the user can see and edit (rename, recolour, add or delete nodes and arrows, drag them). Flow/graph spec: "
              "{title, direction: LR|TB, groups?:[{id,label}], nodes:[{id,label,sub?,kind?,group?}], edges:[{from,to,label?,dashed?}]}. "
              "Sequence spec: {title, participants:[{id,label}], messages:[{from,to,label,kind?: call|return|self|note}]}. "
              "node kind: start,end,process,decision,page,action,component,data,service,state,user,output,note."))
async def forge_create_diagram(name: str, spec: dict, project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    try:
        fname, data, _ = formats.generate("diagram", name, spec=spec)
        item = await asyncio.to_thread(core.library(pid).add, fname, data, "ai")
    except ForgeError as exc:
        return _res(str(exc), error=True)
    return _opened(pid, item, f"Created diagram {item['name']} (id {item['id']}).")


@mcp.tool(name="forge_create_image", meta=SHOW, title="Create an image the user can edit",
          description=(
              "Create an image. Prefer `svg` (a complete <svg> with a viewBox): the user can click any shape or text in it and change its colour, "
              "text or position. Use `png_base64` only for raster images. Scripts and external references are removed from SVG."))
async def forge_create_image(name: str, svg: str | None = None, png_base64: str | None = None, project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    try:
        fmt = "svg" if svg is not None else "png"
        fname, data, _ = formats.generate(fmt, name, content=svg, data_b64=png_base64)
        item = await asyncio.to_thread(core.library(pid).add, fname, data, "ai")
    except ForgeError as exc:
        return _res(str(exc), error=True)
    return _opened(pid, item, f"Created image {item['name']} (id {item['id']}).")


@mcp.tool(name="forge_update_document", meta=SHOW, title="Replace a document's content",
          description=(
              "Replace the whole content of an existing library document (new version; the old one stays in its history). Pass the same fields as "
              "when creating it: content / blocks / sheets / slides / spec / svg / png_base64. For a small change use forge_replace_in_document."))
async def forge_update_document(id: str, content: str | dict | list | int | float | None = None, sheets: list[dict] | None = None, slides: list[dict] | None = None,
                                blocks: list[dict] | None = None, spec: dict | None = None, svg: str | None = None,
                                png_base64: str | None = None, project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    content = _as_text(content)

    def work():
        lib = core.library(pid)
        item, original, side = lib.read(lib.find(id)["id"])
        kind = item["kind"]
        new_side = None
        if kind == "docx":  # keep the original's styles and page setup; replace the body
            bl = B.ensure_ids([{k: v for k, v in b.items() if k != "ref"} for b in (blocks or B.md_to_blocks(content or ""))])
            if not bl:
                raise ForgeError("Provide 'content' (Markdown) or 'blocks'")
            data = B.docx_write(original, bl)
        elif kind == "xlsx":
            if not sheets:
                raise ForgeError("'sheets' is required to update a spreadsheet")
            data = formats.xlsx_write(original, sheets)
        elif kind == "pptx":
            if not slides:
                raise ForgeError("'slides' is required to update a presentation")
            data = formats.pptx_write(original, [{k: v for k, v in s.items() if k != "index"} for s in slides])
        else:
            fmt = {"markdown": "md", "text": "txt", "image": "png"}.get(kind, kind)
            _, data, new_side = formats.generate(fmt, item["name"], **_content_kwargs(content, blocks, sheets, slides, spec, svg, png_base64))
        return lib.save(item["id"], data, source="ai", sidecar=new_side)

    try:
        item = await asyncio.to_thread(work)
    except ForgeError as exc:
        return _res(str(exc), error=True)
    return _opened(pid, item, f"Updated {item['name']} to version {item['version']}.")


@mcp.tool(name="forge_replace_in_document", meta=SHOW, title="Replace text in a document",
          description="Find and replace text inside a library document of any editable type (text, Markdown, HTML, CSV, SVG, chart, diagram, Word, "
                      "Excel, PowerPoint, generated PDF). Use this for edits the user asked for on a selected section: pass the selected text as `find`.")
async def forge_replace_in_document(id: str, find: str | int | float, replace: str | int | float, all: bool = True,
                                    project: str = "default") -> CallToolResult:
    pid = await asyncio.to_thread(_ensure, project)
    find, replace = str(find), str(replace)

    def work():
        lib = core.library(pid)
        item, data, side = lib.read(lib.find(id)["id"])
        saved = formats.replace_text(item["kind"], item["name"], data, find, replace, all, side)
        return lib.save(item["id"], saved.data, source="ai", sidecar=saved.sidecar)

    try:
        item = await asyncio.to_thread(work)
    except ForgeError as exc:
        return _res(str(exc), error=True)
    return _opened(pid, item, f"Edited {item['name']} (version {item['version']}).")


@mcp.tool(name="forge_library_list", title="List the project's documents",
          description="List the documents, images, charts and diagrams in the project's library (uploaded by the user or created by you), with ids.")
def forge_library_list(project: str = "default") -> list[dict]:
    return [{k: i[k] for k in ("id", "name", "kind", "size", "source", "version")} for i in core.library(_ensure(project)).list()]


@mcp.tool(name="forge_library_read", title="Read a library document as text",
          description="Read a library document (including ones the user uploaded) as text: Markdown/plain text as is, Word as blocks with ids, Excel as "
                      "rows, PowerPoint as slide text, PDF text, charts/diagrams as JSON. Look up ids with forge_library_list.")
def forge_library_read(id: str, project: str = "default") -> str:
    lib = core.library(_ensure(project))
    item, data, side = lib.read(lib.find(id)["id"])
    return f"{item['name']} ({formats.KIND_LABEL.get(item['kind'], item['kind'])}, version {item['version']})\n\n" + formats.text_of(item["kind"], item["name"], data, side)


@mcp.tool(name="forge_get_doc_selection", title="What the user selected in a document",
          description="The section the user selected in a document, image, chart or diagram in the Forge window (document id, what is selected, and the "
                      "instruction they queued). Call it when asked to change 'this' or 'the selected part' of a document.")
def forge_get_doc_selection(project: str = "default") -> dict:
    st = core.state(_ensure(project))
    return {"selection": st.doc_selection}


@mcp.tool(name="forge_project_map", title="Structure and diagrams of the app",
          description="A map of the app: folders, file roles, components, routes, state, handlers, problems (unresolved imports, cycles, unused files) "
                      "and, optionally, one diagram spec (architecture, workflow, sequence, dataflow, lifecycle). Use it to understand an app before changing it.")
def forge_project_map(project: str = "default", diagram: str | None = None) -> dict:
    a = core.analysis(_ensure(project))
    out = analyzer.structure(a)
    out.pop("tree", None)
    out["files"] = {p: {"role": fi.role, "components": [c.name for c in fi.components], "imports": [i.resolved for i in fi.imports if i.resolved]}
                    for p, fi in a.files.items() if fi.role in ("entry", "root", "page", "component", "hook", "store", "data", "util")}
    if diagram:
        out["diagram"] = diagrams.build(a, diagram)
    return out


# ============================================================================================= window-only tools
def _bg(fn, *a, **k):
    return asyncio.to_thread(fn, *a, **k)


@mcp.tool(name="forge_ui_lib_list", meta=APP_ONLY, description="Window: documents library.")
def forge_ui_lib_list(project: str = "default") -> dict[str, Any]:
    lib = core.library(_ensure(project))
    return {"items": lib.list(), "stats": lib.stats(), "maxUploadMb": config.MAX_UPLOAD_BYTES // 1_000_000,
            "convertTo": sorted(set(formats.CONVERT_TO))}


@mcp.tool(name="forge_ui_lib_get", meta=APP_ONLY, description="Window: open a document (payload depends on its kind).")
async def forge_ui_lib_get(id: str, version: int | None = None, project: str = "default") -> dict[str, Any]:
    def work():
        lib = core.library(_ensure(project))
        item, data, side = lib.read(id)
        if version is not None and version != item["version"]:
            data, side = lib.read_version(id, version)
        return {"item": item, "version": version or item["version"], "payload": formats.view(item["kind"], item["name"], data, side)}
    return await _bg(work)


@mcp.tool(name="forge_ui_lib_save", meta=APP_ONLY, description="Window: save an edited document (refused if it changed meanwhile).")
async def forge_ui_lib_save(id: str, payload: dict[str, Any], base_version: int | None = None, project: str = "default") -> dict[str, Any]:
    def work():
        lib = core.library(_ensure(project))
        item, original, side = lib.read(id)
        try:
            saved = formats.save(item["kind"], item["name"], original, payload, side)
            item = lib.save(id, saved.data, source="user", sidecar=saved.sidecar, base_version=base_version)
        except VersionConflict as exc:
            return {"ok": False, "conflict": True, "current_version": exc.current, "error": str(exc)}
        except ForgeError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "item": item}
    return await _bg(work)


@mcp.tool(name="forge_ui_lib_upload", meta=APP_ONLY, description="Window: upload a file (base64).")
async def forge_ui_lib_upload(name: str, base64_data: str, project: str = "default") -> dict[str, Any]:
    def work():
        try:
            data = base64.b64decode(base64_data.split(",", 1)[-1], validate=False)
        except Exception:  # noqa: BLE001
            raise ForgeError("The upload could not be decoded") from None
        return {"ok": True, "item": core.library(_ensure(project)).add(name, data, source="upload")}
    return await _bg(work)


_BLANK: dict[str, dict] = {
    "md": {"content": "# Untitled\n\nStart writing…\n"}, "txt": {"content": ""}, "html": {"content": "<!doctype html>\n<html><body>\n<h1>Untitled</h1>\n</body></html>\n"},
    "csv": {"content": "A,B,C\n,,\n,,\n"}, "json": {"content": "{}\n"},
    "docx": {"blocks": [{"type": "h1", "runs": [{"t": "Untitled"}]}, {"type": "p", "runs": [{"t": ""}]}]},
    "pdf": {"blocks": [{"type": "h1", "runs": [{"t": "Untitled"}]}, {"type": "p", "runs": [{"t": "Start writing…"}]}]},
    "xlsx": {"sheets": [{"name": "Sheet1", "rows": [["A", "B", "C"], [None, None, None], [None, None, None]]}]},
    "pptx": {"slides": [{"layout": "title", "title": "Untitled", "subtitle": "Subtitle"}, {"title": "Slide 2", "bullets": ["First point"]}]},
    "svg": {"content": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#f4f4f5"/>'
                       '<circle cx="120" cy="120" r="56" fill="#2563eb"/><rect x="210" y="70" width="120" height="100" rx="12" fill="#f59e0b"/>'
                       '<text x="200" y="210" text-anchor="middle" font-size="20" fill="#111827">Untitled</text></svg>'},
    "chart": {"spec": {"type": "bar", "title": "New chart", "labels": ["A", "B", "C"], "series": [{"name": "Series 1", "values": [4, 7, 5]}]}},
    "diagram": {"spec": {"title": "New diagram", "direction": "LR", "nodes": [{"id": "a", "label": "Start", "kind": "start"}, {"id": "b", "label": "Step", "kind": "process"},
                                                                        {"id": "c", "label": "Done", "kind": "end"}], "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}]}},
}


@mcp.tool(name="forge_ui_lib_new", meta=APP_ONLY, description="Window: create a blank document of a format.")
async def forge_ui_lib_new(format: str, name: str | None = None, project: str = "default") -> dict[str, Any]:
    def work():
        key = format.lower()
        if key not in _BLANK:
            raise ForgeError(f"Cannot create a blank '{format}'")
        fname, data, side = formats.generate(key, name or "Untitled", **_BLANK[key])
        return {"ok": True, "item": core.library(_ensure(project)).add(fname, data, source="user", sidecar=side)}
    return await _bg(work)


@mcp.tool(name="forge_ui_lib_delete", meta=APP_ONLY, description="Window: delete a document.")
def forge_ui_lib_delete(id: str, project: str = "default") -> dict[str, Any]:
    core.library(_ensure(project)).delete(id)
    return {"ok": True}


@mcp.tool(name="forge_ui_lib_rename", meta=APP_ONLY, description="Window: rename a document.")
def forge_ui_lib_rename(id: str, name: str, project: str = "default") -> dict[str, Any]:
    return {"ok": True, "item": core.library(_ensure(project)).rename(id, name)}


@mcp.tool(name="forge_ui_lib_versions", meta=APP_ONLY, description="Window: version history of a document, or restore one.")
def forge_ui_lib_versions(id: str, restore: int | None = None, project: str = "default") -> dict[str, Any]:
    lib = core.library(_ensure(project))
    if restore is not None:
        lib.restore(id, restore)
    return {"versions": lib.versions(id), "item": lib.get(id)}


@mcp.tool(name="forge_ui_lib_export", meta=APP_ONLY, description="Window: download one document (or all as .zip).")
def forge_ui_lib_export(id: str | None = None, project: str = "default") -> dict[str, Any]:
    lib = core.library(_ensure(project))
    if id is None:
        return {"filename": f"{project}-documents.zip", "mimeType": "application/zip", "base64": base64.b64encode(lib.export_zip()).decode()}
    item, data, _ = lib.read(id)
    return {"filename": item["name"], "mimeType": item["mime"], "base64": base64.b64encode(data).decode()}


@mcp.tool(name="forge_ui_lib_convert", meta=APP_ONLY, description="Window: convert a document to another format (new document).")
async def forge_ui_lib_convert(id: str, to: str, project: str = "default") -> dict[str, Any]:
    def work():
        lib = core.library(_ensure(project))
        item, data, side = lib.read(id)
        fname, out, new_side = formats.convert(item["kind"], item["name"], data, to, side)
        return {"ok": True, "item": lib.add(fname, out, source="user", sidecar=new_side)}
    return await _bg(work)


@mcp.tool(name="forge_ui_doc_selection", meta=APP_ONLY, description="Window: remember what the user selected in a document, so the AI can read it.")
def forge_ui_doc_selection(selection: dict[str, Any] | None = None, project: str = "default") -> dict[str, Any]:
    core.state(_ensure(project)).doc_selection = selection
    return {"ok": True}


# ------------------------------------------------------------------------------------- structure and diagrams (Layers tab)
@mcp.tool(name="forge_ui_structure", meta=APP_ONLY, description="Window: project structure tree with file roles, summary and problems.")
async def forge_ui_structure(project: str = "default") -> dict[str, Any]:
    return await _bg(lambda: analyzer.structure(core.analysis(_ensure(project))))


@mcp.tool(name="forge_ui_lib_save", meta=APP_ONLY, description="Window: save an edited document (refused if it changed meanwhile).")
async def forge_ui_lib_save(id: str, payload: dict[str, Any], base_version: int | None = None, project: str = "default") -> dict[str, Any]:
    def work():
        lib = core.library(_ensure(project))
        item, original, side = lib.read(id)
        try:
            saved = formats.save(item["kind"], item["name"], original, payload, side)
            item = lib.save(id, saved.data, source="user", sidecar=saved.sidecar, base_version=base_version)
        except VersionConflict as exc:
            return {"ok": False, "conflict": True, "current_version": exc.current, "error": str(exc)}
        except ForgeError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "item": item}
    return await _bg(work)


@mcp.tool(name="forge_ui_lib_upload", meta=APP_ONLY, description="Window: upload a file (base64).")
async def forge_ui_lib_upload(name: str, base64_data: str, project: str = "default") -> dict[str, Any]:
    def work():
        try:
            data = base64.b64decode(base64_data.split(",", 1)[-1], validate=False)
        except Exception:  # noqa: BLE001
            raise ForgeError("The upload could not be decoded") from None
        return {"ok": True, "item": core.library(_ensure(project)).add(name, data, source="upload")}
    return await _bg(work)


_BLANK: dict[str, dict] = {
    "md": {"content": "# Untitled\n\nStart writing…\n"}, "txt": {"content": ""}, "html": {"content": "<!doctype html>\n<html><body>\n<h1>Untitled</h1>\n</body></html>\n"},
    "csv": {"content": "A,B,C\n,,\n,,\n"}, "json": {"content": "{}\n"},
    "docx": {"blocks": [{"type": "h1", "runs": [{"t": "Untitled"}]}, {"type": "p", "runs": [{"t": ""}]}]},
    "pdf": {"blocks": [{"type": "h1", "runs": [{"t": "Untitled"}]}, {"type": "p", "runs": [{"t": "Start writing…"}]}]},
    "xlsx": {"sheets": [{"name": "Sheet1", "rows": [["A", "B", "C"], [None, None, None], [None, None, None]]}]},
    "pptx": {"slides": [{"layout": "title", "title": "Untitled", "subtitle": "Subtitle"}, {"title": "Slide 2", "bullets": ["First point"]}]},
    "svg": {"content": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#f4f4f5"/>'
                       '<circle cx="120" cy="120" r="56" fill="#2563eb"/><rect x="210" y="70" width="120" height="100" rx="12" fill="#f59e0b"/>'
                       '<text x="200" y="210" text-anchor="middle" font-size="20" fill="#111827">Untitled</text></svg>'},
    "chart": {"spec": {"type": "bar", "title": "New chart", "labels": ["A", "B", "C"], "series": [{"name": "Series 1", "values": [4, 7, 5]}]}},
    "diagram": {"spec": {"title": "New diagram", "direction": "LR", "nodes": [{"id": "a", "label": "Start", "kind": "start"}, {"id": "b", "label": "Step", "kind": "process"},
                                                                        {"id": "c", "label": "Done", "kind": "end"}], "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}]}},
}


@mcp.tool(name="forge_ui_lib_new", meta=APP_ONLY, description="Window: create a blank document of a format.")
async def forge_ui_lib_new(format: str, name: str | None = None, project: str = "default") -> dict[str, Any]:
    def work():
        key = format.lower()
        if key not in _BLANK:
            raise ForgeError(f"Cannot create a blank '{format}'")
        fname, data, side = formats.generate(key, name or "Untitled", **_BLANK[key])
        return {"ok": True, "item": core.library(_ensure(project)).add(fname, data, source="user", sidecar=side)}
    return await _bg(work)


@mcp.tool(name="forge_ui_lib_delete", meta=APP_ONLY, description="Window: delete a document.")
def forge_ui_lib_delete(id: str, project: str = "default") -> dict[str, Any]:
    core.library(_ensure(project)).delete(id)
    return {"ok": True}


@mcp.tool(name="forge_ui_lib_rename", meta=APP_ONLY, description="Window: rename a document.")
def forge_ui_lib_rename(id: str, name: str, project: str = "default") -> dict[str, Any]:
    return {"ok": True, "item": core.library(_ensure(project)).rename(id, name)}


@mcp.tool(name="forge_ui_lib_versions", meta=APP_ONLY, description="Window: version history of a document, or restore one.")
def forge_ui_lib_versions(id: str, restore: int | None = None, project: str = "default") -> dict[str, Any]:
    lib = core.library(_ensure(project))
    if restore is not None:
        lib.restore(id, restore)
    return {"versions": lib.versions(id), "item": lib.get(id)}


@mcp.tool(name="forge_ui_lib_export", meta=APP_ONLY, description="Window: download one document (or all as .zip).")
def forge_ui_lib_export(id: str | None = None, project: str = "default") -> dict[str, Any]:
    lib = core.library(_ensure(project))
    if id is None:
        return {"filename": f"{project}-documents.zip", "mimeType": "application/zip", "base64": base64.b64encode(lib.export_zip()).decode()}
    item, data, _ = lib.read(id)
    return {"filename": item["name"], "mimeType": item["mime"], "base64": base64.b64encode(data).decode()}


@mcp.tool(name="forge_ui_lib_convert", meta=APP_ONLY, description="Window: convert a document to another format (new document).")
async def forge_ui_lib_convert(id: str, to: str, project: str = "default") -> dict[str, Any]:
    def work():
        lib = core.library(_ensure(project))
        item, data, side = lib.read(id)
        fname, out, new_side = formats.convert(item["kind"], item["name"], data, to, side)
        return {"ok": True, "item": lib.add(fname, out, source="user", sidecar=new_side)}
    return await _bg(work)


@mcp.tool(name="forge_ui_doc_selection", meta=APP_ONLY, description="Window: remember what the user selected in a document, so the AI can read it.")
def forge_ui_doc_selection(selection: dict[str, Any] | None = None, project: str = "default") -> dict[str, Any]:
    core.state(_ensure(project)).doc_selection = selection
    return {"ok": True}


# ------------------------------------------------------------------------------------- structure and diagrams (Layers tab)
@mcp.tool(name="forge_ui_structure", meta=APP_ONLY, description="Window: project structure tree with file roles, summary and problems.")
async def forge_ui_structure(project: str = "default") -> dict[str, Any]:
    def work():
        pid = _ensure(project)
        svc = core.files(pid)
        return analyzer.structure(core.analysis(pid), keep=lambda rel: not svc._is_plumbing(rel))  # same files as the Files tab
    return await _bg(work)


def _override(lib, type_: str) -> dict | None:
    for item in lib.list():
        if item["kind"] == "diagram" and item.get("meta", {}).get("origin") == "layers" and item["meta"].get("diagramType") == type_:
            return item
    return None


@mcp.tool(name="forge_ui_diagram", meta=APP_ONLY, description="Window: a diagram of the app (architecture, workflow, sequence, dataflow, lifecycle).")
async def forge_ui_diagram(type: str, project: str = "default") -> dict[str, Any]:
    def work():
        if type not in diagrams.TYPES:
            raise ForgeError(f"Unknown diagram type '{type}'")
        pid = _ensure(project)
        fresh = diagrams.build(core.analysis(pid), type)
        lib = core.library(pid)
        ov = _override(lib, type)
        if ov is None:
            return {"spec": fresh, "edited": False, "stale": False, "types": list(diagrams.TYPES)}
        _, data, _ = lib.read(ov["id"])
        spec = formats.view("diagram", ov["name"], data)["spec"]
        return {"spec": spec, "edited": True, "stale": ov["meta"].get("generated") != fresh["generated"], "docId": ov["id"],
                "version": ov["version"], "types": list(diagrams.TYPES)}
    return await _bg(work)


@mcp.tool(name="forge_ui_diagram_save", meta=APP_ONLY, description="Window: keep a hand-edited version of a generated diagram (also listed in Docs).")
async def forge_ui_diagram_save(type: str, spec: dict[str, Any], project: str = "default") -> dict[str, Any]:
    def work():
        pid = _ensure(project)
        fresh = diagrams.build(core.analysis(pid), type)
        norm = formats.normalize_diagram({**spec, "type": type})
        norm["generated"] = fresh["generated"]
        data = formats._json_text(norm)
        lib = core.library(pid)
        ov = _override(lib, type)
        meta = {"origin": "layers", "diagramType": type, "generated": fresh["generated"]}
        if ov:
            item = lib.save(ov["id"], data, source="user", meta_update=meta)
        else:
            item = lib.add(f"{LAYERS_PREFIX}{type}.diagram.json", data, source="user", meta=meta, unique=False)
        return {"ok": True, "item": item}
    return await _bg(work)


@mcp.tool(name="forge_ui_diagram_reset", meta=APP_ONLY, description="Window: discard the hand-edited diagram and use the generated one again.")
def forge_ui_diagram_reset(type: str, project: str = "default") -> dict[str, Any]:
    lib = core.library(_ensure(project))
    ov = _override(lib, type)
    if ov:
        lib.delete(ov["id"])
    return {"ok": True}


STANDALONE_TOOLS.update({
    "forge_create_document", "forge_create_chart", "forge_create_diagram", "forge_create_image", "forge_update_document",
    "forge_replace_in_document", "forge_library_list", "forge_library_read", "forge_get_doc_selection", "forge_project_map", "forge_ui_lib_list", "forge_ui_lib_get", "forge_ui_lib_save", "forge_ui_lib_upload", "forge_ui_lib_new",
    "forge_ui_lib_delete", "forge_ui_lib_rename", "forge_ui_lib_versions", "forge_ui_lib_export", "forge_ui_lib_convert",
    "forge_ui_doc_selection", "forge_ui_structure", "forge_ui_diagram", "forge_ui_diagram_save", "forge_ui_diagram_reset"})
_ = json
