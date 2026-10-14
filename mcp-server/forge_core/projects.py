"""Projects live in memory only (like Claude Artifacts): nothing is written to disk and everything is gone when the server stops."""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field

from .errors import ForgeError

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")


@dataclass
class Project:
    id: str
    files: dict[str, str] = field(default_factory=dict)  # path -> text content
    created: float = field(default_factory=time.time)
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class ProjectManager:
    """'default' always exists (empty until something is written); every other project is created on demand."""

    def __init__(self) -> None:
        self._projects: dict[str, Project] = {"default": Project("default")}
        self._lock = threading.Lock()

    def get(self, project_id: str = "default") -> Project:
        with self._lock:
            project = self._projects.get(project_id)
        if project is None:
            if project_id != "default" and not NAME_RE.match(project_id):
                raise ForgeError(f"Invalid project name '{project_id}'")
            raise ForgeError(f"Project '{project_id}' does not exist")
        return project

    def list(self) -> list[Project]:
        with self._lock:
            return list(self._projects.values())

    def create(self, name: str) -> Project:
        if name == "default" or not NAME_RE.match(name):
            raise ForgeError("Project names use a-z, 0-9 and '-' (max 41 chars) and cannot be 'default'")
        with self._lock:
            if name in self._projects:
                raise ForgeError(f"Project '{name}' already exists")
            self._projects[name] = Project(name)
            return self._projects[name]

    def delete(self, name: str) -> None:
        if name == "default":
            raise ForgeError("The default workspace cannot be deleted")
        with self._lock:
            if name not in self._projects:
                raise ForgeError(f"Project '{name}' does not exist")
            del self._projects[name]
