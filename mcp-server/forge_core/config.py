from __future__ import annotations

import os
from pathlib import Path

# mcp-server/forge_core/config.py -> parents[2] is the monorepo root (forge/)
ROOT = Path(os.environ.get("FORGE_ROOT", Path(__file__).resolve().parents[2])).resolve()
# Nothing is stored (like Claude Artifacts): projects and documents live in this process's memory only and the app is
# compiled and previewed inside the Forge window. There is no workspace folder, no temp folder, no npm and no build output.

HOST = os.environ.get("FORGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("FORGE_PORT", "8000"))
API_KEY = os.environ.get("FORGE_API_KEY") or None
ALLOWED_HOSTS = [h for h in os.environ.get("FORGE_ALLOWED_HOSTS", "").split(",") if h.strip()]
CORS_ORIGINS = [o for o in os.environ.get("FORGE_CORS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o]

# Folders the AI and the UI may never read or write.
IGNORED_DIRS = {"node_modules", ".git", "dist", ".forge", "__pycache__", ".venv"}
MAX_FILE_BYTES = 500_000
HISTORY_LIMIT = 200
HISTORY_MAX_BYTES = int(os.environ.get("FORGE_HISTORY_MAX_MB", "40")) * 1_000_000  # undo stack memory cap

# Documents library (uploads and generated documents).
MAX_UPLOAD_BYTES = int(os.environ.get("FORGE_MAX_UPLOAD_MB", "15")) * 1_000_000
MAX_BODY_BYTES = int(MAX_UPLOAD_BYTES * 1.4) + 1_000_000  # base64 overhead + envelope
LIBRARY_VERSIONS = int(os.environ.get("FORGE_LIBRARY_VERSIONS", "30"))
LOG_LEVEL = os.environ.get("FORGE_LOG_LEVEL", "INFO").upper()

# Public base URL of this server (e.g. https://forge.example.com). Enables "Open in browser" from an MCP host.
PUBLIC_URL = (os.environ.get("FORGE_PUBLIC_URL") or "").rstrip("/") or None

AI_MODEL = os.environ.get("FORGE_MODEL", "claude-sonnet-5-5")
