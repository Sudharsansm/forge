import asyncio
import base64
import io
import json

import pytest

from forge_core import routes


def test_routes_detected_from_app_sources_only():
    src = {
        "src/App.tsx": '<Routes><Route path="/" element={<A/>}/><Route path="/about-us" element={<B/>}/>'
                       '<Route path="*" element={<N/>}/><Route path="/blog/:id" element={<P/>}/></Routes>',
        "forge-inspector.ts": 'x = { path: "#/evil" }',
        "src/router.ts": 'export const r = [{ path: "pricing", element: 1 }, { path: "https://x.y" }]',
    }
    found = {r["path"]: r["label"] for r in routes.detect_routes(src)}
    assert found == {"/": "Homepage", "/about-us": "About Us", "/pricing": "Pricing"}


def test_mcp_app_wiring():
    from forge_core.mcp_tools import mcp
    tools = {t.name: (t.meta or {}).get("ui") for t in asyncio.run(mcp.list_tools())}
    assert tools["forge_write_files"]["resourceUri"] == "ui://forge/workbench"
    assert "model" in tools["forge_write_files"]["visibility"]
    ui_only = [n for n, m in tools.items() if m and m["visibility"] == ["app"]]
    assert {"forge_ui_state", "forge_ui_sources", "forge_ui_report", "forge_ui_edit", "forge_ui_save", "forge_ui_export"} <= set(ui_only)
    assert tools["forge_check"]["resourceUri"] == "ui://forge/workbench"
    res = asyncio.run(mcp.list_resources())
    assert str(res[0].uri) == "ui://forge/workbench" and res[0].mimeType == "text/html;profile=mcp-app"


def test_workbench_tools_through_a_real_client_session():
    from mcp.shared.memory import create_connected_server_and_client_session
    from forge_core.mcp_tools import mcp

    async def go():
        async with create_connected_server_and_client_session(mcp._mcp_server) as c:
            ok = await c.call_tool("forge_write_files", {"project": "wb-test", "files": [
                {"path": "src/components/Hi.tsx", "content": "export default function Hi(){return <h1>hi</h1>}\n"}]})
            assert not ok.isError and ok.structuredContent["written"][0]["created"] is True
            st = (await c.call_tool("forge_ui_state", {"project": "wb-test"})).structuredContent
            assert "src/components/Hi.tsx" in st["files"] and "wb-test" in st["projects"]
            bad = await c.call_tool("forge_write_files", {"project": "wb-test", "files": [{"path": "../x", "content": "x"}]})
            assert bad.isError
            conflict = (await c.call_tool("forge_ui_save", {"project": "wb-test", "path": "src/components/Hi.tsx",
                                                            "content": "x", "base_hash": "stale"})).structuredContent
            assert conflict["conflict"] is True
            exp = (await c.call_tool("forge_ui_export", {"project": "wb-test"})).structuredContent
            assert exp["filename"] == "hi.zip" and exp["base64"].startswith("UEs")   # "PK" zip magic
            await c.call_tool("forge_ui_projects", {})
    asyncio.run(go())


def test_version_list_and_restore():
    from forge_core.core import Core
    f = Core().files("default")
    f.write("src/ver.txt", "one", source="ai")
    f.write("src/ver.txt", "two", source="user")
    f.write("src/ver.txt", "three", source="visual")
    entries = f.history_entries()
    assert [e["source"] for e in entries[:3]] == ["visual", "user", "ai"] and entries[2]["kind"] == "created"
    assert f.restore_to(entries[1]["index"])["steps"] == 1       # back to right after the "user" change
    assert f.read("src/ver.txt")["content"] == "two"
    f.restore_to(entries[2]["index"] - 1)                          # before the file existed at all
    assert not f.exists("src/ver.txt")


def test_export_single_file_folder_and_project_through_a_session():
    import zipfile
    from mcp.shared.memory import create_connected_server_and_client_session
    from forge_core.mcp_tools import mcp

    async def go():
        async with create_connected_server_and_client_session(mcp._mcp_server) as c:
            await c.call_tool("forge_write_files", {"project": "exp-test", "files": [
                {"path": "src/components/A.tsx", "content": "export const A = 1;\n"},
                {"path": "src/components/B.tsx", "content": "export const B = 2;\n"}]})
            one = (await c.call_tool("forge_ui_export", {"project": "exp-test", "path": "src/components/A.tsx"})).structuredContent
            assert one["filename"] == "A.tsx" and base64.b64decode(one["base64"]) == b"export const A = 1;\n"
            folder = (await c.call_tool("forge_ui_export", {"project": "exp-test", "path": "src/components"})).structuredContent
            names = zipfile.ZipFile(io.BytesIO(base64.b64decode(folder["base64"]))).namelist()
            assert folder["filename"] == "components.zip" and sorted(names) == ["components/A.tsx", "components/B.tsx"]
            whole = (await c.call_tool("forge_ui_export", {"project": "exp-test"})).structuredContent
            wn = zipfile.ZipFile(io.BytesIO(base64.b64decode(whole["base64"]))).namelist()
            assert whole["filename"] == "exp-test.zip" and "exp-test/src/components/A.tsx" in wn
            assert (await c.call_tool("forge_ui_export", {"project": "exp-test", "path": "../etc/passwd"})).isError
            st = (await c.call_tool("forge_ui_state", {"project": "exp-test"})).structuredContent
            assert st["sizes"]["src/components/A.tsx"] == 20 and st["version"] == __import__("forge_core").__version__
            hist = (await c.call_tool("forge_ui_history", {"project": "exp-test", "action": "list"})).structuredContent
            assert hist["entries"][0]["source"] == "ai"
    asyncio.run(go())


def test_code_search_finds_lines_and_limits():
    from mcp.shared.memory import create_connected_server_and_client_session
    from forge_core.mcp_tools import mcp

    async def go():
        async with create_connected_server_and_client_session(mcp._mcp_server) as c:
            await c.call_tool("forge_write_files", {"project": "srch-test", "files": [
                {"path": "src/components/Card.tsx", "content": "const a = 1;\nexport const Card = () => <div>Pricing CARD</div>;\n"},
                {"path": "src/util.ts", "content": "// pricing helper\nexport const price = 3;\n"}]})

            def q(**a):
                return c.call_tool("forge_ui_search", {"project": "srch-test", **a})
            r = (await q(query="pricing")).structuredContent
            assert r["files"] == 2 and {m["path"] for m in r["matches"]} == {"src/components/Card.tsx", "src/util.ts"}
            hit = next(m for m in r["matches"] if m["path"].endswith("Card.tsx"))
            assert hit["line"] == 2 and hit["text"][hit["col"]:hit["col"] + hit["len"]].lower() == "pricing"   # case-insensitive
            assert (await q(query="p")).structuredContent["matches"] == []                                     # too short
            assert (await q(query="export", limit=1)).structuredContent["truncated"] is True
    asyncio.run(go())


def test_blank_means_no_files():
    from forge_core.workbench_tools import is_blank
    assert is_blank([])
    assert not is_blank(["src/App.tsx"])


def test_empty_project_suggests_the_one_with_files(client):
    from forge_core.workbench_tools import _suggest
    client.post("/api/projects", json={"name": "suggest-a"})
    client.post("/api/file", json={"project": "suggest-a", "path": "src/App.tsx", "content": "x"})
    assert _suggest("default", []) is not None
    assert _suggest("default", ["src/App.tsx"]) is None
    client.delete("/api/projects/suggest-a")


def test_project_with_only_documents_is_not_redirected(client):
    from forge_core.workbench_tools import _suggest
    client.post("/api/projects", json={"name": "docs-only"})
    client.post("/api/projects", json={"name": "has-app"})
    client.post("/api/file", json={"project": "has-app", "path": "src/App.tsx", "content": "x"})
    client.post("/api/tool/forge_create_document", json={"project": "docs-only", "name": "n", "format": "md", "content": "# hi"})
    assert _suggest("docs-only", []) is None          # has a document: stay here
    client.delete("/api/projects/docs-only")
    client.delete("/api/projects/has-app")


def test_old_stored_projects_are_never_suggested(client):
    import os
    import time

    from forge_core.core import core
    from forge_core.workbench_tools import _suggest
    client.post("/api/projects", json={"name": "old-site"})
    client.post("/api/file", json={"project": "old-site", "path": "src/App.tsx", "content": "x"})
    assert _suggest("default", []) == "old-site"                       # just written: the window may follow it
    core.state("old-site").recent_writes["src/App.tsx"] = time.time() - 3600  # an hour old
    assert _suggest("default", []) != "old-site"                         # a stored project does not pop up by itself
    client.delete("/api/projects/old-site")


def test_forge_ui_sources_and_report_round_trip():
    from mcp.shared.memory import create_connected_server_and_client_session
    from forge_core.mcp_tools import mcp

    async def go():
        async with create_connected_server_and_client_session(mcp._mcp_server) as c:
            await c.call_tool("forge_write_files", {"project": "src-test", "files": [
                {"path": "src/App.tsx", "content": "export default function App(){return <h1>hi</h1>}\n"}]})
            r = (await c.call_tool("forge_ui_sources", {"project": "src-test"})).structuredContent
            assert r["files"] == {"src/App.tsx": "export default function App(){return <h1>hi</h1>}\n"} and r["rev"]
            # the window compiles in the browser and tells the server how it went, so forge_check can answer the AI
            await c.call_tool("forge_ui_report", {"project": "src-test", "build_error": "src/App.tsx:1 Unexpected token"})
            bad = await c.call_tool("forge_check", {"project": "src-test"})
            assert bad.isError and "Unexpected token" in bad.content[0].text
            await c.call_tool("forge_ui_report", {"project": "src-test", "rev": r["rev"]})
            assert not (await c.call_tool("forge_check", {"project": "src-test"})).isError
    asyncio.run(go())


def test_zip_is_named_after_the_app():
    import asyncio
    from mcp.shared.memory import create_connected_server_and_client_session
    from forge_core.mcp_tools import mcp

    async def go():
        async with create_connected_server_and_client_session(mcp._mcp_server) as c:
            await c.call_tool("forge_write_files", {"project": "zip-name", "files": [
                {"path": "src/App.tsx", "content": "export default function App(){return <h1>Cafe Billing & POS</h1>}\n"}]})
            st = (await c.call_tool("forge_ui_state", {"project": "zip-name"})).structuredContent
            assert st["title"] == "Cafe Billing & POS"
            exp = (await c.call_tool("forge_ui_export", {"project": "zip-name"})).structuredContent
            assert exp["filename"] == "cafe-billing-pos.zip"
    asyncio.run(go())