from __future__ import annotations

import threading
from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class ProjectState:
    selection: dict | None = None
    pending_prompt: str | None = None
    doc_selection: dict | None = None
    runtime_errors: list[dict] = field(default_factory=list)
    build_error: str | None = None  # last compile error reported by the window (it compiles the app in the browser)
    compiled_rev: int | None = None  # source revision the window last compiled successfully
    undo: list[dict] = field(default_factory=list)
    redo: list[dict] = field(default_factory=list)
    recent_writes: dict[str, float] = field(default_factory=dict)
    path_locks: dict[str, threading.Lock] = field(default_factory=lambda: defaultdict(threading.Lock))
