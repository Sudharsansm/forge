import pytest

from forge_core.core import Core
from forge_core.errors import ConflictError, ForgeError, PathError


@pytest.fixture()
def files():
    core = Core()
    core.projects.get("default").files["src/App.tsx"] = "export default function App() { return null }\n"
    return core.files("default")


@pytest.mark.parametrize("bad", ["../x.txt", "..\\x.txt", "/etc/passwd", "C:\\Windows\\win.ini",
                                 "src/../../x", "node_modules/secret.txt", ".git/config"])
def test_paths_outside_or_protected_are_blocked(files, bad):
    with pytest.raises(PathError):
        files.read(bad)
    with pytest.raises(PathError):
        files.write(bad, "x")


def test_list_hides_node_modules(files):
    listing = files.list_files()
    assert "src/App.tsx" in listing and not any("node_modules" in f for f in listing)


def test_write_read_roundtrip_keeps_crlf(files):
    files.write("src/crlf.txt", "a\r\nb\r\n")
    assert files.read("src/crlf.txt")["content"] == "a\r\nb\r\n"


def test_optimistic_concurrency(files):
    first = files.write("src/c.txt", "one")
    files.write("src/c.txt", "two", source="ai")
    with pytest.raises(ConflictError):
        files.write("src/c.txt", "mine", base_hash=first["hash"])
    ok = files.write("src/c.txt", "mine", base_hash=files.read("src/c.txt")["hash"])
    assert ok["changed"]


def test_undo_redo_across_create_modify_delete(files):
    files.write("src/h.txt", "v1")
    files.write("src/h.txt", "v2")
    files.undo()
    assert files.read("src/h.txt")["content"] == "v1"
    files.undo()
    with pytest.raises(PathError):
        files.read("src/h.txt")  # creation undone -> file gone
    files.redo()
    files.redo()
    assert files.read("src/h.txt")["content"] == "v2"
    files.delete("src/h.txt")
    files.undo()
    assert files.read("src/h.txt")["content"] == "v2"


def test_new_write_clears_redo(files):
    files.write("src/r.txt", "1")
    files.undo()
    files.write("src/r.txt", "2")
    with pytest.raises(ForgeError):
        files.redo()


def test_nothing_is_written_to_disk(files, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    files.write("src/mem.tsx", "export const x = 1")
    assert files.read("src/mem.tsx")["content"] == "export const x = 1"
    assert list(tmp_path.iterdir()) == []  # the project lives in memory only


def test_download_adds_the_files_needed_to_run_it(client):
    client.post("/api/projects", json={"name": "plumb"})
    client.post("/api/file", json={"project": "plumb", "path": "src/App.tsx", "content": "export default () => null"})
    assert client.get("/api/files", params={"project": "plumb"}).json()["files"] == ["src/App.tsx"]  # the window lists only what was generated
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/export", params={"project": "plumb"}).content))
    names = set(z.namelist())
    assert {"src/App.tsx", "package.json", "vite.config.ts", "index.html", "src/main.tsx"} <= names
    client.delete("/api/projects/plumb")
