import asyncio

from forge_core import mcp_tools  # noqa: F401
from forge_core.mcp_tools import mcp


def test_every_tool_that_changes_the_project_links_the_workbench_window():
    tools = {t.name: (t.meta or {}) for t in asyncio.run(mcp.list_tools())}
    for name in ["write_file", "delete_file", "update_component", "undo", "redo", "forge_write_files",
                 "forge_check", "forge_open", "forge_create_document", "forge_create_chart", "forge_create_image", "forge_update_document"]:
        assert tools[name].get("ui", {}).get("resourceUri") == "ui://forge/workbench", name
