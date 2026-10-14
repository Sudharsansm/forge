"""MCP tools. They use the same Core as the HTTP API, so AI edits show up live in the web app."""
from __future__ import annotations

import json
import os
import urllib.request

from mcp.server.fastmcp import FastMCP

from . import config, visual_edit
from .core import core
from .errors import ForgeError

# Tools that change the project also link the workbench window, so the Forge preview card shows up under the AI's reply after ANY edit.
SHOW = {"ui": {"resourceUri": "ui://forge/workbench", "visibility": ["model", "app"]}}
mcp = FastMCP("bitsophia-forge", host=config.HOST, port=config.PORT)

# In stdio mode this process is separate from the web app, so selection/errors are read over HTTP.
REMOTE_API = os.environ.get("FORGE_API_URL")


def _remote(path: str) -> dict | None:
    if not REMOTE_API:
        return None
    req = urllib.request.Request(REMOTE_API.rstrip("/") + path)
    if config.API_KEY:
        req.add_header("X-API-Key", config.API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp)
    except OSError as exc:
        raise ForgeError(f"Cannot reach the Forge API at {REMOTE_API}: {exc}") from exc


@mcp.tool()
def list_files(path: str = ".", project: str = "default") -> list[str]:
    """List all files in the project (or a sub-folder)."""
    return core.files(project).list_files(path)


@mcp.tool()
def read_file(path: str, project: str = "default") -> str:
    """Read a text file from the project."""
    return core.files(project).read(path)["content"]


@mcp.tool(meta=SHOW)
def write_file(path: str, content: str, project: str = "default") -> str:
    """Create or overwrite a file (parent folders are created). The web app shows the change live."""
    result = core.files(project).write(path, content, source="ai")
    return f"{'Created' if result['created'] else 'Updated' if result['changed'] else 'Unchanged'} {result['path']}"


@mcp.tool(meta=SHOW)
def delete_file(path: str, project: str = "default") -> str:
    """Delete one file."""
    return f"Deleted {core.files(project).delete(path, source='ai')['path']}"


@mcp.tool(meta=SHOW)
def get_preview_url(project: str = "default") -> dict:
    """Where the live preview is shown. The app is compiled inside the Forge window (nothing runs on a server)."""
    from .workbench_tools import preview_link
    return {"url": preview_link(project), "note": "The preview is rendered inside the Forge window; open the link to see it in a browser."}


@mcp.tool()
def get_preview_errors(project: str = "default") -> dict:
    """Compile errors and runtime errors reported by the Forge window (it compiles the app in the browser). Fix them, then check again."""
    remote = _remote(f"/api/errors?project={project}")
    return remote if remote is not None else core.errors(project)


@mcp.tool()
def get_selected_component(project: str = "default") -> dict:
    """The element the user clicked in the preview (file, line, column, tag, classes, text) plus any instruction they queued for you."""
    remote = _remote(f"/api/selection?project={project}")
    if remote is not None:
        return remote
    state = core.state(project)
    prompt, state.pending_prompt = state.pending_prompt, None
    return {"selection": state.selection, "instruction": prompt}


@mcp.tool(meta=SHOW)
def update_component(path: str, line: int, col: int, text: str | None = None, text_color: str | None = None,
                     background_color: str | None = None, padding_px: int | None = None,
                     font_size_px: int | None = None, font_weight: str | None = None,
                     project: str = "default") -> str:
    """Change one JSX element, located by the line/col from get_selected_component, without touching the rest
    of the file. Colors are hex like #ff0000. For anything else, use read_file + write_file."""
    changes = {"text": text, "textColor": text_color, "bgColor": background_color,
               "padding": padding_px, "fontSize": font_size_px, "fontWeight": font_weight}
    changes = {k: v for k, v in changes.items() if v is not None}
    files = core.files(project)
    current = files.read(path)
    new = visual_edit.apply_changes(current["content"], line, col, changes)
    result = files.write(path, new, source="ai", base_hash=current["hash"])
    return f"Updated {result['path']} at {line}:{col}"


@mcp.tool(meta=SHOW)
def undo(project: str = "default") -> str:
    """Undo the last file change (by the user or the AI)."""
    return f"Undid change to {core.files(project).undo()['path']}"


@mcp.tool(meta=SHOW)
def redo(project: str = "default") -> str:
    """Redo the last undone change."""
    return f"Redid change to {core.files(project).redo()['path']}"


from . import workbench_tools  # noqa: E402,F401  (registers the MCP App tools and the ui:// resource)
from . import library_tools  # noqa: E402,F401  (documents library, project structure and Layers diagrams)
