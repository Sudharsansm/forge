import pytest


def test_health(client):
    assert client.get("/api/health").json()["ok"] is True


def test_files_and_traversal(client):
    assert "src/App.tsx" in client.get("/api/files").json()["files"]
    assert client.get("/api/file", params={"path": "../x"}).status_code == 400
    assert client.get("/api/file", params={"path": "node_modules/x.js"}).status_code == 400


def test_save_conflict_and_events(client):
    with client.websocket_connect("/ws", headers={"Host": "localhost"}) as sock:
        assert sock.receive_json()["type"] == "hello"
        f = client.get("/api/file", params={"path": "src/App.tsx"}).json()
        r = client.post("/api/file", json={"path": "src/note.txt", "content": "hi"})
        assert r.status_code == 200
        event = sock.receive_json()
        assert event["type"] == "file_changed" and event["path"] == "src/note.txt" and event["source"] == "user"
        # stale hash -> 409
        client.post("/api/file", json={"path": "src/App.tsx", "content": f["content"] + "\n// a"})
        stale = client.post("/api/file", json={"path": "src/App.tsx", "content": "x", "base_hash": f["hash"]})
        assert stale.status_code == 409 and "current_hash" in stale.json()
    client.post("/api/undo")


def test_visual_edit_endpoint_and_undo(client):
    before = client.get("/api/file", params={"path": "src/App.tsx"}).json()["content"]
    line = next(i for i, l in enumerate(before.split("\n"), 1) if "<h1" in l)
    col = before.split("\n")[line - 1].index("<h1")
    r = client.post("/api/visual-edit", json={"path": "src/App.tsx", "line": line, "col": col,
                                              "changes": {"textColor": "#ff0000"}})
    assert r.status_code == 200
    after = client.get("/api/file", params={"path": "src/App.tsx"}).json()["content"]
    assert "text-[#ff0000]" in after
    client.post("/api/undo")
    assert client.get("/api/file", params={"path": "src/App.tsx"}).json()["content"] == before
    bad = client.post("/api/visual-edit", json={"path": "src/App.tsx", "line": 1, "col": 0, "changes": {"padding": 4}})
    assert bad.status_code == 400


def test_selection_errors_and_queue(client):
    sel = {"path": "src/App.tsx", "line": 4, "col": 6, "tag": "h1"}
    client.post("/api/selection", json={"selection": sel})
    client.post("/api/ai/queue", json={"instruction": "make it bigger"})
    got = client.get("/api/selection").json()
    assert got["selection"]["tag"] == "h1" and got["instruction"] == "make it bigger"
    assert client.get("/api/selection").json()["instruction"] is None  # delivered once
    client.post("/api/errors", json={"message": "boom", "kind": "runtime"})
    assert client.get("/api/errors").json()["runtime"][0]["message"] == "boom"
    client.delete("/api/errors")
    assert client.get("/api/errors").json()["runtime"] == []


def test_projects_lifecycle_and_export(client):
    assert client.post("/api/projects", json={"name": "Bad Name!"}).status_code == 400
    assert client.post("/api/projects", json={"name": "demo"}).status_code == 200
    assert client.get("/api/files", params={"project": "demo"}).json()["files"] == []  # new projects start empty
    client.post("/api/file", json={"project": "demo", "path": "src/App.tsx", "content": "export default function App() { return null; }"})
    files = client.get("/api/files", params={"project": "demo"}).json()["files"]
    assert "src/App.tsx" in files and not any("node_modules" in f for f in files)
    zipped = client.get("/api/export", params={"project": "demo"})
    assert zipped.headers["content-type"] == "application/zip" and zipped.content[:2] == b"PK"
    assert client.delete("/api/projects/demo").status_code == 200
    assert client.delete("/api/projects/default").status_code == 400


def test_ai_edit_needs_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/ai/edit", json={"instruction": "x", "path": "src/App.tsx"})
    assert r.status_code == 400 and "ANTHROPIC_API_KEY" in r.json()["error"]


def test_api_key_middleware(client, monkeypatch):
    from forge_core import config
    monkeypatch.setattr(config, "API_KEY", "s3cret")
    assert client.get("/api/files").status_code == 401
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/files", headers={"X-API-Key": "s3cret"}).status_code == 200
    assert client.get("/api/files", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_describe_endpoint(client):
    src = client.get("/api/file", params={"path": "src/App.tsx"}).json()["content"]
    line = next(i for i, l in enumerate(src.split("\n"), 1) if "<h1" in l)
    col = src.split("\n")[line - 1].index("<h1")
    info = client.post("/api/describe", json={"path": "src/App.tsx", "line": line, "col": col}).json()
    assert info["tag"] == "h1" and info["text"] == "Hello"
