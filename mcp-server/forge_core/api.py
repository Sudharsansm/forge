from __future__ import annotations

import asyncio
import io
import os
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from . import __version__, ai, config, visual_edit
from .core import core
from .errors import ConflictError, EditError, ForgeError, PathError
from .files import content_hash
from .mcp_tools import mcp
from .security import (ApiKeyMiddleware, BodyLimitMiddleware, HostGuardMiddleware, SecurityHeadersMiddleware)
from .starter import starter_files
from .workbench_tools import STANDALONE_TOOLS, STATIC_HTML
from mcp.types import CallToolResult

LANGUAGES = {".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
             ".json": "json", ".css": "css", ".html": "html", ".md": "markdown", ".svg": "xml"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    core.bus.bind_loop(asyncio.get_running_loop())
    async with mcp.session_manager.run():
        yield
    core.bus.bind_loop(None)  # nothing to clean up: projects and documents only ever lived in memory


def create_app() -> FastAPI:
    app = FastAPI(title="Bitsophia Forge", version=__version__, lifespan=lifespan)
    # Browser-based MCP clients/hosts need to read the session id header.
    # Added innermost-first: auth, body limit, host guard, response headers, then CORS outermost (so errors carry CORS headers).
    app.add_middleware(ApiKeyMiddleware)
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(HostGuardMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["Mcp-Session-Id"])

    @app.exception_handler(ConflictError)
    async def _conflict(_, exc: ConflictError):
        return JSONResponse({"error": str(exc), "current_hash": exc.current_hash}, status_code=409)

    @app.exception_handler(PathError)
    async def _path(_, exc: PathError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    @app.exception_handler(ForgeError)
    async def _forge(_, exc: ForgeError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    # ---- health / projects -----------------------------------------------------
    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__, "auth": bool(config.API_KEY), "ai": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "storage": "memory"}

    @app.get("/api/projects")
    def projects():
        return [{"id": p.id} for p in core.projects.list()]

    @app.post("/api/projects")
    def create_project(body: dict = Body(...)):
        project = core.projects.create(str(body.get("name", "")).strip().lower())
        return {"id": project.id}

    @app.delete("/api/projects/{name}")
    def delete_project(name: str):
        core.forget(name)
        core.projects.delete(name)
        return {"deleted": name}

    # ---- files -----------------------------------------------------------------
    @app.get("/api/files")
    def list_files(project: str = "default"):
        return {"files": core.files(project).list_files(visible=True)}

    @app.get("/api/file")
    def read_file(path: str, project: str = "default"):
        data = core.files(project).read(path)
        return {**data, "language": LANGUAGES.get(Path(path).suffix.lower(), "plaintext")}

    @app.post("/api/file")
    def write_file(body: dict = Body(...)):
        return core.files(body.get("project", "default")).write(
            body["path"], body["content"], source="user", base_hash=body.get("base_hash"))

    @app.delete("/api/file")
    def delete_file(path: str, project: str = "default"):
        return core.files(project).delete(path, source="user")

    # ---- history -----------------------------------------------------------------
    @app.get("/api/history")
    def history(project: str = "default"):
        return core.files(project).history_info()

    @app.post("/api/undo")
    def undo(project: str = Query("default")):
        return core.files(project).undo()

    @app.post("/api/redo")
    def redo(project: str = Query("default")):
        return core.files(project).redo()

    # ---- errors & selection --------------------------------------------------------
    @app.get("/api/errors")
    def get_errors(project: str = "default"):
        return core.errors(project)

    @app.post("/api/errors")
    def add_error(body: dict = Body(...)):
        project = body.get("project", "default")
        state = core.state(project)
        entry = {"message": str(body.get("message", ""))[:2000], "stack": str(body.get("stack", ""))[:4000],
                 "kind": body.get("kind", "runtime"), "ts": time.time()}
        if entry["message"] and not any(e["message"] == entry["message"] for e in state.runtime_errors):
            state.runtime_errors.append(entry)
            del state.runtime_errors[:-20]
        core.bus.publish({"type": "errors_updated", "project": project})
        return {"ok": True}

    @app.delete("/api/errors")
    def clear_errors(project: str = "default"):
        core.state(project).runtime_errors.clear()
        core.state(project).build_error = None
        core.bus.publish({"type": "errors_updated", "project": project})
        return {"ok": True}

    @app.post("/api/selection")
    def set_selection(body: dict = Body(...)):
        project = body.get("project", "default")
        selection = body.get("selection")
        core.state(project).selection = selection
        core.bus.publish({"type": "selection", "project": project, "selection": selection})
        return {"ok": True}

    @app.get("/api/selection")
    def get_selection(project: str = "default"):
        state = core.state(project)
        prompt, state.pending_prompt = state.pending_prompt, None
        return {"selection": state.selection, "instruction": prompt}

    # ---- editing ---------------------------------------------------------------------
    @app.post("/api/visual-edit")
    def visual_edit_route(body: dict = Body(...)):
        files = core.files(body.get("project", "default"))
        current = files.read(body["path"])
        try:
            new = visual_edit.apply_changes(current["content"], int(body["line"]), int(body["col"]), body["changes"])
        except EditError:
            raise
        return files.write(body["path"], new, source="visual", base_hash=current["hash"])

    @app.post("/api/describe")
    def describe(body: dict = Body(...)):
        """What can be edited on the selected element (tag, literal className, simple text)?"""
        current = core.files(body.get("project", "default")).read(body["path"])
        return visual_edit.describe(current["content"], int(body["line"]), int(body["col"]))

    @app.post("/api/ai/queue")
    def ai_queue(body: dict = Body(...)):
        core.state(body.get("project", "default")).pending_prompt = str(body.get("instruction", "")).strip() or None
        return {"queued": True}

    @app.post("/api/ai/edit")
    async def ai_edit(body: dict = Body(...)):
        return await asyncio.to_thread(
            ai.edit_with_claude, body.get("project", "default"), str(body.get("instruction", "")).strip(),
            body.get("path"), body.get("line"), body.get("col"))

    # ---- export --------------------------------------------------------------------------
    @app.get("/api/export")
    def export(project: str = "default"):
        files = core.files(project)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            entries = {r: files.read(r)["content"] for r in files.list_files()}
            entries.update(starter_files(project, set(entries)))
            for rel, content in sorted(entries.items()):
                zf.writestr(rel, content)
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{project}.zip"'})

    # ---- websocket ---------------------------------------------------------------------------
    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        queue = core.bus.subscribe()
        try:
            await socket.send_json({"type": "hello"})
            while True:
                await socket.send_json(await queue.get())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            core.bus.unsubscribe(queue)

    # ---- the workbench window, standalone (the same HTML an MCP host renders from ui://forge/workbench) ---------
    @app.post("/api/tool/{name}")
    async def call_tool(name: str, body: dict = Body(default_factory=dict)):
        """REST mirror of the workbench tools, so the window also works outside an MCP host."""
        if name not in STANDALONE_TOOLS:
            return JSONResponse({"error": f"Unknown tool '{name}'"}, status_code=404)
        tool = mcp._tool_manager.get_tool(name)
        try:
            result = await tool.run(body, convert_result=False)
        except ForgeError:
            raise
        except Exception as exc:  # noqa: BLE001 - bad arguments etc. become a clean 400
            return JSONResponse({"error": str(exc)}, status_code=400)
        if isinstance(result, CallToolResult):
            if result.isError:
                text = "".join(getattr(c, "text", "") for c in result.content)
                return JSONResponse({"error": text or "The tool failed", **(result.structuredContent or {})}, status_code=400)
            return result.structuredContent or {}
        return result if isinstance(result, dict) else {"result": result}

    @app.get("/ui")
    def workbench_page():
        if not STATIC_HTML.is_file():
            return JSONResponse({"error": "Workbench not built. Run: npm run build:ui"}, status_code=404)
        return FileResponse(STATIC_HTML, media_type="text/html")

    # The MCP endpoint is /mcp (mounted last so the routes above win).
    app.mount("/", mcp.streamable_http_app())
    return app


app = create_app()
