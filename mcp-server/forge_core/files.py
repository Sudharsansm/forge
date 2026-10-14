from __future__ import annotations

import hashlib
import posixpath
import re
import time

from . import config
from .errors import ConflictError, ForgeError, PathError
from .events import EventBus
from .projects import Project
from .state import ProjectState


def content_hash(text: str | None) -> str:
    return hashlib.sha256(("\0missing" if text is None else text).encode("utf-8")).hexdigest()[:16]


class FileService:
    """All reads and writes to a project go through here: path safety, history and events. Files live in memory only."""

    def __init__(self, project: Project, state: ProjectState, bus: EventBus):
        self.project = project
        self.state = state
        self.bus = bus

    # ---- path safety ---------------------------------------------------------
    def norm(self, rel: str) -> str:
        """A clean project-relative path (forward slashes), or PathError."""
        rel = (rel or "").replace("\\", "/").strip()
        if not rel or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or "\0" in rel:
            raise PathError(f"Path '{rel}' must be relative to the project")
        parts = posixpath.normpath(rel).split("/")
        if parts[0] == ".." or ".." in parts or parts == ["."]:
            raise PathError(f"Path '{rel}' is outside the project")
        if set(parts) & config.IGNORED_DIRS:
            raise PathError(f"Path '{rel}' is in a protected folder")
        return "/".join(parts)

    # ---- reading -------------------------------------------------------------
    def list_files(self, sub: str = ".", visible: bool = False) -> list[str]:
        """All files of the project (or of one folder). `visible` is kept for old callers: nothing is hidden any more."""
        with self.project.lock:
            names = list(self.project.files)
        if sub not in ("", ".", "./"):
            prefix = self.norm(sub).rstrip("/") + "/"
            names = [n for n in names if n.startswith(prefix)]
        return sorted(n for n in names if not n.endswith(".DS_Store"))

    def exists(self, rel: str) -> bool:
        return self.norm(rel) in self.project.files

    def _read_raw(self, rel: str) -> str | None:
        return self.project.files.get(rel)

    def read(self, rel: str) -> dict:
        path = self.norm(rel)
        text = self._read_raw(path)
        if text is None:
            raise PathError(f"'{rel}' does not exist")
        return {"path": path, "content": text, "hash": content_hash(text)}

    def mtime(self, rel: str) -> float:
        return self.state.recent_writes.get(rel, 0.0)

    # ---- writing -------------------------------------------------------------
    def write(self, rel: str, content: str, source: str = "user",
              base_hash: str | None = None, record: bool = True) -> dict:
        rel_path = self.norm(rel)
        if len(content.encode("utf-8")) > config.MAX_FILE_BYTES:
            raise PathError("Content is too large")
        if any(other.startswith(rel_path + "/") for other in self.project.files):
            raise PathError(f"'{rel}' is a folder")
        with self.state.path_locks[rel_path]:
            before = self._read_raw(rel_path)
            current = content_hash(before)
            if base_hash is not None and base_hash != current:
                raise ConflictError(current)
            if before == content:
                return {"path": rel_path, "hash": current, "changed": False, "created": False}
            self.project.files[rel_path] = content
            self.state.recent_writes[rel_path] = time.time()
            if record:
                self._push_history(rel_path, before, content, source)
        new_hash = content_hash(content)
        self.bus.publish({"type": "file_changed", "project": self.project.id, "path": rel_path,
                          "source": source, "hash": new_hash, "created": before is None})
        if record:
            self._history_event()
        return {"path": rel_path, "hash": new_hash, "changed": True, "created": before is None}

    def delete(self, rel: str, source: str = "user", record: bool = True) -> dict:
        rel_path = self.norm(rel)
        if rel_path not in self.project.files:
            raise PathError(f"'{rel}' is not a file")
        with self.state.path_locks[rel_path]:
            before = self._read_raw(rel_path)
            self.project.files.pop(rel_path, None)
            self.state.recent_writes[rel_path] = time.time()
            if record:
                self._push_history(rel_path, before, None, source)
        self.bus.publish({"type": "file_deleted", "project": self.project.id, "path": rel_path, "source": source})
        if record:
            self._history_event()
        return {"path": rel_path, "deleted": True}

    # ---- history (undo / redo across files, like an editor) --------------------
    def _push_history(self, rel_path: str, before: str | None, after: str | None, source: str) -> None:
        st = self.state
        st.undo.append({"path": rel_path, "before": before, "after": after, "source": source, "ts": time.time()})
        del st.undo[:-config.HISTORY_LIMIT]
        size = sum(len(e["before"] or "") + len(e["after"] or "") for e in st.undo)
        while len(st.undo) > 1 and size > config.HISTORY_MAX_BYTES:  # cap memory used by the undo stack
            dropped = st.undo.pop(0)
            size -= len(dropped["before"] or "") + len(dropped["after"] or "")
        st.redo.clear()

    def _history_event(self) -> None:
        self.bus.publish({"type": "history", "project": self.project.id,
                          "can_undo": bool(self.state.undo), "can_redo": bool(self.state.redo)})

    def history_info(self) -> dict:
        return {"can_undo": bool(self.state.undo), "can_redo": bool(self.state.redo),
                "undo_count": len(self.state.undo), "redo_count": len(self.state.redo),
                "last": self.state.undo[-1]["path"] if self.state.undo else None}

    def history_entries(self, limit: int = 60) -> list[dict]:
        """Newest first. `index` is how many changes must be kept to be at that point (see restore_to)."""
        out = []
        for i, e in enumerate(self.state.undo, start=1):
            kind = "created" if e["before"] is None else "deleted" if e["after"] is None else "edited"
            out.append({"index": i, "path": e["path"], "source": e["source"], "ts": e["ts"], "kind": kind})
        return out[::-1][:limit]

    def restore_to(self, keep: int) -> dict:
        """Undo changes until only `keep` remain: go back to the state right after change number `keep`."""
        keep = max(0, min(int(keep), len(self.state.undo)))
        steps = 0
        while len(self.state.undo) > keep:
            self.undo()
            steps += 1
        return {"steps": steps, **self.history_info()}

    def _apply(self, rel_path: str, text: str | None, source: str) -> None:
        if text is None:
            if rel_path in self.project.files:
                self.delete(rel_path, source=source, record=False)
        else:
            self.write(rel_path, text, source=source, record=False)

    def undo(self) -> dict:
        if not self.state.undo:
            raise ForgeError("Nothing to undo")
        entry = self.state.undo.pop()
        self._apply(entry["path"], entry["before"], "undo")
        self.state.redo.append(entry)
        self._history_event()
        return {"path": entry["path"], **self.history_info()}

    def redo(self) -> dict:
        if not self.state.redo:
            raise ForgeError("Nothing to redo")
        entry = self.state.redo.pop()
        self._apply(entry["path"], entry["after"], "redo")
        self.state.undo.append(entry)
        self._history_event()
        return {"path": entry["path"], **self.history_info()}
