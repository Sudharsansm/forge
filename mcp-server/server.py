"""stdio entry point (Claude Desktop / VS Code launch this).

File tools work directly on disk; run `uv run forge-server` as well and set FORGE_API_URL so that
get_selected_component / get_preview_errors can read the web app's state.

    uv run mcp dev server.py       # MCP Inspector
    uv run server.py               # plain stdio
"""
import sys

from forge_core.mcp_tools import mcp

if __name__ == "__main__":
    print("Forge MCP server running (stdio)", file=sys.stderr)
    mcp.run()
