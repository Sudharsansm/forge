"""Documents library: uploaded and generated documents of a project, with version history.

Everything is kept in memory (like Claude Artifacts): nothing is written to disk and it is gone when the server stops.
"""
from __future__ import annotations

import io
import re
import secrets
import threading
import time
import zipfile

from . import config, formats
from .errors import ConflictError, ForgeError
from .events import EventBus
from .projects import Project


class VersionConflict(ConflictError):
    def __init__(self, current: int):
        ForgeError.__init__(self, "The document changed since you opened it.")
        self.current_hash = str(current)
        self.current = current


class Library:
    def __init__(self, project: Project, bus: EventBus):
        self.project = project
        self.bus = bus
        self._lock = threading.RLock()
        self._items: dict[str, dict] = {}
        self._data: dict[str, bytes] = {}
        self._side: dict[str, bytes] = {}
        self._versions: dict[str, dict[int, dict]] = {}  # id -> {n: {data, side, source, updated, size}}

    @staticmethod
    def _check_id(id_: str) -> None:
        if not re.fullmatch(r"doc_[0-9a-f]{8}", id_):
            raise ForgeError("Invalid document id")

    def _publish(self, id_: str, action: str) -> None:
        self.bus.publish({"type": "library_changed", "project": self.project.id, "id": id_, "action": action})

    # ------------------------------------------------------------------ reading
    def list(self) -> list[dict]:
        with self._lock:
            items = [dict(i) for i in self._items.values()]
        return sorted(items, key=lambda i: i["updated"], reverse=True)

    def get(self, id_: str) -> dict:
        with self._lock:
            item = self._items.get(id_)
            if item is None:
                raise ForgeError(f"Document '{id_}' does not exist")
            return dict(item)

    def find(self, key: str) -> dict:
        """By id, or by exact (case-insensitive) name when no id matches."""
        with self._lock:
            items = dict(self._items)
        if key in items:
            return dict(items[key])
        hits = [i for i in items.values() if i["name"].lower() == key.lower()]
        if len(hits) == 1:
            return dict(hits[0])
        raise ForgeError(f"Document '{key}' does not exist" if not hits else f"More than one document is named '{key}'; use its id")

    def read(self, id_: str) -> tuple[dict, bytes, bytes | None]:
        item = self.get(id_)
        with self._lock:
            data = self._data.get(id_)
            if data is None:
                raise ForgeError("The document's file is missing")
            return item, data, self._side.get(id_)

    def read_version(self, id_: str, version: int) -> tuple[bytes, bytes | None]:
        self._check_id(id_)
        with self._lock:
            v = self._versions.get(id_, {}).get(int(version))
        if v is None:
            raise ForgeError("That version does not exist")
        return v["data"], v["side"]

    # ------------------------------------------------------------------ writing
    def _unique_name(self, items: dict, name: str) -> str:
        taken = {i["name"].lower() for i in items.values()}
        if name.lower() not in taken:
            return name
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        n = 2
        while True:
            cand = f"{stem} ({n})" + (f".{ext}" if ext else "")
            if cand.lower() not in taken:
                return cand
            n += 1

    def add(self, name: str, data: bytes, source: str = "upload", sidecar: bytes | None = None, meta: dict | None = None,
            unique: bool = True) -> dict:
        name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", name.strip())[:120] or "untitled"
        if len(data) > config.MAX_UPLOAD_BYTES:
            raise ForgeError(f"The file is larger than {config.MAX_UPLOAD_BYTES // 1_000_000} MB")
        kind = formats.kind_of(name)
        if kind == "other" and formats.looks_like_text(data):
            kind = "text"  # unknown extension, but plainly text: show and edit it as text
        if kind == "svg":
            data = formats.sanitize_svg(formats._decode_text(data)).encode("utf-8")
        with self._lock:
            if unique:
                name = self._unique_name(self._items, name)
            id_ = "doc_" + secrets.token_hex(4)
            while id_ in self._items:
                id_ = "doc_" + secrets.token_hex(4)
            now = time.time()
            item = {"id": id_, "name": name, "kind": kind, "mime": formats.mime_of(name), "size": len(data), "source": source,
                    "created": now, "updated": now, "version": 1, "meta": meta or {}}
            self._data[id_] = data
            if sidecar is not None:
                self._side[id_] = sidecar
            self._items[id_] = item
            item = dict(item)
        self._publish(id_, "created")
        return item

    def save(self, id_: str, data: bytes, source: str = "user", sidecar: bytes | None = None, base_version: int | None = None,
             meta_update: dict | None = None) -> dict:
        if len(data) > config.MAX_UPLOAD_BYTES:
            raise ForgeError(f"The file is larger than {config.MAX_UPLOAD_BYTES // 1_000_000} MB")
        with self._lock:
            item = self._items.get(id_)
            if item is None:
                raise ForgeError(f"Document '{id_}' does not exist")
            if base_version is not None and base_version != item["version"]:
                raise VersionConflict(item["version"])
            vers = self._versions.setdefault(id_, {})
            if id_ in self._data:
                vers[item["version"]] = {"data": self._data[id_], "side": self._side.get(id_), "source": item.get("source"),
                                         "updated": item["updated"], "size": item["size"]}
            self._data[id_] = data
            if sidecar is not None:
                self._side[id_] = sidecar
            elif id_ in self._side and item["kind"] != "pdf":
                del self._side[id_]
            item.update(size=len(data), updated=time.time(), version=item["version"] + 1, source=source)
            if meta_update:
                item["meta"] = {**item.get("meta", {}), **meta_update}
            for n in sorted(vers)[:-config.LIBRARY_VERSIONS]:  # prune old versions
                del vers[n]
            item = dict(item)
        self._publish(id_, "updated")
        return item

    def versions(self, id_: str) -> list[dict]:
        item = self.get(id_)
        out = [{"version": item["version"], "current": True, "updated": item["updated"], "size": item["size"], "source": item.get("source")}]
        with self._lock:
            vers = dict(self._versions.get(id_, {}))
        for n in sorted(vers, reverse=True):
            v = vers[n]
            out.append({"version": n, "current": False, "updated": v["updated"], "size": v["size"], "source": v["source"]})
        return out

    def restore(self, id_: str, version: int) -> dict:
        data, side = self.read_version(id_, version)
        return self.save(id_, data, source="restore", sidecar=side)

    def rename(self, id_: str, name: str) -> dict:
        name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", name.strip())[:120]
        if not name:
            raise ForgeError("The name cannot be empty")
        with self._lock:
            item = self._items.get(id_)
            if item is None:
                raise ForgeError(f"Document '{id_}' does not exist")
            same_ext = formats.ext_of(name) == formats.ext_of(item["name"])
            if formats.kind_of(name) != item["kind"] and not (item["kind"] == "text" and same_ext):
                raise ForgeError(f"Keep the file type: the name must still end in .{formats.ext_of(item['name'])}")
            others = {k: v for k, v in self._items.items() if k != id_}
            item["name"] = self._unique_name(others, name)
            item["updated"] = time.time()
            item = dict(item)
        self._publish(id_, "renamed")
        return item

    def delete(self, id_: str) -> None:
        with self._lock:
            if id_ not in self._items:
                raise ForgeError(f"Document '{id_}' does not exist")
            del self._items[id_]
            self._data.pop(id_, None)
            self._side.pop(id_, None)
            self._versions.pop(id_, None)
        self._publish(id_, "deleted")

    def export_zip(self) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for item in self.list():
                data = self._data.get(item["id"])
                if data is not None:
                    zf.writestr(item["name"], data)
        return buf.getvalue()

    def stats(self) -> dict:
        items = self.list()
        return {"count": len(items), "bytes": sum(i["size"] for i in items)}
