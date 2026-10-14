from __future__ import annotations

from . import config
from .events import EventBus
from .files import FileService
from .library import Library
from .projects import ProjectManager
from .state import ProjectState


class Core:
    """Process-wide singletons shared by the HTTP API and the MCP tools."""

    def __init__(self) -> None:
        self.bus = EventBus()
        self.projects = ProjectManager()
        self._states: dict[str, ProjectState] = {}
        self._files: dict[str, FileService] = {}
        self._libs: dict[str, Library] = {}
        self._analysis: dict[str, tuple[str, object]] = {}

    def state(self, project_id: str = "default") -> ProjectState:
        self.projects.get(project_id)
        return self._states.setdefault(project_id, ProjectState())

    def files(self, project_id: str = "default") -> FileService:
        project = self.projects.get(project_id)
        if project_id not in self._files:
            self._files[project_id] = FileService(project, self.state(project_id), self.bus)
        return self._files[project_id]

    def library(self, project_id: str = "default") -> Library:
        project = self.projects.get(project_id)
        if project_id not in self._libs:
            self._libs[project_id] = Library(project, self.bus)
        return self._libs[project_id]

    def analysis(self, project_id: str = "default"):
        """Static analysis of the project, cached until a source file changes."""
        import hashlib

        from . import analyzer
        from .routes import detect_routes

        project = self.projects.get(project_id)
        with project.lock:
            snapshot = dict(project.files)
        h = hashlib.sha1()
        for p in sorted(snapshot):
            h.update(p.encode())
            h.update(hashlib.sha1(snapshot[p].encode("utf-8")).digest())
        sig = h.hexdigest()
        cached = self._analysis.get(project_id)
        if cached and cached[0] == sig:
            return cached[1]
        sources, sizes = analyzer.source_files(snapshot)
        result = analyzer.analyze(project_id, sources, detect_routes(sources), sizes)
        self._analysis[project_id] = (sig, result)
        return result

    def forget(self, project_id: str) -> None:
        self._files.pop(project_id, None)
        self._states.pop(project_id, None)
        self._libs.pop(project_id, None)
        self._analysis.pop(project_id, None)

    def errors(self, project_id: str = "default") -> dict:
        st = self.state(project_id)
        return {"build": [st.build_error] if st.build_error else [], "runtime": list(st.runtime_errors)}


core = Core()
