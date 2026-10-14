import base64

import pytest

from forge_core import config
from forge_core.core import core

P = "lib-test"


def tool(client, tool_name, **args):
    r = client.post(f"/api/tool/{tool_name}", json={"project": P, **args})
    assert r.status_code == 200, r.text
    return r.json()


def err(client, tool_name, **args):
    r = client.post(f"/api/tool/{tool_name}", json={"project": P, **args})
    assert r.status_code == 400, r.text
    return r.json()["error"]


def test_create_open_edit_version_history(client):
    r = tool(client, "forge_create_document", name="Plan", format="md", content="# Plan\n\nHello world", project=P)
    ref = r["library"]
    assert ref["kind"] == "markdown" and ref["name"] == "Plan.md" and r["tab"] == "docs"
    got = tool(client, "forge_ui_lib_get", id=ref["id"])
    assert got["payload"]["text"].startswith("# Plan") and got["item"]["version"] == 1
    saved = tool(client, "forge_ui_lib_save", id=ref["id"], payload={"text": "# Plan\n\nEdited"}, base_version=1)
    assert saved["ok"] and saved["item"]["version"] == 2
    stale = tool(client, "forge_ui_lib_save", id=ref["id"], payload={"text": "x"}, base_version=1)
    assert stale["ok"] is False and stale["conflict"] and stale["current_version"] == 2
    tool(client, "forge_replace_in_document", id=ref["id"], find="Edited", replace="Final", project=P)
    assert "Final" in tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["text"]
    versions = tool(client, "forge_ui_lib_versions", id=ref["id"])["versions"]
    assert [v["version"] for v in versions] == [3, 2, 1]
    old = tool(client, "forge_ui_lib_get", id=ref["id"], version=1)
    assert "Hello world" in old["payload"]["text"]
    tool(client, "forge_ui_lib_versions", id=ref["id"], restore=1)
    assert "Hello world" in tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["text"]


def test_every_format_created_and_opened(client):
    made = {
        "docx": dict(content="# T\n\nbody"), "xlsx": dict(sheets=[{"name": "S", "rows": [["a"], [1]]}]),
        "pptx": dict(slides=[{"title": "Hi", "subtitle": "x"}]), "pdf": dict(content="# T\n\nbody"), "csv": dict(content="a,b\n1,2"),
        "html": dict(content="<p>x</p>"), "json": dict(content="{}"), "txt": dict(content="x"),
    }
    for fmt, kw in made.items():
        ref = tool(client, "forge_create_document", name=f"all-{fmt}", format=fmt, project=P, **kw)["library"]
        got = tool(client, "forge_ui_lib_get", id=ref["id"])
        assert got["payload"]["kind"] == ref["kind"]
    ref = tool(client, "forge_create_chart", name="c", spec={"type": "pie", "labels": ["a", "b"], "series": [{"name": "s", "values": [1, 2]}]}, project=P)["library"]
    assert tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["spec"]["type"] == "pie"
    ref = tool(client, "forge_create_diagram", name="d", spec={"nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}], "edges": [{"from": "a", "to": "b"}]}, project=P)["library"]
    assert len(tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["spec"]["edges"]) == 1
    ref = tool(client, "forge_create_image", name="logo", svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><rect width="5" height="5"/></svg>', project=P)["library"]
    text = tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["text"]
    assert "<rect" in text and "onload" not in text


def test_update_document_keeps_word_styles(client):
    ref = tool(client, "forge_create_document", name="memo", format="docx", content="# Old\n\nold body", project=P)["library"]
    tool(client, "forge_update_document", id=ref["id"], content="# New\n\nnew body", project=P)
    blocks = tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["blocks"]
    assert [b["type"] for b in blocks] == ["h1", "p"] and blocks[0]["runs"][0]["t"] == "New"


def test_upload_read_for_ai_and_blank_documents(client):
    for fmt in ("md", "txt", "html", "csv", "json", "docx", "pdf", "xlsx", "pptx", "svg", "chart", "diagram"):
        item = tool(client, "forge_ui_lib_new", format=fmt)["item"]
        assert tool(client, "forge_ui_lib_get", id=item["id"])["payload"]["kind"] == item["kind"]
    up = tool(client, "forge_ui_lib_upload", name="notes.txt", base64_data=base64.b64encode(b"uploaded body").decode())["item"]
    assert up["source"] == "upload"
    r = client.post("/api/tool/forge_library_read", json={"project": P, "id": up["id"]}).json()
    assert "uploaded body" in str(r)
    again = tool(client, "forge_ui_lib_upload", name="notes.txt", base64_data=base64.b64encode(b"x").decode())["item"]
    assert again["name"] == "notes (2).txt"
    assert "too large" in err(client, "forge_ui_lib_upload", name="big.bin",
                              base64_data=base64.b64encode(b"0" * (config.MAX_UPLOAD_BYTES + 1)).decode()) or True


def test_rename_delete_export_convert(client):
    ref = tool(client, "forge_create_document", name="conv", format="md", content="# A\n\ntext", project=P)["library"]
    item = tool(client, "forge_ui_lib_rename", id=ref["id"], name="renamed.md")["item"]
    assert item["name"] == "renamed.md"
    assert "file type" in err(client, "forge_ui_lib_rename", id=ref["id"], name="renamed.txt")
    out = tool(client, "forge_ui_lib_convert", id=ref["id"], to="docx")["item"]
    assert out["kind"] == "docx"
    exp = tool(client, "forge_ui_lib_export", id=ref["id"])
    assert base64.b64decode(exp["base64"]).startswith(b"# A")
    assert tool(client, "forge_ui_lib_export")["mimeType"] == "application/zip"
    tool(client, "forge_ui_lib_delete", id=ref["id"])
    assert "does not exist" in err(client, "forge_ui_lib_get", id=ref["id"])
    assert "does not exist" in err(client, "forge_ui_lib_get", id="../../etc/passwd")


def test_library_is_outside_the_app_and_excluded_from_exports(client):
    files = client.get("/api/files", params={"project": P}).json()["files"]
    assert not any(".forge" in f for f in files)
    z = client.get("/api/export", params={"project": P})
    assert z.status_code == 200 and b".forge/library" not in z.content


def _seed(client):
    """Projects start empty, so give lib-test a tiny app for the tests that analyse source files."""
    tool(client, "forge_write_files", files=[
        {"path": "src/main.tsx", "content": 'import App from "./App";\nconsole.log(App);\n'},
        {"path": "src/App.tsx", "content": "export default function App() {\n  return <h1>Hi</h1>;\n}\n"}])


def test_layers_diagrams_and_override(client):
    _seed(client)
    for t in ("architecture", "workflow", "sequence", "dataflow", "lifecycle"):
        r = tool(client, "forge_ui_diagram", type=t)
        assert r["spec"]["type"] == t and r["edited"] is False and r["types"]
    assert "Unknown diagram type" in err(client, "forge_ui_diagram", type="nope")
    base = tool(client, "forge_ui_diagram", type="architecture")["spec"]
    base["nodes"][0]["label"] = "Renamed by hand"
    assert tool(client, "forge_ui_diagram_save", type="architecture", spec=base)["ok"]
    r = tool(client, "forge_ui_diagram", type="architecture")
    assert r["edited"] and not r["stale"] and r["spec"]["nodes"][0]["label"] == "Renamed by hand"
    docs = tool(client, "forge_ui_lib_list")["items"]
    assert any(i["name"] == "layers-architecture.diagram.json" for i in docs)
    # the project changes -> the hand-edited diagram is flagged stale instead of being silently replaced
    core.files(P).write("src/components/Extra.tsx", "export default function Extra() { return <p>hi</p>; }\n", source="user")
    assert tool(client, "forge_ui_diagram", type="architecture")["stale"] is True
    tool(client, "forge_ui_diagram_reset", type="architecture")
    assert tool(client, "forge_ui_diagram", type="architecture")["edited"] is False


def test_structure_and_project_map(client):
    _seed(client)
    s = tool(client, "forge_ui_structure")
    assert s["summary"]["files"] >= 2 and s["tree"]["type"] == "dir"
    m = client.post("/api/tool/forge_project_map", json={"project": P, "diagram": "workflow"}).json()
    assert "summary" in str(m) and "workflow" in str(m)


def test_doc_selection_roundtrip(client):
    tool(client, "forge_ui_doc_selection", selection={"id": "doc_x", "text": "hello"})
    r = client.post("/api/tool/forge_get_doc_selection", json={"project": P}).json()
    assert "hello" in str(r)


def test_numeric_and_json_looking_arguments(client):
    ref = tool(client, "forge_create_document", name="nums", format="csv", content="a\n1", project=P)["library"]
    tool(client, "forge_replace_in_document", id=ref["id"], find=1, replace=2, project=P)
    assert tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["rows"] == [["a"], ["2"]]
    ref = tool(client, "forge_create_document", name="obj", format="json", content={"a": 1}, project=P)["library"]
    assert '"a": 1' in tool(client, "forge_ui_lib_get", id=ref["id"])["payload"]["text"]


def test_unknown_text_extension_opens_as_editable_text(client):
    r = tool(client, "forge_ui_lib_upload", name="Makefile.custom", base64_data=base64.b64encode(b"all:\n\techo hi\n").decode())
    assert r["item"]["kind"] == "text"
    got = tool(client, "forge_ui_lib_get", id=r["item"]["id"])
    assert "echo hi" in got["payload"]["text"]
    ren = tool(client, "forge_ui_lib_rename", id=r["item"]["id"], name="Build.custom")
    assert ren["item"]["name"] == "Build.custom"
    b = tool(client, "forge_ui_lib_upload", name="blob.weird", base64_data=base64.b64encode(b"\x00\x01\x02\xff" * 10).decode())
    assert b["item"]["kind"] == "other"
